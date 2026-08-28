import { afterEach, describe, expect, it } from "vitest";
import { SshSessionManager } from "../src/server/ssh/manager.js";
import type { Space } from "../src/shared/contracts.js";
import { type StubSshServer, startStubSshServer } from "./helpers/ssh-stub.js";

const STUB_USERNAME = "tester";
const STUB_PASSWORD = "secret";

function makeSpace(overrides: Partial<Space> = {}, port: number): Space {
  return {
    id: "space-1",
    name: "Test space",
    host: "127.0.0.1",
    port,
    username: STUB_USERNAME,
    createdAt: new Date().toISOString(),
    auth: { kind: "password", password: STUB_PASSWORD },
    ...overrides,
  };
}

/** Waits until `predicate` becomes true or `timeoutMs` elapses. */
function waitFor(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (predicate()) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      reject(new Error(`timed out waiting for: ${description}`));
    }, timeoutMs);
    const check = () => {
      if (predicate()) {
        clearTimeout(timer);
        resolve();
      } else {
        setImmediate(check);
      }
    };
    setImmediate(check);
  });
}

describe("SshSessionManager", () => {
  let stub: StubSshServer;
  let manager: SshSessionManager;

  afterEach(async () => {
    if (manager) await manager.closeAll();
    if (stub) await stub.close();
  });

  it("streams written input back through onOutput", async () => {
    stub = await startStubSshServer();
    manager = new SshSessionManager();

    let seen = "";
    let resolveMarker: (() => void) | undefined;
    const markerSeen = new Promise<void>((resolve) => {
      resolveMarker = resolve;
    });

    await manager.openSession({
      tabId: "tab-1",
      space: makeSpace({}, stub.port),
      cols: 80,
      rows: 24,
      onOutput: (chunk) => {
        seen += chunk;
        if (seen.includes("echo hi") && resolveMarker) {
          resolveMarker();
          resolveMarker = undefined;
        }
      },
      onExit: () => {},
      onError: () => {},
    });

    manager.write("tab-1", "echo hi\n");

    await Promise.race([
      markerSeen,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timed out waiting for echo")), 5000),
      ),
    ]);

    expect(seen).toContain("echo hi");
  });

  it("keeps two concurrent sessions isolated with no cross-talk", async () => {
    stub = await startStubSshServer();
    manager = new SshSessionManager();

    const outputA: string[] = [];
    const outputB: string[] = [];
    let resolveA: (() => void) | undefined;
    let resolveB: (() => void) | undefined;
    const seenA = new Promise<void>((resolve) => {
      resolveA = resolve;
    });
    const seenB = new Promise<void>((resolve) => {
      resolveB = resolve;
    });

    await manager.openSession({
      tabId: "tab-a",
      space: makeSpace({}, stub.port),
      cols: 80,
      rows: 24,
      onOutput: (chunk) => {
        outputA.push(chunk);
        if (outputA.join("").includes("marker-a") && resolveA) {
          resolveA();
          resolveA = undefined;
        }
      },
      onExit: () => {},
      onError: () => {},
    });

    await manager.openSession({
      tabId: "tab-b",
      space: makeSpace({}, stub.port),
      cols: 80,
      rows: 24,
      onOutput: (chunk) => {
        outputB.push(chunk);
        if (outputB.join("").includes("marker-b") && resolveB) {
          resolveB();
          resolveB = undefined;
        }
      },
      onExit: () => {},
      onError: () => {},
    });

    expect(manager.size()).toBe(2);

    manager.write("tab-a", "marker-a\n");
    manager.write("tab-b", "marker-b\n");

    await Promise.race([
      Promise.all([seenA, seenB]),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timed out waiting for markers")), 5000),
      ),
    ]);

    expect(outputA.join("")).toContain("marker-a");
    expect(outputA.join("")).not.toContain("marker-b");
    expect(outputB.join("")).toContain("marker-b");
    expect(outputB.join("")).not.toContain("marker-a");
    expect(manager.size()).toBe(2);
  });

  it("resize returns true for an open tab and false for an unknown tab", async () => {
    stub = await startStubSshServer();
    manager = new SshSessionManager();

    await manager.openSession({
      tabId: "tab-resize",
      space: makeSpace({}, stub.port),
      cols: 80,
      rows: 24,
      onOutput: () => {},
      onExit: () => {},
      onError: () => {},
    });

    expect(manager.resize("tab-resize", 100, 40)).toBe(true);
    expect(manager.resize("unknown-tab", 100, 40)).toBe(false);
  });

  it("close() drops the session so has() is false and size() decreases", async () => {
    stub = await startStubSshServer();
    manager = new SshSessionManager();

    await manager.openSession({
      tabId: "tab-close",
      space: makeSpace({}, stub.port),
      cols: 80,
      rows: 24,
      onOutput: () => {},
      onExit: () => {},
      onError: () => {},
    });

    expect(manager.has("tab-close")).toBe(true);
    expect(manager.size()).toBe(1);

    await manager.close("tab-close");

    expect(manager.has("tab-close")).toBe(false);
    expect(manager.size()).toBe(0);
  });

  it("closeAll() leaves size() 0 and the stub reports no lingering sessions", async () => {
    stub = await startStubSshServer();
    manager = new SshSessionManager();

    await manager.openSession({
      tabId: "tab-x",
      space: makeSpace({}, stub.port),
      cols: 80,
      rows: 24,
      onOutput: () => {},
      onExit: () => {},
      onError: () => {},
    });
    await manager.openSession({
      tabId: "tab-y",
      space: makeSpace({}, stub.port),
      cols: 80,
      rows: 24,
      onOutput: () => {},
      onExit: () => {},
      onError: () => {},
    });

    expect(manager.size()).toBe(2);

    await manager.closeAll();

    expect(manager.size()).toBe(0);
    await waitFor(() => stub.sessionCount() === 0, 5000, "stub to report zero lingering sessions");
    expect(stub.sessionCount()).toBe(0);
  });

  it("rejects and calls onError on a wrong password, leaving no session behind", async () => {
    stub = await startStubSshServer();
    manager = new SshSessionManager();

    let errorMessage: string | undefined;

    await expect(
      manager.openSession({
        tabId: "tab-bad-auth",
        space: makeSpace({ auth: { kind: "password", password: "wrong-password" } }, stub.port),
        cols: 80,
        rows: 24,
        onOutput: () => {},
        onExit: () => {},
        onError: (message) => {
          errorMessage = message;
        },
      }),
    ).rejects.toBeTruthy();

    expect(manager.has("tab-bad-auth")).toBe(false);
    expect(manager.size()).toBe(0);
    expect(errorMessage).toBeDefined();
  });

  it("rejects when opening the same tabId twice", async () => {
    stub = await startStubSshServer();
    manager = new SshSessionManager();

    await manager.openSession({
      tabId: "tab-dup",
      space: makeSpace({}, stub.port),
      cols: 80,
      rows: 24,
      onOutput: () => {},
      onExit: () => {},
      onError: () => {},
    });

    await expect(
      manager.openSession({
        tabId: "tab-dup",
        space: makeSpace({}, stub.port),
        cols: 80,
        rows: 24,
        onOutput: () => {},
        onExit: () => {},
        onError: () => {},
      }),
    ).rejects.toBeTruthy();

    expect(manager.size()).toBe(1);
  });
});
