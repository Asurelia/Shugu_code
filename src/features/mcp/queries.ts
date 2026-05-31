// src/features/mcp/queries.ts — hooks TanStack pour les serveurs MCP.
import { useQuery, useMutation } from "@tanstack/react-query";
import { invoke } from "@/lib/tauri";
import { queryClient } from "@/lib/queryClient";

export interface McpServerStatus {
  name: string; transport: string; enabled: boolean;
  connected: boolean; toolCount: number; error?: string;
}
export interface McpToolInfo { name: string; description: string }
export interface McpServerConfig {
  command?: string; args?: string[]; env?: Record<string,string>; url?: string;
}

const KEY = ["mcp", "servers"] as const;

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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
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
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}

export function useMcpRemove() {
  return useMutation({
    mutationFn: (name: string) => invoke("mcp_remove_server", { name }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: KEY }),
  });
}
