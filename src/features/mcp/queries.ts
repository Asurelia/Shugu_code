// src/features/mcp/queries.ts — hooks TanStack pour les serveurs MCP.
import { useQuery, useMutation } from "@tanstack/react-query";
import { invoke } from "@/lib/tauri";
import { queryClient } from "@/lib/queryClient";
import type { McpToolEffect } from "./mcpToolEffects";

export interface McpServerStatus {
  name: string; transport: string; enabled: boolean;
  connected: boolean; toolCount: number; error?: string;
}
export interface McpToolInfo {
  name: string;
  description: string;
  effect: McpToolEffect;
}
export interface McpServerConfig {
  command?: string; args?: string[]; env?: Record<string,string>; url?: string;
}

// ─── Inventaire multi-source (Lane 6) ────────────────────────────────────────
// Reflète la forme sérialisée par `commands::mcp_sources` (serde camelCase).
export type McpSourceKind = "shugu" | "claude-desktop" | "codex" | "opencode";
export type McpRisk = "low" | "medium" | "high";

export interface InventoryEntry {
  name: string;
  source: McpSourceKind;
  sourceLabel: string;
  transport: string;            // "stdio" | "http" | "invalid"
  alreadyImported: boolean;
  enabled: boolean;
  sourceEnabled: boolean | null;
  secretEnvKeys: string[];
  risk: McpRisk;
  config: McpServerConfig;
}

export interface SourceError {
  source: McpSourceKind;
  sourceLabel: string;
  path: string | null;
  message: string;
}

export interface McpInventory {
  entries: InventoryEntry[];
  errors: SourceError[];
}

const KEY = ["mcp", "servers"] as const;
const INVENTORY_KEY = ["mcp", "inventory"] as const;

export function useMcpServers() {
  return useQuery<McpServerStatus[]>({
    queryKey: KEY,
    queryFn: () => invoke<McpServerStatus[]>("mcp_list_servers"),
    staleTime: 5_000,
  });
}

export function useMcpToggle() {
  return useMutation({
    mutationFn: (p: { name: string; enabled: boolean }) =>
      invoke("mcp_set_enabled", { name: p.name, enabled: p.enabled }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      void queryClient.invalidateQueries({ queryKey: INVENTORY_KEY });
    },
  });
}

export function useMcpTest() {
  return useMutation<McpToolInfo[], unknown, string>({
    mutationFn: (name: string) => invoke<McpToolInfo[]>("mcp_test_server", { name }),
  });
}

export function useMcpAdd() {
  return useMutation({
    mutationFn: (p: { name: string; config: McpServerConfig; global: boolean }) =>
      invoke("mcp_add_server", { name: p.name, config: p.config, global: p.global }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      void queryClient.invalidateQueries({ queryKey: INVENTORY_KEY });
    },
  });
}

export function useMcpRemove() {
  return useMutation({
    mutationFn: (name: string) => invoke("mcp_remove_server", { name }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      void queryClient.invalidateQueries({ queryKey: INVENTORY_KEY });
    },
  });
}

// ─── Inventaire multi-source ─────────────────────────────────────────────────

export function useMcpInventory() {
  return useQuery<McpInventory>({
    queryKey: INVENTORY_KEY,
    queryFn: () => invoke<McpInventory>("mcp_inventory"),
    staleTime: 5_000,
  });
}

/** Importe une entrée externe dans `.mcp.json` (les secrets sont migrés au
 *  keychain côté Rust). Renvoie les clés d'env migrées. */
export function useMcpImport() {
  return useMutation<string[], unknown, { name: string; config: McpServerConfig; global: boolean }>({
    mutationFn: (p) =>
      invoke<string[]>("mcp_import_server", { name: p.name, config: p.config, global: p.global }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: KEY });
      void queryClient.invalidateQueries({ queryKey: INVENTORY_KEY });
    },
  });
}
