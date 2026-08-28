import WebSocket from "ws";
import { bootHarness, seedTab } from "./harness.mjs";
import { api, awaitEvent, evidenceDir, Recorder } from "./lib.mjs";

/** Criterion C2: auth + malformed input. Nothing gets through without the token. */
const dir = evidenceDir(process.argv);
const rec = new Recorder(dir, "C2 auth and malformed input");
let harness;
let receipts = [];

try {
  harness = await bootHarness();
  rec.log(`server up at ${harness.baseUrl}`);
  const noToken = await api(harness.baseUrl, "/api/spaces");
  rec.check(
    "GET /api/spaces without a token -> 401",
    noToken.status === 401,
    `status=${noToken.status}`,
  );
  const wrongToken = await api(harness.baseUrl, "/api/spaces", { token: "deadbeef" });
  rec.check(
    "GET /api/spaces with a wrong token -> 401",
    wrongToken.status === 401,
    `status=${wrongToken.status}`,
  );
  const malformed = await api(harness.baseUrl, "/api/spaces", {
    method: "POST",
    token: harness.token,
    body: { name: "", host: "", username: "", auth: { kind: "telepathy" } },
  });
  const hasIssues =
    Array.isArray(malformed.json?.issues) || typeof malformed.json?.issues === "object";
  rec.check(
    "malformed space body -> 422 with zod issues",
    malformed.status === 422 && hasIssues,
    `status=${malformed.status} body=${malformed.text.slice(0, 160)}`,
  );
  const unknownPatch = await api(harness.baseUrl, "/api/spaces/spc_missing", {
    method: "PATCH",
    token: harness.token,
    body: { name: "renamed" },
  });
  rec.check(
    "PATCH an unknown space id -> 404",
    unknownPatch.status === 404,
    `status=${unknownPatch.status}`,
  );
  const seeded = await seedTab(api, harness, { title: "auth" });
  const badWs = new WebSocket(`${harness.wsBase}/ws?tabId=${seeded.tabId}&token=wrong-token`);
  const badWsRejected = await new Promise((resolve) => {
    badWs.once("unexpected-response", (_req, res) => resolve(`http ${res.statusCode}`));
    badWs.once("error", (err) => resolve(`error ${err.message}`));
    badWs.once("open", () => resolve("OPENED"));
  });
  rec.check(
    "/ws with a wrong token is rejected",
    badWsRejected !== "OPENED",
    String(badWsRejected),
  );
  rec.check(
    "no SSH session created by the rejected upgrade",
    harness.manager.size() === 0,
    `manager.size()=${harness.manager.size()}`,
  );
  const unknownTabWs = new WebSocket(
    `${harness.wsBase}/ws?tabId=tab_missing&token=${harness.token}`,
  );
  const unknownRejected = await new Promise((resolve) => {
    unknownTabWs.once("unexpected-response", (_req, res) => resolve(`http ${res.statusCode}`));
    unknownTabWs.once("error", (err) => resolve(`error ${err.message}`));
    unknownTabWs.once("open", () => resolve("OPENED"));
  });
  rec.check(
    "/ws with an unknown tabId is rejected",
    unknownRejected !== "OPENED",
    String(unknownRejected),
  );
  rec.check(
    "still no SSH session after the unknown-tab upgrade",
    harness.manager.size() === 0,
    `manager.size()=${harness.manager.size()}`,
  );
  const oversized = await api(harness.baseUrl, "/api/spaces", {
    method: "POST",
    token: harness.token,
    body: {
      name: "big",
      host: "h",
      username: "u",
      auth: { kind: "password", password: "x".repeat(300 * 1024) },
    },
  });
  rec.check("oversized body -> 413", oversized.status === 413, `status=${oversized.status}`);
  const invalidFrame = new WebSocket(
    `${harness.wsBase}/ws?tabId=${seeded.tabId}&token=${harness.token}`,
  );
  await awaitEvent(invalidFrame, "open", () => true, { label: "ws open" });
  await awaitEvent(invalidFrame, "message", (raw) => JSON.parse(raw.toString()).type === "ready", {
    label: "ready",
  });
  const errored = awaitEvent(
    invalidFrame,
    "message",
    (raw) => JSON.parse(raw.toString()).type === "error",
    { label: "error frame" },
  );
  invalidFrame.send(JSON.stringify({ type: "exec", data: "rm -rf /" }));
  const errFrame = JSON.parse((await errored).toString());
  rec.check(
    "an unknown ws frame type yields an error frame, not a crash",
    errFrame.type === "error",
    errFrame.message,
  );
  rec.check("socket survives the invalid frame", invalidFrame.readyState === WebSocket.OPEN);
  invalidFrame.send(JSON.stringify({ type: "close" }));
  await awaitEvent(invalidFrame, "close", () => true, { label: "ws close" });
  const health = await api(harness.baseUrl, "/api/health", { token: harness.token });
  rec.check(
    "server still healthy after every rejection",
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
