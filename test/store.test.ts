import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigStore } from "../src/server/config/store.js";
import type { AgentInput, SpaceInput, TabInput } from "../src/shared/contracts.js";

const spaceInput: SpaceInput = {
  name: "oracle",
  host: "129.225.158.248",
  port: 22,
  username: "ubuntu",
  auth: { kind: "password", password: "hunter2" },
};

let dir: string;
let filePath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "pocket-ssh-store-"));
  filePath = join(dir, "config.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("ConfigStore spaces", () => {
  it("creates and lists spaces", async () => {
    const store = await ConfigStore.open(filePath);
    const created = await store.createSpace(spaceInput);

    expect(created.id).toMatch(/^spc_[0-9a-f]{12}$/);
    expect(created.name).toBe("oracle");
    expect(typeof created.createdAt).toBe("string");
    expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);

    const listed = store.listSpaces();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toEqual(created);
    expect(store.getSpace(created.id)).toEqual(created);
  });

  it("persists spaces across a reopen of the same path", async () => {
    const store = await ConfigStore.open(filePath);
    const created = await store.createSpace(spaceInput);

    const reopened = await ConfigStore.open(filePath);
    expect(reopened.listSpaces()).toEqual([created]);
    expect(reopened.getSpace(created.id)).toEqual(created);
  });

  it("merges a patch into an existing space", async () => {
    const store = await ConfigStore.open(filePath);
    const created = await store.createSpace(spaceInput);

    const updated = await store.updateSpace(created.id, { name: "renamed", port: 2222 });

    expect(updated).toBeDefined();
    expect(updated?.name).toBe("renamed");
    expect(updated?.port).toBe(2222);
    expect(updated?.host).toBe(spaceInput.host);
    expect(updated?.id).toBe(created.id);
    expect(store.getSpace(created.id)?.name).toBe("renamed");
  });

  it("returns undefined when updating an unknown space", async () => {
    const store = await ConfigStore.open(filePath);
    expect(await store.updateSpace("spc_unknownunkn", { name: "nope" })).toBeUndefined();
  });

  it("deletes a space and cascades to its agents and tabs", async () => {
    const store = await ConfigStore.open(filePath);
    const space = await store.createSpace(spaceInput);
    const otherSpace = await store.createSpace(spaceInput);

    const agentInput: AgentInput = {
      spaceId: space.id,
      name: "claude",
      command: "claude",
      env: {},
    };
    const agent = await store.createAgent(agentInput);
    const otherAgent = await store.createAgent({ ...agentInput, spaceId: otherSpace.id });

    const tabInput: TabInput = {
      spaceId: space.id,
      agentId: agent.id,
      title: "shell",
      cols: 80,
      rows: 24,
    };
    const tab = await store.createTab(tabInput);
    const otherTab = await store.createTab({
      ...tabInput,
      spaceId: otherSpace.id,
      agentId: otherAgent.id,
    });

    const deleted = await store.deleteSpace(space.id);
    expect(deleted).toBe(true);

    expect(store.getSpace(space.id)).toBeUndefined();
    expect(store.getAgent(agent.id)).toBeUndefined();
    expect(store.getTab(tab.id)).toBeUndefined();

    expect(store.getAgent(otherAgent.id)).toEqual(otherAgent);
    expect(store.getTab(otherTab.id)).toEqual(otherTab);
    expect(store.getSpace(otherSpace.id)).toEqual(otherSpace);
  });

  it("returns false when deleting an unknown space", async () => {
    const store = await ConfigStore.open(filePath);
    expect(await store.deleteSpace("spc_unknownunkn")).toBe(false);
  });
});

describe("ConfigStore agents", () => {
  it("rejects createAgent when spaceId does not exist", async () => {
    const store = await ConfigStore.open(filePath);
    await expect(
      store.createAgent({ spaceId: "spc_missingxxxx", name: "x", command: "echo hi", env: {} }),
    ).rejects.toThrow();
  });

  it("creates, updates and deletes an agent", async () => {
    const store = await ConfigStore.open(filePath);
    const space = await store.createSpace(spaceInput);
    const agent = await store.createAgent({
      spaceId: space.id,
      name: "claude",
      command: "claude",
      env: {},
    });

    expect(agent.id).toMatch(/^agt_[0-9a-f]{12}$/);
    expect(store.listAgents()).toEqual([agent]);

    const updated = await store.updateAgent(agent.id, { command: "claude --resume" });
    expect(updated?.command).toBe("claude --resume");

    expect(await store.deleteAgent(agent.id)).toBe(true);
    expect(store.getAgent(agent.id)).toBeUndefined();
    expect(await store.deleteAgent(agent.id)).toBe(false);
  });
});

describe("ConfigStore tabs", () => {
  it("rejects createTab when spaceId does not exist", async () => {
    const store = await ConfigStore.open(filePath);
    await expect(
      store.createTab({ spaceId: "spc_missingxxxx", title: "shell", cols: 80, rows: 24 }),
    ).rejects.toThrow();
  });

  it("rejects createTab when agentId is given but does not exist", async () => {
    const store = await ConfigStore.open(filePath);
    const space = await store.createSpace(spaceInput);
    await expect(
      store.createTab({
        spaceId: space.id,
        agentId: "agt_missingxxxx",
        title: "shell",
        cols: 80,
        rows: 24,
      }),
    ).rejects.toThrow();
  });

  it("creates, updates and deletes a tab", async () => {
    const store = await ConfigStore.open(filePath);
    const space = await store.createSpace(spaceInput);
    const tab = await store.createTab({ spaceId: space.id, title: "shell", cols: 80, rows: 24 });

    expect(tab.id).toMatch(/^tab_[0-9a-f]{12}$/);
    expect(store.listTabs()).toEqual([tab]);

    const updated = await store.updateTab(tab.id, { title: "renamed" });
    expect(updated?.title).toBe("renamed");

    expect(await store.deleteTab(tab.id)).toBe(true);
    expect(store.getTab(tab.id)).toBeUndefined();
    expect(await store.deleteTab(tab.id)).toBe(false);
  });
});

describe("ConfigStore persistence edge cases", () => {
  it("yields an empty store when the file does not exist", async () => {
    const store = await ConfigStore.open(filePath);
    expect(store.listSpaces()).toEqual([]);
    expect(store.listAgents()).toEqual([]);
    expect(store.listTabs()).toEqual([]);
  });

  it("throws a clear error mentioning the path on corrupt JSON", async () => {
    await writeFile(filePath, "{ not valid json", "utf8");
    await expect(ConfigStore.open(filePath)).rejects.toThrow(filePath);
  });

  it("creates parent directories that do not exist yet", async () => {
    const nestedPath = join(dir, "nested", "deep", "config.json");
    const store = await ConfigStore.open(nestedPath);
    await store.createSpace(spaceInput);
    const reopened = await ConfigStore.open(nestedPath);
    expect(reopened.listSpaces()).toHaveLength(1);
  });

  it("persists both spaces when two createSpace calls are issued concurrently", async () => {
    const store = await ConfigStore.open(filePath);
    const [a, b] = await Promise.all([
      store.createSpace({ ...spaceInput, name: "first" }),
      store.createSpace({ ...spaceInput, name: "second" }),
    ]);

    expect(a.id).not.toBe(b.id);
    expect(store.listSpaces()).toHaveLength(2);

    const reopened = await ConfigStore.open(filePath);
    const names = reopened
      .listSpaces()
      .map((s) => s.name)
      .sort();
    expect(names).toEqual(["first", "second"]);
  });
});
