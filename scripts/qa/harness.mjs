import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Boots a real pocket-ssh HTTP server plus the ssh2 stub SSH server in-process,
 * so the QA drivers exercise the shipped code paths over real sockets.
 */
export async function bootHarness({ port = 0, host = "127.0.0.1", webRoot = false } = {}) {
  const { ConfigStore } = await import("../../src/server/config/store.ts");
  const { SshSessionManager } = await import("../../src/server/ssh/manager.ts");
  const { createServer } = await import("../../src/server/http/server.ts");
  const { startStubSshServer } = await import("../../test/helpers/ssh-stub.ts");

  const configDir = mkdtempSync(join(tmpdir(), "pocket-ssh-qa-"));
  const configPath = join(configDir, "config.json");
  const token = randomBytes(32).toString("hex");

  const ssh = await startStubSshServer();
  const store = await ConfigStore.open(configPath);
  const manager = new SshSessionManager();
  const resolvedWebRoot = webRoot
    ? new URL("../../dist-web/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")
    : undefined;
  const server = createServer({
    store,
    manager,
    token,
    ...(resolvedWebRoot ? { webRoot: resolvedWebRoot } : {}),
  });
  const listening = await server.listen(port, host);
  const baseUrl = `http://${host}:${listening.port}`;

  return {
    token,
    baseUrl,
    wsBase: `ws://${host}:${listening.port}`,
    sshPort: ssh.port,
    manager,
    store,
    configPath,
    async cleanup() {
      const receipts = [];
      await manager.closeAll();
      receipts.push(`manager.closeAll -> size=${manager.size()}`);
      await server.close();
      receipts.push("http server closed");
      await ssh.close();
      receipts.push("stub sshd closed");
      rmSync(configDir, { recursive: true, force: true });
      receipts.push(`rm -rf ${configDir}`);
      return receipts;
    },
  };
}

/** Creates a space pointing at the stub sshd, plus an optional agent, plus a tab. */
export async function seedTab(api, { baseUrl, token, sshPort }, { title, agentCommand } = {}) {
  const space = await api(baseUrl, "/api/spaces", {
    method: "POST",
    token,
    body: {
      name: `qa-space-${title ?? "default"}`,
      host: "127.0.0.1",
      port: sshPort,
      username: "tester",
      auth: { kind: "password", password: "secret" },
    },
  });
  if (space.status !== 201 && space.status !== 200) {
    throw new Error(`space create failed: ${space.status} ${space.text}`);
  }
  const spaceId = space.json.id;

  let agentId;
  if (agentCommand) {
    const agent = await api(baseUrl, "/api/agents", {
      method: "POST",
      token,
      body: { spaceId, name: `qa-agent-${title ?? "default"}`, command: agentCommand },
    });
    if (agent.status !== 201 && agent.status !== 200) {
      throw new Error(`agent create failed: ${agent.status} ${agent.text}`);
    }
    agentId = agent.json.id;
  }

  const tab = await api(baseUrl, "/api/tabs", {
    method: "POST",
    token,
    body: {
      spaceId,
      ...(agentId ? { agentId } : {}),
      title: title ?? "qa-tab",
      cols: 80,
      rows: 24,
    },
  });
  if (tab.status !== 201 && tab.status !== 200) {
    throw new Error(`tab create failed: ${tab.status} ${tab.text}`);
  }
  return { spaceId, agentId, tabId: tab.json.id };
}
