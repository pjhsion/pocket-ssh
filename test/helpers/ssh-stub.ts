import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";

const { Server } = ssh2;

/**
 * In-process fake sshd used by tests. Real sshd is not available in this
 * environment, so every SSH-dependent test runs against this stub instead.
 *
 * The stub accepts password auth for a single configurable user and,
 * once a session/pty/shell is granted, echoes back every line it receives.
 * Sending a line equal to "exit" makes the fake shell report exit code 0
 * and close the channel, mirroring a real interactive shell.
 */
export interface StubSshServerOptions {
  username?: string;
  password?: string;
}

export interface StubSshServer {
  port: number;
  close(): Promise<void>;
  sessionCount(): number;
}

export function startStubSshServer(options: StubSshServerOptions = {}): Promise<StubSshServer> {
  const username = options.username ?? "tester";
  const password = options.password ?? "secret";

  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
  });

  let activeSessions = 0;

  const server = new Server({ hostKeys: [privateKey] }, (client) => {
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === username && ctx.password === password) {
        ctx.accept();
        return;
      }
      if (ctx.method === "none") {
        ctx.reject(["password"]);
        return;
      }
      ctx.reject();
    });

    client.on("session", (accept) => {
      const session = accept();
      activeSessions += 1;
      let sessionClosed = false;
      const closeSession = () => {
        if (sessionClosed) return;
        sessionClosed = true;
        activeSessions -= 1;
      };
      session.once("close", closeSession);

      session.on("pty", (ptyAccept) => {
        ptyAccept();
      });

      session.on("shell", (shellAccept) => {
        const channel = shellAccept();
        let buffer = "";

        channel.on("data", (chunk: Buffer) => {
          const received = chunk.toString("utf8");
          // A real pty echoes typed characters back and maps CR to NL (ICRNL).
          // Mirror both so terminal clients behave the same against the stub.
          channel.write(received.replace(/\r/g, "\r\n"));
          buffer += received;

          let breakIndex = buffer.search(/[\r\n]/);
          while (breakIndex !== -1) {
            const line = buffer.slice(0, breakIndex);
            buffer = buffer.slice(breakIndex + 1);
            if (buffer.startsWith("\n")) buffer = buffer.slice(1);

            if (line === "exit") {
              channel.exit(0);
              channel.close();
              return;
            }

            channel.write(`${line}\r\n`);
            breakIndex = buffer.search(/[\r\n]/);
          }
        });

        channel.on("close", closeSession);
      });
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("stub ssh server failed to bind to a TCP port"));
        return;
      }

      resolve({
        port: address.port,
        sessionCount: () => activeSessions,
        close: () =>
          new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          }),
      });
    });
  });
}
