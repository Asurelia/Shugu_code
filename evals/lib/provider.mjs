// evals/lib/provider.mjs
//
// Provider client for the eval harness — talks to the SAME provider protocols
// the Shugu Rust agent runner uses (`src-tauri/src/commands/agents/runner.rs`),
// but from plain Node so the harness can drive a coding agent headless without
// booting Tauri. Two wire formats, mirroring the runner's
// `build_anthropic_messages` / `build_openai_messages`:
//
//   - anthropic : POST /v1/messages           (tool_use / tool_result blocks)
//   - openai    : POST /v1/chat/completions    (tool_calls + role:"tool")
//
// The harness model id uses the SAME "prefix/model" convention as
// `src/lib/providers.ts` (e.g. "anthropic/claude-haiku-4-5",
// "openai/gpt-4o-mini", "groq/llama-3.3-70b-versatile"). `resolveProvider`
// here is a small, dependency-free port of that registry so the eval harness
// has no import coupling to the app's TS build.
//
// No SDK dependency on purpose: raw `fetch` (Node >= 18 has it global) keeps the
// harness runnable from a bare `node` with zero install — important because the
// worktree's node_modules is a junction we must not mutate.

/**
 * @typedef {"anthropic"|"openai"} Protocol
 */

// Mirrors PROVIDER_REGISTRY in src/lib/providers.ts (HTTP providers only — the
// `codex`/`ollama` arms aren't reachable from a pure-fetch eval client).
const PROVIDER_REGISTRY = {
  anthropic: { protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
  openai: { protocol: "openai", baseUrl: "https://api.openai.com" },
  mistral: { protocol: "openai", baseUrl: "https://api.mistral.ai" },
  groq: { protocol: "openai", baseUrl: "https://api.groq.com/openai" },
  openrouter: { protocol: "openai", baseUrl: "https://openrouter.ai/api" },
  deepseek: { protocol: "openai", baseUrl: "https://api.deepseek.com" },
  together: { protocol: "openai", baseUrl: "https://api.together.xyz" },
  // Local OpenAI-compatible servers (llama.cpp `llama-server`, LM Studio, vLLM).
  llamacpp: { protocol: "openai", baseUrl: "http://localhost:8090" },
  lmstudio: { protocol: "openai", baseUrl: "http://localhost:1234" },
};

// Per-protocol env var for the API key, matching the Rust credential lookup
// (ANTHROPIC_API_KEY / OPENAI_API_KEY). Provider-prefix-specific keys override
// the protocol default so e.g. GROQ_API_KEY works for "groq/..." models.
const PROTOCOL_KEY_ENV = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

/**
 * Decompose "prefix/model" into routing bits. Port of resolveProvider in
 * src/lib/providers.ts. Unknown prefixes fall back to the openai protocol with
 * an empty baseUrl (the caller must then supply EVAL_BASE_URL).
 * @param {string} modelId
 */
export function resolveProvider(modelId) {
  const slash = modelId.indexOf("/");
  if (slash === -1) {
    return { providerId: modelId, protocol: "openai", baseUrl: "", model: modelId };
  }
  const prefix = modelId.slice(0, slash);
  const model = modelId.slice(slash + 1);
  const entry = PROVIDER_REGISTRY[prefix];
  if (!entry) {
    return { providerId: prefix, protocol: "openai", baseUrl: "", model };
  }
  return { providerId: prefix, protocol: entry.protocol, baseUrl: entry.baseUrl, model };
}

/**
 * Resolve the API key for a model from the environment.
 * Order: EVAL_API_KEY (explicit override) → <PREFIX>_API_KEY → <PROTOCOL>_API_KEY.
 * @param {string} providerId
 * @param {Protocol} protocol
 * @returns {string|undefined}
 */
export function resolveApiKey(providerId, protocol) {
  const env = process.env;
  if (env.EVAL_API_KEY) return env.EVAL_API_KEY;
  const prefixKey = `${providerId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
  if (env[prefixKey]) return env[prefixKey];
  const protoKey = PROTOCOL_KEY_ENV[protocol];
  if (protoKey && env[protoKey]) return env[protoKey];
  return undefined;
}

/**
 * A resolved, ready-to-call provider config for one eval run.
 * @typedef {Object} ProviderConfig
 * @property {Protocol} protocol
 * @property {string} baseUrl
 * @property {string} model
 * @property {string} [apiKey]
 * @property {string} providerId
 */

/**
 * Build a ProviderConfig from a model id + env, honouring EVAL_BASE_URL.
 * @param {string} modelId
 * @returns {ProviderConfig}
 */
export function buildProviderConfig(modelId) {
  const { providerId, protocol, baseUrl, model } = resolveProvider(modelId);
  const effectiveBaseUrl = process.env.EVAL_BASE_URL?.trim() || baseUrl;
  const apiKey = resolveApiKey(providerId, protocol);
  return { protocol, baseUrl: effectiveBaseUrl, model, apiKey, providerId };
}

/**
 * Tool definition shared by both wire formats.
 * @typedef {Object} ToolDef
 * @property {string} name
 * @property {string} description
 * @property {object} parameters  JSON schema for the tool input.
 */

/**
 * One requested tool call returned by the model.
 * @typedef {Object} ToolCall
 * @property {string} id
 * @property {string} name
 * @property {object} args   Parsed JSON arguments.
 */

/**
 * Internal agent message — a provider-neutral transcript element, translated to
 * the right wire shape per protocol. Mirrors `AgentMessage` in runner.rs.
 * @typedef {Object} AgentMessage
 * @property {"system"|"user"|"assistant"|"assistant_tools"|"tool_results"} kind
 * @property {string} [content]
 * @property {ToolCall[]} [toolCalls]
 * @property {{ id: string, content: string, isError: boolean }[]} [results]
 */

// ─── Wire builders ───────────────────────────────────────────────

function toolDefsAnthropic(tools) {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

function toolDefsOpenai(tools) {
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

function buildAnthropicMessages(history) {
  // Anthropic requires alternating roles and forbids two consecutive user
  // turns, so a run of tool_results is folded into ONE user message.
  const msgs = [];
  for (const m of history) {
    if (m.kind === "user") {
      msgs.push({ role: "user", content: m.content ?? "" });
    } else if (m.kind === "assistant") {
      msgs.push({ role: "assistant", content: m.content ?? "" });
    } else if (m.kind === "assistant_tools") {
      const blocks = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args ?? {} });
      }
      msgs.push({ role: "assistant", content: blocks });
    } else if (m.kind === "tool_results") {
      const blocks = (m.results ?? []).map((r) => ({
        type: "tool_result",
        tool_use_id: r.id,
        content: r.content,
        is_error: r.isError || undefined,
      }));
      msgs.push({ role: "user", content: blocks });
    }
  }
  return msgs;
}

function buildOpenaiMessages(history, system) {
  const msgs = [];
  if (system) msgs.push({ role: "system", content: system });
  for (const m of history) {
    if (m.kind === "user") {
      msgs.push({ role: "user", content: m.content ?? "" });
    } else if (m.kind === "assistant") {
      msgs.push({ role: "assistant", content: m.content ?? "" });
    } else if (m.kind === "assistant_tools") {
      msgs.push({
        role: "assistant",
        content: m.content || null,
        tool_calls: (m.toolCalls ?? []).map((tc) => ({
          id: tc.id,
          type: "function",
          function: { name: tc.name, arguments: JSON.stringify(tc.args ?? {}) },
        })),
      });
    } else if (m.kind === "tool_results") {
      for (const r of m.results ?? []) {
        msgs.push({ role: "tool", tool_call_id: r.id, content: r.content });
      }
    }
  }
  return msgs;
}

// ─── Response parsing ────────────────────────────────────────────

/**
 * @typedef {Object} LlmTurn
 * @property {string} text        Assistant prose (may be empty).
 * @property {ToolCall[]} toolCalls
 * @property {string} stopReason  Provider stop reason (normalised best-effort).
 * @property {{ input: number, output: number }} [usage]
 */

function parseAnthropicResponse(json) {
  /** @type {ToolCall[]} */
  const toolCalls = [];
  let text = "";
  for (const block of json.content ?? []) {
    if (block.type === "text") text += block.text ?? "";
    else if (block.type === "tool_use")
      toolCalls.push({ id: block.id, name: block.name, args: block.input ?? {} });
  }
  return {
    text,
    toolCalls,
    stopReason: json.stop_reason ?? "end_turn",
    usage: json.usage
      ? { input: json.usage.input_tokens ?? 0, output: json.usage.output_tokens ?? 0 }
      : undefined,
  };
}

function parseOpenaiResponse(json) {
  const choice = json.choices?.[0] ?? {};
  const msg = choice.message ?? {};
  /** @type {ToolCall[]} */
  const toolCalls = [];
  for (const tc of msg.tool_calls ?? []) {
    let args = {};
    try {
      args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
    } catch {
      args = { __raw: tc.function?.arguments };
    }
    toolCalls.push({ id: tc.id, name: tc.function?.name, args });
  }
  return {
    text: msg.content ?? "",
    toolCalls,
    stopReason: choice.finish_reason ?? "stop",
    usage: json.usage
      ? { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 }
      : undefined,
  };
}

// ─── The single call ─────────────────────────────────────────────

/**
 * Issue ONE model turn (non-streaming — the harness only needs the final tool
 * decisions, not live tokens). Returns the assistant text + any tool calls.
 *
 * @param {ProviderConfig} cfg
 * @param {string} system            System prompt.
 * @param {AgentMessage[]} history    Conversation so far (no system entry).
 * @param {ToolDef[]} tools
 * @param {{ maxTokens?: number, temperature?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<LlmTurn>}
 */
export async function callModel(cfg, system, history, tools, opts = {}) {
  if (!cfg.baseUrl) {
    throw new Error(
      `no baseUrl for model "${cfg.providerId}/${cfg.model}" — set EVAL_BASE_URL for custom/local providers`,
    );
  }
  const maxTokens = opts.maxTokens ?? 4096;
  const temperature = opts.temperature ?? 0;

  if (cfg.protocol === "anthropic") {
    const url = `${cfg.baseUrl.replace(/\/$/, "")}/v1/messages`;
    const body = {
      model: cfg.model,
      max_tokens: maxTokens,
      temperature,
      system,
      messages: buildAnthropicMessages(history),
      tools: toolDefsAnthropic(tools),
    };
    const res = await fetch(url, {
      method: "POST",
      signal: opts.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": cfg.apiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`anthropic ${res.status}: ${txt.slice(0, 600)}`);
    }
    return parseAnthropicResponse(await res.json());
  }

  // openai-compatible
  const url = `${cfg.baseUrl.replace(/\/$/, "")}/v1/chat/completions`;
  const body = {
    model: cfg.model,
    max_tokens: maxTokens,
    temperature,
    messages: buildOpenaiMessages(history, system),
    tools: toolDefsOpenai(tools),
    tool_choice: "auto",
  };
  const headers = { "content-type": "application/json" };
  if (cfg.apiKey) headers["authorization"] = `Bearer ${cfg.apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    signal: opts.signal,
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`openai ${res.status}: ${txt.slice(0, 600)}`);
  }
  return parseOpenaiResponse(await res.json());
}
