import { describe, expect, it } from "vitest";
import {
  AgentInputSchema,
  ClientMessageSchema,
  ServerMessageSchema,
  SpaceInputSchema,
  TabInputSchema,
} from "../src/shared/contracts.js";

describe("SpaceInputSchema", () => {
  it("accepts a minimal space with password auth", () => {
    const parsed = SpaceInputSchema.parse({
      name: "oracle",
      host: "129.225.158.248",
      username: "ubuntu",
      auth: { kind: "password", password: "hunter2" },
    });
    expect(parsed.port).toBe(22);
    expect(parsed.name).toBe("oracle");
  });

  it("accepts an agent-key space with explicit port and cwd", () => {
    const parsed = SpaceInputSchema.parse({
      name: "laptop",
      host: "localhost",
      port: 2222,
      username: "dev",
      cwd: "/home/dev/project",
      auth: { kind: "agent" },
    });
    expect(parsed.port).toBe(2222);
    expect(parsed.cwd).toBe("/home/dev/project");
  });

  it("rejects an empty name", () => {
    const result = SpaceInputSchema.safeParse({
      name: "",
      host: "localhost",
      username: "dev",
      auth: { kind: "agent" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an out-of-range port", () => {
    const result = SpaceInputSchema.safeParse({
      name: "bad",
      host: "localhost",
      port: 70000,
      username: "dev",
      auth: { kind: "agent" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown auth kind", () => {
    const result = SpaceInputSchema.safeParse({
      name: "bad",
      host: "localhost",
      username: "dev",
      auth: { kind: "telepathy" },
    });
    expect(result.success).toBe(false);
  });

  it("strips unknown keys instead of trusting them", () => {
    const parsed = SpaceInputSchema.parse({
      name: "strict",
      host: "localhost",
      username: "dev",
      auth: { kind: "agent" },
      isAdmin: true,
    });
    expect("isAdmin" in parsed).toBe(false);
  });
});

describe("AgentInputSchema", () => {
  it("accepts an agent bound to a space", () => {
    const parsed = AgentInputSchema.parse({
      spaceId: "spc_abc",
      name: "claude",
      command: "claude --dangerously-skip-permissions",
    });
    expect(parsed.command).toContain("claude");
    expect(parsed.env).toEqual({});
  });

  it("rejects a blank command", () => {
    const result = AgentInputSchema.safeParse({ spaceId: "spc_abc", name: "x", command: "   " });
    expect(result.success).toBe(false);
  });
});

describe("TabInputSchema", () => {
  it("defaults the terminal size", () => {
    const parsed = TabInputSchema.parse({ spaceId: "spc_abc", title: "shell" });
    expect(parsed.cols).toBe(80);
    expect(parsed.rows).toBe(24);
  });

  it("accepts an agent-backed tab with a custom size", () => {
    const parsed = TabInputSchema.parse({
      spaceId: "spc_abc",
      agentId: "agt_1",
      title: "claude",
      cols: 40,
      rows: 30,
    });
    expect(parsed.agentId).toBe("agt_1");
    expect(parsed.cols).toBe(40);
  });

  it("rejects a zero column count", () => {
    expect(TabInputSchema.safeParse({ spaceId: "spc_abc", title: "t", cols: 0 }).success).toBe(
      false,
    );
  });
});

describe("websocket message contracts", () => {
  it("parses client input, resize and close messages", () => {
    expect(ClientMessageSchema.parse({ type: "input", data: "ls\n" }).type).toBe("input");
    expect(ClientMessageSchema.parse({ type: "resize", cols: 100, rows: 40 })).toEqual({
      type: "resize",
      cols: 100,
      rows: 40,
    });
    expect(ClientMessageSchema.parse({ type: "close" }).type).toBe("close");
  });

  it("rejects an unknown client message type", () => {
    expect(ClientMessageSchema.safeParse({ type: "exec", data: "rm -rf /" }).success).toBe(false);
  });

  it("parses server output, exit and error messages", () => {
    expect(ServerMessageSchema.parse({ type: "output", data: "hi" }).type).toBe("output");
    expect(ServerMessageSchema.parse({ type: "exit", code: 0 }).type).toBe("exit");
    expect(ServerMessageSchema.parse({ type: "error", message: "boom" }).type).toBe("error");
  });
});
