// evals/test/live-loop.test.mjs
//
// End-to-end exercise of the LIVE agent loop (runAgentTask) WITHOUT a real
// provider: a local HTTP server impersonates the Anthropic Messages API and
// returns a scripted tool-use sequence (write the file, run the test, finish).
// This proves the loop, the wire format, the tool dispatch, and the
// sandbox/verify plumbing all work together — the thing self-check alone
// can't cover (self-check skips the model + tool loop).
//
// Run: node --test evals/test/live-loop.test.mjs

import test from "node:test";
import assert from "node:assert";
import http from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { runAgentTask } from "../lib/agent.mjs";
import { runVerify } from "../lib/sandbox.mjs";

// A scripted "model": each call returns the next turn from a queue.
function makeServer(turns) {
  let i = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const turn = turns[Math.min(i, turns.length - 1)];
      i++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(turn));
    });
  });
  return server;
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

test("runAgentTask drives a scripted provider to a passing solution", async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "shugu-live-"));

  // Anthropic-shaped responses: turn 1 writes the file, turn 2 runs the test,
  // turn 3 finishes (no tool calls).
  const fileContent =
    "function fizzbuzz(n){const o=[];for(let i=1;i<=n;i++){o.push(i%15===0?'FizzBuzz':i%3===0?'Fizz':i%5===0?'Buzz':String(i));}return o;}\nmodule.exports={fizzbuzz};\n";
  const turns = [
    {
      stop_reason: "tool_use",
      usage: { input_tokens: 10, output_tokens: 5 },
      content: [
        { type: "text", text: "Writing the file." },
        {
          type: "tool_use",
          id: "t1",
          name: "fs_write_file",
          input: { path: "fizzbuzz.js", content: fileContent },
        },
      ],
    },
    {
      stop_reason: "tool_use",
      usage: { input_tokens: 8, output_tokens: 4 },
      content: [
        {
          type: "tool_use",
          id: "t2",
          name: "run_command",
          input: { command: "node --test verify.test.js" },
        },
      ],
    },
    {
      stop_reason: "end_turn",
      usage: { input_tokens: 6, output_tokens: 3 },
      content: [{ type: "text", text: "Done — fizzbuzz.js written and the test passes." }],
    },
  ];

  const server = makeServer(turns);
  const port = await listen(server);

  try {
    // Seed the sandbox with the golden verify test for fizzbuzz.
    await fs.copyFile(
      path.resolve(import.meta.dirname, "..", "tasks", "fizzbuzz", "fixture", "verify.test.js"),
      path.join(sandbox, "verify.test.js"),
    );

    const provider = {
      protocol: "anthropic",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "scripted",
      apiKey: "test",
      providerId: "anthropic",
    };

    const result = await runAgentTask({
      provider,
      sandboxRoot: sandbox,
      task: "Implement fizzbuzz.js",
      verifyCommand: "node --test verify.test.js",
      maxIterations: 6,
    });

    assert.strictEqual(result.stopReason, "done");
    assert.strictEqual(result.toolCalls, 2);
    assert.strictEqual(result.toolErrors, 0);
    assert.ok(result.iterations >= 3);
    assert.strictEqual(result.usage.input, 24);

    // Ground truth: the file the agent wrote actually passes the verify command.
    const v = await runVerify("node --test verify.test.js", sandbox, 60);
    assert.strictEqual(v.pass, true, `verify failed: exit ${v.code}\n${v.stdout}\n${v.stderr}`);
  } finally {
    server.close();
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("runAgentTask drives an OpenAI-format scripted provider", async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "shugu-live-oai-"));
  const turns = [
    {
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "writing",
            tool_calls: [
              {
                id: "c1",
                type: "function",
                function: {
                  name: "fs_write_file",
                  arguments: JSON.stringify({ path: "hi.txt", content: "ok" }),
                },
              },
            ],
          },
        },
      ],
    },
    {
      usage: { prompt_tokens: 6, completion_tokens: 3 },
      choices: [{ finish_reason: "stop", message: { content: "done" } }],
    },
  ];
  const server = makeServer(turns);
  const port = await listen(server);
  try {
    const provider = {
      protocol: "openai",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "scripted",
      apiKey: "test",
      providerId: "openai",
    };
    const result = await runAgentTask({
      provider,
      sandboxRoot: sandbox,
      task: "write hi.txt",
      maxIterations: 5,
    });
    assert.strictEqual(result.stopReason, "done");
    assert.strictEqual(result.toolCalls, 1);
    const written = await fs.readFile(path.join(sandbox, "hi.txt"), "utf8");
    assert.strictEqual(written, "ok");
  } finally {
    server.close();
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("runAgentTask reports a provider error as stopReason=error", async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "shugu-live-err-"));
  const server = http.createServer((req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "boom" }));
  });
  const port = await listen(server);
  try {
    const provider = {
      protocol: "anthropic",
      baseUrl: `http://127.0.0.1:${port}`,
      model: "scripted",
      apiKey: "test",
      providerId: "anthropic",
    };
    const result = await runAgentTask({
      provider,
      sandboxRoot: sandbox,
      task: "anything",
      maxIterations: 3,
    });
    assert.strictEqual(result.stopReason, "error");
    assert.match(result.error, /anthropic 500/);
  } finally {
    server.close();
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});
