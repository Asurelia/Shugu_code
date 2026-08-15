#!/usr/bin/env node
/**
 * Deletes the vendored open-design design-systems tree from public/.
 * The product no longer ships the generic site catalogue — Studio is canvas-first.
 *
 * Usage: node scripts/remove-design-catalogue.mjs
 */
import { rm, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "public", "design-systems");

await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });
await writeFile(join(dir, "index.json"), "[]\n", "utf8");
await writeFile(
  join(dir, "README.md"),
  "# Catalogue retiré\n\nLe catalogue open-design a été retiré de Shugu (Studio canvas-first).\n",
  "utf8",
);
console.log("Removed public/design-systems/* (kept empty index.json).");
