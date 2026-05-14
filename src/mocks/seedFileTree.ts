import type { FileNode } from "@/lib/types";

export const seedFileTree: FileNode[] = [
  { name: "src", path: "src", open: true, children: [
    { name: "components", path: "src/components", open: true, children: [
      { name: "Forge.tsx", path: "src/components/Forge.tsx", git: "M" },
      { name: "ChatPanel.tsx", path: "src/components/ChatPanel.tsx" },
      { name: "ImageStage.tsx", path: "src/components/ImageStage.tsx", git: "A" },
    ]},
    { name: "views", path: "src/views", children: [
      { name: "ImageView.tsx", path: "src/views/ImageView.tsx", git: "A" },
      { name: "TerminalView.tsx", path: "src/views/TerminalView.tsx" },
    ]},
    { name: "lib", path: "src/lib", children: [
      { name: "ipc.ts", path: "src/lib/ipc.ts" },
      { name: "store.ts", path: "src/lib/store.ts", git: "M" },
    ]},
    { name: "App.tsx", path: "src/App.tsx" },
    { name: "main.tsx", path: "src/main.tsx" },
  ]},
  { name: "src-tauri", path: "src-tauri", children: [
    { name: "src", path: "src-tauri/src", children: [
      { name: "main.rs", path: "src-tauri/src/main.rs", git: "M" },
      { name: "image.rs", path: "src-tauri/src/image.rs", git: "A" },
    ]},
    { name: "Cargo.toml", path: "src-tauri/Cargo.toml" },
    { name: "tauri.conf.json", path: "src-tauri/tauri.conf.json" },
  ]},
  { name: "package.json", path: "package.json" },
  { name: "vite.config.ts", path: "vite.config.ts" },
  { name: "tsconfig.json", path: "tsconfig.json" },
  { name: "README.md", path: "README.md" },
];
