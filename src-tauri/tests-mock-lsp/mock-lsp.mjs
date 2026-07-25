// Mock LSP server for P6.12 tests — speaks Content-Length JSON-RPC on stdio.
// Protocol coverage: initialize / initialized / textDocument/didOpen|didChange →
// publishDiagnostics (1 deliberate error, or 60 when MOCK_MANY=1) /
// textDocument/definition / textDocument/references / shutdown / exit.

let buffer = Buffer.alloc(0);
let initialized = false;

function send(obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  process.stdout.write(`Content-Length: ${payload.length}\r\n\r\n`);
  process.stdout.write(payload);
}

function publishDiagnostics(uri) {
  // The URI keeps this test mode local to one mock process/request. Using a
  // process-wide environment variable made parallel Rust tests race.
  const many = uri.endsWith("/many.ts");
  const diagnostics = many
    ? Array.from({ length: 60 }, (_, i) => ({
        range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } },
        severity: 2,
        code: `ts${9000 + i}`,
        message: `warning ${i}`,
        source: "mock-ls",
      }))
    : [
        {
          range: { start: { line: 2, character: 4 }, end: { line: 2, character: 11 } },
          severity: 1,
          code: "ts2304",
          message: "Cannot find name 'fooBar'.",
          source: "mock-ls",
        },
      ];
  send({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics },
  });
}

function handle(msg) {
  let obj;
  try {
    obj = JSON.parse(msg);
  } catch {
    return;
  }
  if (obj.method === "initialize") {
    if (initialized) {
      send({ jsonrpc: "2.0", id: obj.id, error: { code: -32002, message: "already initialized" } });
    } else {
      initialized = true;
      send({ jsonrpc: "2.0", id: obj.id, result: { capabilities: {} } });
    }
  } else if (
    obj.method === "textDocument/didOpen" ||
    obj.method === "textDocument/didChange"
  ) {
    const uri = obj.params?.textDocument?.uri;
    if (uri) setTimeout(() => publishDiagnostics(uri), 30);
  } else if (obj.method === "textDocument/definition") {
    send({
      jsonrpc: "2.0",
      id: obj.id,
      result: [
        {
          uri: obj.params?.textDocument?.uri ?? "file:///unknown",
          range: {
            start: { line: 2, character: 4 },
            end: { line: 2, character: 11 },
          },
        },
      ],
    });
  } else if (obj.method === "textDocument/references") {
    const uri = obj.params?.textDocument?.uri ?? "file:///unknown";
    send({
      jsonrpc: "2.0",
      id: obj.id,
      result: [
        { uri, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 11 } } },
        { uri, range: { start: { line: 9, character: 2 }, end: { line: 9, character: 9 } } },
      ],
    });
  } else if (obj.method === "shutdown") {
    send({ jsonrpc: "2.0", id: obj.id, result: null });
  } else if (obj.method === "exit") {
    process.exit(0);
  }
}

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return;
    const header = buffer.subarray(0, headerEnd).toString("utf8");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      buffer = buffer.subarray(headerEnd + 4);
      continue;
    }
    const length = Number(match[1]);
    if (buffer.length < headerEnd + 4 + length) return;
    const payload = buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
    buffer = buffer.subarray(headerEnd + 4 + length);
    handle(payload);
  }
});
