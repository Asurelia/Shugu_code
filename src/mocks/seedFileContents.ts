import type { FileContent } from "@/lib/types";

export const seedFileContents: Record<string, FileContent> = {
  "src/components/Forge.tsx": {
    lang: "typescript",
    dirty: false,
    text: `import { useEffect, useState } from "react";\nimport { invoke } from "@tauri-apps/api/core";\nimport { listen } from "@tauri-apps/api/event";\nimport type { ChatDelta, Message } from "../lib/types";\n\n/**\n * Forge — root shell. Mounts the chat stream, the IDE host\n * and the image stage. Talks to the Rust side over IPC.\n */\nexport function Forge() {\n  const [messages, setMessages] = useState<Message[]>([]);\n  const [model, setModel] = useState("shugu-haiku-4-5");\n\n  useEffect(() => {\n    const off = listen<ChatDelta>("chat://delta", (e) => {\n      setMessages((prev) => mergeDelta(prev, e.payload));\n    });\n    return () => { void off.then((f) => f()); };\n  }, []);\n\n  async function send(prompt: string) {\n    await invoke("chat_send", { prompt, model });\n  }\n\n  return (\n    <main className="forge">\n      <ChatPanel messages={messages} onSend={send} model={model} />\n      <IdeHost />\n      <ImageStage />\n    </main>\n  );\n}\n`,
  },
  "src/components/ChatPanel.tsx": {
    lang: "typescript",
    text: `import { useRef, useEffect } from "react";\nimport type { Message } from "../lib/types";\n\nexport function ChatPanel({ messages, onSend, model }: Props) {\n  const ref = useRef<HTMLDivElement>(null);\n  useEffect(() => {\n    ref.current?.scrollTo({ top: ref.current.scrollHeight });\n  }, [messages]);\n\n  return (\n    <section className="chat-panel">\n      <Feed ref={ref} messages={messages} />\n      <Composer onSubmit={onSend} model={model} />\n    </section>\n  );\n}\n\ninterface Props {\n  messages: Message[];\n  onSend: (p: string) => Promise<void>;\n  model: string;\n}\n`,
  },
  "src-tauri/src/main.rs": {
    lang: "javascript",
    text: `// SPDX-License-Identifier: MIT\n// Shugu Forge — Tauri 2 bootstrap\nuse tauri::Manager;\n\nmod chat;\nmod image;\n\nfn main() {\n  tauri::Builder::default()\n    .plugin(tauri_plugin_fs::init())\n    .plugin(tauri_plugin_shell::init())\n    .invoke_handler(tauri::generate_handler![\n      chat::send,\n      image::generate,\n      image::variations,\n    ])\n    .setup(|app| {\n      let win = app.get_webview_window("main").unwrap();\n      win.set_decorations(false).ok();\n      Ok(())\n    })\n    .run(tauri::generate_context!())\n    .expect("error while running tauri application");\n}`,
    original: `// SPDX-License-Identifier: MIT\n// Shugu Forge — Tauri 2 bootstrap\nuse tauri::Manager;\n\nmod chat;\n\nfn main() {\n  tauri::Builder::default()\n    .plugin(tauri_plugin_fs::init())\n    .invoke_handler(tauri::generate_handler![\n      chat::send,\n    ])\n    .run(tauri::generate_context!())\n    .expect("error while running tauri application");\n}`,
    dirty: true,
  },
  "src/lib/store.ts": {
    lang: "typescript",
    text: `import { create } from "zustand";\nimport { persist } from "zustand/middleware";\nimport type { Message, Generation } from "./types";\n\ninterface ForgeStore {\n  messages: Message[];\n  generations: Generation[];\n  model: string;\n  pushMessage: (m: Message) => void;\n  pushGeneration: (g: Generation) => void;\n  setModel: (m: string) => void;\n}\n\nexport const useForge = create<ForgeStore>()(\n  persist(\n    (set) => ({\n      messages: [],\n      generations: [],\n      model: "shugu-haiku-4-5",\n      pushMessage: (m) => set((s) => ({ messages: [...s.messages, m] })),\n      pushGeneration: (g) => set((s) => ({ generations: [g, ...s.generations] })),\n      setModel: (model) => set({ model }),\n    }),\n    { name: "shugu-forge" }\n  )\n);\n`,
  },
  "README.md": {
    lang: "javascript",
    text: `# Shugu Forge\n\nThe creative-and-code workshop. Tauri 2 + React + CodeMirror 6.\n\n## What's inside\n- Chat with multiple LLMs (local & remote)\n- Full IDE (CodeMirror 6, tabs, diff, git)\n- Image generation (flux.1 / sdxl / lcm-fast)\n- Background agents that keep working when you switch view\n- Integrated terminal\n\n## Running locally\n\n\\\`\\\`\\\`bash\npnpm install\npnpm tauri dev\n\\\`\\\`\\\`\n`,
  },
};
