/**
 * e2e.test.ts – happy path through the real SSH stub.
 *
 * No fixed sleeps. Every async gate is driven by a specific message/event with
 * a bounded timeout.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { ConfigStore } from "../src/server/config/store.js";
import { createServer } from "../src/server/http/server.js";
import { SshSessionManager } from "../src/server/ssh/manager.js";
import type { SpaceInput, TabInput } from "../src/shared/contracts.js";
import { type StubSshServer, startStubSshServer } from "./helpers/ssh-stub.js";

// ─── helpers ────────────────────────────────────────────────────────────────

const TOKEN = "e2e-token-99887766";
const STUB_USER = "tester";
const STUB_PASS = "secret";

interface ServerMessage {
  type: string;
  tabId?: string;
  data?: string;
  code?: number | null;
  message?: string;
}

/** Wait for the first ws message matching `predicate`, or reject after `timeoutMs`. */
function waitForMessage(
  ws: WebSocket,
  predicate: (msg: ServerMessage) => boolean,
  timeoutMs = 8000,
): Promise<ServerMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error(`timed out waiting for matching ws message (${timeoutMs}ms)`));
    }, timeoutMs);

    function handler(raw: Buffer | string) {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(raw.toString()) as ServerMessage;
      } catch {
        return; // skip non-JSON frames
      }
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    }
    ws.on("message", handler);
  });
}

/** Open a WebSocket and resolve as soon as it is either open or has emitted an error. */
function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) => {
      res.destroy();
      reject(new Error(`unexpected-response: ${res.statusCode}`));
    });
  });
}

/** POST helper. */
async function post(
  path: string,
  body: unknown,
  baseUrl: string,
): Promise<{ status: number; body: unknown }> {
  const { default: http } = await import("node:http");
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const url = new URL(path, baseUrl);
    const r = http.request(
      {
        method: "POST",
        hostname: url.hostname,
        port: Number(url.port),
        path: url.pathname,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${TOKEN}`,
          "Content-Length": String(Buffer.byteLength(bodyStr)),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c: Buffer) => (raw += c.toString()));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
      },
    );
    r.on("error", reject);
    r.write(bodyStr);
    r.end();
  });
}

// ─── suite ──────────────────────────────────────────────────────────────────

let baseUrl: string;
let wsBase: string;
let serverClose: () => Promise<void>;
let manager: SshSessionManager;
let stub: StubSshServer;
let tmpDir: string;
let store: ConfigStore;

beforeAll(async () => {
  stub = await startStubSshServer({ username: STUB_USER, password: STUB_PASS });
  tmpDir = await mkdtemp(join(tmpdir(), "pocket-ssh-e2e-test-"));
  const configPath = join(tmpDir, "config.json");
  store = await ConfigStore.open(configPath);
  manager = new SshSessionManager();
  const srv = createServer({ store, manager, token: TOKEN });
  const { port } = await srv.listen(0);
  baseUrl = `http://127.0.0.1:${port}`;
  wsBase = `ws://127.0.0.1:${port}`;
  serverClose = srv.close.bind(srv);
});

afterAll(async () => {
  await serverClose();
  await manager.closeAll();
  await stub.close();
  await rm(tmpDir, { recursive: true, force: true });
});

describe("happy path – single tab echo", () => {
  it("connects, gets ready, sends input, receives echo output", async () => {
    // 1. POST a space pointing at the stub
    const spaceBody: SpaceInput = {
      name: "stub-space",
      host: "127.0.0.1",
      port: stub.port,
      username: STUB_USER,
      auth: { kind: "password", password: STUB_PASS },
    };
    const { body: spaceResp, status: spaceStatus } = await post("/api/spaces", spaceBody, baseUrl);
    expect(spaceStatus).toBe(201);
    const space = spaceResp as { id: string };
    expect(space.id).toMatch(/^spc_/);

    // 2. POST a tab referencing the space
    const tabBody: TabInput = { spaceId: space.id, title: "echo-test", cols: 80, rows: 24 };
    const { body: tabResp, status: tabStatus } = await post("/api/tabs", tabBody, baseUrl);
    expect(tabStatus).toBe(201);
    const tab = tabResp as { id: string };
    expect(tab.id).toMatch(/^tab_/);

    // 3. Open the WebSocket
    const ws = await connectWs(`${wsBase}/ws?tabId=${tab.id}&token=${TOKEN}`);

    try {
      // 4. Await the "ready" frame
      const ready = await waitForMessage(ws, (m) => m.type === "ready");
      expect(ready.tabId).toBe(tab.id);

      // 5. Send input and await an output frame containing the echo
      const outputPromise = waitForMessage(
        ws,
        (m) =>
          m.type === "output" && typeof m.data === "string" && m.data.includes("POCKET_SSH_OK"),
      );
      ws.send(JSON.stringify({ type: "input", data: "echo POCKET_SSH_OK\n" }));

      const output = await outputPromise;
      expect(output.data).toContain("POCKET_SSH_OK");
    } finally {
      ws.close();
    }
  });
});

describe("isolation – two tabs must not see each other's output", () => {
  it("two concurrent tabs each receive only their own marker", async () => {
    // Create space once; tabs share it
    const spaceBody: SpaceInput = {
      name: "iso-space",
      host: "127.0.0.1",
      port: stub.port,
      username: STUB_USER,
      auth: { kind: "password", password: STUB_PASS },
    };
    const { body: spaceResp } = await post("/api/spaces", spaceBody, baseUrl);
    const space = spaceResp as { id: string };

    const tabBodyA: TabInput = { spaceId: space.id, title: "tab-a", cols: 80, rows: 24 };
    const tabBodyB: TabInput = { spaceId: space.id, title: "tab-b", cols: 80, rows: 24 };

    const [tabA, tabB] = await Promise.all([
      post("/api/tabs", tabBodyA, baseUrl).then((r) => r.body as { id: string }),
      post("/api/tabs", tabBodyB, baseUrl).then((r) => r.body as { id: string }),
    ]);

    const [wsA, wsB] = await Promise.all([
      connectWs(`${wsBase}/ws?tabId=${tabA.id}&token=${TOKEN}`),
      connectWs(`${wsBase}/ws?tabId=${tabB.id}&token=${TOKEN}`),
    ]);

    try {
      // Wait for both "ready" frames
      await Promise.all([
        waitForMessage(wsA, (m) => m.type === "ready"),
        waitForMessage(wsB, (m) => m.type === "ready"),
      ]);

      // Subscribe to markers before sending input (subscribe before trigger)
      const markerA = waitForMessage(
        wsA,
        (m) => m.type === "output" && typeof m.data === "string" && m.data.includes("MARKER_A"),
      );
      const markerB = waitForMessage(
        wsB,
        (m) => m.type === "output" && typeof m.data === "string" && m.data.includes("MARKER_B"),
      );

      wsA.send(JSON.stringify({ type: "input", data: "echo MARKER_A\n" }));
      wsB.send(JSON.stringify({ type: "input", data: "echo MARKER_B\n" }));

      const [outA, outB] = await Promise.all([markerA, markerB]);

      // Each socket only sees its own marker
      expect(outA.data).toContain("MARKER_A");
      expect(outA.data).not.toContain("MARKER_B");
      expect(outB.data).toContain("MARKER_B");
      expect(outB.data).not.toContain("MARKER_A");
    } finally {
      // Close both sockets and wait for the manager to drain
      const closedA = new Promise<void>((resolve) => wsA.once("close", resolve));
      const closedB = new Promise<void>((resolve) => wsB.once("close", resolve));
      wsA.close();
      wsB.close();
      await Promise.all([closedA, closedB]);

      // After socket close, sessions must be cleaned up
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(
          () => reject(new Error("manager did not drain to 0 sessions")),
          5000,
        );
        const check = () => {
          if (manager.size() === 0) {
            clearTimeout(deadline);
            resolve();
          } else {
            setImmediate(check);
          }
        };
        setImmediate(check);
      });

      expect(manager.size()).toBe(0);
    }
  });
});
