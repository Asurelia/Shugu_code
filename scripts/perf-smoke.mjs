// Shugu native performance smoke.
//
// Runs against a real Tauri/WebView2 process and an isolated SQLite profile.
// The fixture workspace and the OpenAI-compatible SSE provider are both local
// and deterministic. This exercises the production IPC paths without touching
// the user's workspace, database, providers, or credentials.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "@playwright/test";

const cdpUrl = process.env.SHUGU_CDP_URL;
const outDir = process.env.SHUGU_PERF_OUT;
const workspace = process.env.SHUGU_PERF_WORKSPACE;
const fixtureFileCount = Number(process.env.SHUGU_PERF_FILE_COUNT ?? 1200);
const streamChunkCount = Number(process.env.SHUGU_PERF_STREAM_CHUNKS ?? 1200);
const incrementalFileCount = Math.min(120, Math.max(1, Math.floor(fixtureFileCount / 10)));

if (!cdpUrl || !outDir || !workspace) {
  throw new Error("SHUGU_CDP_URL, SHUGU_PERF_OUT and SHUGU_PERF_WORKSPACE are required");
}
if (!Number.isInteger(fixtureFileCount) || fixtureFileCount < 100) {
  throw new Error(`invalid fixture file count: ${fixtureFileCount}`);
}
if (!Number.isInteger(streamChunkCount) || streamChunkCount < 200) {
  throw new Error(`invalid stream chunk count: ${streamChunkCount}`);
}
mkdirSync(outDir, { recursive: true });

const provider = {
  requests: 0,
  requestBodies: [],
  chunksWritten: 0,
  startedAt: 0,
  completedAt: 0,
};

const server = http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
    response.writeHead(404, { "content-type": "application/json" });
    response.end('{"error":"not found"}');
    return;
  }

  const body = [];
  request.on("data", (chunk) => body.push(chunk));
  request.on("end", () => {
    provider.requests += 1;
    try {
      provider.requestBodies.push(JSON.parse(Buffer.concat(body).toString("utf8")));
    } catch {
      provider.requestBodies.push(null);
    }
    provider.startedAt = Date.now();
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    response.flushHeaders();

    let index = 0;
    const timer = setInterval(() => {
      if (index >= streamChunkCount) {
        clearInterval(timer);
        response.write("data: [DONE]\n\n");
        response.end();
        provider.completedAt = Date.now();
        return;
      }
      const payload = {
        choices: [{ index: 0, delta: { content: "x" }, finish_reason: null }],
      };
      response.write(`data: ${JSON.stringify(payload)}\n\n`);
      provider.chunksWritten += 1;
      index += 1;
    }, 4);
    // The incoming request stream closes as soon as its POST body is consumed;
    // tying cleanup to `request.close` would cancel the SSE timer before the
    // first response chunk. Only the outgoing response lifecycle owns it.
    response.on("close", () => clearInterval(timer));
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (!address || typeof address === "string") {
  throw new Error("local provider did not expose a TCP address");
}
const providerBaseUrl = `http://127.0.0.1:${address.port}`;

let browser;
const pageErrors = [];
const consoleErrors = [];
const failedRequests = [];
let summary;

try {
  browser = await chromium.connectOverCDP(cdpUrl);
  const deadline = Date.now() + 45_000;
  let page;
  while (!page && Date.now() < deadline) {
    page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => {
        const url = candidate.url();
        return url.includes("localhost:1420") && !url.includes("mascot.html");
      });
    if (!page) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!page) {
    throw new Error(
      `main WebView target not found; targets=${browser.contexts().flatMap((c) => c.pages()).map((p) => p.url()).join(", ")}`,
    );
  }

  page.on("pageerror", (error) => pageErrors.push(`${error.name}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("requestfailed", (request) =>
    failedRequests.push(`${request.method()} ${request.url()}: ${request.failure()?.errorText ?? "unknown"}`),
  );

  await page.waitForFunction(
    () => Boolean(globalThis.__TAURI_INTERNALS__?.invoke && document.querySelector("#root")?.children.length),
    undefined,
    { timeout: 45_000 },
  );

  const full = await page.evaluate(
    async ({ workspacePath, providerUrl, expectedFiles, expectedChunks }) => {
      const { invoke, listen } = await import("/src/lib/tauri.ts");
      const { indexWorkspace, reindexWorkspace } = await import(
        "/src/features/fs/workspaceIndexer.ts"
      );

      const canonicalWorkspace = await invoke("fs_set_workspace_root", { path: workspacePath });
      const deltas = [];
      const startedAt = performance.now();
      const heartbeat = [];
      let lastHeartbeat = startedAt;
      const heartbeatTimer = setInterval(() => {
        const now = performance.now();
        heartbeat.push(now - lastHeartbeat);
        lastHeartbeat = now;
      }, 16);
      const unlisten = await listen("chat://delta", (payload) => {
        if (payload?.conversationId === "perf-smoke-conversation") {
          deltas.push({ ...payload, at: performance.now() });
        }
      });

      let indexedChunks;
      let reply;
      try {
        [indexedChunks, reply] = await Promise.all([
          reindexWorkspace(),
          invoke("chat_send", {
            messages: [{ role: "user", content: "Stream a deterministic performance payload." }],
            model: "gpt-4o-mini",
            protocol: "openai",
            baseUrl: providerUrl,
            apiKey: "",
            conversationId: "perf-smoke-conversation",
            readTools: false,
            writeTools: false,
          }),
        ]);
      } finally {
        clearInterval(heartbeatTimer);
        unlisten();
      }
      const fullCompletedAt = performance.now();

      const warmStartedAt = performance.now();
      await indexWorkspace();
      const warmCompletedAt = performance.now();

      const listing = await invoke("fs_list_files", {
        excludeExts: [],
        maxFiles: expectedFiles + 50,
      });
      const staleAfterWarm = await invoke("vec_stale_paths", {
        paths: listing.paths,
        truncated: listing.truncated,
      });
      const searchStartedAt = performance.now();
      const searchHits = await invoke("semantic_search", {
        query: "deterministic semantic performance sentinel module",
        k: 8,
      });
      const searchCompletedAt = performance.now();

      const contentDeltas = deltas.filter((delta) => !delta.done && delta.kind === "content");
      const doneDeltas = deltas.filter((delta) => delta.done);
      const eventText = contentDeltas.map((delta) => delta.chunk).join("");
      const eventGaps = contentDeltas.slice(1).map((delta, index) => delta.at - contentDeltas[index].at);

      return {
        canonicalWorkspace,
        indexedChunks,
        expectedFiles,
        expectedChunks,
        listing: {
          count: listing.paths.length,
          truncated: listing.truncated,
          totalSeen: listing.totalSeen,
        },
        staleAfterWarm: {
          stale: staleAfterWarm.stale.length,
          deleted: staleAfterWarm.deleted.length,
          fresh: staleAfterWarm.fresh,
        },
        searchHits,
        fullDurationMs: fullCompletedAt - startedAt,
        warmDurationMs: warmCompletedAt - warmStartedAt,
        searchDurationMs: searchCompletedAt - searchStartedAt,
        stream: {
          replyLength: reply.length,
          eventTextLength: eventText.length,
          contentEvents: contentDeltas.length,
          doneEvents: doneDeltas.length,
          firstDeltaMs: contentDeltas.length ? contentDeltas[0].at - startedAt : null,
          maxDeltaGapMs: eventGaps.length ? Math.max(...eventGaps) : 0,
        },
        renderer: {
          heartbeatSamples: heartbeat.length,
          maxHeartbeatGapMs: heartbeat.length ? Math.max(...heartbeat) : 0,
          jsHeapUsedBytes: performance.memory?.usedJSHeapSize ?? null,
          jsHeapLimitBytes: performance.memory?.jsHeapSizeLimit ?? null,
        },
      };
    },
    {
      workspacePath: workspace,
      providerUrl: providerBaseUrl,
      expectedFiles: fixtureFileCount,
      expectedChunks: streamChunkCount,
    },
  );

  // Modify 10% of the fixture outside Tauri. The watcher intentionally waits
  // 1.5 s before background reindexing; the immediate IPC diff below must see
  // the stale files and reconcile them in one foreground pass.
  for (let index = 0; index < incrementalFileCount; index += 1) {
    const dir = `module-${String(Math.floor(index / 40)).padStart(3, "0")}`;
    const file = `file-${String(index).padStart(4, "0")}.ts`;
    const sentinel =
      index === 0
        ? '\nexport const perfMutation = "SHUGU_PERF_MUTATION_SENTINEL";\n'
        : `\nexport const perfMutation${index} = ${index};\n`;
    appendFileSync(path.join(workspace, dir, file), sentinel, "utf8");
  }

  const incremental = await page.evaluate(async ({ expectedFiles, expectedStale }) => {
    const { invoke } = await import("/src/lib/tauri.ts");
    const { indexWorkspace } = await import("/src/features/fs/workspaceIndexer.ts");
    const listing = await invoke("fs_list_files", {
      excludeExts: [],
      maxFiles: expectedFiles + 50,
    });
    const staleBefore = await invoke("vec_stale_paths", {
      paths: listing.paths,
      truncated: listing.truncated,
    });
    const startedAt = performance.now();
    await indexWorkspace();
    const completedAt = performance.now();
    const staleAfter = await invoke("vec_stale_paths", {
      paths: listing.paths,
      truncated: listing.truncated,
    });
    const searchStartedAt = performance.now();
    const searchHits = await invoke("semantic_search", {
      query: "SHUGU PERF MUTATION SENTINEL",
      k: 8,
    });
    return {
      expectedStale,
      staleBefore: {
        stale: staleBefore.stale.length,
        deleted: staleBefore.deleted.length,
        fresh: staleBefore.fresh,
      },
      staleAfter: {
        stale: staleAfter.stale.length,
        deleted: staleAfter.deleted.length,
        fresh: staleAfter.fresh,
      },
      durationMs: completedAt - startedAt,
      searchDurationMs: performance.now() - searchStartedAt,
      searchHits,
    };
  }, { expectedFiles: fixtureFileCount, expectedStale: incrementalFileCount });

  const failures = [];
  if (provider.requests !== 1) failures.push(`provider requests=${provider.requests}, expected 1`);
  if (provider.chunksWritten !== streamChunkCount) {
    failures.push(`provider chunks=${provider.chunksWritten}, expected ${streamChunkCount}`);
  }
  if (provider.requestBodies[0]?.stream !== true) failures.push("provider request was not streaming");
  if (full.listing.count !== fixtureFileCount || full.listing.truncated) {
    failures.push(
      `workspace listing=${full.listing.count}, truncated=${full.listing.truncated}, expected ${fixtureFileCount}`,
    );
  }
  if (full.indexedChunks < fixtureFileCount) {
    failures.push(`indexed chunks=${full.indexedChunks}, expected at least ${fixtureFileCount}`);
  }
  if (
    full.staleAfterWarm.stale !== 0
    || full.staleAfterWarm.deleted !== 0
    || full.staleAfterWarm.fresh !== fixtureFileCount
  ) {
    failures.push(`warm index is not clean: ${JSON.stringify(full.staleAfterWarm)}`);
  }
  if (full.fullDurationMs > 600_000) failures.push(`full index exceeded 600 s: ${full.fullDurationMs}`);
  if (full.warmDurationMs > 15_000) failures.push(`warm index exceeded 15 s: ${full.warmDurationMs}`);
  if (full.searchDurationMs > 10_000 || full.searchHits.length === 0) {
    failures.push(`semantic search invalid: ${full.searchDurationMs} ms, ${full.searchHits.length} hits`);
  }
  if (
    full.stream.replyLength !== streamChunkCount
    || full.stream.eventTextLength !== streamChunkCount
    || full.stream.doneEvents !== 1
  ) {
    failures.push(`stream content contract failed: ${JSON.stringify(full.stream)}`);
  }
  if (full.stream.contentEvents < 10 || full.stream.contentEvents >= streamChunkCount / 2) {
    failures.push(`stream coalescing ineffective: ${full.stream.contentEvents} events`);
  }
  if (full.stream.firstDeltaMs == null || full.stream.firstDeltaMs > 2_500) {
    failures.push(`first stream delta too slow: ${full.stream.firstDeltaMs} ms`);
  }
  if (full.stream.maxDeltaGapMs > 1_500) {
    failures.push(`stream stalled during indexing: ${full.stream.maxDeltaGapMs} ms`);
  }
  if (full.renderer.heartbeatSamples < 10 || full.renderer.maxHeartbeatGapMs > 2_500) {
    failures.push(`renderer heartbeat stalled: ${JSON.stringify(full.renderer)}`);
  }
  if (incremental.staleBefore.stale < incrementalFileCount * 0.8) {
    failures.push(
      `incremental diff saw only ${incremental.staleBefore.stale}/${incrementalFileCount} stale files`,
    );
  }
  if (
    incremental.staleAfter.stale !== 0
    || incremental.staleAfter.deleted !== 0
    || incremental.staleAfter.fresh !== fixtureFileCount
  ) {
    failures.push(`incremental index is not clean: ${JSON.stringify(incremental.staleAfter)}`);
  }
  if (incremental.durationMs > 120_000) {
    failures.push(`incremental index exceeded 120 s: ${incremental.durationMs}`);
  }
  if (incremental.searchDurationMs > 10_000 || incremental.searchHits.length === 0) {
    failures.push(
      `incremental semantic search invalid: ${incremental.searchDurationMs} ms, ${incremental.searchHits.length} hits`,
    );
  }
  if (pageErrors.length || consoleErrors.length || failedRequests.length) {
    failures.push(
      [
        ...pageErrors.map((message) => `page: ${message}`),
        ...consoleErrors.map((message) => `console: ${message}`),
        ...failedRequests.map((message) => `request: ${message}`),
      ].join("\n"),
    );
  }

  summary = {
    cdpUrl,
    mainUrl: page.url(),
    fixture: {
      workspace,
      files: fixtureFileCount,
      incrementallyModified: incrementalFileCount,
    },
    provider: {
      url: providerBaseUrl,
      requests: provider.requests,
      chunksWritten: provider.chunksWritten,
      streamDurationMs:
        provider.completedAt && provider.startedAt ? provider.completedAt - provider.startedAt : null,
      requestStreamFlag: provider.requestBodies[0]?.stream ?? null,
    },
    full,
    incremental,
    pageErrors,
    consoleErrors,
    failedRequests,
    failures,
    completedAt: new Date().toISOString(),
  };
  writeFileSync(`${outDir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  await page.screenshot({ path: `${outDir}/performance-shell.png`, fullPage: false });
  if (failures.length) throw new Error(`performance budgets failed:\n${failures.join("\n")}`);
  console.log(`Native performance smoke OK — ${outDir}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  if (browser) await browser.close().catch(() => {});
}
