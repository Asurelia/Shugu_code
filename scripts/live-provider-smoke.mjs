// Real-provider proof through Shugu's production Tauri IPC surface.
//
// This intentionally does not call Codex or llama.cpp directly for inference:
// the model requests go through codex_auth_status/codex_models/
// codex_exec_probe/chat_send and llama_start/chat_send/llama_stop.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const cdpUrl = process.env.SHUGU_CDP_URL;
const outDir = process.env.SHUGU_LIVE_OUT;
const localModelPath = process.env.SHUGU_LIVE_MODEL_PATH;
const llamaBinary = process.env.SHUGU_LIVE_LLAMA_BIN;
const agentWorkspace = process.env.SHUGU_LIVE_AGENT_WORKSPACE;
const agentHfModel = process.env.SHUGU_LIVE_AGENT_HF_MODEL;
const skipCodex = process.env.SHUGU_LIVE_SKIP_CODEX === "1";
if (
  !cdpUrl ||
  !outDir ||
  !localModelPath ||
  !llamaBinary ||
  !agentWorkspace ||
  !agentHfModel
) {
  throw new Error(
    "SHUGU_CDP_URL, SHUGU_LIVE_OUT, SHUGU_LIVE_MODEL_PATH, SHUGU_LIVE_LLAMA_BIN, SHUGU_LIVE_AGENT_WORKSPACE and SHUGU_LIVE_AGENT_HF_MODEL are required",
  );
}
mkdirSync(outDir, { recursive: true });

const browser = await chromium.connectOverCDP(cdpUrl);
const pageDeadline = Date.now() + 120_000;
let page;
while (!page && Date.now() < pageDeadline) {
  page = browser
    .contexts()
    .flatMap((context) => context.pages())
    .find((candidate) => {
      const url = candidate.url();
      return url !== "about:blank" && !url.includes("mascot.html");
    });
  if (!page) await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!page) {
  throw new Error(
    `live-provider main WebView target not found; targets=${browser
      .contexts()
      .flatMap((context) => context.pages())
      .map((target) => target.url())
      .join(", ")}`,
  );
}

page.setDefaultTimeout(180_000);
const pageErrors = [];
const consoleErrors = [];
const failedRequests = [];
page.on("pageerror", (error) =>
  pageErrors.push(`${error.name}: ${error.message}`),
);
page.on("console", (message) => {
  if (message.type() === "error") consoleErrors.push(message.text());
});
page.on("requestfailed", (request) =>
  failedRequests.push(
    `${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`,
  ),
);

await page.waitForSelector("#root", { state: "attached" });
await page.waitForFunction(
  () => (document.getElementById("root")?.childElementCount ?? 0) > 0,
);

const invoke = (command, args = {}) =>
  page.evaluate(
    async ({ commandName, commandArgs }) => {
      const bridge = globalThis.__TAURI_INTERNALS__;
      if (!bridge?.invoke)
        throw new Error("live-provider Tauri IPC bridge missing");
      return bridge.invoke(commandName, commandArgs);
    },
    { commandName: command, commandArgs: args },
  );

const waitForChild = (child, timeoutMs) =>
  new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("native dialog automation timed out"));
    }, timeoutMs);
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(
            `native dialog automation failed (${code}): ${stderr.trim() || stdout.trim()}`,
          ),
        );
    });
  });

async function waitForLlamaModel(timeoutMs) {
  let modelsPayload;
  const readyDeadline = Date.now() + timeoutMs;
  while (!modelsPayload && Date.now() < readyDeadline) {
    try {
      const response = await fetch("http://127.0.0.1:8090/v1/models", {
        signal: AbortSignal.timeout(2_000),
      });
      if (response.ok) modelsPayload = await response.json();
    } catch {
      // Download/model mmap/GPU upload is still in progress.
    }
    if (!modelsPayload)
      await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!modelsPayload) {
    throw new Error(
      `llama.cpp did not become ready within ${Math.round(timeoutMs / 1000)} seconds`,
    );
  }
  const model = modelsPayload?.data?.[0]?.id;
  if (!model) {
    throw new Error(
      `llama.cpp /v1/models returned no model id: ${JSON.stringify(modelsPayload)}`,
    );
  }
  return model;
}

let codexResult = {
  skipped: true,
  reason: "explicitly skipped; no Codex inference was counted by this run",
};
if (!skipCodex) {
  const codexStartedAt = performance.now();
  const codexAuth = await invoke("codex_auth_status");
  if (!codexAuth?.loggedIn || !codexAuth?.binaryFound) {
    throw new Error(
      `Codex is not live-ready through Shugu: ${JSON.stringify({
        loggedIn: codexAuth?.loggedIn,
        binaryFound: codexAuth?.binaryFound,
      })}`,
    );
  }

  const codexModels = await invoke("codex_models");
  if (!Array.isArray(codexModels) || codexModels.length === 0) {
    throw new Error("Shugu codex_models returned no account model");
  }
  writeFileSync(
    `${outDir}/codex-models.json`,
    `${JSON.stringify(
      codexModels.map((model) => ({
        model: model.model,
        displayName: model.displayName,
        isDefault: model.isDefault,
        supportedEfforts: model.supportedEfforts,
      })),
      null,
      2,
    )}\n`,
  );
  const requestedCodexModel = process.env.SHUGU_LIVE_CODEX_MODEL?.trim();
  const codexModel =
    (requestedCodexModel
      ? codexModels.find((model) => model.model === requestedCodexModel)
      : undefined) ??
    codexModels.find((model) => model.model === "gpt-5.4-mini") ??
    codexModels.find((model) => model.isDefault) ??
    codexModels[0];
  if (!codexModel?.model)
    throw new Error("Shugu returned a Codex model without an id");

  const codexProbeStartedAt = performance.now();
  const codexProbe = await invoke("codex_exec_probe", {
    prompt: "Reply with exactly LIVE_CODEX_PROBE_OK and no other text.",
    model: codexModel.model,
  });
  const codexProbeMs = Math.round(performance.now() - codexProbeStartedAt);
  if (
    codexProbe?.producedText !== true ||
    codexProbe?.schemaUnrecognized === true ||
    codexProbe?.failure
  ) {
    throw new Error(
      `Shugu Codex exec probe failed: ${JSON.stringify(codexProbe)}`,
    );
  }

  const codexChatStartedAt = performance.now();
  const codexReply = await invoke("chat_send", {
    messages: [
      {
        role: "user",
        content: "Reply with exactly LIVE_CODEX_CHAT_OK and no other text.",
      },
    ],
    model: codexModel.model,
    protocol: "codex",
    baseUrl: "",
    apiKey: null,
    conversationId: `live-codex-${Date.now()}`,
    chatTemplateKwargs: null,
    reasoningEffort: codexModel.supportedEfforts?.includes("low")
      ? "low"
      : codexModel.defaultReasoningEffort,
    attachedImage: null,
    readTools: false,
    writeTools: false,
    fallbackModel: null,
    fallbackProtocol: null,
    fallbackBaseUrl: null,
    fallbackApiKey: null,
  });
  const codexChatMs = Math.round(performance.now() - codexChatStartedAt);
  if (
    typeof codexReply !== "string" ||
    !codexReply.toUpperCase().includes("LIVE_CODEX_CHAT_OK")
  ) {
    throw new Error(
      `Shugu Codex chat returned an unexpected answer (length=${String(codexReply ?? "").length})`,
    );
  }
  codexResult = {
    skipped: false,
    authenticated: true,
    binaryFound: true,
    model: codexModel.model,
    availableModels: codexModels.length,
    probeMs: codexProbeMs,
    probeProducedText: codexProbe.producedText,
    probeUnknownEvents: codexProbe.unknownEvents,
    probeSchemaRecognized: !codexProbe.schemaUnrecognized,
    chatMs: codexChatMs,
    totalMs: Math.round(performance.now() - codexStartedAt),
    replyLength: codexReply.length,
    sentinelMatched: true,
  };
}

let llamaStarted = false;
let localResult;
try {
  const backend = await invoke("llama_backend_info");
  const llamaStartStartedAt = performance.now();
  const startStatus = await invoke("llama_start", {
    binary: llamaBinary,
    hfModel: null,
    modelPath: localModelPath,
    ctx: 8192,
    port: 8090,
    backend: "auto",
    nGpuLayers: null,
    chatTemplate: null,
  });
  llamaStarted = startStatus?.running === true;
  if (!llamaStarted || !startStatus?.pid) {
    throw new Error(
      `Shugu llama_start did not own a running child: ${JSON.stringify(startStatus)}`,
    );
  }

  const localModel = await waitForLlamaModel(90_000);
  const llamaReadyMs = Math.round(performance.now() - llamaStartStartedAt);

  const localChatStartedAt = performance.now();
  const localReply = await invoke("chat_send", {
    messages: [
      {
        role: "user",
        content:
          "Réponds exactement par LIVE_LOCAL_CHAT_OK, sans aucun autre texte.",
      },
    ],
    model: localModel,
    protocol: "openai",
    baseUrl: "http://127.0.0.1:8090",
    apiKey: null,
    conversationId: `live-local-${Date.now()}`,
    chatTemplateKwargs: { enable_thinking: false },
    reasoningEffort: null,
    attachedImage: null,
    readTools: false,
    writeTools: false,
    fallbackModel: null,
    fallbackProtocol: null,
    fallbackBaseUrl: null,
    fallbackApiKey: null,
  });
  const localChatMs = Math.round(performance.now() - localChatStartedAt);
  if (
    typeof localReply !== "string" ||
    !localReply.toUpperCase().includes("LIVE_LOCAL_CHAT_OK")
  ) {
    throw new Error(
      `Shugu local chat returned an unexpected answer (length=${String(localReply ?? "").length})`,
    );
  }
  localResult = {
    backend,
    pid: startStatus.pid,
    model: localModel,
    modelBytes: Number(process.env.SHUGU_LIVE_MODEL_BYTES ?? 0),
    readyMs: llamaReadyMs,
    chatMs: localChatMs,
    replyLength: localReply.length,
    sentinelMatched: true,
  };
} finally {
  if (llamaStarted) {
    const stopped = await invoke("llama_stop").catch(() => null);
    if (stopped?.running !== false) {
      throw new Error(
        `Shugu llama_stop did not confirm shutdown: ${JSON.stringify(stopped)}`,
      );
    }
  }
}

await new Promise((resolve) => setTimeout(resolve, 1_000));
let agentLlamaStarted = false;
let fullAccessGranted = false;
let agentResult;
try {
  const agentServerStartedAt = performance.now();
  const startStatus = await invoke("llama_start", {
    binary: llamaBinary,
    hfModel: agentHfModel,
    modelPath: null,
    // The full runtime contract + reduced tool schemas tokenize slightly above
    // 8k on Mistral v3. Both live agent models support at least 32k, so keep a
    // real execution margin instead of truncating the controller contract.
    ctx: 32768,
    port: 8090,
    backend: "auto",
    nGpuLayers: null,
    chatTemplate: agentHfModel.toLowerCase().includes("mistral")
      ? "mistral-v3"
      : null,
  });
  agentLlamaStarted = startStatus?.running === true;
  if (!agentLlamaStarted || !startStatus?.pid) {
    throw new Error(
      `Shugu agent llama_start did not own a running child: ${JSON.stringify(startStatus)}`,
    );
  }
  // First download is several GB; subsequent runs reuse llama.cpp's cache.
  const agentModel = await waitForLlamaModel(30 * 60_000);
  const propsResponse = await fetch("http://127.0.0.1:8090/props", {
    signal: AbortSignal.timeout(5_000),
  });
  if (!propsResponse.ok) {
    throw new Error(
      `llama.cpp /props failed for the live agent (${propsResponse.status})`,
    );
  }
  const agentProps = await propsResponse.json();
  const loadedContext =
    agentProps?.n_ctx ??
    agentProps?.default_generation_settings?.n_ctx ??
    null;
  const templateProof = {
    nCtx: loadedContext,
    hasChatTemplate:
      typeof agentProps?.chat_template === "string" &&
      agentProps.chat_template.length > 0,
    hasToolUseTemplate:
      typeof agentProps?.chat_template_tool_use === "string" &&
      agentProps.chat_template_tool_use.length > 0,
  };
  writeFileSync(
    `${outDir}/agent-server-props.json`,
    `${JSON.stringify(templateProof, null, 2)}\n`,
  );
  if (typeof loadedContext !== "number" || loadedContext < 32_768) {
    throw new Error(
      `llama.cpp reported an insufficient live-agent context: ${JSON.stringify(templateProof)}`,
    );
  }
  const agentServerReadyMs = Math.round(
    performance.now() - agentServerStartedAt,
  );
  const capabilities = await invoke("model_capabilities", {
    protocol: "openai",
    model: agentModel,
  });
  if (
    capabilities?.supportsTools !== true ||
    capabilities?.agentLoop === "chatOnly"
  ) {
    throw new Error(
      `Downloaded model is not agent-capable in Shugu: ${JSON.stringify(capabilities)}`,
    );
  }

  const canonicalWorkspace = await invoke("fs_set_workspace_root", {
    path: agentWorkspace,
  });
  const dialogHelperPath = fileURLToPath(
    new URL("./accept-full-access-dialog.ps1", import.meta.url),
  );
  const dialogHelper = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      dialogHelperPath,
      "-TimeoutSeconds",
      "45",
    ],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  const dialogAutomation = waitForChild(dialogHelper, 60_000);
  fullAccessGranted = await invoke("agent_enable_full_access");
  const dialogProof = await dialogAutomation;
  if (
    fullAccessGranted !== true ||
    (await invoke("agent_full_access_status")) !== true
  ) {
    throw new Error("native Full Access session grant was not enabled");
  }
  const agentStartedAt = performance.now();
  const agentId = await invoke("agent_spawn", {
    args: {
      role: "coder",
      task: "Travaille directement dans le workspace et ne touche à aucun autre fichier. Commence par enregistrer un plan court avec todo_write dans un tour séparé. Crée ensuite agent-proof.txt avec exactement LIVE_AGENT_OK, sans guillemets et sans saut de ligne. Vérifie réellement ce contenu avec run_command en exécutant exactement `cmd.exe /d /c type agent-proof.txt` après l'écriture. N'appelle pas submit_plan et ne pose aucune question. Termine uniquement après cette vérification verte.",
      model: agentModel,
      parentId: null,
      conversationId: `live-agent-${Date.now()}`,
      protocol: "openai",
      baseUrl: "http://127.0.0.1:8090",
      apiKey: null,
      chatTemplateKwargs: { enable_thinking: false },
      designContext: null,
      agentDefPath: null,
      mode: "agent",
      executionProfile: "fullAccess",
      advisorModel: null,
      advisorProtocol: null,
      advisorBaseUrl: null,
      advisorApiKey: null,
      isolate: false,
    },
  });
  if (typeof agentId !== "string" || !agentId) {
    throw new Error(
      `agent_spawn returned an invalid id: ${JSON.stringify(agentId)}`,
    );
  }

  let transcript;
  const agentDeadline = Date.now() + 10 * 60_000;
  while (Date.now() < agentDeadline) {
    transcript = await invoke("agent_get_transcript", { agentId });
    if (["complete", "error", "killed"].includes(transcript?.agent?.status))
      break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  writeFileSync(
    `${outDir}/agent-transcript.json`,
    JSON.stringify(transcript ?? null, null, 2),
  );
  if (!transcript || transcript?.agent?.status !== "complete") {
    throw new Error(
      `live agent did not complete: ${JSON.stringify({
        status: transcript?.agent?.status,
        error: transcript?.agent?.error,
      })}`,
    );
  }

  const proofPath = `${agentWorkspace}\\agent-proof.txt`;
  const proofContent = readFileSync(proofPath, "utf8").replace(/\r\n/g, "\n");
  if (proofContent !== "LIVE_AGENT_OK") {
    throw new Error(
      `live agent proof file has unexpected content (length=${proofContent.length})`,
    );
  }
  const parsedEvents = transcript.events.map((row) => {
    try {
      return JSON.parse(row.payload);
    } catch {
      return null;
    }
  });
  const toolCalls = parsedEvents.filter((event) => event?.kind === "toolCall");
  const toolResults = parsedEvents.filter(
    (event) => event?.kind === "toolResult",
  );
  const orderedToolNames = toolCalls.map((event) => event.tool).filter(Boolean);
  const toolNames = [...new Set(orderedToolNames)];
  const planIndex = orderedToolNames.indexOf("todo_write");
  const mutationIndex = orderedToolNames.findIndex(
    (name, index) =>
      index > planIndex && (name === "fs_write_file" || name === "fs_edit"),
  );
  const verificationIndex = orderedToolNames.findIndex(
    (name, index) => index > mutationIndex && name === "run_command",
  );
  if (
    toolCalls.length === 0 ||
    toolResults.length === 0 ||
    planIndex < 0 ||
    mutationIndex < 0 ||
    verificationIndex < 0 ||
    toolNames.includes("submit_plan")
  ) {
    throw new Error(
      `live agent completed without persisted plan -> mutation -> verification proof: ${JSON.stringify(
        {
          toolCalls: toolCalls.length,
          toolResults: toolResults.length,
          orderedToolNames,
        },
      )}`,
    );
  }
  agentResult = {
    id: agentId,
    model: agentModel,
    hfModel: agentHfModel,
    pid: startStatus.pid,
    canonicalWorkspace,
    serverReadyMs: agentServerReadyMs,
    serverProps: templateProof,
    runMs: Math.round(performance.now() - agentStartedAt),
    status: transcript.agent.status,
    executionProfile: transcript.agent.executionProfile,
    profileVerified: transcript.agent.profileVerified,
    fullAccessDialog: dialogProof,
    toolCalls: toolCalls.length,
    toolResults: toolResults.length,
    toolNames,
    orderedToolNames,
    cycleVerified: true,
    proofFile: "agent-proof.txt",
    proofBytes: Buffer.byteLength(proofContent),
    sentinelMatched: true,
  };
} finally {
  if (fullAccessGranted) {
    const disabled = await invoke("agent_disable_full_access").catch(
      () => null,
    );
    if (
      disabled !== false ||
      (await invoke("agent_full_access_status").catch(() => null)) !== false
    ) {
      throw new Error(
        "Full Access session grant did not revoke after the test",
      );
    }
  }
  if (agentLlamaStarted) {
    const stopped = await invoke("llama_stop").catch(() => null);
    if (stopped?.running !== false) {
      throw new Error(
        `Shugu agent llama_stop did not confirm shutdown: ${JSON.stringify(stopped)}`,
      );
    }
  }
}

if (pageErrors.length || consoleErrors.length || failedRequests.length) {
  throw new Error(
    JSON.stringify({ pageErrors, consoleErrors, failedRequests }),
  );
}

const summary = {
  cdpUrl,
  codex: codexResult,
  local: localResult,
  agent: agentResult,
  pageErrors,
  consoleErrors,
  failedRequests,
  completedAt: new Date().toISOString(),
};
writeFileSync(
  `${outDir}/summary.json`,
  `${JSON.stringify(summary, null, 2)}\n`,
);
await browser.close();
console.log(`Live provider smoke OK — ${outDir}`);
