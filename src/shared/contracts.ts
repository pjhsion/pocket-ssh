import { z } from "zod";

/** Non-empty, trimmed display string used for names and titles. */
const Label = z.string().trim().min(1).max(80);

const Port = z.number().int().min(1).max(65535);

/**
 * How pocket-ssh authenticates to a host. Secrets stay in the config store and
 * are never included in websocket frames, HTTP responses or log lines.
 */
export const SpaceAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("agent") }),
  z.object({ kind: z.literal("password"), password: z.string().min(1) }),
  z.object({
    kind: z.literal("key"),
    privateKeyPath: z.string().trim().min(1),
    passphrase: z.string().min(1).optional(),
  }),
]);
export type SpaceAuth = z.infer<typeof SpaceAuthSchema>;

/** A space is one SSH destination plus the working directory agents launch in. */
export const SpaceInputSchema = z.object({
  name: Label,
  host: z.string().trim().min(1),
  port: Port.default(22),
  username: z.string().trim().min(1),
  cwd: z.string().trim().min(1).optional(),
  auth: SpaceAuthSchema,
});
export type SpaceInput = z.infer<typeof SpaceInputSchema>;

export const SpaceSchema = SpaceInputSchema.extend({
  id: z.string().min(1),
  createdAt: z.string(),
});
export type Space = z.infer<typeof SpaceSchema>;

/** An agent is a named launch command executed inside a space. */
export const AgentInputSchema = z.object({
  spaceId: z.string().trim().min(1),
  name: Label,
  command: z.string().trim().min(1),
  env: z.record(z.string(), z.string()).default({}),
});
export type AgentInput = z.infer<typeof AgentInputSchema>;

export const AgentSchema = AgentInputSchema.extend({
  id: z.string().min(1),
  createdAt: z.string(),
});
export type Agent = z.infer<typeof AgentSchema>;

/** A tab is one live terminal: a space, optionally an agent, and a pty size. */
export const TabInputSchema = z.object({
  spaceId: z.string().trim().min(1),
  agentId: z.string().trim().min(1).optional(),
  title: Label,
  cols: z.number().int().min(20).max(500).default(80),
  rows: z.number().int().min(5).max(300).default(24),
});
export type TabInput = z.infer<typeof TabInputSchema>;

export const TabSchema = TabInputSchema.extend({
  id: z.string().min(1),
  createdAt: z.string(),
});
export type Tab = z.infer<typeof TabSchema>;

export const SpacePatchSchema = SpaceInputSchema.partial();
export const AgentPatchSchema = AgentInputSchema.partial();
export const TabPatchSchema = TabInputSchema.partial();

/** Frames the browser sends over /ws. */
export const ClientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("input"), data: z.string() }),
  z.object({ type: z.literal("resize"), cols: z.number().int().min(20).max(500), rows: z.number().int().min(5).max(300) }),
  z.object({ type: z.literal("close") }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

/** Frames the server sends over /ws. */
export const ServerMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ready"), tabId: z.string() }),
  z.object({ type: z.literal("output"), data: z.string() }),
  z.object({ type: z.literal("exit"), code: z.number().int().nullable() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

/** Space shape safe to return over HTTP: auth kind only, never the secret. */
export type PublicSpace = Omit<Space, "auth"> & { auth: { kind: SpaceAuth["kind"] } };

export function toPublicSpace(space: Space): PublicSpace {
  const { auth, ...rest } = space;
  return { ...rest, auth: { kind: auth.kind } };
}
