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

fn strip_extended_prefix(p: PathBuf) -> PathBuf {
    if cfg!(windows) {
        let s = p.to_string_lossy();
        let stripped = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            format!(r"\\{rest}")
        } else if let Some(rest) = s.strip_prefix(r"\\?\") {
            rest.to_string()
        } else {
            return p;
        };
        PathBuf::from(stripped)
    } else {
        p
    }
}

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

        items.push(measure(
            "appConfig",
            "Config app + backups",
            "Dossier de configuration de l'app, incluant les sauvegardes internes (backups/).",
            cfg.clone(),
        ));
    }

    // Cache des embeddings fastembed (sous app_local_data_dir, plusieurs noms
    // possibles selon la version de la crate).
    if let Ok(local) = app.path().app_local_data_dir() {
        let candidates = vec![
            local.join("fastembed_cache"),
            local.join(".fastembed_cache"),
            local.join("models"),
        ];
        items.push(measure_first_present(
            "embeddings",
            "Modèles d'embeddings",
            "Modèles fastembed téléchargés pour la recherche sémantique. Re-téléchargés au besoin.",
            candidates,
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
