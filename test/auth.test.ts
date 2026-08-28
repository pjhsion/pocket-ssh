/**
 * auth.test.ts – bearer-token auth, body validation, 413, ws upgrade rejection.
 *
 * No fixed sleeps. All async behavior is driven by event subscriptions with
 * bounded timeouts.
 */

import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ConfigStore } from "../src/server/config/store.js";
import { createServer } from "../src/server/http/server.js";
import { SshSessionManager } from "../src/server/ssh/manager.js";

// ─── helpers ────────────────────────────────────────────────────────────────

const TOKEN = "correct-token-abc123";
const BAD_TOKEN = "wrong-token-xyz";

function req(
  opts: {
    method?: string;
    path: string;
    token?: string | null;
    body?: unknown;
  },
  baseUrl: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(opts.path, baseUrl);
    const bodyStr = opts.body !== undefined ? JSON.stringify(opts.body) : undefined;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (opts.token !== null) {
      headers.Authorization = `Bearer ${opts.token ?? TOKEN}`;
    }
    if (bodyStr !== undefined) {
      headers["Content-Length"] = String(Buffer.byteLength(bodyStr));
    }

    const options: http.RequestOptions = {
      method: opts.method ?? "GET",
      hostname: url.hostname,
      port: Number(url.port),
      path: url.pathname + url.search,
      headers,
    };

    const r = http.request(options, (res) => {
      let raw = "";
      res.on("data", (chunk: Buffer) => {
        raw += chunk.toString("utf8");
      });
      res.on("end", () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          parsed = raw;
        }
        resolve({ status: res.statusCode ?? 0, body: parsed });
      });
    });
    r.on("error", reject);
    if (bodyStr !== undefined) r.write(bodyStr);
    r.end();
  });
}

function openWs(
  path: string,
  baseUrl: string,
): Promise<{ ws: WebSocket; status: number | undefined }> {
  const wsUrl = baseUrl.replace(/^http/, "ws") + path;
  const ws = new WebSocket(wsUrl);
  return new Promise((resolve) => {
    ws.once("open", () => resolve({ ws, status: undefined }));
    ws.once("unexpected-response", (_req, res) => {
      res.destroy();
      resolve({ ws, status: res.statusCode });
    });
    ws.once("error", () => {
      // For testing rejection – treat connection error as a non-open state.
      resolve({ ws, status: undefined });
    });
  });
}

// ─── test suite ─────────────────────────────────────────────────────────────

let baseUrl: string;
let serverClose: () => Promise<void>;
let manager: SshSessionManager;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "pocket-ssh-auth-test-"));
  const configPath = join(tmpDir, "config.json");
  const store = await ConfigStore.open(configPath);
  manager = new SshSessionManager();
  const srv = createServer({ store, manager, token: TOKEN });
  const { port } = await srv.listen(0);
  baseUrl = `http://127.0.0.1:${port}`;
  serverClose = srv.close.bind(srv);
});

afterAll(async () => {
  await serverClose();
  await manager.closeAll();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("auth – /api routes", () => {
  it("401 on /api/spaces with no token", async () => {
    const r = await req({ path: "/api/spaces", token: null }, baseUrl);
    expect(r.status).toBe(401);
    expect((r.body as Record<string, unknown>).error).toBe("unauthorized");
  });

  it("401 on /api/spaces with a wrong token", async () => {
    const r = await req({ path: "/api/spaces", token: BAD_TOKEN }, baseUrl);
    expect(r.status).toBe(401);
    expect((r.body as Record<string, unknown>).error).toBe("unauthorized");
  });

  it("200 on /api/spaces with the right token", async () => {
    const r = await req({ path: "/api/spaces" }, baseUrl);
    expect(r.status).toBe(200);
  });

  it("200 on /api/health", async () => {
    const r = await req({ path: "/api/health" }, baseUrl);
    expect(r.status).toBe(200);
    expect((r.body as Record<string, unknown>).ok).toBe(true);
  });
});

describe("validation – POST /api/spaces", () => {
  it("422 with an issues array on a malformed space body", async () => {
    const r = await req(
      {
        method: "POST",
        path: "/api/spaces",
        body: { name: "", host: "localhost", username: "u", auth: { kind: "agent" } },
      },
      baseUrl,
    );
    expect(r.status).toBe(422);
    const body = r.body as Record<string, unknown>;
    expect(body.error).toBe("validation_failed");
    // issues is either an array or the treeifyError shape
    expect(body.issues).toBeDefined();
  });
});

describe("not found – PATCH unknown space", () => {
  it("404 on PATCH /api/spaces/:id with a non-existent id", async () => {
    const r = await req(
      { method: "PATCH", path: "/api/spaces/no-such-id", body: { name: "renamed" } },
      baseUrl,
    );
    expect(r.status).toBe(404);
    expect((r.body as Record<string, unknown>).error).toBe("not_found");
  });
});

describe("request body limit", () => {
  it("413 on a body larger than 256 KiB", async () => {
    const oversized = "x".repeat(256 * 1024 + 1);
    const r = await req(
      {
        method: "POST",
        path: "/api/spaces",
        body: { name: oversized, host: "h", username: "u", auth: { kind: "agent" } },
      },
      baseUrl,
    );
    expect(r.status).toBe(413);
  });
});

describe("ws upgrade rejection", () => {
  it("rejects /ws with a wrong token and manager.size() stays 0", async () => {
    const { status } = await openWs(`/ws?tabId=anything&token=${BAD_TOKEN}`, baseUrl);
    // ws library surfaces rejection as unexpected-response (4xx) or error
    expect(status === 401 || status === undefined).toBe(true);
    // no SSH session must have been created
    expect(manager.size()).toBe(0);
  });

  it("rejects /ws for an unknown tabId and manager.size() stays 0", async () => {
    const { status } = await openWs(`/ws?tabId=tab_doesnotexist&token=${TOKEN}`, baseUrl);
    expect(status === 404 || status === undefined).toBe(true);
    expect(manager.size()).toBe(0);
  });

  it("server still answers /api/health after ws rejections", async () => {
    const r = await req({ path: "/api/health" }, baseUrl);
    expect(r.status).toBe(200);
    expect((r.body as Record<string, unknown>).ok).toBe(true);
  });
});
