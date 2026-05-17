// Shugu Forge — credential & provider-config persistence layer.
//
// Two storage tiers, by sensitivity:
//
//   SECRETS  (API keys, tokens) ─────────► OS keychain via Tauri `cred_*` commands
//                                          (Windows Credential Manager, macOS Keychain,
//                                           Linux Secret Service). NEVER touches SQLite.
//
//   CONFIGS  (baseUrl, orgId, endpoint) ─► SQLite `settings` table (already migrated).
//                                          Plain text on disk — fine for non-secret
//                                          config; a future Convex sync can safely
//                                          replicate this tier without leaking keys.
//
// Account naming convention (single namespace under service="shugu-forge"):
//
//   provider.<providerId>.<fieldKey>
//
// Examples: provider.anthropic.apiKey, provider.openai.orgId,
//           provider.llamacpp.endpoint

import { invoke } from "@/lib/tauri";
import { db } from "@/lib/db";

// ─── Account-name helpers ──────────────────────────────────────────────

function secretAccount(providerId: string, fieldKey: string): string {
  return `provider.${providerId}.${fieldKey}`;
}

function configKey(providerId: string, fieldKey: string): string {
  return `provider.${providerId}.${fieldKey}`;
}

// ─── Secrets API — backed by OS keychain ───────────────────────────────

/** Read a secret. Returns `null` when absent (no thrown errors on common path). */
export async function getSecret(providerId: string, fieldKey: string): Promise<string | null> {
  const account = secretAccount(providerId, fieldKey);
  try {
    const v = await invoke<string | null>("cred_get", { account });
    return v ?? null;
  } catch (err) {
    console.warn("[credentials] cred_get failed", { account, error: err });
    return null;
  }
}

/** Write or update a secret. Empty `value` is treated as a delete. */
export async function setSecret(providerId: string, fieldKey: string, value: string): Promise<void> {
  if (!value) return deleteSecret(providerId, fieldKey);
  const account = secretAccount(providerId, fieldKey);
  await invoke("cred_set", { account, secret: value });
}

/** Remove a secret. Idempotent on the not-found case. */
export async function deleteSecret(providerId: string, fieldKey: string): Promise<void> {
  const account = secretAccount(providerId, fieldKey);
  await invoke("cred_delete", { account });
}

// ─── Configs API — backed by SQLite `settings` ─────────────────────────

/** Read a non-secret config value. Returns `null` when absent. */
export async function getConfig(providerId: string, fieldKey: string): Promise<string | null> {
  const key = configKey(providerId, fieldKey);
  try { return await db.settings.get(key); } catch { return null; }
}

/** Write or update a non-secret config value. Empty `value` stores "" (treated as absent on read). */
export async function setConfig(providerId: string, fieldKey: string, value: string): Promise<void> {
  const key = configKey(providerId, fieldKey);
  // db.settings has no explicit delete — store empty string. resolveProviderConfig
  // treats "" the same as absent.
  await db.settings.set(key, value);
}

// ─── High-level helpers used by ConnCard + chat-sync ───────────────────

export interface ProviderConfig {
  apiKey: string | null;
  baseUrl: string | null;
  orgId: string | null;
  endpoint: string | null;
}

/**
 * Bulk-load every well-known credential field for a provider in one round
 * trip. The shape is intentionally flat (no nested raw[fieldKey]) — only
 * the fields chat-sync actually needs. UI components that surface custom
 * fields still call getProviderField / setProviderField directly with
 * their own fieldKey.
 */
export async function loadProviderConfig(providerId: string): Promise<ProviderConfig> {
  const [apiKey, baseUrl, orgId, endpoint] = await Promise.all([
    getSecret(providerId, "apiKey"),
    getConfig(providerId, "baseUrl"),
    getConfig(providerId, "orgId"),
    getConfig(providerId, "endpoint"),
  ]);
  return { apiKey, baseUrl, orgId, endpoint };
}

/**
 * Generic field setter — routes to the right tier (keyring vs SQLite)
 * based on the `secret` flag. The ConnCard component is the primary
 * caller (one save per dirty input on the "Connect" button).
 */
export async function setProviderField(
  providerId: string,
  fieldKey: string,
  value: string,
  secret: boolean,
): Promise<void> {
  if (secret) {
    await setSecret(providerId, fieldKey, value);
  } else {
    await setConfig(providerId, fieldKey, value);
  }
}

/** Generic field getter — symmetric companion of setProviderField. */
export async function getProviderField(
  providerId: string,
  fieldKey: string,
  secret: boolean,
): Promise<string | null> {
  return secret ? getSecret(providerId, fieldKey) : getConfig(providerId, fieldKey);
}

/** Wipe every well-known field for a provider — used by "Disconnect". Also
 * sets the explicit-disable flag so the discovery layer stops auto-probing
 * the provider's default endpoint (otherwise built-in providers like
 * llama.cpp / Ollama with a localhost default would keep being reachable
 * even after the user explicitly disconnected). */
export async function clearProviderConfig(providerId: string): Promise<void> {
  await Promise.all([
    deleteSecret(providerId, "apiKey"),
    setConfig(providerId, "baseUrl", ""),
    setConfig(providerId, "orgId", ""),
    setConfig(providerId, "endpoint", ""),
    setConfig(providerId, "enabled", "false"),
  ]);
}

/**
 * Provider enable-state tracking.
 *
 * Three possible states for any built-in provider:
 *   - "true"  : user explicitly saved a config → use it.
 *   - "false" : user explicitly disconnected → skip entirely (NO auto-probe
 *               of the default endpoint, even if it would respond).
 *   - null    : never interacted → fall back to the legacy behavior
 *               (auto-probe localhost endpoints for Ollama / llama.cpp,
 *               require explicit key for remote providers).
 *
 * This is what makes "Disconnect" actually mean disconnect for a provider
 * whose default baseUrl is a working local server.
 */
export async function setProviderEnabled(providerId: string, enabled: boolean): Promise<void> {
  await setConfig(providerId, "enabled", enabled ? "true" : "false");
}

export async function getProviderEnabled(providerId: string): Promise<"true" | "false" | null> {
  const v = await getConfig(providerId, "enabled");
  if (v === "true" || v === "false") return v;
  return null;
}
