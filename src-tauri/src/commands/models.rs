use serde::Serialize;

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
