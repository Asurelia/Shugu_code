//! Lane OPÉRABILITÉ — backup / restore atomique des données Shugu.
//!
//! Ce module est **autonome** : il n'altère aucune logique existante. Il
//! n'expose que des commandes nouvelles (enregistrées en APPEND dans `lib.rs`)
//! plus un point d'entrée runtime `auto_backup_before_migration` appelé depuis
//! le `setup` de `lib.rs`.
//!
//! ## Ce qui est sauvegardé
//!
//! La source de vérité de Shugu est `shugu.db` (SQLite, dans
//! `app_config_dir()`), qui contient AUSSI la table `settings` (clés/valeurs
//! non secrètes : workspace_root, préférences…). Les secrets (clés API, env
//! MCP) vivent dans le keychain OS — ils ne sont JAMAIS écrits dans un backup
//! (par conception : un backup déposé sur disque ne doit pas fuiter de secret).
//!
//! Un « bundle de backup » est donc un DOSSIER contenant :
//!   - `shugu.db`            : copie ATOMIQUE et cohérente de la base (VACUUM INTO).
//!   - `settings.json`       : export lisible de la table `settings` (redondant
//!                             avec la base, mais utile pour inspection / restore
//!                             sélectif côté humain).
//!   - `manifest.json`       : métadonnées (version d'app, horodatage, taille,
//!                             nombre de tables, version de schéma).
//!
//! ## Copie ATOMIQUE
//!
//! On n'utilise PAS un simple `std::fs::copy` de `shugu.db` : la base est en
//! mode WAL et ouverte par le pool sqlx du plugin → un copy brut peut capturer
//! un état incohérent (pages en vol dans le `-wal`). On utilise donc
//! `VACUUM INTO '<dest>'` : SQLite écrit un snapshot propre, défragmenté et
//! transactionnellement cohérent de la base vivante dans un nouveau fichier,
//! sans nécessiter l'arrêt de l'app. Disponible depuis SQLite 3.27 (la version
//! bundlée ici est ≥ 3.46). Aucune dépendance crate nouvelle.
//!
//! ## Backup automatique pré-migration
//!
//! `tauri-plugin-sql` applique les migrations lazily (au premier `db.load()`
//! côté front), pas au boot. Au `setup`, la base sur disque est donc ENCORE à
//! sa version précédente. `auto_backup_before_migration` lit `MAX(version)` de
//! la table `_sqlx_migrations` (créée par sqlx) ; si elle est en retard sur la
//! version cible (`TARGET_SCHEMA_VERSION`), un snapshot horodaté est déposé sous
//! `app_config_dir()/backups/pre-migration/` AVANT que le front ne déclenche la
//! migration. Best-effort : un échec n'empêche jamais le boot.

use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::{command, AppHandle, Manager};
use tauri_plugin_dialog::DialogExt;

// ---------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------

/// Version de schéma cible = nombre de migrations déclarées dans `lib.rs`.
/// Tenue À JOUR ici en miroir de la liste `migrations` de `run()`. Sert
/// uniquement à décider « une migration est-elle en attente ? » au boot.
/// Si la valeur sous-estime la réalité, on rate un backup pré-migration (sans
/// danger) ; si elle la sur-estime, on prend un backup superflu (sans danger).
pub const TARGET_SCHEMA_VERSION: i64 = 16;

/// Nom du fichier base dans un bundle.
const DB_FILE: &str = "shugu.db";
/// Nom du fichier settings exporté.
const SETTINGS_FILE: &str = "settings.json";
/// Nom du manifeste.
const MANIFEST_FILE: &str = "manifest.json";

// ---------------------------------------------------------------------------
// Modèles
// ---------------------------------------------------------------------------

/// Manifeste écrit dans chaque bundle, et relu au restore pour vérification.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupManifest {
    /// Marqueur de format (toujours "shugu-backup").
    pub format: String,
    /// Version du format de bundle (incrémentée si la disposition change).
    pub bundle_version: u32,
    /// Version de l'application au moment du backup.
    pub app_version: String,
    /// Horodatage de création, unix millis (UTC).
    pub created_at: i64,
    /// Taille de la base copiée, octets.
    pub db_bytes: u64,
    /// Version de schéma (MAX(version) de `_sqlx_migrations`) capturée.
    pub schema_version: Option<i64>,
    /// Nombre de tables utilisateur dans la base copiée.
    pub table_count: i64,
    /// `PRAGMA integrity_check` sur la copie a-t-il renvoyé "ok" ?
    pub integrity_ok: bool,
}

/// Résultat d'un export, renvoyé à l'UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    /// Dossier du bundle créé (forward-slash).
    pub bundle_dir: String,
    /// Le manifeste écrit.
    pub manifest: BackupManifest,
}

/// Résultat d'un import (restore), renvoyé à l'UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    /// Bundle dont on a restauré.
    pub bundle_dir: String,
    /// Manifeste lu dans le bundle.
    pub manifest: BackupManifest,
    /// Chemin du backup de sécurité de l'ANCIENNE base, pris juste avant le
    /// remplacement (pour rollback manuel si besoin). Forward-slash.
    pub safety_backup: String,
    /// `true` — un redémarrage de l'app est requis pour que le pool sqlx
    /// rouvre la nouvelle base. L'UI doit l'indiquer à l'utilisateur.
    pub restart_required: bool,
}

/// Résultat d'un check d'intégrité.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IntegrityReport {
    /// `true` si `PRAGMA integrity_check` renvoie exactement "ok".
    pub ok: bool,
    /// Les lignes renvoyées par le check (au plus 20, tronquées). "ok" si saine.
    pub messages: Vec<String>,
    /// `PRAGMA quick_check` côté foreign-keys : violations détectées (au plus 20).
    pub foreign_key_violations: Vec<String>,
    /// Taille de la base inspectée, octets.
    pub db_bytes: u64,
    /// Chemin de la base inspectée (forward-slash).
    pub db_path: String,
}

// ---------------------------------------------------------------------------
// Helpers chemins
// ---------------------------------------------------------------------------

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// Strip du préfixe Windows extended-length (`\\?\`) : helper CENTRAL
// (ex-copie locale migrée) — les chemins passent l'IPC proprement.
use super::pathutil::strip_extended_prefix;

fn norm(p: &Path) -> String {
    strip_extended_prefix(p.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
}

/// Chemin de la base vivante : `app_config_dir()/shugu.db` (le MÊME fichier que
/// tauri-plugin-sql et `vector.rs`).
pub fn live_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir indisponible : {e}"))?
        .join(DB_FILE))
}

/// Racine des backups gérés par l'app : `app_config_dir()/backups`.
fn backups_root(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| format!("app_config_dir indisponible : {e}"))?
        .join("backups"))
}

// ---------------------------------------------------------------------------
// Snapshot atomique de la base (VACUUM INTO)
// ---------------------------------------------------------------------------

/// Copie ATOMIQUE et cohérente de `src` (base SQLite vivante, mode WAL) vers
/// `dest`. Utilise `VACUUM INTO` qui écrit un snapshot transactionnellement
/// cohérent et défragmenté sans arrêter l'app. `dest` ne doit PAS exister
/// (VACUUM INTO refuse d'écraser) — on le supprime au préalable si présent.
fn snapshot_db(src: &Path, dest: &Path) -> Result<(), String> {
    if !src.exists() {
        return Err(format!("base introuvable : {}", src.display()));
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir backup dir : {e}"))?;
    }
    // VACUUM INTO échoue si la cible existe → on nettoie d'abord (la cible est
    // toujours un fichier de backup que NOUS gérons, jamais la base vivante).
    if dest.exists() {
        std::fs::remove_file(dest).map_err(|e| format!("clean dest : {e}"))?;
    }

    // Ouverture en lecture/écriture (VACUUM a besoin d'écrire le journal de la
    // source), mais aucune donnée de la source n'est modifiée par VACUUM INTO.
    let conn =
        Connection::open(src).map_err(|e| format!("ouverture base source {} : {e}", src.display()))?;
    // Le chemin destination doit être quoté en littéral SQL ; on échappe les
    // apostrophes pour éviter toute cassure de requête sur un chemin exotique.
    let dest_str = dest.to_string_lossy().replace('\'', "''");
    conn.execute_batch(&format!("VACUUM INTO '{dest_str}';"))
        .map_err(|e| format!("VACUUM INTO : {e}"))?;
    Ok(())
}

/// MAX(version) de `_sqlx_migrations` sur une base donnée. `None` si la table
/// n'existe pas (base jamais migrée par sqlx) ou base absente.
fn schema_version_of(db: &Path) -> Option<i64> {
    if !db.exists() {
        return None;
    }
    let conn = Connection::open(db).ok()?;
    // La table peut ne pas exister encore — on teste d'abord son existence.
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='_sqlx_migrations'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return None;
    }
    conn.query_row("SELECT MAX(version) FROM _sqlx_migrations", [], |r| r.get(0))
        .ok()
        .flatten()
}

/// Nombre de tables utilisateur (hors tables internes sqlite_/`_sqlx_`).
fn user_table_count(db: &Path) -> i64 {
    let Ok(conn) = Connection::open(db) else {
        return 0;
    };
    conn.query_row(
        "SELECT COUNT(*) FROM sqlite_master WHERE type='table' \
         AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_sqlx\\_%' ESCAPE '\\'",
        [],
        |r| r.get(0),
    )
    .unwrap_or(0)
}

/// `PRAGMA integrity_check` sur une base : `Ok(true)` ssi exactement "ok".
/// Renvoie aussi les messages bruts (tronqués) pour l'UI.
fn run_integrity_check(db: &Path) -> Result<(bool, Vec<String>), String> {
    let conn = Connection::open(db).map_err(|e| format!("ouverture {} : {e}", db.display()))?;
    let mut stmt = conn
        .prepare("PRAGMA integrity_check")
        .map_err(|e| format!("prepare integrity_check : {e}"))?;
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|e| format!("integrity_check : {e}"))?;
    let mut messages: Vec<String> = Vec::new();
    for r in rows {
        if let Ok(m) = r {
            messages.push(m);
        }
        if messages.len() >= 20 {
            break;
        }
    }
    let ok = messages.len() == 1 && messages[0] == "ok";
    Ok((ok, messages))
}

/// Résumé booléen de l'intégrité d'une base : `Ok(true)` ssi `integrity_check`
/// renvoie "ok". Exposé pour le module `diagnostics` (source unique de vérité).
pub fn integrity_summary(db: &Path) -> Result<bool, String> {
    run_integrity_check(db).map(|(ok, _)| ok)
}

/// `PRAGMA foreign_key_check` : violations de FK (au plus 20, formatées).
fn run_foreign_key_check(db: &Path) -> Vec<String> {
    let Ok(conn) = Connection::open(db) else {
        return Vec::new();
    };
    let Ok(mut stmt) = conn.prepare("PRAGMA foreign_key_check") else {
        return Vec::new();
    };
    // Colonnes : table, rowid, parent, fkid.
    let rows = stmt.query_map([], |row| {
        let table: String = row.get(0).unwrap_or_default();
        let rowid: Option<i64> = row.get(1).ok();
        let parent: String = row.get(2).unwrap_or_default();
        Ok(format!(
            "{table} (rowid={}) → {parent}",
            rowid.map(|v| v.to_string()).unwrap_or_else(|| "?".into())
        ))
    });
    let mut out = Vec::new();
    if let Ok(rows) = rows {
        for r in rows.flatten() {
            out.push(r);
            if out.len() >= 20 {
                break;
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// Export de la table `settings` (lisible humain)
// ---------------------------------------------------------------------------

/// Sérialise la table `settings` en JSON `{ key: value, ... }`. Best-effort :
/// si la table n'existe pas, renvoie un objet vide.
fn export_settings_json(db: &Path) -> Result<String, String> {
    let conn = Connection::open(db).map_err(|e| format!("ouverture {} : {e}", db.display()))?;
    let exists: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='settings'",
            [],
            |r| r.get(0),
        )
        .unwrap_or(0);
    if exists == 0 {
        return Ok("{}".to_string());
    }
    let mut stmt = conn
        .prepare("SELECT key, value FROM settings ORDER BY key")
        .map_err(|e| format!("prepare settings : {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|e| format!("query settings : {e}"))?;
    let mut map = serde_json::Map::new();
    for r in rows.flatten() {
        map.insert(r.0, serde_json::Value::String(r.1));
    }
    serde_json::to_string_pretty(&serde_json::Value::Object(map))
        .map_err(|e| format!("encode settings : {e}"))
}

// ---------------------------------------------------------------------------
// Construction d'un bundle dans un dossier donné
// ---------------------------------------------------------------------------

/// Écrit un bundle complet (db + settings + manifest) dans `bundle_dir`.
/// `bundle_dir` est créé s'il n'existe pas. Renvoie le manifeste écrit.
fn write_bundle(app: &AppHandle, bundle_dir: &Path) -> Result<BackupManifest, String> {
    let src = live_db_path(app)?;
    std::fs::create_dir_all(bundle_dir).map_err(|e| format!("mkdir bundle : {e}"))?;

    let dest_db = bundle_dir.join(DB_FILE);
    snapshot_db(&src, &dest_db)?;

    // Métadonnées calculées SUR LA COPIE (cohérente), pas sur la base vivante.
    let db_bytes = std::fs::metadata(&dest_db).map(|m| m.len()).unwrap_or(0);
    let schema_version = schema_version_of(&dest_db);
    let table_count = user_table_count(&dest_db);
    let (integrity_ok, _) = run_integrity_check(&dest_db).unwrap_or((false, Vec::new()));

    // settings.json (lisible).
    let settings = export_settings_json(&dest_db)?;
    std::fs::write(bundle_dir.join(SETTINGS_FILE), settings.as_bytes())
        .map_err(|e| format!("write settings.json : {e}"))?;

    let manifest = BackupManifest {
        format: "shugu-backup".to_string(),
        bundle_version: 1,
        app_version: app.package_info().version.to_string(),
        created_at: now_millis(),
        db_bytes,
        schema_version,
        table_count,
        integrity_ok,
    };
    let manifest_json =
        serde_json::to_string_pretty(&manifest).map_err(|e| format!("encode manifest : {e}"))?;
    std::fs::write(bundle_dir.join(MANIFEST_FILE), manifest_json.as_bytes())
        .map_err(|e| format!("write manifest.json : {e}"))?;

    Ok(manifest)
}

// ---------------------------------------------------------------------------
// Backup automatique pré-migration (appelé depuis lib.rs::setup)
// ---------------------------------------------------------------------------

/// Si la base sur disque est en retard sur `TARGET_SCHEMA_VERSION`, dépose un
/// snapshot horodaté sous `backups/pre-migration/` AVANT que le front ne
/// déclenche la migration. Best-effort : toute erreur est loggée et avalée
/// (jamais de crash au boot). Renvoie `Some(chemin)` si un backup a été pris.
pub fn auto_backup_before_migration(app: &AppHandle) -> Option<PathBuf> {
    let src = match live_db_path(app) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[backup] pré-migration: chemin base indisponible: {e}");
            return None;
        }
    };
    // Pas de base = installation fraîche = rien à sauvegarder.
    if !src.exists() {
        return None;
    }
    let current = schema_version_of(&src);
    // `None` = base présente mais jamais migrée par sqlx (par ex. créée par un
    // outil tiers) ; on NE prend pas de backup pré-migration dans ce cas car il
    // n'y a pas de schéma versionné à protéger. Si `current < target`, migration
    // en attente → on protège.
    let needs = matches!(current, Some(v) if v < TARGET_SCHEMA_VERSION);
    if !needs {
        return None;
    }

    let from = current.map(|v| v.to_string()).unwrap_or_else(|| "?".into());
    let dir = match backups_root(app) {
        Ok(r) => r
            .join("pre-migration")
            .join(format!("v{from}-to-v{TARGET_SCHEMA_VERSION}-{}", now_millis())),
        Err(e) => {
            eprintln!("[backup] pré-migration: racine backups indisponible: {e}");
            return None;
        }
    };
    match write_bundle(app, &dir) {
        Ok(m) => {
            eprintln!(
                "[backup] snapshot pré-migration v{from}→v{TARGET_SCHEMA_VERSION} → {} ({} octets, integrity_ok={})",
                dir.display(),
                m.db_bytes,
                m.integrity_ok
            );
            Some(dir)
        }
        Err(e) => {
            eprintln!("[backup] pré-migration échouée (boot continue): {e}");
            None
        }
    }
}

// ---------------------------------------------------------------------------
// Commandes Tauri
// ---------------------------------------------------------------------------

/// Exporte un bundle de backup vers un dossier choisi par l'utilisateur.
///
/// Si `dest_dir` est fourni (chemin absolu d'un dossier), le bundle y est créé.
/// Sinon, un sélecteur de dossier natif s'ouvre. Le bundle est un sous-dossier
/// horodaté `shugu-backup-<millis>/` du dossier choisi, pour ne jamais écraser
/// un export précédent. Renvoie `Ok(None)` si l'utilisateur annule le dialog.
#[command(rename_all = "camelCase")]
pub async fn shugu_export_data(
    app: AppHandle,
    dest_dir: Option<String>,
) -> Result<Option<ExportResult>, String> {
    // Résolution du dossier parent : argument explicite OU sélecteur natif.
    let parent: PathBuf = match dest_dir {
        Some(d) if !d.trim().is_empty() => {
            let p = PathBuf::from(d.trim());
            if !p.is_dir() {
                return Err(format!("dossier de destination introuvable : {}", p.display()));
            }
            p
        }
        _ => {
            let picked = app
                .dialog()
                .file()
                .set_title("Choisir le dossier de sauvegarde")
                .blocking_pick_folder();
            match picked {
                Some(fp) => fp
                    .into_path()
                    .map_err(|e| format!("chemin dialog invalide : {e}"))?,
                None => return Ok(None), // annulé
            }
        }
    };

    let bundle_dir = parent.join(format!("shugu-backup-{}", now_millis()));
    let manifest = write_bundle(&app, &bundle_dir)?;
    Ok(Some(ExportResult {
        bundle_dir: norm(&bundle_dir),
        manifest,
    }))
}

/// Importe (restaure) un bundle de backup, remplaçant la base vivante.
///
/// Si `bundle_dir` est fourni, on y lit le bundle ; sinon un sélecteur de
/// dossier s'ouvre (l'utilisateur pointe le dossier `shugu-backup-*`). Avant
/// de remplacer, on prend un backup de sécurité de l'ANCIENNE base sous
/// `backups/pre-restore/`. La base copiée est d'abord VÉRIFIÉE
/// (`integrity_check`) ; un bundle corrompu est refusé sans toucher à la base
/// vivante. Le pool sqlx tient encore l'ancien fichier ouvert → un REDÉMARRAGE
/// est requis (drapeau `restart_required`). Renvoie `Ok(None)` si annulé.
#[command(rename_all = "camelCase")]
pub async fn shugu_import_data(
    app: AppHandle,
    bundle_dir: Option<String>,
) -> Result<Option<ImportResult>, String> {
    let dir: PathBuf = match bundle_dir {
        Some(d) if !d.trim().is_empty() => {
            let p = PathBuf::from(d.trim());
            if !p.is_dir() {
                return Err(format!("bundle introuvable : {}", p.display()));
            }
            p
        }
        _ => {
            let picked = app
                .dialog()
                .file()
                .set_title("Choisir le dossier de sauvegarde à restaurer")
                .blocking_pick_folder();
            match picked {
                Some(fp) => fp
                    .into_path()
                    .map_err(|e| format!("chemin dialog invalide : {e}"))?,
                None => return Ok(None),
            }
        }
    };

    // 1. Vérifier le manifeste + la présence de la base dans le bundle.
    let manifest_path = dir.join(MANIFEST_FILE);
    let manifest_bytes = std::fs::read(&manifest_path)
        .map_err(|e| format!("manifest.json illisible ({}) : {e}", manifest_path.display()))?;
    let manifest: BackupManifest = serde_json::from_slice(&manifest_bytes)
        .map_err(|e| format!("manifest.json invalide : {e}"))?;
    if manifest.format != "shugu-backup" {
        return Err(format!(
            "format de bundle inattendu : « {} »",
            manifest.format
        ));
    }
    let bundle_db = dir.join(DB_FILE);
    if !bundle_db.is_file() {
        return Err(format!(
            "base absente du bundle : {}",
            bundle_db.display()
        ));
    }

    // 2. Vérifier l'intégrité de la base DU BUNDLE avant de risquer un remplacement.
    let (ok, messages) = run_integrity_check(&bundle_db)?;
    if !ok {
        return Err(format!(
            "base du bundle corrompue (integrity_check) — restore refusé : {}",
            messages.join("; ")
        ));
    }

    let live = live_db_path(&app)?;

    // 3. Backup de sécurité de l'ANCIENNE base (si présente) avant remplacement.
    let safety_dir = backups_root(&app)?
        .join("pre-restore")
        .join(format!("{}", now_millis()));
    if live.exists() {
        // On snapshot l'ancienne base (atomique) plutôt qu'un copy brut.
        let safety_db = safety_dir.join(DB_FILE);
        snapshot_db(&live, &safety_db)?;
    } else {
        std::fs::create_dir_all(&safety_dir).map_err(|e| format!("mkdir pre-restore : {e}"))?;
    }

    // 4. Remplacement atomique : on copie la base du bundle vers un fichier
    //    temporaire à côté de la base vivante, puis rename (atomique sur le même
    //    volume). On purge aussi les fichiers WAL/SHM périmés de l'ancienne base
    //    pour éviter qu'un -wal résiduel ne « ressuscite » d'anciennes pages.
    let parent = live
        .parent()
        .ok_or_else(|| "base vivante sans dossier parent".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| format!("mkdir config dir : {e}"))?;
    let tmp = parent.join(format!(".shugu.db.restore-{}.tmp", now_millis()));
    std::fs::copy(&bundle_db, &tmp).map_err(|e| format!("copie base bundle : {e}"))?;

    // Purge des sidecars WAL/SHM de l'ancienne base (best-effort).
    for ext in ["-wal", "-shm"] {
        let side = PathBuf::from(format!("{}{ext}", live.to_string_lossy()));
        let _ = std::fs::remove_file(side);
    }
    std::fs::rename(&tmp, &live).map_err(|e| {
        // Nettoyage du tmp en cas d'échec de rename.
        let _ = std::fs::remove_file(&tmp);
        format!("remplacement base vivante : {e}")
    })?;

    Ok(Some(ImportResult {
        bundle_dir: norm(&dir),
        manifest,
        safety_backup: norm(&safety_dir),
        restart_required: true,
    }))
}

/// Vérifie l'intégrité de la base vivante (`PRAGMA integrity_check` +
/// `foreign_key_check`). Ne modifie rien.
#[command(rename_all = "camelCase")]
pub async fn shugu_db_integrity_check(app: AppHandle) -> Result<IntegrityReport, String> {
    let db = live_db_path(&app)?;
    if !db.exists() {
        return Err(format!("base introuvable : {}", db.display()));
    }
    let (ok, messages) = run_integrity_check(&db)?;
    let fk = run_foreign_key_check(&db);
    let db_bytes = std::fs::metadata(&db).map(|m| m.len()).unwrap_or(0);
    Ok(IntegrityReport {
        ok: ok && fk.is_empty(),
        messages,
        foreign_key_violations: fk,
        db_bytes,
        db_path: norm(&db),
    })
}

/// Prend MANUELLEMENT un backup interne (sous `backups/manual/`), sans dialog.
/// Utile pour un bouton « Sauvegarder maintenant » qui ne demande pas de dossier.
/// Renvoie le manifeste + le dossier du bundle.
#[command(rename_all = "camelCase")]
pub async fn shugu_backup_now(app: AppHandle) -> Result<ExportResult, String> {
    let dir = backups_root(&app)?
        .join("manual")
        .join(format!("shugu-backup-{}", now_millis()));
    let manifest = write_bundle(&app, &dir)?;
    Ok(ExportResult {
        bundle_dir: norm(&dir),
        manifest,
    })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn temp_dir(tag: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("shugu_backup_test_{tag}_{}", now_millis()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// Crée une petite base SQLite simulant `shugu.db` : table `settings` +
    /// table `_sqlx_migrations` avec une version donnée.
    fn make_db(path: &Path, schema_version: i64) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
             CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL);
             CREATE TABLE _sqlx_migrations (version BIGINT PRIMARY KEY, description TEXT, installed_on TEXT, success BOOLEAN, checksum BLOB, execution_time BIGINT);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
            params!["workspace_root", "C:/Dev/x", 1234_i64],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO _sqlx_migrations (version, description, success) VALUES (?1, 'm', 1)",
            params![schema_version],
        )
        .unwrap();
    }

    #[test]
    fn snapshot_is_consistent_and_readable() {
        let dir = temp_dir("snap");
        let src = dir.join("shugu.db");
        make_db(&src, 16);
        let dest = dir.join("copy/shugu.db");
        snapshot_db(&src, &dest).unwrap();
        assert!(dest.is_file(), "snapshot file created");
        // Re-snapshot over an existing dest must succeed (clean + rewrite).
        snapshot_db(&src, &dest).unwrap();
        // The copy is readable and carries the data.
        let conn = Connection::open(&dest).unwrap();
        let v: String = conn
            .query_row("SELECT value FROM settings WHERE key='workspace_root'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(v, "C:/Dev/x");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn schema_version_and_table_count() {
        let dir = temp_dir("ver");
        let src = dir.join("shugu.db");
        make_db(&src, 12);
        assert_eq!(schema_version_of(&src), Some(12));
        // 2 user tables (settings, conversations) — _sqlx_migrations excluded.
        assert_eq!(user_table_count(&src), 2);
        // Missing DB → None / 0.
        assert_eq!(schema_version_of(&dir.join("nope.db")), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn integrity_check_passes_on_fresh_db() {
        let dir = temp_dir("integ");
        let src = dir.join("shugu.db");
        make_db(&src, 16);
        let (ok, messages) = run_integrity_check(&src).unwrap();
        assert!(ok, "fresh db should be ok, got {messages:?}");
        assert_eq!(messages, vec!["ok".to_string()]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn settings_export_roundtrip() {
        let dir = temp_dir("settings");
        let src = dir.join("shugu.db");
        make_db(&src, 16);
        let json = export_settings_json(&src).unwrap();
        let v: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(v["workspace_root"], "C:/Dev/x");
        // No settings table → empty object, not an error.
        let empty = dir.join("empty.db");
        Connection::open(&empty)
            .unwrap()
            .execute_batch("CREATE TABLE x (a INTEGER);")
            .unwrap();
        assert_eq!(export_settings_json(&empty).unwrap(), "{}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
