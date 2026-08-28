/**
 * src/server/main.ts
 *
 * CLI entry point for pocket-ssh. Reads configuration from environment
 * variables, opens the config store, starts the HTTP+WS server, and wires
 * graceful shutdown on SIGINT/SIGTERM.
 *
 * Environment variables:
 *  - POCKET_SSH_PORT    listen port (default 8790)
 *  - POCKET_SSH_HOST    listen host (default 127.0.0.1)
 *  - POCKET_SSH_CONFIG  path to the config JSON file (default ~/.pocket-ssh/config.json)
 *  - POCKET_SSH_TOKEN   bearer token; when absent, a 32-byte hex token is
 *                       generated and printed once
 *  - POCKET_SSH_WEB_ROOT static asset directory (default dist-web when it exists)
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ConfigStore } from "./config/store.js";
import { createServer } from "./http/server.js";
import { SshSessionManager } from "./ssh/manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function readIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function defaultWebRoot(): string | undefined {
  // main.ts runs compiled from dist/server/main.js; dist-web sits next to dist/.
  const candidate = join(__dirname, "..", "..", "dist-web");
  return existsSync(candidate) ? candidate : undefined;
}

export async function main(): Promise<void> {
  const port = readIntEnv("POCKET_SSH_PORT", 8790);
  const host = process.env.POCKET_SSH_HOST ?? "127.0.0.1";
  const configPath = process.env.POCKET_SSH_CONFIG ?? join(homedir(), ".pocket-ssh", "config.json");

  let token = process.env.POCKET_SSH_TOKEN;
  let generatedToken = false;
  if (!token) {
    token = randomBytes(32).toString("hex");
    generatedToken = true;
  }

  const webRootEnv = process.env.POCKET_SSH_WEB_ROOT;
  const webRoot = webRootEnv ?? defaultWebRoot();

  const store = await ConfigStore.open(configPath);
  const manager = new SshSessionManager();

  const server = createServer({
    store,
    manager,
    token,
    ...(webRoot ? { webRoot } : {}),
  });

  const { port: boundPort } = await server.listen(port, host);

  if (generatedToken) {
    console.log(`Generated bearer token (save this, it will not be shown again): ${token}`);
  }
  console.log(`pocket-ssh listening on http://${host}:${boundPort}`);
  console.log(
    "Warning: pocket-ssh has no TLS and is intended for LAN or Tailscale-only access. " +
      "Do not expose it directly to the public internet.",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}, shutting down...`);
    try {
      await server.close();
    } finally {
      await manager.closeAll();
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

// Only run automatically when executed directly (not when imported for tests).
const isMain =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });
}
