/**
 * src/server/http/server.ts
 *
 * HTTP + WebSocket server that wires the ConfigStore and SshSessionManager
 * behind bearer-token auth.
 *
 * Security notes:
 *  - Tokens are compared with timingSafeEqual; no early-exit short circuit.
 *  - Secrets (passwords, passphrases, key paths) are never emitted over HTTP
 *    or WebSocket. All space responses pass through toPublicSpace().
 *  - Request bodies are capped at 256 KiB before parsing.
 */

import { timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { createServer as createHttpServer, type IncomingMessage, type Server } from "node:http";
import { extname, join } from "node:path";
import { URL } from "node:url";
import { WebSocketServer } from "ws";
import { z } from "zod";
import {
  AgentInputSchema,
  AgentPatchSchema,
  ClientMessageSchema,
  SpaceInputSchema,
  SpacePatchSchema,
  TabInputSchema,
  TabPatchSchema,
  toPublicSpace,
} from "../../shared/contracts.js";
import type { ConfigStore } from "../config/store.js";
import type { SshSessionManager } from "../ssh/manager.js";

// ─── constants ───────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 256 * 1024;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

// ─── public types ────────────────────────────────────────────────────────────

export interface CreateServerOptions {
  store: ConfigStore;
  manager: SshSessionManager;
  token: string;
  webRoot?: string;
}

export interface CreateServerResult {
  httpServer: Server;
  listen(port: number, host?: string): Promise<{ port: number }>;
  close(): Promise<void>;
}

// ─── auth helpers ────────────────────────────────────────────────────────────

function makeTokenBuf(token: string): Buffer {
  return Buffer.from(token, "utf8");
}

function tokenMatches(provided: string, expected: string): boolean {
  const a = makeTokenBuf(provided);
  const b = makeTokenBuf(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract the bearer token from an Authorization header. */
function bearerFromHeader(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

/** Extract token from query string (?token=…). */

// ─── body reader ─────────────────────────────────────────────────────────────

/**
 * Read the entire request body up to MAX_BODY_BYTES. Rejects with
 * { tooLarge: true } when the limit is exceeded, or a normal Error on failure.
 */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let rejected = false;

    req.on("data", (chunk: Buffer) => {
      if (rejected) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        // Don't destroy the socket: let the body drain so the response can
        // still be written. Just stop accumulating further chunks.
        rejected = true;
        const err = Object.assign(new Error("Payload Too Large"), { tooLarge: true });
        reject(err);
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      if (!rejected) reject(err);
    });
  });
}

// ─── response helpers ────────────────────────────────────────────────────────

type Res = import("node:http").ServerResponse;

function json(res: Res, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function unauthorized(res: Res): void {
  json(res, 401, { error: "unauthorized" });
}

function notFound(res: Res): void {
  json(res, 404, { error: "not_found" });
}

function methodNotAllowed(res: Res): void {
  json(res, 405, { error: "method_not_allowed" });
}

function badRequest(res: Res, message: string): void {
  json(res, 400, { error: "bad_request", message });
}

function validationFailed(res: Res, err: z.ZodError): void {
  json(res, 422, { error: "validation_failed", issues: z.treeifyError(err) });
}

// ─── parse body helper ───────────────────────────────────────────────────────

async function parseBody<T>(
  req: IncomingMessage,
  res: Res,
  schema: z.ZodType<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let raw: Buffer;
  try {
    raw = await readBody(req);
  } catch (err) {
    if ((err as { tooLarge?: boolean }).tooLarge) {
      res.setHeader("Connection", "close");
      json(res, 413, { error: "payload_too_large" });
    } else {
      badRequest(res, "failed to read request body");
    }
    return { ok: false };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    badRequest(res, "invalid JSON");
    return { ok: false };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    validationFailed(res, result.error);
    return { ok: false };
  }

  return { ok: true, value: result.data };
}

// ─── router ──────────────────────────────────────────────────────────────────

/**
 * Tiny pattern-based router.
 * Supports patterns like "/api/spaces" and "/api/spaces/:id".
 */
interface RouteMatch {
  params: Record<string, string>;
}

function matchRoute(pattern: string, pathname: string): RouteMatch | null {
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const p = patternParts[i];
    const v = pathParts[i];
    if (p === undefined || v === undefined) return null;
    if (p.startsWith(":")) {
      params[p.slice(1)] = v;
    } else if (p !== v) {
      return null;
    }
  }
  return { params };
}

// ─── static file serving ─────────────────────────────────────────────────────

async function serveStatic(webRoot: string, pathname: string, res: Res): Promise<boolean> {
  // Security: never navigate above webRoot
  const safePath = pathname.replace(/\.\./g, "");
  const filePath = join(webRoot, safePath);

  const tryFile = async (fp: string): Promise<boolean> => {
    try {
      const s = await stat(fp);
      if (!s.isFile()) return false;
      const ext = extname(fp).toLowerCase();
      const mime = MIME[ext] ?? "application/octet-stream";
      const data = await readFile(fp);
      res.writeHead(200, { "Content-Type": mime });
      res.end(data);
      return true;
    } catch {
      return false;
    }
  };

  if (await tryFile(filePath)) return true;

  // Try index.html inside a directory
  if (await tryFile(join(filePath, "index.html"))) return true;

  // Fallback: serve index.html for non-/api paths (SPA routing)
  if (await tryFile(join(webRoot, "index.html"))) return true;

  return false;
}

// ─── CRUD resource handler ───────────────────────────────────────────────────

/** Handles GET list, POST create for /api/<resource> and PATCH/DELETE for /api/<resource>/:id. */
async function handleResource(opts: {
  req: IncomingMessage;
  res: Res;
  match: RouteMatch;
  list: () => unknown[];
  get: (id: string) => unknown;
  create: (body: unknown) => Promise<unknown>;
  update: (id: string, body: unknown) => Promise<unknown>;
  remove: (id: string) => Promise<boolean>;
  createSchema: z.ZodType;
  updateSchema: z.ZodType;
  wrapOutput?: (item: unknown) => unknown;
}): Promise<void> {
  const { req, res, match, list, get, create, update, remove, createSchema, updateSchema } = opts;
  const wrapOutput = opts.wrapOutput ?? ((x) => x);

  const id = match.params.id;
  const method = req.method ?? "GET";

  // ── Collection (no :id) ──────────────────────────────────────────────────
  if (id === undefined) {
    if (method === "GET") {
      json(res, 200, list().map(wrapOutput));
      return;
    }
    if (method === "POST") {
      const parsed = await parseBody(req, res, createSchema);
      if (!parsed.ok) return;
      const item = await create(parsed.value);
      json(res, 201, wrapOutput(item));
      return;
    }
    methodNotAllowed(res);
    return;
  }

  // ── Single item (with :id) ───────────────────────────────────────────────
  if (method === "GET") {
    const item = get(id);
    if (!item) {
      notFound(res);
      return;
    }
    json(res, 200, wrapOutput(item));
    return;
  }

  if (method === "PATCH") {
    const parsed = await parseBody(req, res, updateSchema);
    if (!parsed.ok) return;
    const updated = await update(id, parsed.value);
    if (!updated) {
      notFound(res);
      return;
    }
    json(res, 200, wrapOutput(updated));
    return;
  }

  if (method === "DELETE") {
    const removed = await remove(id);
    if (!removed) {
      notFound(res);
      return;
    }
    res.writeHead(204);
    res.end();
    return;
  }

  methodNotAllowed(res);
}

// ─── createServer ────────────────────────────────────────────────────────────

export function createServer(opts: CreateServerOptions): CreateServerResult {
  const { store, manager, token, webRoot } = opts;

  const expectedToken = token;

  // noServer=true: we intercept the "upgrade" event ourselves for auth control.
  const wss = new WebSocketServer({ noServer: true });

  const httpServer = createHttpServer(async (req, res) => {
    const rawUrl = req.url ?? "/";
    let pathname: string;
    try {
      pathname = new URL(rawUrl, "http://localhost").pathname;
    } catch {
      pathname = rawUrl;
    }

    // ── /api routes (all require bearer auth) ───────────────────────────────
    if (pathname.startsWith("/api/")) {
      const provided = bearerFromHeader(req);
      if (!provided || !tokenMatches(provided, expectedToken)) {
        unauthorized(res);
        return;
      }

      // GET /api/health
      if (pathname === "/api/health") {
        json(res, 200, { ok: true });
        return;
      }

      // /api/spaces[/:id]
      const spacesExact = matchRoute("/api/spaces", pathname);
      const spacesItem = matchRoute("/api/spaces/:id", pathname);
      const spacesMatch = spacesExact ?? spacesItem;
      if (spacesMatch) {
        await handleResource({
          req,
          res,
          match: spacesMatch,
          list: () => store.listSpaces(),
          get: (id) => store.getSpace(id),
          create: (body) => store.createSpace(body as Parameters<typeof store.createSpace>[0]),
          update: (id, body) =>
            store.updateSpace(id, body as Parameters<typeof store.updateSpace>[1]),
          remove: (id) => store.deleteSpace(id),
          createSchema: SpaceInputSchema,
          updateSchema: SpacePatchSchema,
          wrapOutput: (item) => toPublicSpace(item as Parameters<typeof toPublicSpace>[0]),
        });
        return;
      }

      // /api/agents[/:id]
      const agentsExact = matchRoute("/api/agents", pathname);
      const agentsItem = matchRoute("/api/agents/:id", pathname);
      const agentsMatch = agentsExact ?? agentsItem;
      if (agentsMatch) {
        await handleResource({
          req,
          res,
          match: agentsMatch,
          list: () => store.listAgents(),
          get: (id) => store.getAgent(id),
          create: (body) => store.createAgent(body as Parameters<typeof store.createAgent>[0]),
          update: (id, body) =>
            store.updateAgent(id, body as Parameters<typeof store.updateAgent>[1]),
          remove: (id) => store.deleteAgent(id),
          createSchema: AgentInputSchema,
          updateSchema: AgentPatchSchema,
        });
        return;
      }

      // /api/tabs[/:id]
      const tabsExact = matchRoute("/api/tabs", pathname);
      const tabsItem = matchRoute("/api/tabs/:id", pathname);
      const tabsMatch = tabsExact ?? tabsItem;
      if (tabsMatch) {
        await handleResource({
          req,
          res,
          match: tabsMatch,
          list: () => store.listTabs(),
          get: (id) => store.getTab(id),
          create: (body) => store.createTab(body as Parameters<typeof store.createTab>[0]),
          update: (id, body) => store.updateTab(id, body as Parameters<typeof store.updateTab>[1]),
          remove: (id) => store.deleteTab(id),
          createSchema: TabInputSchema,
          updateSchema: TabPatchSchema,
        });
        return;
      }

      // unknown /api route
      notFound(res);
      return;
    }

    // ── Static files (no auth required) ─────────────────────────────────────
    if (webRoot) {
      const served = await serveStatic(webRoot, pathname, res);
      if (served) return;
    }

    // Not found
    json(res, 404, { error: "not_found" });
  });

  // ── WebSocket upgrade ──────────────────────────────────────────────────────
  httpServer.on("upgrade", (req, socket, head) => {
    const rawUrl = req.url ?? "/";
    let pathname: string;
    let searchParams: URLSearchParams;
    try {
      const u = new URL(rawUrl, "http://localhost");
      pathname = u.pathname;
      searchParams = u.searchParams;
    } catch {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    if (pathname !== "/ws") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    // Auth: check Authorization header OR ?token= query param
    const provided = bearerFromHeader(req) ?? searchParams.get("token") ?? "";
    if (!provided || !tokenMatches(provided, expectedToken)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }

    // Tab lookup
    const tabId = searchParams.get("tabId") ?? "";
    const tab = store.getTab(tabId);
    if (!tab) {
      socket.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n");
      socket.destroy();
      return;
    }

    // Auth + tab OK: complete the WebSocket upgrade
    wss.handleUpgrade(req, socket, head, (ws) => {
      const space = store.getSpace(tab.spaceId);
      if (!space) {
        ws.send(JSON.stringify({ type: "error", message: "space not found" }));
        ws.close();
        return;
      }

      const agent = tab.agentId ? store.getAgent(tab.agentId) : undefined;

      // The client may send frames as soon as it receives "ready", which can
      // race manager.openSession()'s async setup. Queue incoming client
      // messages until the session is actually open, then replay them in
      // order so no input/resize/close is silently dropped.
      let sessionOpen = false;
      const pending: Array<() => void> = [];

      const applyMessage = (msg: import("../../shared/contracts.js").ClientMessage) => {
        switch (msg.type) {
          case "input":
            manager.write(tab.id, msg.data);
            break;
          case "resize":
            manager.resize(tab.id, msg.cols, msg.rows);
            break;
          case "close":
            manager.close(tab.id).catch(() => {});
            ws.close();
            break;
        }
      };

      // Handle incoming client frames
      ws.on("message", (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw.toString());
        } catch {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "error", message: "invalid JSON frame" }));
          }
          return;
        }

        const result = ClientMessageSchema.safeParse(parsed);
        if (!result.success) {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "error", message: "invalid message schema" }));
          }
          return;
        }

        const msg = result.data;
        if (sessionOpen) {
          applyMessage(msg);
        } else {
          pending.push(() => applyMessage(msg));
        }
      });

      // When the socket closes (for any reason), clean up the SSH session
      ws.once("close", () => {
        manager.close(tab.id).catch(() => {});
      });

      // Open the SSH session, then announce readiness and flush any queued input.
      manager
        .openSession({
          tabId: tab.id,
          space,
          ...(agent ? { agent } : {}),
          cols: tab.cols,
          rows: tab.rows,
          onOutput: (chunk) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: "output", data: chunk }));
            }
          },
          onExit: (code) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: "exit", code }));
              ws.close();
            }
          },
          onError: (message) => {
            if (ws.readyState === ws.OPEN) {
              ws.send(JSON.stringify({ type: "error", message }));
              ws.close();
            }
          },
        })
        .then(() => {
          sessionOpen = true;
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "ready", tabId: tab.id }));
          }
          for (const run of pending) run();
          pending.length = 0;
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify({ type: "error", message }));
            ws.close();
          }
        });
    });
  });

  // ── listen / close ────────────────────────────────────────────────────────

  function listen(port: number, host = "127.0.0.1"): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, host, () => {
        httpServer.off("error", reject);
        const addr = httpServer.address();
        const assignedPort = addr !== null && typeof addr === "object" ? addr.port : port;
        resolve({ port: assignedPort });
      });
    });
  }

  function close(): Promise<void> {
    return new Promise((resolve, reject) => {
      wss.close(() => {
        httpServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    });
  }

  return { httpServer, listen, close };
}
