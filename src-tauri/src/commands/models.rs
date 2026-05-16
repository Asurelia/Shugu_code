use serde::Serialize;

// Minimal Rust-side model list returned by the `models_list` Tauri command.
// The extended catalog (with groups + meta tags for the UI) lives in
// `src/lib/providers.ts` (MODEL_CATALOG). Keep the entries below as a
// subset of that catalog — when adding a model here, mirror it in the TS
// catalog so the web/dev mock and the Tauri command stay aligned.
// TS ↔ Rust sharing without a JSON build step isn't worth the friction
// while the list is < 20 entries.

#[derive(Serialize)]
pub struct Provider {
    pub id: String,
    pub label: String,
    pub protocol: String,
}

#[tauri::command]
pub fn models_list() -> Vec<Provider> {
    vec![
        Provider { id: "anthropic/claude-haiku-4-5".into(), label: "claude-haiku-4-5".into(), protocol: "anthropic".into() },
        Provider { id: "anthropic/claude-sonnet-5".into(),  label: "claude-sonnet-5".into(),  protocol: "anthropic".into() },
        Provider { id: "openai/gpt-4o-mini".into(),         label: "gpt-4o-mini".into(),      protocol: "openai".into() },
        Provider { id: "ollama/qwen2.5:32b".into(),         label: "qwen2.5:32b".into(),      protocol: "ollama".into() },
    ]
}
