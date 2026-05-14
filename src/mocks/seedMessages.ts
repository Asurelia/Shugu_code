import type { Message } from "@/lib/types";

// Rust snippet shown inside the seeded AI reply (message id 2).
// Kept as a real multi-line template literal for readability — the runtime
// string is byte-identical to the previous `\n`-escaped single-line form.
const rustWindowBuilderExample = `#[tauri::command]
fn open_forge_panel(app: tauri::AppHandle) -> Result<(), String> {
  WebviewWindowBuilder::new(&app, "forge",
    WebviewUrl::App("forge.html".into())
  )
  .title("Shugu · Forge")
  .decorations(false)
  .inner_size(960., 640.)
  .theme(Some(tauri::Theme::Dark))
  .build()
  .map_err(|e| e.to_string())?;
  Ok(())
}`;

export const seedMessages: Message[] = [
  {
    id: 1,
    role: "user",
    text: "Comment je structure mon Tauri command pour ouvrir une fenêtre flottante de génération d'images, avec un thème dark forcé ?",
    ts: "14:30",
  },
  {
    id: 2,
    role: "ai",
    ts: "14:30",
    body: "Tu peux utiliser `WebviewWindowBuilder` — la clé est de passer `Theme::Dark` et de désactiver les décorations pour ton chrome custom, comme ceci :",
    code: { lang: "rust", text: rustWindowBuilderExample },
  },
  {
    id: 3,
    role: "user",
    text: "Parfait. Et pour l'animation d'entrée glassmorph quand la fenêtre apparaît ?",
    ts: "14:31",
  },
  {
    id: 4,
    role: "ai",
    ts: "14:31",
    body: "Trois couches : (1) Tauri émet `window-opened`, (2) ton root React applique une classe `forge--enter` avec backdrop-filter qui monte de 0 → 20px en 240ms, (3) un keyframe `scale(0.98) → scale(1)` synchronisé. Le piège : Safari/Linux ne supportent pas `backdrop-filter` animé — fallback sur opacity.",
    image: true,
  },
];
