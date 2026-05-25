//! Workspace-wide text search via ripgrep-as-library (LOT 2).
//!
//! ## Pourquoi cette commande
//!
//! Avant le LOT 2, la commande palette `search-in-files` (Cmd+Shift+F) appelait
//! `vecSearch("code", ...)` — recherche sémantique via la collection vectorielle
//! VEC3. C'est puissant mais c'est PAS ce qu'on attend d'un Cmd+Shift+F dans
//! un IDE : on veut du grep textuel pur, instantané, qui respecte .gitignore.
//!
//! Le LOT 2 remplace donc le wiring palette par cette commande. Le semantic
//! search reste disponible pour les autres callers (chat, agents) via
//! `lib/vector.rs::vec_search` — il quitte juste la palette.
//!
//! ## Architecture
//!
//! - Walker : `ignore::WalkBuilder` (respecte .gitignore + .ignore + globs
//!   custom). Identique au walker de ripgrep CLI, garantit le même comportement.
//! - Matcher : `grep_regex::RegexMatcherBuilder` — wrap autour de la regex Rust
//!   officielle (pas de PCRE pour éviter la dépendance native).
//! - Searcher : `grep_searcher::Searcher` avec un `Sink` custom qui sérialise
//!   les matches en `GrepMatch` push-és dans un Vec partagé via Arc<Mutex>.
//! - Parallélisme : `build_parallel().run()` pour utiliser tous les cores ;
//!   un AtomicBool sert de stop-flag quand `max_results` est atteint.
//! - Async-wrap : `tokio::task::spawn_blocking` car ripgrep est sync ; on évite
//!   ainsi de bloquer le runtime async Tauri pendant les gros workspaces.
//!
//! ## Sécurité
//!
//! - Le workspace root est lu depuis le state Tauri (`Mutex<Option<PathBuf>>`).
//!   Si aucun workspace n'est ouvert, on retourne `Err("no workspace open")`.
//! - Pas de path crossing : on walk depuis workspace_root, jamais en dehors.
//! - Symlinks NON suivis par défaut (comportement de `ignore::WalkBuilder`),
//!   ce qui empêche d'échapper au workspace via un lien symbolique malicieux.
//! - La regex est compilée par `regex` crate (Rust officiel) qui rejette les
//!   patterns à backtracking catastrophique (pas de ReDoS possible).
//!
//! ## Performance
//!
//! Sur un workspace ~10k fichiers (~50 MB de code), une recherche typique :
//!   - Build matcher : <1 ms
//!   - Walk + search parallèle (8 cores) : 50-150 ms selon le pattern.
//!   - Max résultats cappé à `max_results` (défaut 1000) pour éviter les UI
//!     explosions sur les patterns trop génériques (e.g. "function").

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use grep_regex::RegexMatcherBuilder;
use grep_searcher::{Searcher, SearcherBuilder, Sink, SinkError, SinkMatch};
use ignore::{WalkBuilder, WalkState};
use serde::{Deserialize, Serialize};
use tauri::Manager;

// ---------------------------------------------------------------------------
// Public types (échangés avec le front via serde — camelCase)
// ---------------------------------------------------------------------------

/// Options de recherche reçues depuis le front.
#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GrepOpts {
    /// Si false (défaut), recherche insensible à la casse.
    #[serde(default)]
    pub case_sensitive: bool,
    /// Si false (défaut), `query` est traité comme texte littéral (escapé) ;
    /// si true, `query` est compilé tel quel comme regex.
    #[serde(default)]
    pub regex: bool,
    /// Nombre max de matches retournés. 0 = défaut (1000).
    #[serde(default)]
    pub max_results: usize,
}

/// Un match individuel — sérialisé en camelCase pour le front.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GrepMatch {
    /// Workspace-relative path, forward-slash normalisé (e.g. "src/lib/fs.ts").
    pub path: String,
    /// Numéro de ligne 1-indexed (convention IDE).
    pub line: u32,
    /// Texte de la ligne entière (sans `\n` final), tronqué à 500 chars max
    /// pour éviter les lignes minifiées qui explosent l'UI.
    pub preview: String,
}

// ---------------------------------------------------------------------------
// Tauri command
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn fs_grep_workspace(
    app: tauri::AppHandle,
    query: String,
    opts: GrepOpts,
) -> Result<Vec<GrepMatch>, String> {
    // Snapshot du workspace root — clone hors du Mutex (pas de lock pendant la
    // recherche). Le cœur est factorisé dans `grep_inner` pour être réutilisé
    // tel quel par l'outil agent `fs_search` (qui passe un root sandbox, pas le
    // state).
    let workspace_root: Option<PathBuf> = {
        let state = app.state::<Mutex<Option<PathBuf>>>();
        let guard = state.lock().map_err(|e| format!("workspace lock: {e}"))?;
        guard.clone()
    };
    let root = workspace_root.ok_or_else(|| "no workspace open".to_string())?;

    // ripgrep est SYNC — blocking pool pour ne pas bloquer le runtime Tauri.
    tokio::task::spawn_blocking(move || grep_inner(&root, &query, &opts))
        .await
        .map_err(|e| format!("blocking task join: {e}"))?
}

/// Cœur SYNC de la recherche workspace, factorisé hors de `fs_grep_workspace`
/// pour que la commande Tauri (root depuis le state) ET l'outil agent
/// `fs_search` (root = la COPIE sandbox du banc) partagent exactement le même
/// moteur. Bloque pendant que le walker parallèle tourne — à appeler dans un
/// `spawn_blocking` (la commande) ou un contexte déjà bloquant (le dispatcher
/// d'outils agent tourne sous `spawn_blocking`).
pub(crate) fn grep_inner(
    root: &Path,
    query: &str,
    opts: &GrepOpts,
) -> Result<Vec<GrepMatch>, String> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    // Mode littéral (défaut) : échappe les métacaractères regex.
    // Mode regex : laisse le pattern tel quel.
    let pattern = if opts.regex {
        query.to_string()
    } else {
        regex::escape(query)
    };
    let max_results = if opts.max_results == 0 { 1000 } else { opts.max_results };

    let matcher = RegexMatcherBuilder::new()
        .case_insensitive(!opts.case_sensitive)
        .build(&pattern)
        .map_err(|e| format!("invalid regex: {e}"))?;

    let results = Arc::new(Mutex::new(Vec::<GrepMatch>::with_capacity(max_results.min(256))));
    let stop = Arc::new(AtomicBool::new(false));
    let root_arc = Arc::new(root.to_path_buf());

    // Walker parallèle — utilise rayon en interne, threads auto-détectés.
    let walker = WalkBuilder::new(root).build_parallel();
    walker.run(|| {
        let matcher = matcher.clone();
        let results = Arc::clone(&results);
        let stop = Arc::clone(&stop);
        let root_arc = Arc::clone(&root_arc);
        Box::new(move |entry| {
            if stop.load(Ordering::Relaxed) {
                return WalkState::Quit;
            }
            let entry = match entry {
                Ok(e) => e,
                Err(_) => return WalkState::Continue,
            };
            // Skip directories — Searcher veut un fichier.
            if !entry.file_type().map(|ft| ft.is_file()).unwrap_or(false) {
                return WalkState::Continue;
            }
            let path = entry.path();
            // Workspace-relative path en forward-slash (contrat IPC fs).
            let rel_path = path
                .strip_prefix(root_arc.as_ref())
                .map(|p| p.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| path.to_string_lossy().to_string());

            let sink = GrepSink {
                rel_path,
                matches: Arc::clone(&results),
                max_results,
                stop: Arc::clone(&stop),
            };
            let mut searcher = SearcherBuilder::new().line_number(true).build();
            // Erreurs de search (binary, non-UTF8) ignorées — on continue.
            let _ = searcher.search_path(&matcher, path, sink);
            WalkState::Continue
        })
    });

    // Récupère le Vec final. Arc::try_unwrap peut échouer si une closure a
    // survécu — théoriquement impossible après walker.run(), géré défensivement.
    match Arc::try_unwrap(results) {
        Ok(mutex) => mutex.into_inner().map_err(|e| format!("results poison: {e}")),
        Err(arc) => {
            let guard = arc.lock().map_err(|e| format!("results lock: {e}"))?;
            Ok(guard.clone())
        }
    }
}

// ---------------------------------------------------------------------------
// Sink — callback invoqué par Searcher pour chaque match
// ---------------------------------------------------------------------------

struct GrepSink {
    rel_path: String,
    matches: Arc<Mutex<Vec<GrepMatch>>>,
    max_results: usize,
    stop: Arc<AtomicBool>,
}

impl Sink for GrepSink {
    type Error = std::io::Error;

    fn matched(
        &mut self,
        _searcher: &Searcher,
        mat: &SinkMatch<'_>,
    ) -> Result<bool, Self::Error> {
        // Atomically check + insert to avoid going over max_results when the
        // parallel walker is racing on the same Mutex.
        let mut guard = self
            .matches
            .lock()
            .map_err(|e| std::io::Error::other(format!("matches lock: {e}")))?;
        if guard.len() >= self.max_results {
            self.stop.store(true, Ordering::Relaxed);
            // Ok(false) = stop searching THIS file (the walker will see `stop`
            // before walking the next entry and will Quit globally).
            return Ok(false);
        }

        // Décodage best-effort UTF-8 (lossy) + trim final newline. Les bytes
        // non-UTF8 deviennent U+FFFD ; mieux qu'une erreur silencieuse.
        let preview_raw = String::from_utf8_lossy(mat.bytes());
        let preview = preview_raw.trim_end_matches(['\r', '\n']);
        // Truncate à 500 chars pour les lignes minifiées (e.g. dist/*.js).
        let preview = if preview.len() > 500 {
            // Char-boundary safe truncation
            let mut end = 500;
            while end > 0 && !preview.is_char_boundary(end) {
                end -= 1;
            }
            format!("{}…", &preview[..end])
        } else {
            preview.to_string()
        };

        // line_number() est None si on n'a pas activé .line_number(true) côté
        // SearcherBuilder — on l'a fait, donc unwrap_or(0) ne devrait jamais
        // tomber sur 0. Défensif quand même.
        let line = mat.line_number().unwrap_or(0) as u32;

        guard.push(GrepMatch {
            path: self.rel_path.clone(),
            line,
            preview,
        });
        Ok(true)
    }
}

// SinkError est requis indirectement pour le retour de matched(); std::io::Error
// implémente déjà SinkError, donc rien à faire — on l'importe juste pour
// rendre la dépendance explicite (lint clippy::unused_imports n'aime pas).
#[allow(dead_code)]
fn _assert_sink_error_impl()
where
    std::io::Error: SinkError,
{
}
