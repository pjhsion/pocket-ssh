import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  type Agent,
  type AgentInput,
  AgentInputSchema,
  AgentSchema,
  type Space,
  type SpaceInput,
  SpaceInputSchema,
  SpaceSchema,
  type Tab,
  type TabInput,
  TabInputSchema,
  TabSchema,
} from "../../shared/contracts.js";

const AgentPatchSchema = AgentInputSchema.partial();
const SpacePatchSchema = SpaceInputSchema.partial();
const TabPatchSchema = TabInputSchema.partial();

type SpacePatch = z.infer<typeof SpacePatchSchema>;
type AgentPatch = z.infer<typeof AgentPatchSchema>;
type TabPatch = z.infer<typeof TabPatchSchema>;

const ConfigFileSchema = z.object({
  spaces: z.array(SpaceSchema).default([]),
  agents: z.array(AgentSchema).default([]),
  tabs: z.array(TabSchema).default([]),
});

type ConfigFile = z.infer<typeof ConfigFileSchema>;

function emptyConfig(): ConfigFile {
  return { spaces: [], agents: [], tabs: [] };
}

function generateId(prefix: "spc_" | "agt_" | "tab_"): string {
  return `${prefix}${randomBytes(6).toString("hex")}`;
}

/**
 * Single JSON-file backed store for spaces, agents and tabs. All mutating
 * calls are serialized through an internal write chain so concurrent
 * `await`-less calls never race each other's writes to disk.
 */
export class ConfigStore {
  private data: ConfigFile;
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly filePath: string,
    data: ConfigFile,
  ) {
    this.data = data;
  }

  static async open(filePath: string): Promise<ConfigStore> {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return new ConfigStore(filePath, emptyConfig());
      }
      throw err;
    }

    if (raw.trim().length === 0) {
      return new ConfigStore(filePath, emptyConfig());
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(raw);
    } catch {
      throw new Error(`Config file at ${filePath} contains invalid JSON`);
    }

    const result = ConfigFileSchema.safeParse(parsedJson);
    if (!result.success) {
      throw new Error(`Config file at ${filePath} does not match the expected schema`);
    }

    return new ConfigStore(filePath, result.data);
  }

  private async persist(): Promise<void> {
    const next = this.writeQueue.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const tmpPath = `${this.filePath}.tmp`;
      await writeFile(tmpPath, JSON.stringify(this.data, null, 2), "utf8");
      await rename(tmpPath, this.filePath);
    });
    this.writeQueue = next.catch(() => {});
    await next;
  }

  // ---- spaces ----

  listSpaces(): Space[] {
    return [...this.data.spaces];
  }

  getSpace(id: string): Space | undefined {
    return this.data.spaces.find((s) => s.id === id);
  }

  async createSpace(input: SpaceInput): Promise<Space> {
    const parsed = SpaceInputSchema.parse(input);
    const space: Space = { ...parsed, id: generateId("spc_"), createdAt: new Date().toISOString() };
    this.data.spaces.push(space);
    await this.persist();
    return space;
  }

  async updateSpace(id: string, patch: SpacePatch): Promise<Space | undefined> {
    const index = this.data.spaces.findIndex((s) => s.id === id);
    if (index === -1) return undefined;
    const parsedPatch = SpacePatchSchema.parse(patch);
    const existing = this.data.spaces[index] as Space;
    const updated: Space = SpaceSchema.parse({ ...existing, ...parsedPatch });
    this.data.spaces[index] = updated;
    await this.persist();
    return updated;
  }

  async deleteSpace(id: string): Promise<boolean> {
    const index = this.data.spaces.findIndex((s) => s.id === id);
    if (index === -1) return false;
    this.data.spaces.splice(index, 1);
    this.data.agents = this.data.agents.filter((a) => a.spaceId !== id);
    this.data.tabs = this.data.tabs.filter((t) => t.spaceId !== id);
    await this.persist();
    return true;
  }

  // ---- agents ----

  listAgents(): Agent[] {
    return [...this.data.agents];
  }

  getAgent(id: string): Agent | undefined {
    return this.data.agents.find((a) => a.id === id);
  }

  async createAgent(input: AgentInput): Promise<Agent> {
    const parsed = AgentInputSchema.parse(input);
    if (!this.getSpace(parsed.spaceId)) {
      throw new Error(`Cannot create agent: space ${parsed.spaceId} does not exist`);
    }
    const agent: Agent = { ...parsed, id: generateId("agt_"), createdAt: new Date().toISOString() };
    this.data.agents.push(agent);
    await this.persist();
    return agent;
  }

  async updateAgent(id: string, patch: AgentPatch): Promise<Agent | undefined> {
    const index = this.data.agents.findIndex((a) => a.id === id);
    if (index === -1) return undefined;
    const parsedPatch = AgentPatchSchema.parse(patch);
    if (parsedPatch.spaceId !== undefined && !this.getSpace(parsedPatch.spaceId)) {
      throw new Error(`Cannot update agent: space ${parsedPatch.spaceId} does not exist`);
    }
    const existing = this.data.agents[index] as Agent;
    const updated: Agent = AgentSchema.parse({ ...existing, ...parsedPatch });
    this.data.agents[index] = updated;
    await this.persist();
    return updated;
  }

  async deleteAgent(id: string): Promise<boolean> {
    const index = this.data.agents.findIndex((a) => a.id === id);
    if (index === -1) return false;
    this.data.agents.splice(index, 1);
    await this.persist();
    return true;
  }

  // ---- tabs ----

  listTabs(): Tab[] {
    return [...this.data.tabs];
  }

  getTab(id: string): Tab | undefined {
    return this.data.tabs.find((t) => t.id === id);
  }

  async createTab(input: TabInput): Promise<Tab> {
    const parsed = TabInputSchema.parse(input);
    if (!this.getSpace(parsed.spaceId)) {
      throw new Error(`Cannot create tab: space ${parsed.spaceId} does not exist`);
    }
    if (parsed.agentId !== undefined && !this.getAgent(parsed.agentId)) {
      throw new Error(`Cannot create tab: agent ${parsed.agentId} does not exist`);
    }
    const tab: Tab = { ...parsed, id: generateId("tab_"), createdAt: new Date().toISOString() };
    this.data.tabs.push(tab);
    await this.persist();
    return tab;
  }

  async updateTab(id: string, patch: TabPatch): Promise<Tab | undefined> {
    const index = this.data.tabs.findIndex((t) => t.id === id);
    if (index === -1) return undefined;
    const parsedPatch = TabPatchSchema.parse(patch);
    if (parsedPatch.spaceId !== undefined && !this.getSpace(parsedPatch.spaceId)) {
      throw new Error(`Cannot update tab: space ${parsedPatch.spaceId} does not exist`);
    }
    if (parsedPatch.agentId !== undefined && !this.getAgent(parsedPatch.agentId)) {
      throw new Error(`Cannot update tab: agent ${parsedPatch.agentId} does not exist`);
    }
    const existing = this.data.tabs[index] as Tab;
    const updated: Tab = TabSchema.parse({ ...existing, ...parsedPatch });
    this.data.tabs[index] = updated;
    await this.persist();
    return updated;
  }

  async deleteTab(id: string): Promise<boolean> {
    const index = this.data.tabs.findIndex((t) => t.id === id);
    if (index === -1) return false;
    this.data.tabs.splice(index, 1);
    await this.persist();
    return true;
  }
}
