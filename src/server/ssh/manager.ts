import { readFileSync } from "node:fs";
import ssh2 from "ssh2";
import type { Agent, Space } from "../../shared/contracts.js";

const { Client } = ssh2;
type ClientChannel = import("ssh2").ClientChannel;

/** Arguments accepted by {@link SshSessionManager.openSession}. */
export interface OpenSessionArgs {
  tabId: string;
  space: Space;
  agent?: Agent;
  cols: number;
  rows: number;
  onOutput: (chunk: string) => void;
  onExit: (code: number | null) => void;
  onError: (message: string) => void;
}

interface Session {
  client: InstanceType<typeof Client>;
  channel: ClientChannel;
}

/**
 * Owns one ssh2 `Client` per open tab. Handles auth (password / agent / key),
 * pty + shell setup, launching an agent command inside the space's cwd, and
 * routing terminal I/O to the callbacks supplied by the caller.
 *
 * Secrets (passwords, passphrases, private key contents) are only ever used
 * to build the ssh2 connect config; they are never logged or forwarded to
 * `onOutput`/`onError`.
 */
export class SshSessionManager {
  private readonly sessions = new Map<string, Session>();

  async openSession(args: OpenSessionArgs): Promise<void> {
    const { tabId, space, agent, cols, rows, onOutput, onExit, onError } = args;

    if (this.sessions.has(tabId)) {
      throw new Error(`ssh session for tab ${tabId} is already open`);
    }

    const client = new Client();

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;

        const fail = (message: string) => {
          if (settled) return;
          settled = true;
          client.removeAllListeners();
          client.end();
          reject(new Error(message));
        };

        client.once("error", (err) => {
          fail(err.message);
        });

        client.once("ready", () => {
          client.shell({ cols, rows, term: "xterm-256color" }, (shellErr, channel) => {
            if (shellErr) {
              fail(shellErr.message);
              return;
            }
            if (settled) {
              // openSession already failed/timed out; don't leak the channel.
              channel.end();
              return;
            }
            settled = true;

            // Once the session is live, a transport error is no longer an
            // openSession failure: the promise has settled, so routing it into
            // fail() would strip every listener and leave the socket's next
            // 'error' event unhandled, taking the whole process down. A phone
            // dropping Wi-Fi produces exactly that ECONNRESET.
            client.removeAllListeners("error");
            client.on("error", (err: Error) => {
              this.sessions.delete(tabId);
              client.end();
              onError(err.message);
            });

            channel.on("data", (chunk: Buffer) => {
              onOutput(chunk.toString("utf8"));
            });
            channel.stderr.on("data", (chunk: Buffer) => {
              onOutput(chunk.toString("utf8"));
            });
            channel.on("close", () => {
              this.sessions.delete(tabId);
              client.end();
            });
            channel.on("exit", (code: number | null) => {
              onExit(code);
            });

            this.sessions.set(tabId, { client, channel });

            if (agent) {
              this.launchAgent(channel, space, agent);
            }

            resolve();
          });
        });

        let connectConfig: ssh2.ConnectConfig;
        try {
          connectConfig = buildConnectConfig(space);
        } catch (configErr) {
          fail(configErr instanceof Error ? configErr.message : String(configErr));
          return;
        }

        client.connect(connectConfig);
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      onError(message);
      throw err;
    }
  }

  private launchAgent(channel: ClientChannel, space: Space, agent: Agent): void {
    const lines: string[] = [];
    if (space.cwd) {
      lines.push(`cd ${shellQuote(space.cwd)}`);
    }
    for (const [key, value] of Object.entries(agent.env)) {
      lines.push(`export ${key}=${shellQuote(value)}`);
    }
    lines.push(agent.command);
    channel.write(`${lines.join("\n")}\n`);
  }

  write(tabId: string, data: string): boolean {
    const session = this.sessions.get(tabId);
    if (!session) return false;
    session.channel.write(data);
    return true;
  }

  resize(tabId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(tabId);
    if (!session) return false;
    session.channel.setWindow(rows, cols, 0, 0);
    return true;
  }

  async close(tabId: string): Promise<void> {
    const session = this.sessions.get(tabId);
    if (!session) return;
    this.sessions.delete(tabId);
    session.channel.end();
    session.client.end();
  }

  async closeAll(): Promise<void> {
    const tabIds = [...this.sessions.keys()];
    await Promise.all(tabIds.map((tabId) => this.close(tabId)));
  }

  has(tabId: string): boolean {
    return this.sessions.has(tabId);
  }

  size(): number {
    return this.sessions.size;
  }
}

function buildConnectConfig(space: Space): ssh2.ConnectConfig {
  const base: ssh2.ConnectConfig = {
    host: space.host,
    port: space.port,
    username: space.username,
  };

  switch (space.auth.kind) {
    case "password":
      return { ...base, password: space.auth.password };
    case "agent": {
      const socketPath = process.env.SSH_AUTH_SOCK;
      if (!socketPath) {
        throw new Error("SSH_AUTH_SOCK is not set; cannot authenticate via agent");
      }
      return { ...base, agent: socketPath };
    }
    case "key": {
      const privateKey = readFileSync(space.auth.privateKeyPath, "utf8");
      const config: ssh2.ConnectConfig = { ...base, privateKey };
      if (space.auth.passphrase !== undefined) {
        config.passphrase = space.auth.passphrase;
      }
      return config;
    }
  }
}

/** Single-quotes a shell value, escaping any embedded single quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
