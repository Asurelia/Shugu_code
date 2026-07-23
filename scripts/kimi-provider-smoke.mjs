// Kimi K3 proof through Shugu's production Tauri IPC surface.
//
// The secret is read from Shugu's OS credential store inside the isolated
// WebView and is never written to disk, logged, or included in the summary.

import { readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const cdpUrl = process.env.SHUGU_CDP_URL;
const outDir = process.env.SHUGU_KIMI_OUT;
const workspace = process.env.SHUGU_KIMI_WORKSPACE;
const providerId = process.env.SHUGU_KIMI_PROVIDER_ID;
const model = process.env.SHUGU_KIMI_MODEL || "k3";
const resumeExisting = process.env.SHUGU_KIMI_RESUME === "1";
if (!cdpUrl || !outDir || !workspace || !providerId) {
  throw new Error(
    "SHUGU_CDP_URL, SHUGU_KIMI_OUT, SHUGU_KIMI_WORKSPACE and SHUGU_KIMI_PROVIDER_ID are required",
  );
}

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
if (!page) throw new Error("Kimi smoke: main Shugu WebView target not found");
page.setDefaultTimeout(180_000);

const invoke = (command, args = {}) =>
  page.evaluate(
    async ({ commandName, commandArgs }) => {
      const bridge = globalThis.__TAURI_INTERNALS__;
      if (!bridge?.invoke) throw new Error("Kimi smoke: Tauri IPC bridge missing");
      return bridge.invoke(commandName, commandArgs);
    },
    { commandName: command, commandArgs: args },
  );

const waitForChild = (child, timeoutMs) =>
  new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`helper timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      const out = Buffer.concat(stdout).toString("utf8").trim();
      const err = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) resolve(out);
      else reject(new Error(`helper exit ${code}: ${err || out}`));
    });
  });

await page.waitForSelector("#root", { state: "attached" });
await page.waitForFunction(
  () => (document.getElementById("root")?.childElementCount ?? 0) > 0,
);

const credentialAccount = `provider.${providerId}.apiKey`;
const apiKey = await invoke("cred_get", { account: credentialAccount });
if (typeof apiKey !== "string" || apiKey.trim().length < 8) {
  throw new Error(
    `Kimi smoke: no usable key in Shugu credential account ${credentialAccount}`,
  );
}

const baseUrl = "https://api.kimi.com/coding/v1";
const discoveryStartedAt = performance.now();
const models = await invoke("models_discover_external", {
  protocol: "openai",
  baseUrl,
  apiKey,
});
const discoveryMs = Math.round(performance.now() - discoveryStartedAt);
if (!Array.isArray(models) || !models.includes(model)) {
  throw new Error(
    `Kimi smoke: Shugu discovery did not return requested model ${model}`,
  );
}

const chatStartedAt = performance.now();
const chatReply = await invoke("chat_send", {
  messages: [
    {
      role: "user",
      content: "Reply with exactly SHUGU_KIMI_CHAT_OK and no other text.",
    },
  ],
  model,
  protocol: "openai",
  baseUrl,
  apiKey,
  conversationId: `kimi-chat-${Date.now()}`,
  chatTemplateKwargs: null,
  reasoningEffort: null,
  attachedImage: null,
  readTools: false,
  writeTools: false,
  fallbackModel: null,
  fallbackProtocol: null,
  fallbackBaseUrl: null,
  fallbackApiKey: null,
});
const chatMs = Math.round(performance.now() - chatStartedAt);
if (
  typeof chatReply !== "string" ||
  !chatReply.toUpperCase().includes("SHUGU_KIMI_CHAT_OK")
) {
  throw new Error(
    `Kimi smoke: Shugu chat returned an unexpected answer (length=${String(chatReply ?? "").length})`,
  );
}

const canonicalWorkspace = await invoke("fs_set_workspace_root", {
  path: workspace,
});
const capabilities = await invoke("model_capabilities", {
  protocol: "openai",
  model,
});
if (
  capabilities?.supportsTools !== true ||
  capabilities?.agentLoop === "chatOnly"
) {
  throw new Error(
    `Kimi smoke: Shugu classified ${model} as non-agentic: ${JSON.stringify(capabilities)}`,
  );
}

const task = resumeExisting
  ? [
      "Tu reprends l'audit UI Kimi existant dans ce workspace isolé.",
      "Commence par appeler todo_write dans un tour séparé avec un plan court.",
      "Lis BRIEF.md puis KIMI_UI_REVIEW.md avec les outils filesystem.",
      "Ne modifie aucun fichier source.",
      "Ajoute à la fin de KIMI_UI_REVIEW.md une section `## Validation E2E` contenant exactement la ligne `KIMI_FULL_ACCESS_VERIFIED`.",
      "Après l'écriture, vérifie réellement le rapport avec run_command en exécutant exactement",
      "`cmd.exe /d /c findstr /C:\"VERDICT:\" KIMI_UI_REVIEW.md`.",
      "N'appelle pas submit_plan, ne délègue pas et ne pose aucune question.",
      "Termine uniquement après une vérification verte.",
    ].join(" ")
  : [
      "Tu es le directeur UI chargé d'auditer une copie isolée de Shugu.",
      "Commence par appeler todo_write dans un tour séparé avec un plan court.",
      "Lis ensuite BRIEF.md et les huit fichiers source présents dans le workspace avec les outils filesystem.",
      "Ne modifie aucun fichier source.",
      "Crée KIMI_UI_REVIEW.md en respectant strictement les titres demandés dans BRIEF.md.",
      "Après l'écriture, vérifie réellement le rapport avec run_command en exécutant exactement",
      "`cmd.exe /d /c findstr /C:\"VERDICT:\" KIMI_UI_REVIEW.md`.",
      "N'appelle pas submit_plan, ne délègue pas et ne pose aucune question.",
      "Termine uniquement après une vérification verte.",
    ].join(" ");

const agentStartedAt = performance.now();
const dialogHelper = spawn(
  "powershell.exe",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    "scripts/accept-full-access-dialog.ps1",
    "-TimeoutSeconds",
    "45",
  ],
  { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
);
const dialogAutomation = waitForChild(dialogHelper, 60_000);
const fullAccessGranted = await invoke("agent_enable_full_access");
const dialogProof = await dialogAutomation;
if (
  fullAccessGranted !== true ||
  (await invoke("agent_full_access_status")) !== true
) {
  throw new Error("Kimi smoke: native Full Access session grant was not enabled");
}

let agentId;
let transcript;
const agentAttempts = [];
for (let attempt = 1; attempt <= 3; attempt += 1) {
  agentId = await invoke("agent_spawn", {
    args: {
      role: "coder",
      task,
      model,
      parentId: null,
      conversationId: `kimi-agent-${Date.now()}-${attempt}`,
      protocol: "openai",
      baseUrl,
      apiKey,
      chatTemplateKwargs: null,
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
    throw new Error("Kimi smoke: agent_spawn returned no agent id");
  }

  const agentDeadline = Date.now() + 12 * 60_000;
  while (Date.now() < agentDeadline) {
    transcript = await invoke("agent_get_transcript", { agentId });
    if (["complete", "error", "killed"].includes(transcript?.agent?.status)) break;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  agentAttempts.push({
    attempt,
    agentId,
    status: transcript?.agent?.status ?? "timeout",
    error: transcript?.agent?.error ?? null,
  });
  writeFileSync(
    `${outDir}/agent-transcript-attempt-${attempt}.json`,
    `${JSON.stringify(transcript ?? null, null, 2)}\n`,
  );
  if (transcript?.agent?.status === "complete") break;

  const transientOverload = /(?:429|overload|too many requests)/i.test(
    transcript?.agent?.error ?? "",
  );
  if (!transientOverload || attempt === 3) break;
  await new Promise((resolve) => setTimeout(resolve, attempt * 15_000));
}
writeFileSync(
  `${outDir}/agent-transcript.json`,
  `${JSON.stringify(transcript ?? null, null, 2)}\n`,
);
if (!transcript || transcript?.agent?.status !== "complete") {
  throw new Error(
    `Kimi smoke: agent did not complete (${transcript?.agent?.status ?? "timeout"}: ${transcript?.agent?.error ?? "no error"})`,
  );
}

const reportPath = `${workspace}\\KIMI_UI_REVIEW.md`;
const report = readFileSync(reportPath, "utf8");
for (const heading of [
  "VERDICT:",
  "Architecture d'interface proposée",
  "Cartes de connexion",
  "Sélecteur de modèle",
  "Responsive",
  "Changements fichier par fichier",
  "Critères E2E vérifiables",
]) {
  if (!report.includes(heading)) {
    throw new Error(`Kimi smoke: generated report is missing ${heading}`);
  }
}

const parsedEvents = transcript.events.map((row) => {
  try {
    return JSON.parse(row.payload);
  } catch {
    return null;
  }
});
const toolCalls = parsedEvents.filter((event) => event?.kind === "toolCall");
const toolResults = parsedEvents.filter((event) => event?.kind === "toolResult");
const orderedToolNames = toolCalls.map((event) => event.tool).filter(Boolean);
const planIndex = orderedToolNames.indexOf("todo_write");
const readIndex = orderedToolNames.findIndex(
  (name, index) => index > planIndex && name === "fs_read_file",
);
const mutationIndex = orderedToolNames.findIndex(
  (name, index) =>
    index > readIndex && (name === "fs_write_file" || name === "fs_edit"),
);
const verificationIndex = orderedToolNames.findIndex(
  (name, index) => index > mutationIndex && name === "run_command",
);
if (
  planIndex < 0 ||
  readIndex < 0 ||
  mutationIndex < 0 ||
  verificationIndex < 0 ||
  toolResults.length === 0 ||
  orderedToolNames.includes("submit_plan")
) {
  throw new Error(
    `Kimi smoke: missing plan -> read -> write -> verify proof: ${JSON.stringify(orderedToolNames)}`,
  );
}

const summary = {
  provider: "Kimi Coding",
  model,
  credentialSource: "Shugu OS credential store",
  discoveredModels: models.length,
  discoveryMs,
  chatMs,
  chatSentinelMatched: true,
  agent: {
    id: agentId,
    status: transcript.agent.status,
    executionProfile: transcript.agent.executionProfile,
    profileVerified: transcript.agent.profileVerified,
    canonicalWorkspace,
    runMs: Math.round(performance.now() - agentStartedAt),
    attempts: agentAttempts,
    fullAccessDialog: dialogProof,
    toolCalls: toolCalls.length,
    toolResults: toolResults.length,
    orderedToolNames,
    cycleVerified: true,
    report: "agent-workspace/KIMI_UI_REVIEW.md",
    reportBytes: Buffer.byteLength(report),
  },
  completedAt: new Date().toISOString(),
};

const disabled = await invoke("agent_disable_full_access");
if (
  disabled !== false ||
  (await invoke("agent_full_access_status")) !== false
) {
  throw new Error("Kimi smoke: Full Access session grant was not revoked");
}
summary.agent.fullAccessRevoked = true;
writeFileSync(
  `${outDir}/summary.json`,
  `${JSON.stringify(summary, null, 2)}\n`,
);

await browser.close();
console.log(`Kimi provider smoke OK — ${outDir}`);
