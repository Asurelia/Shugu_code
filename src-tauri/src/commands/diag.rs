//! Diagnostic plumbing — capture les logs JS dans le stdout Rust.
//!
//! Pourquoi ce module : la WebView2 de Tauri sur Windows a des DevTools
//! peu pratiques (peuvent être inaccessibles si fenêtre dimensionnée
//! petitement, ou polluées par des warnings third-party). Pour diagnostiquer
//! des bugs cross-process (Rust → JS via emit/listen), c'est précieux
//! d'avoir UN SEUL flux où on voit à la fois ce que Rust pense émettre
//! ET ce que JS pense recevoir.
//!
//! Le frontend appelle `js_diag` via `@/lib/diag.ts::diag(category, msg)`,
//! qui mirror sur `console.log` ET sur ce stdout via Tauri invoke.
//!
//! Side du Rust : on print sur stderr (avec `eprintln!`) parce que c'est
//! ce que Tauri dev capture par défaut dans son terminal. Ajouter une
//! catégorie pour faciliter le `grep` ultérieur.
//!
//! Activation : auto-actif via `cfg!(debug_assertions)` — c.-à-d. les
//! builds dev. Les builds release ignorent silencieusement (pas de coût
//! au-delà d'un appel de fonction vide).

/// Reçoit un log diag depuis le frontend. Format de sortie :
///   [js:agent-events] event=spawn agent=abc12345
///
/// Le `category` doit être kebab-case court (e.g. "agent-events",
/// "chat-stream", "delegate") pour grep facile dans le trace.
#[tauri::command]
pub fn js_diag(category: String, msg: String) {
    if cfg!(debug_assertions) {
        eprintln!("[js:{}] {}", category, msg);
    }
}
