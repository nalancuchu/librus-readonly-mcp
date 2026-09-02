import test from "node:test";
import assert from "node:assert/strict";

import { createHttpApp } from "../src/http-server.js";

const TOKEN = "a".repeat(48);

async function withServer(run) {
  const app = createHttpApp({
    accessToken: TOKEN,
    rateLimitPerMinute: 100,
    serviceFactory: () => ({
      maxResults: 100,
      async listStudents() { return { students: [], count: 0 }; },
    }),
  });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const address = server.address();
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("zdalny serwer odmawia startu bez mocnego tokenu", () => {
  assert.throws(() => createHttpApp({ accessToken: "short" }), /32 znaki/);
});

test("health nie ujawnia danych i nie wymaga dostępu do Librusa", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok", service: "librus-readonly-mcp" });
  });
});

test("endpoint MCP wymaga Bearer tokenu", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(response.status, 401);
  });
});

test("endpoint MCP wykonuje handshake z poprawnym tokenem", async () => {
  await withServer(async (base) => {
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
    });
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, /librus-readonly-mcp/);
  });
});
