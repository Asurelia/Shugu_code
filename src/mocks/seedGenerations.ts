import type { Generation } from "@/lib/types";

export const seedGenerations: Generation[] = Array.from({ length: 18 }, (_, i) => ({
  id: 1000 + i,
  prompt: ["dreamy aurora, soft pinks", "neon liquid metal", "celestial veil at dusk", "stained glass mecha", "cyber-cottagecore garden", "violet fog over a city"][i % 6],
  ratio: ["1:1", "16:9", "3:4"][i % 3],
  hue: (i * 47) % 360,
  ts: "14:" + String(10 + i).padStart(2, "0"),
}));
