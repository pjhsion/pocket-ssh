import WebSocket from "ws";
import { bootHarness, seedTab } from "./harness.mjs";
import { api, awaitEvent, evidenceDir, Recorder } from "./lib.mjs";

/** Criterion C1: configure a space + agent + tab over REST, then echo through a live SSH terminal. */
const dir = evidenceDir(process.argv);
const rec = new Recorder(dir, "C1 happy path: REST config + live SSH terminal echo");
const MARKER = "POCKET_SSH_OK";
let harness;
let receipts = [];

try {
  harness = await bootHarness();
  rec.log(`server up at ${harness.baseUrl}, stub sshd on port ${harness.sshPort}`);
  const health = await api(harness.baseUrl, "/api/health", { token: harness.token });
  rec.check(
    "GET /api/health returns 200 with the token",
    health.status === 200,
    `status=${health.status}`,
  );
  const seeded = await seedTab(api, harness, { title: "e2e", agentCommand: "true" });
  rec.check("POST /api/spaces created a space", Boolean(seeded.spaceId), seeded.spaceId);
  rec.check("POST /api/agents created an agent", Boolean(seeded.agentId), seeded.agentId);
  rec.check("POST /api/tabs created a tab", Boolean(seeded.tabId), seeded.tabId);
  const spaces = await api(harness.baseUrl, "/api/spaces", { token: harness.token });
  const leaked = JSON.stringify(spaces.json ?? []).includes("secret");
  rec.check("GET /api/spaces never returns the SSH password", !leaked);
  const socket = new WebSocket(
    `${harness.wsBase}/ws?tabId=${seeded.tabId}&token=${harness.token}`,
  );
  await awaitEvent(socket, "open", () => true, { label: "ws open" });
  rec.log("websocket open");
  const ready = await awaitEvent(
    socket,
    "message",
    (raw) => JSON.parse(raw.toString()).type === "ready",
    { label: "ready frame" },
  );
  rec.check("server sent a ready frame", JSON.parse(ready.toString()).tabId === seeded.tabId);
  let transcript = "";
  const echoed = awaitEvent(
    socket,
    "message",
    (raw) => {
      const frame = JSON.parse(raw.toString());
      if (frame.type === "output") transcript += frame.data;
      return transcript.includes(MARKER);
    },
    { label: `output containing ${MARKER}`, timeoutMs: 20000 },
  );

  socket.send(JSON.stringify({ type: "input", data: `echo ${MARKER}\n` }));
  await echoed;
  rec.check(
    `terminal streamed ${MARKER} back`,
    transcript.includes(MARKER),
    `${transcript.replace(/\r?\n/g, "\\n").slice(0, 200)}`,
  );

  socket.send(JSON.stringify({ type: "resize", cols: 40, rows: 30 }));
  rec.check(
    "resize frame accepted without dropping the socket",
    socket.readyState === WebSocket.OPEN,
  );

  socket.send(JSON.stringify({ type: "close" }));
  await awaitEvent(socket, "close", () => true, { label: "ws close" });
  rec.check("socket closed after a close frame", socket.readyState === WebSocket.CLOSED);
  rec.check(
    "no SSH session leaked",
    harness.manager.size() === 0,
    `manager.size()=${harness.manager.size()}`,
  );
} catch (error) {
  rec.check(
    "driver ran without throwing",
    false,
    error instanceof Error ? error.message : String(error),
  );
} finally {
  if (harness) receipts = await harness.cleanup();
  rec.log(`cleanup: ${receipts.join("; ")}`);
}

process.exit(rec.finish() ? 0 : 1);
