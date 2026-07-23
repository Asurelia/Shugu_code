//! Utilitaires de chemins partagés par les commandes — notamment le retrait du
//! préfixe Windows extended-length (`\\?\`), LE bug Windows récurrent du
//! projet (cf. mémoire `feedback_windows_extended_path_prefix`).
//!
//! `std::fs::canonicalize()` renvoie sur Windows des chemins « verbatim »
//! préfixés `\\?\` (ou `\\?\UNC\` pour les partages réseau). Beaucoup de
//! consommateurs les REFUSENT : cmd.exe (spawn des shims .cmd/.bat npm),
//! `git worktree add` quand le chemin est passé en ARGUMENT (« could not
//! create leading directories of '//?/…': Invalid argument »), divers outils
//! node — et le frontend ne doit jamais voir ce préfixe via l'IPC.
//!
//! Ce module est LE point unique de vérité. Avant sa création il existait une
//! dizaine de copies privées du helper, avec des variantes de comportement
//! (PathBuf vs &str, gestion UNC ou pas, forme forward-slash ou pas) — le
//! comportement retenu ici est le SUPERSET :
//!
//! - `\\?\UNC\server\share` → `\\server\share`
//! - `\\?\C:\…`             → `C:\…`
//! - `//?/UNC/…` / `//?/…`  → même traitement (forme forward-slash qui
//!   apparaît quand un chemin verbatim a déjà subi `replace('\\', "/")`)
//! - tout autre chemin      → inchangé (la fonction est idempotente)
//!
//! Volontairement PAS de `cfg!(windows)` : ces préfixes n'existent jamais sur
//! Unix, donc le comportement y est identique (no-op), et les tests restent
//! portables.

use std::path::{Path, PathBuf};

/// Retire le préfixe Windows extended-length d'un chemin. Idempotent.
pub(crate) fn strip_extended_prefix(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy();
    let stripped = if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{rest}")
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        rest.to_string()
    } else if let Some(rest) = s.strip_prefix("//?/UNC/") {
        format!("//{rest}")
    } else if let Some(rest) = s.strip_prefix("//?/") {
        rest.to_string()
    } else {
        return p;
    };
    PathBuf::from(stripped)
}

/// Variante `&str → String` pour les sites d'appel qui manipulent déjà des
/// chaînes (capture, browser). Même comportement que [`strip_extended_prefix`].
pub(crate) fn strip_extended_prefix_str(s: &str) -> String {
    strip_extended_prefix(PathBuf::from(s))
        .to_string_lossy()
        .into_owned()
}

/// Forme « affichage / IPC » d'un chemin : préfixe verbatim retiré + séparateurs
/// forward-slash. C'est la forme que le frontend doit TOUJOURS recevoir.
pub(crate) fn norm_display(p: &Path) -> String {
    strip_extended_prefix(p.to_path_buf())
        .to_string_lossy()
        .replace('\\', "/")
}

// ---------------------------------------------------------------------------
// Tests (migrés depuis git.rs / lsp.rs lors de la centralisation)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_prefix_noop_on_non_extended() {
        let p = PathBuf::from(if cfg!(windows) {
            r"C:\foo\bar"
        } else {
            "/foo/bar"
        });
        let stripped = strip_extended_prefix(p.clone());
        assert_eq!(stripped, p);
    }

    #[test]
    fn strip_prefix_handles_drive() {
        let p = PathBuf::from(r"\\?\C:\foo\bar");
        let stripped = strip_extended_prefix(p);
        assert_eq!(stripped, PathBuf::from(r"C:\foo\bar"));
    }

    #[test]
    fn strip_prefix_handles_unc() {
        let p = PathBuf::from(r"\\?\UNC\server\share\foo");
        let stripped = strip_extended_prefix(p);
        assert_eq!(stripped, PathBuf::from(r"\\server\share\foo"));
    }

    /// Forme forward-slash (ex-lsp.rs) : un chemin verbatim déjà passé par
    /// `replace('\\', "/")` doit aussi être nettoyé.
    #[test]
    fn strip_prefix_handles_forward_slash_form() {
        assert_eq!(
            strip_extended_prefix(PathBuf::from("//?/F:/Dev/x.cmd")),
            PathBuf::from("F:/Dev/x.cmd")
        );
        assert_eq!(
            strip_extended_prefix(PathBuf::from("//?/UNC/server/share/foo")),
            PathBuf::from("//server/share/foo")
        );
    }

    #[test]
    fn strip_prefix_is_idempotent() {
        let once = strip_extended_prefix(PathBuf::from(r"\\?\C:\foo"));
        let twice = strip_extended_prefix(once.clone());
        assert_eq!(once, twice);
    }

    #[test]
    fn strip_prefix_str_variant_matches() {
        assert_eq!(strip_extended_prefix_str(r"\\?\C:\foo\bar"), r"C:\foo\bar");
        assert_eq!(
            strip_extended_prefix_str("plain/relative"),
            "plain/relative"
        );
    }

    /// La forme IPC/affichage ne doit JAMAIS fuir le préfixe verbatim, sous
    /// aucune de ses deux écritures (régression `fs_get_workspace_root` qui
    /// renvoyait `//?/F:/…` au frontend).
    #[test]
    fn norm_display_never_leaks_verbatim_prefix() {
        for raw in [r"\\?\C:\Dev\proj", r"C:\Dev\proj", "//?/C:/Dev/proj"] {
            let out = norm_display(Path::new(raw));
            assert!(
                !out.starts_with("//?/") && !out.contains(r"\\?\"),
                "prefix leaked: {out}"
            );
        }
        assert_eq!(norm_display(Path::new(r"\\?\C:\Dev\proj")), "C:/Dev/proj");
    }

    /// Sur Windows, un chemin réellement canonicalisé (donc verbatim) ressort
    /// propre — le cas prod exact.
    #[cfg(windows)]
    #[test]
    fn norm_display_cleans_real_canonicalized_path() {
        let dir = std::env::temp_dir().join(format!("shugu_pathutil_test_{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("create temp dir");
        let canon = std::fs::canonicalize(&dir).expect("canonicalize");
        let out = norm_display(&canon);
        assert!(
            !out.starts_with("//?/") && !out.contains(r"\\?\"),
            "prefix leaked: {out}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
