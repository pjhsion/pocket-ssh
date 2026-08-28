/**
 * Minimal app state store. No framework: a plain object plus a subscriber
 * list is enough for the handful of views this client renders, and keeps the
 * bundle small for a PWA that has to boot fast on a phone connection.
 */
import type { Agent, PublicSpace, Tab } from "../shared/contracts.js";

export type View = "terminals" | "spaces" | "agents";

export type ConnectionStatus = "idle" | "connecting" | "connected" | "error";

export interface AppState {
  authenticated: boolean;
  view: View;
  spaces: PublicSpace[];
  agents: Agent[];
  tabs: Tab[];
  /** tabId -> live connection status, driven by the terminal websocket. */
  tabStatus: Record<string, ConnectionStatus>;
  /** Tab currently shown full-screen, or null when on a list view. */
  activeTabId: string | null;
  loading: boolean;
  globalError: string | null;
  loginError: string | null;
  /** Space form: open + which space is being edited (null = creating new). */
  spaceFormOpen: boolean;
  editingSpaceId: string | null;
  agentFormOpen: boolean;
  newTabFormOpen: boolean;
}

export function createInitialState(): AppState {
  return {
    authenticated: false,
    view: "terminals",
    spaces: [],
    agents: [],
    tabs: [],
    tabStatus: {},
    activeTabId: null,
    loading: false,
    globalError: null,
    loginError: null,
    spaceFormOpen: false,
    editingSpaceId: null,
    agentFormOpen: false,
    newTabFormOpen: false,
  };
}

type Listener = (state: AppState) => void;

export class Store {
  private state: AppState;
  private listeners = new Set<Listener>();

  constructor(initial: AppState) {
    this.state = initial;
  }

  getState(): AppState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Shallow-merges `patch` into state and notifies subscribers. */
  update(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    this.notify();
  }

  setTabStatus(tabId: string, status: ConnectionStatus): void {
    this.state = {
      ...this.state,
      tabStatus: { ...this.state.tabStatus, [tabId]: status },
    };
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}
