/**
 * Thin REST client for the pocket-ssh backend. Every request attaches the
 * stored bearer token; a 401 response clears the token and notifies the
 * registered listener so the app can fall back to the login screen from one
 * place instead of handling it ad-hoc at every call site.
 */
import type {
  Agent,
  AgentInput,
  PublicSpace,
  Space,
  SpaceInput,
  Tab,
  TabInput,
} from "../shared/contracts.js";
import { AgentPatchSchema, SpacePatchSchema, TabPatchSchema } from "../shared/contracts.js";

export const TOKEN_STORAGE_KEY = "pocket-ssh.token";

export class UnauthorizedError extends Error {
  constructor() {
    super("Unauthorized");
    this.name = "UnauthorizedError";
  }
}

export class ValidationError extends Error {
  readonly issues: unknown[];
  constructor(issues: unknown[]) {
    super("Validation failed");
    this.name = "ValidationError";
    this.issues = issues;
  }
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function storeToken(token: string): void {
  localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearStoredToken(): void {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

/** Fired whenever a request comes back 401 so the app can drop to login. */
export type UnauthorizedListener = () => void;
let unauthorizedListener: UnauthorizedListener | null = null;
export function onUnauthorized(listener: UnauthorizedListener): void {
  unauthorizedListener = listener;
}

async function apiFetch(method: string, path: string, body?: unknown): Promise<Response> {
  const token = getStoredToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }

  const response = await fetch(path, init);

  if (response.status === 401) {
    clearStoredToken();
    unauthorizedListener?.();
    throw new UnauthorizedError();
  }
  if (response.status === 422) {
    const data = (await response.json().catch(() => ({}))) as { issues?: unknown[] };
    throw new ValidationError(data.issues ?? []);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => response.statusText);
    throw new ApiError(response.status, text || response.statusText);
  }
  return response;
}

async function getJson<T>(path: string): Promise<T> {
  const response = await apiFetch("GET", path);
  return (await response.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const response = await apiFetch("POST", path, body);
  return (await response.json()) as T;
}

async function patchJson(path: string, body: unknown): Promise<void> {
  await apiFetch("PATCH", path, body);
}

async function del(path: string): Promise<void> {
  await apiFetch("DELETE", path);
}

// ---------- health ----------

export async function checkHealth(): Promise<boolean> {
  try {
    const response = await fetch("/api/health");
    return response.ok;
  } catch {
    return false;
  }
}

// ---------- spaces ----------
// GET responses omit secrets by contract (PublicSpace); creation/update echo
// back what the server chooses to send. Outgoing patches are pruned through
// the shared partial schemas so we never send unexpected keys.

export function listSpaces(): Promise<PublicSpace[]> {
  return getJson<PublicSpace[]>("/api/spaces");
}

export function createSpace(input: SpaceInput): Promise<Space> {
  return postJson<Space>("/api/spaces", input);
}

export function updateSpace(id: string, patch: Record<string, unknown>): Promise<void> {
  return patchJson(`/api/spaces/${encodeURIComponent(id)}`, SpacePatchSchema.parse(patch));
}

export function deleteSpace(id: string): Promise<void> {
  return del(`/api/spaces/${encodeURIComponent(id)}`);
}

// ---------- agents ----------

export function listAgents(): Promise<Agent[]> {
  return getJson<Agent[]>("/api/agents");
}

export function createAgent(input: AgentInput): Promise<Agent> {
  return postJson<Agent>("/api/agents", input);
}

export function updateAgent(id: string, patch: Record<string, unknown>): Promise<void> {
  return patchJson(`/api/agents/${encodeURIComponent(id)}`, AgentPatchSchema.parse(patch));
}

export function deleteAgent(id: string): Promise<void> {
  return del(`/api/agents/${encodeURIComponent(id)}`);
}

// ---------- tabs ----------

export function listTabs(): Promise<Tab[]> {
  return getJson<Tab[]>("/api/tabs");
}

export function createTab(input: TabInput): Promise<Tab> {
  return postJson<Tab>("/api/tabs", input);
}

export function updateTab(id: string, patch: Record<string, unknown>): Promise<void> {
  return patchJson(`/api/tabs/${encodeURIComponent(id)}`, TabPatchSchema.parse(patch));
}

export function deleteTab(id: string): Promise<void> {
  return del(`/api/tabs/${encodeURIComponent(id)}`);
}
