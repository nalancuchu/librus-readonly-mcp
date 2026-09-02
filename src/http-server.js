#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { rateLimit } from "express-rate-limit";

import { LibrusReadOnlyService } from "./librus-service.js";
import { createServer } from "./server.js";

export function createHttpApp(options = {}) {
  const accessToken = options.accessToken ?? process.env.MCP_ACCESS_TOKEN;
  const allowInsecure = options.allowInsecure ?? process.env.ALLOW_INSECURE_HTTP === "true";
  if ((!accessToken || accessToken.length < 32) && !allowInsecure) {
    throw new Error("MCP_ACCESS_TOKEN musi mieć co najmniej 32 znaki.");
  }

  const maxPerMinute = options.rateLimitPerMinute ?? positiveInt(
    process.env.MCP_RATE_LIMIT_PER_MINUTE, 30, 1, 300,
  );
  const app = createMcpExpressApp();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(rateLimit({
    windowMs: 60_000,
    limit: maxPerMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
  }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok", service: "librus-readonly-mcp" });
  });

  app.all("/mcp", bearerAuth(accessToken, allowInsecure), async (req, res) => {
    if (!["POST", "GET", "DELETE"].includes(req.method)) {
      res.set("Allow", "POST, GET, DELETE").status(405).send("Method Not Allowed");
      return;
    }
    if (req.method !== "POST") {
      res.status(405).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "This server uses stateless Streamable HTTP; send POST requests." },
        id: null,
      });
      return;
    }

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const service = options.serviceFactory
      ? options.serviceFactory()
      : new LibrusReadOnlyService({ attachmentMode: "inline" });
    const server = createServer(service);
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      process.stderr.write(`[librus-readonly-mcp] HTTP MCP error: ${safeError(error)}\n`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
      }
    }
  });
  return app;
}

function bearerAuth(expectedToken, allowInsecure) {
  const expected = expectedToken ? createHash("sha256").update(expectedToken).digest() : null;
  return (req, res, next) => {
    if (allowInsecure && !expected) return next();
    const header = req.headers.authorization;
    const supplied = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    const actual = createHash("sha256").update(supplied).digest();
    if (!expected || !timingSafeEqual(expected, actual)) {
      res.set("WWW-Authenticate", 'Bearer realm="librus-readonly-mcp"').status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

function positiveInt(raw, fallback, min, max) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Wartość musi być liczbą całkowitą od ${min} do ${max}.`);
  }
  return value;
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [REDACTED]")
    .slice(0, 500);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = positiveInt(process.env.PORT, 3000, 1, 65535);
  const app = createHttpApp();
  const httpServer = app.listen(port, "0.0.0.0", () => {
    process.stderr.write(`[librus-readonly-mcp] Streamable HTTP listening on port ${port}\n`);
  });
  const shutdown = () => httpServer.close(() => process.exit(0));
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
