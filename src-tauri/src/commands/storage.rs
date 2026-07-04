//! Lane OPÉRABILITÉ — Storage Center : ventilation des tailles sur disque.
//!
//! Module autonome. Calcule la taille des grands postes de stockage de Shugu
//! pour que l'utilisateur voie d'où vient l'espace consommé (et puisse décider
//! quoi nettoyer via les commandes worktree existantes). Aucune mutation : on
//! ne fait que MESURER.
//!
//! Catégories mesurées :
//!   - `worktrees`   : `<workspace>/.shugu/worktrees` (les worktrees d'agent).
//!   - `target`      : le dossier de build Rust partagé (`CARGO_TARGET_DIR` si
//!                     défini, sinon `<workspace>/src-tauri/target` puis
//!                     `<workspace>/target`).
//!   - `logs`        : `<workspace>/.shugu/logs` + le dossier de logs app.
//!   - `vector`      : taille du fichier `shugu.db` + ses sidecars `-wal`/`-shm`
//!                     (l'index vectoriel sqlite-vec vit DANS shugu.db).
//!   - `embeddings`  : cache des modèles fastembed
//!                     (`app_local_data_dir()/fastembed_cache` et variantes).
//!   - `nodeModules` : `<workspace>/node_modules` (souvent énorme).
//!   - `appConfig`   : `app_config_dir()` (base + backups internes).
//!
//! Chaque poste renvoie `present` (le chemin existe), `bytes`, et `path`. Une
//! catégorie absente renvoie `present=false`, `bytes=0` — jamais une erreur :
//! le breakdown est best-effort par conception (un poste illisible ne casse
//! pas tout le rapport).

use std::path::{Path, PathBuf};

use serde::Serialize;
use tauri::{command, AppHandle, Manager};

// ---------------------------------------------------------------------------
// Modèle
// ---------------------------------------------------------------------------

/// Un poste de stockage mesuré.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageItem {
    /// Identifiant stable (clé pour l'UI) : "worktrees", "target", etc.
    pub key: String,
    /// Libellé lisible.
    pub label: String,
    /// Le chemin existe sur disque.
    pub present: bool,
    /// Taille récursive en octets (0 si absent / illisible).
    pub bytes: u64,
    /// Chemin mesuré (forward-slash). Vide si non résolu.
    pub path: String,
    /// Note explicative courte (ce que c'est, est-ce sûr de le supprimer).
    pub hint: String,
}

/// Rapport complet de stockage.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageBreakdown {
    /// Un workspace est-il ouvert ? Sinon les postes workspace sont vides.
    pub has_workspace: bool,
    /// Racine du workspace (forward-slash), si ouverte.
    pub workspace_root: Option<String>,
    /// Total des octets de tous les postes présents.
    pub total_bytes: u64,
    /// Les postes, ordre d'affichage = ordre du vec.
    pub items: Vec<StorageItem>,
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Strip du préfixe Windows extended-length (`\\?\`) : helper CENTRAL
// (ex-copie locale migrée).
use super::pathutil::strip_extended_prefix;

fn norm(p: &Path) -> String {
    strip_extended_prefix(p.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
}

/// Taille récursive d'un dossier OU d'un fichier. Symlinks non suivis ; entrées
/// illisibles ignorées (un glitch de permission ne fait jamais échouer).
fn path_size_bytes(path: &Path) -> u64 {
    if path.is_file() {
        return std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    }
    if !path.is_dir() {
        return 0;
    }
    let mut total: u64 = 0;
    for entry in walkdir::WalkDir::new(path)
        .follow_links(false)
        .into_iter()
        .filter_map(|e| e.ok())
    {
        if entry.file_type().is_file() {
            if let Ok(meta) = entry.metadata() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

fn workspace_root(app: &AppHandle) -> Option<PathBuf> {
    let st = app.state::<std::sync::Mutex<Option<PathBuf>>>();
    let guard = st.lock().ok()?;
    guard.clone()
}

/// Construit un `StorageItem` en mesurant `path` (peut être un fichier).
fn measure(key: &str, label: &str, hint: &str, path: PathBuf) -> StorageItem {
    let present = path.exists();
    let bytes = if present { path_size_bytes(&path) } else { 0 };
    StorageItem {
        key: key.to_string(),
        label: label.to_string(),
        present,
        bytes,
        path: norm(&path),
        hint: hint.to_string(),
    }
}

/// Mesure agrégée de plusieurs chemins candidats sous une seule clé : on prend
/// le PREMIER qui existe (utile quand un poste a plusieurs emplacements
/// possibles, par ex. `target` selon `CARGO_TARGET_DIR`). Si aucun n'existe,
/// renvoie un item absent pointant sur le premier candidat (pour info).
fn measure_first_present(
    key: &str,
    label: &str,
    hint: &str,
    candidates: Vec<PathBuf>,
) -> StorageItem {
    for c in &candidates {
        if c.exists() {
            return measure(key, label, hint, c.clone());
        }
    }
    let fallback = candidates.into_iter().next().unwrap_or_default();
    StorageItem {
        key: key.to_string(),
        label: label.to_string(),
        present: false,
        bytes: 0,
        path: norm(&fallback),
        hint: hint.to_string(),
    }
}

// ---------------------------------------------------------------------------
// Commande
// ---------------------------------------------------------------------------

/// Ventile la taille des grands postes de stockage de Shugu.
///
/// Mesure best-effort : un poste illisible renvoie 0 sans casser le rapport.
/// Les postes liés au workspace sont vides si aucun workspace n'est ouvert.
#[command(rename_all = "camelCase")]
pub async fn shugu_storage_breakdown(app: AppHandle) -> Result<StorageBreakdown, String> {
    let ws = workspace_root(&app);
    let mut items: Vec<StorageItem> = Vec::new();

    // Postes liés au workspace.
    if let Some(root) = &ws {
        let shugu = root.join(".shugu");
        items.push(measure(
            "worktrees",
            "Worktrees d'agent",
            "Copies de travail isolées par run. Nettoyables via l'onglet Git / le service worktree.",
            shugu.join("worktrees"),
        ));

        // target : CARGO_TARGET_DIR > src-tauri/target > target.
        let mut target_candidates: Vec<PathBuf> = Vec::new();
        if let Some(custom) = std::env::var_os("CARGO_TARGET_DIR") {
            target_candidates.push(PathBuf::from(custom));
        }
        target_candidates.push(root.join("src-tauri").join("target"));
        target_candidates.push(root.join("target"));
        items.push(measure_first_present(
            "target",
            "Build Rust (target)",
            "Artefacts de compilation Rust. Régénérables : sûr à supprimer (un rebuild les recrée).",
            target_candidates,
        ));

        items.push(measure(
            "logs",
            "Logs Shugu",
            "Journaux de dev/exécution. Sûr à supprimer.",
            shugu.join("logs"),
        ));

        items.push(measure(
            "nodeModules",
            "node_modules",
            "Dépendances frontend. Régénérables via le gestionnaire de paquets.",
            root.join("node_modules"),
        ));
    }

    // Postes liés au workspace : snippets d'éditeur (créations utilisateur).
    if let Some(root) = &ws {
        items.push(measure(
            "snippets",
            "Snippets d'éditeur",
            "Extraits de code que tu as ouverts dans l'éditeur. Jamais supprimés automatiquement.",
            root.join(".shugu-snippets"),
        ));
    }

    // Postes liés à l'app (indépendants du workspace).
    // shugu.db + sidecars WAL/SHM (l'index vectoriel sqlite-vec vit DEDANS).
    if let Ok(cfg) = app.path().app_config_dir() {
        let db = cfg.join("shugu.db");
        let mut vec_bytes = path_size_bytes(&db);
        for ext in ["-wal", "-shm"] {
            let side = PathBuf::from(format!("{}{ext}", db.to_string_lossy()));
            vec_bytes = vec_bytes.saturating_add(path_size_bytes(&side));
        }
        items.push(StorageItem {
            key: "vector".to_string(),
            label: "Base + index vectoriel".to_string(),
            present: db.exists(),
            bytes: vec_bytes,
            path: norm(&db),
            hint: "Source de vérité (conversations, agents, settings) + index sémantique. NE PAS supprimer.".to_string(),
        });

        // Backups internes : poste SÉPARÉ (avant, ils étaient noyés dans
        // appConfig et la base y était comptée DEUX fois).
        items.push(measure(
            "backups",
            "Sauvegardes internes",
            "Copies de sécurité prises avant chaque migration. Les 2 plus récentes sont gardées automatiquement.",
            cfg.join("backups"),
        ));

        // appConfig = le RESTE du dossier de config (settings exportés, presets…),
        // base et backups exclus pour ne compter chaque octet qu'une fois.
        let mut cfg_rest: u64 = 0;
        if let Ok(entries) = std::fs::read_dir(&cfg) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_string();
                if name == "backups" || name.starts_with("shugu.db") {
                    continue;
                }
                cfg_rest = cfg_rest.saturating_add(path_size_bytes(&e.path()));
            }
        }
        items.push(StorageItem {
            key: "appConfig".to_string(),
            label: "Config app".to_string(),
            present: cfg.exists(),
            bytes: cfg_rest,
            path: norm(&cfg),
            hint: "Configuration de l'app (hors base et sauvegardes, comptées à part).".to_string(),
        });
    }

    // Médias générés + artefacts techniques (app_data_dir) — le trou de la
    // v1 du breakdown : ces dossiers grossissaient sans être ni mesurés ni
    // purgés (vidéos MiniMax, captures d'écran d'agents…).
    if let Ok(data) = app.path().app_data_dir() {
        items.push(measure(
            "videoAssets",
            "Vidéos générées",
            "Tes créations du Studio. Jamais supprimées automatiquement.",
            data.join("video-assets"),
        ));
        items.push(measure(
            "musicAssets",
            "Musiques générées",
            "Tes créations du Studio. Jamais supprimées automatiquement.",
            data.join("music-assets"),
        ));
        items.push(measure(
            "imageAssets",
            "Images générées",
            "Tes créations du Studio. Jamais supprimées automatiquement.",
            data.join("image-assets"),
        ));
        items.push(measure(
            "captures",
            "Captures d'écran d'agents",
            "Captures techniques prises par les agents. Purgées automatiquement après 7 jours.",
            data.join("captures"),
        ));
        items.push(measure(
            "browserTests",
            "Artefacts de tests navigateur",
            "Captures et traces des tests de pages web. Purgés automatiquement après 7 jours.",
            data.join("browser-tests"),
        ));
    }

    // Cache des embeddings fastembed (sous app_local_data_dir, plusieurs noms
    // possibles selon la version de la crate) + modèles GGUF locaux (poste
    // séparé : 1,2 Go de Qwen n'a rien à faire caché derrière « embeddings »).
    if let Ok(local) = app.path().app_local_data_dir() {
        let candidates = vec![
            local.join("fastembed_cache"),
            local.join(".fastembed_cache"),
        ];
        items.push(measure_first_present(
            "embeddings",
            "Modèles d'embeddings",
            "Modèles fastembed téléchargés pour la recherche sémantique. Re-téléchargés au besoin.",
            candidates,
        ));
        items.push(measure(
            "models",
            "Modèles IA locaux",
            "Modèles téléchargés pour l'IA locale (GGUF). Gérables dans Réglages → Modèles ; re-téléchargeables.",
            local.join("models"),
        ));
    }

    let total_bytes = items
        .iter()
        .filter(|i| i.present)
        .fold(0u64, |acc, i| acc.saturating_add(i.bytes));

    Ok(StorageBreakdown {
        has_workspace: ws.is_some(),
        workspace_root: ws.as_deref().map(norm),
        total_bytes,
        items,
    })
}

// ---------------------------------------------------------------------------
// Nettoyage — commande allowlistée + rétention automatique de boot
// ---------------------------------------------------------------------------

/// Résultat d'un nettoyage de zone, renvoyé à l'UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    /// Octets libérés (taille mesurée AVANT suppression).
    pub freed_bytes: u64,
    /// Nombre d'entrées de premier niveau supprimées.
    pub deleted_count: usize,
}

/// Vide le CONTENU de `dir` (fichiers + sous-dossiers de premier niveau), en
/// gardant le dossier lui-même. Best-effort : une entrée verrouillée est
/// loggée et sautée, jamais d'échec global.
fn clear_dir_contents(dir: &Path) -> CleanupResult {
    let freed_bytes = path_size_bytes(dir);
    let mut deleted_count = 0usize;
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let p = e.path();
            let res = if p.is_dir() {
                std::fs::remove_dir_all(&p)
            } else {
                std::fs::remove_file(&p)
            };
            match res {
                Ok(()) => deleted_count += 1,
                Err(err) => eprintln!("[storage] nettoyage {} : {err}", p.display()),
            }
        }
    }
    CleanupResult {
        freed_bytes,
        deleted_count,
    }
}

/// Nettoie UNE zone de stockage, identifiée par sa clé du breakdown.
///
/// Allowlist STRICTE — c'est la seule protection entre un clic UI et un
/// `remove_dir_all` : aucune zone hors de cette liste n'est touchable, et la
/// résolution du chemin est refaite ICI (jamais un chemin venu du front).
/// Les zones « créations utilisateur » (vidéos, musiques, images, snippets)
/// sont nettoyables UNIQUEMENT via ce bouton — l'UI DOIT confirmer avant.
/// Les modèles IA locaux passent par `model_bundle_delete` (système existant),
/// et la base (`vector`) n'est volontairement PAS nettoyable.
#[command(rename_all = "camelCase")]
pub async fn shugu_storage_cleanup(app: AppHandle, zone: String) -> Result<CleanupResult, String> {
    match zone.as_str() {
        // Artefacts techniques.
        "captures" | "browserTests" => {
            let data = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("app_data_dir indisponible : {e}"))?;
            let sub = if zone == "captures" { "captures" } else { "browser-tests" };
            Ok(clear_dir_contents(&data.join(sub)))
        }
        "logs" => {
            let root = workspace_root(&app).ok_or("aucun workspace ouvert")?;
            Ok(clear_dir_contents(&root.join(".shugu").join("logs")))
        }
        // Backups automatiques : on garde LE plus récent (filet), on purge le reste.
        "backups" => {
            let before = app
                .path()
                .app_config_dir()
                .map(|cfg| path_size_bytes(&cfg.join("backups")))
                .unwrap_or(0);
            let removed = super::backup::prune_auto_backups(&app, 1);
            let after = app
                .path()
                .app_config_dir()
                .map(|cfg| path_size_bytes(&cfg.join("backups")))
                .unwrap_or(0);
            Ok(CleanupResult {
                freed_bytes: before.saturating_sub(after),
                deleted_count: removed,
            })
        }
        // Créations utilisateur — l'UI confirme avant d'appeler.
        "videoAssets" | "musicAssets" | "imageAssets" => {
            let data = app
                .path()
                .app_data_dir()
                .map_err(|e| format!("app_data_dir indisponible : {e}"))?;
            let sub = match zone.as_str() {
                "videoAssets" => "video-assets",
                "musicAssets" => "music-assets",
                _ => "image-assets",
            };
            Ok(clear_dir_contents(&data.join(sub)))
        }
        "snippets" => {
            let root = workspace_root(&app).ok_or("aucun workspace ouvert")?;
            Ok(clear_dir_contents(&root.join(".shugu-snippets")))
        }
        other => Err(format!("zone de nettoyage inconnue : {other}")),
    }
}

/// Durée de vie des artefacts TECHNIQUES (captures d'agents, tests
/// navigateur). 7 jours = aligné sur la purge des miniatures de screenshots en
/// base (agents/mod.rs). Les créations utilisateur n'ont JAMAIS de TTL.
const TECH_ARTIFACT_TTL_MS: u128 = 7 * 24 * 60 * 60 * 1000;

/// Supprime les entrées de premier niveau de `dir` plus vieilles que `ttl_ms`
/// (mtime). Renvoie le nombre d'entrées supprimées.
fn prune_older_than(dir: &Path, ttl_ms: u128) -> usize {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    let now = std::time::SystemTime::now();
    let mut removed = 0usize;
    for e in entries.flatten() {
        let p = e.path();
        let old_enough = e
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|mtime| now.duration_since(mtime).ok())
            .map(|age| age.as_millis() > ttl_ms)
            .unwrap_or(false); // mtime illisible → on ne supprime PAS
        if !old_enough {
            continue;
        }
        let res = if p.is_dir() {
            std::fs::remove_dir_all(&p)
        } else {
            std::fs::remove_file(&p)
        };
        match res {
            Ok(()) => removed += 1,
            Err(err) => eprintln!("[storage] TTL {} : {err}", p.display()),
        }
    }
    removed
}

/// Rétention automatique de boot : purge les artefacts techniques de plus de
/// 7 jours. Appelée depuis la tâche de maintenance de `lib.rs::setup`.
/// Best-effort, ne touche JAMAIS aux créations utilisateur.
pub fn boot_retention(app: &AppHandle) {
    let Ok(data) = app.path().app_data_dir() else {
        return;
    };
    let mut removed = 0usize;
    removed += prune_older_than(&data.join("captures"), TECH_ARTIFACT_TTL_MS);
    removed += prune_older_than(&data.join("browser-tests"), TECH_ARTIFACT_TTL_MS);
    if removed > 0 {
        eprintln!("[storage] rétention 7 j : {removed} artefact(s) technique(s) supprimé(s)");
    }
}

// ---------------------------------------------------------------------------
// Garde-fou anti-Codex — taille de la base, en un stat (pas un walk)
// ---------------------------------------------------------------------------

/// Seuil d'alerte UI sur la taille de `shugu.db`. Une base saine tient sous
/// ~50 Mo après purge/VACUUM ; 300 Mo ≈ 10× la normale — assez de marge pour
/// ne jamais crier au loup, assez tôt pour agir avant le point où l'incident
/// Codex (crash au-delà de ~200 Mo de logs SQLite) devient un précédent.
const DB_ALERT_THRESHOLD_BYTES: u64 = 300 * 1024 * 1024;

/// Taille instantanée de la base, pour le bandeau d'alerte au boot.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSizeReport {
    /// Taille de `shugu.db` (octets).
    pub bytes: u64,
    /// Taille du sidecar `-wal` (octets) — un WAL énorme = checkpoint en panne.
    pub wal_bytes: u64,
    /// Seuil au-delà duquel l'UI doit alerter (constante Rust, source unique).
    pub alert_threshold_bytes: u64,
}

/// Taille de `shugu.db` + son WAL en DEUX stats de fichier — instantané,
/// appelable à chaque boot (contrairement au breakdown complet, qui walke
/// node_modules et compte en secondes).
#[command(rename_all = "camelCase")]
pub async fn shugu_db_size(app: AppHandle) -> Result<DbSizeReport, String> {
    let cfg = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir indisponible : {e}"))?;
    let db = cfg.join("shugu.db");
    let file_len = |p: &Path| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
    Ok(DbSizeReport {
        bytes: file_len(&db),
        wal_bytes: file_len(&PathBuf::from(format!("{}-wal", db.to_string_lossy()))),
        alert_threshold_bytes: DB_ALERT_THRESHOLD_BYTES,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let n = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let p = std::env::temp_dir().join(format!("shugu_storage_test_{tag}_{n}"));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn path_size_counts_files_recursively() {
        let dir = temp_dir("size");
        std::fs::write(dir.join("a.txt"), b"hello").unwrap();
        let sub = dir.join("sub");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("b.txt"), b"world!!").unwrap();
        // 5 + 7 = 12 bytes.
        assert_eq!(path_size_bytes(&dir), 12);
        // Single file path.
        assert_eq!(path_size_bytes(&dir.join("a.txt")), 5);
        // Missing path → 0.
        assert_eq!(path_size_bytes(&dir.join("nope")), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn clear_dir_contents_empties_but_keeps_dir() {
        let dir = temp_dir("clear");
        std::fs::write(dir.join("a.mp4"), vec![0u8; 100]).unwrap();
        let sub = dir.join("nested");
        std::fs::create_dir_all(&sub).unwrap();
        std::fs::write(sub.join("b.jpg"), vec![0u8; 50]).unwrap();

        let res = clear_dir_contents(&dir);
        assert_eq!(res.freed_bytes, 150);
        assert_eq!(res.deleted_count, 2, "a.mp4 + nested/ (premier niveau)");
        assert!(dir.exists(), "le dossier racine survit");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);

        // Dossier absent : zéro partout, pas d'erreur.
        let absent = clear_dir_contents(&dir.join("nope"));
        assert_eq!((absent.freed_bytes, absent.deleted_count), (0, 0));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn prune_older_than_respects_mtime() {
        let dir = temp_dir("ttl");
        std::fs::write(dir.join("vieux.jpg"), b"x").unwrap();
        std::fs::write(dir.join("recent.jpg"), b"y").unwrap();
        // Vieillit artificiellement `vieux.jpg` : mtime à l'époque 0 via
        // filetime ? Pas de crate — on passe par un TTL de 0 ms pour « tout est
        // vieux » et un TTL énorme pour « rien n'est vieux ».
        assert_eq!(prune_older_than(&dir, u128::MAX), 0, "TTL infini → rien");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
        // Les fichiers viennent d'être créés : âge > 0 ms dès le prochain tick.
        std::thread::sleep(std::time::Duration::from_millis(15));
        assert_eq!(prune_older_than(&dir, 0), 2, "TTL 0 → tout part");
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn measure_first_present_picks_existing() {
        let dir = temp_dir("first");
        let missing = dir.join("missing");
        let real = dir.join("real");
        std::fs::create_dir_all(&real).unwrap();
        std::fs::write(real.join("f"), b"xyz").unwrap();
        let item = measure_first_present(
            "k",
            "L",
            "h",
            vec![missing.clone(), real.clone()],
        );
        assert!(item.present);
        assert_eq!(item.bytes, 3);
        assert!(item.path.ends_with("/real"));
        // None present → absent item pointing at first candidate.
        let absent = measure_first_present("k", "L", "h", vec![missing.clone()]);
        assert!(!absent.present);
        assert_eq!(absent.bytes, 0);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
