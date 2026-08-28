import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** Minimal shared helpers for the QA drivers. No test framework, no sleeps. */

export function evidenceDir(argv) {
  const idx = argv.indexOf("--evidence-dir");
  const dir = idx >= 0 ? argv[idx + 1] : undefined;
  if (!dir) throw new Error("--evidence-dir <path> is required");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function arg(argv, flag, fallback) {
  const idx = argv.indexOf(flag);
  if (idx < 0) return fallback;
  const value = argv[idx + 1];
  return value === undefined ? fallback : value;
}

export class Recorder {
  constructor(dir, name) {
    this.dir = dir;
    this.name = name;
    this.lines = [];
    this.checks = [];
    this.startedAt = new Date().toISOString();
  }

  log(message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    this.lines.push(line);
    console.log(line);
  }

  check(label, ok, detail) {
    this.checks.push({ label, ok: Boolean(ok), detail: detail ?? null });
    this.log(`${ok ? "PASS" : "FAIL"} ${label}${detail ? ` - ${detail}` : ""}`);
  }

  finish() {
    const ok = this.checks.length > 0 && this.checks.every((c) => c.ok);
    const summary = {
      name: this.name,
      ok,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      checks: this.checks,
    };
    const summaryPath = join(this.dir, "summary.json");
    const transcriptPath = join(this.dir, "transcript.log");
    mkdirSync(dirname(summaryPath), { recursive: true });
    writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
    writeFileSync(transcriptPath, `${this.lines.join("\n")}\n`);
    console.log(`\nevidence: ${summaryPath}`);
    console.log(`evidence: ${transcriptPath}`);
    return ok;
  }
}

/** Resolve with the event's first argument when `predicate` matches, reject on timeout. Event-driven, never polled. */
export function awaitEvent(emitter, event, predicate, { timeoutMs = 15_000, label = event } = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`));
    }, timeoutMs);
    function onEvent(...args) {
      let verdict;
      try {
        verdict = predicate(...args);
      } catch (error) {
        cleanup();
        reject(error);
        return;
      }
      if (verdict) {
        cleanup();
        resolve(args[0]);
      }
    }
    function cleanup() {
      clearTimeout(timer);
      emitter.off(event, onEvent);
    }
    emitter.on(event, onEvent);
  });
}

export async function api(baseUrl, path, { method = "GET", token, body } = {}) {
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(new URL(path, baseUrl), {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: response.status, json, text };
}
