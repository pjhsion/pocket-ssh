import WebSocket from "ws";
import { bootHarness, seedTab } from "./harness.mjs";
import { api, awaitEvent, evidenceDir, Recorder } from "./lib.mjs";

/** Criterion C3: two tabs at once, zero cross-talk, zero leaked sessions. */
const dir = evidenceDir(process.argv);
const rec = new Recorder(dir, "C3 concurrent tabs without cross-talk");
let harness;
let receipts = [];

async function openChannel(harnessRef, tabId) {
  const socket = new WebSocket(`${harnessRef.wsBase}/ws?tabId=${tabId}&token=${harnessRef.token}`);
  await awaitEvent(socket, "open", () => true, { label: `open ${tabId}` });
  await awaitEvent(socket, "message", (raw) => JSON.parse(raw.toString()).type === "ready", {
    label: `ready ${tabId}`,
  });
  const channel = { socket, text: "" };
  socket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "output") channel.text += frame.data;
  });
  return channel;
}

function awaitMarker(channel, marker) {
  return awaitEvent(channel.socket, "message", () => channel.text.includes(marker), {
    label: marker,
    timeoutMs: 20_000,
  });
}

try {
  harness = await bootHarness();
  const first = await seedTab(api, harness, { title: "tab-alpha" });
  const second = await seedTab(api, harness, { title: "tab-bravo" });
  rec.log(`tabs: ${first.tabId} / ${second.tabId}`);

  const [alpha, bravo] = await Promise.all([
    openChannel(harness, first.tabId),
    openChannel(harness, second.tabId),
  ]);
  rec.check(
    "both tabs opened concurrently",
    harness.manager.size() === 2,
    `manager.size()=${harness.manager.size()}`,
  );

  const alphaSeen = awaitMarker(alpha, "MARKER_ALPHA");
  const bravoSeen = awaitMarker(bravo, "MARKER_BRAVO");
  alpha.socket.send(JSON.stringify({ type: "input", data: "echo MARKER_ALPHA\n" }));
  bravo.socket.send(JSON.stringify({ type: "input", data: "echo MARKER_BRAVO\n" }));
  await Promise.all([alphaSeen, bravoSeen]);

  rec.check("tab alpha received its own marker", alpha.text.includes("MARKER_ALPHA"));
  rec.check("tab bravo received its own marker", bravo.text.includes("MARKER_BRAVO"));
  rec.check(
    "no cross-talk into alpha",
    !alpha.text.includes("MARKER_BRAVO"),
    `alpha=${alpha.text.replace(/\r?\n/g, "\\n").slice(0, 120)}`,
  );
  rec.check(
    "no cross-talk into bravo",
    !bravo.text.includes("MARKER_ALPHA"),
    `bravo=${bravo.text.replace(/\r?\n/g, "\\n").slice(0, 120)}`,
  );

  for (const channel of [alpha, bravo]) {
    const closed = awaitEvent(channel.socket, "close", () => true, { label: "close" });
    channel.socket.send(JSON.stringify({ type: "close" }));
    await closed;
  }
  rec.check(
    "both sessions torn down",
    harness.manager.size() === 0,
    `manager.size()=${harness.manager.size()}`,
  );

  const health = await api(harness.baseUrl, "/api/health", { token: harness.token });
  rec.check(
    "server healthy after concurrent teardown",
    health.status === 200,
    `status=${health.status}`,
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
