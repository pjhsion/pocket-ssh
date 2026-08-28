/**
 * pocket-ssh web app entry. No framework: this is a small, hand-rolled
 * controller that renders three views (Terminals / Spaces / Agents), a token
 * login screen, and a full-screen xterm terminal pane. State flows through the
 * `Store`; DOM nodes are rebuilt each render for simplicity at this scale.
 */
import "@xterm/xterm/css/xterm.css";

import type { Agent, AgentInput, SpaceInput, Tab, TabInput } from "../shared/contracts.js";
import {
  clearStoredToken,
  createAgent,
  createSpace,
  createTab,
  deleteAgent,
  deleteSpace,
  deleteTab,
  getStoredToken,
  listAgents,
  listSpaces,
  listTabs,
  onUnauthorized,
  storeToken,
} from "./api.js";
import {
  type AppState,
  type ConnectionStatus,
  createInitialState,
  Store,
  type View,
} from "./state.js";
import { TerminalSession } from "./terminal.js";

const store = new Store(createInitialState());
let session: TerminalSession | null = null;
let resizeObserver: ResizeObserver | null = null;
let orientationHandler: () => void = () => {};
/** Tab id whose terminal pane is currently mounted; prevents re-render churn. */
let renderedTerminalTabId: string | null = null;

onUnauthorized(() => {
  store.update({
    authenticated: false,
    globalError: "Session expired. Please sign in again.",
    activeTabId: null,
  });
  teardownSession();
});

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const rootElement = document.getElementById("app");
if (!rootElement) throw new Error("#app root missing");
const root: HTMLElement = rootElement;

const initialToken = getStoredToken();
if (initialToken) {
  store.update({ authenticated: true });
  void loadAll();
}

store.subscribe(render);
// Paint once up front: subscribers only fire on change, so a first load with no
// stored token would otherwise leave the page blank instead of showing login.
render(store.getState());

// Register the service worker so the app shell is installable and offline-ready.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      /* registration is best-effort; the app still works without it */
    });
  });
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

async function loadAll(): Promise<void> {
  store.update({ loading: true });
  try {
    const [spaces, agents, tabs] = await Promise.all([listSpaces(), listAgents(), listTabs()]);
    store.update({ spaces, agents, tabs, loading: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load data";
    store.update({ loading: false, globalError: message });
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

function handleLoginSubmit(event: Event): void {
  event.preventDefault();
  const form = event.currentTarget as HTMLFormElement;
  const input = form.querySelector<HTMLInputElement>("[data-testid='token-input']");
  const token = input?.value.trim() ?? "";
  if (!token) return;
  storeToken(token);
  store.update({ authenticated: true, loginError: null });
  void loadAll();
}

function handleLogout(): void {
  clearStoredToken();
  teardownSession();
  store.update({
    ...createInitialState(),
  });
}

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

function switchView(view: View): void {
  store.update({
    view,
    activeTabId: null,
    spaceFormOpen: false,
    agentFormOpen: false,
    newTabFormOpen: false,
  });
}

// ---------------------------------------------------------------------------
// Terminal pane
// ---------------------------------------------------------------------------

async function openTerminal(tab: Tab): Promise<void> {
  store.update({ activeTabId: tab.id });
  store.setTabStatus(tab.id, "connecting");
}

function teardownSession(): void {
  if (session) {
    session.dispose();
    session = null;
  }
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
  window.removeEventListener("orientationchange", orientationHandler);
  renderedTerminalTabId = null;
}

function closeTerminal(): void {
  teardownSession();
  const activeTabId = store.getState().activeTabId;
  store.update({ activeTabId: null });
  if (activeTabId) {
    store.setTabStatus(activeTabId, "idle");
  }
}

function ensureSession(tab: Tab, container: HTMLElement): void {
  if (session && session.tabId === tab.id) return;
  if (session) teardownSession();
  const token = getStoredToken();
  if (!token) {
    store.update({ authenticated: false });
    return;
  }
  session = new TerminalSession(container, tab.id, token, {
    onStatusChange: (status: ConnectionStatus) => {
      store.setTabStatus(tab.id, status);
    },
    onError: (message: string) => {
      store.setTabStatus(tab.id, "error");
      const banner = container.parentElement?.querySelector<HTMLElement>(
        "[data-testid='terminal-error-banner']",
      );
      if (banner) {
        banner.textContent = message;
        banner.hidden = false;
      }
    },
    onExit: (code: number | null) => {
      store.setTabStatus(tab.id, "idle");
      const banner = container.parentElement?.querySelector<HTMLElement>(
        "[data-testid='terminal-error-banner']",
      );
      if (banner) {
        banner.textContent = `Process exited with code ${code ?? "?"}.`;
        banner.hidden = false;
      }
    },
  });

  // Re-fit on container resize and orientation change, sending a resize frame.
  resizeObserver = new ResizeObserver(() => {
    session?.fit();
  });
  resizeObserver.observe(container);
  orientationHandler = () => {
    session?.fit();
  };
  window.addEventListener("orientationchange", orientationHandler);
}

// ---------------------------------------------------------------------------
// Tab actions
// ---------------------------------------------------------------------------

async function handleCreateTab(input: TabInput): Promise<void> {
  try {
    const tab = await createTab(input);
    store.update({ tabs: [...store.getState().tabs, tab], newTabFormOpen: false });
  } catch (err) {
    store.update({ globalError: err instanceof Error ? err.message : "Failed to create tab" });
  }
}

async function handleDeleteTab(id: string): Promise<void> {
  try {
    await deleteTab(id);
    const tabs = store.getState().tabs.filter((t) => t.id !== id);
    store.update({ tabs });
  } catch (err) {
    store.update({ globalError: err instanceof Error ? err.message : "Failed to delete tab" });
  }
}

// ---------------------------------------------------------------------------
// Space actions
// ---------------------------------------------------------------------------

async function handleCreateSpace(input: SpaceInput): Promise<void> {
  try {
    await createSpace(input);
    const spaces = await listSpaces();
    store.update({ spaces, spaceFormOpen: false, editingSpaceId: null });
  } catch (err) {
    store.update({ globalError: err instanceof Error ? err.message : "Failed to create space" });
  }
}

async function handleDeleteSpace(id: string): Promise<void> {
  try {
    await deleteSpace(id);
    const [spaces, agents] = await Promise.all([listSpaces(), listAgents()]);
    store.update({ spaces, agents });
  } catch (err) {
    store.update({ globalError: err instanceof Error ? err.message : "Failed to delete space" });
  }
}

// ---------------------------------------------------------------------------
// Agent actions
// ---------------------------------------------------------------------------

async function handleCreateAgent(input: AgentInput): Promise<void> {
  try {
    await createAgent(input);
    const agents = await listAgents();
    store.update({ agents, agentFormOpen: false });
  } catch (err) {
    store.update({ globalError: err instanceof Error ? err.message : "Failed to create agent" });
  }
}

async function handleDeleteAgent(id: string): Promise<void> {
  try {
    await deleteAgent(id);
    const agents = store.getState().agents.filter((a) => a.id !== id);
    store.update({ agents });
  } catch (err) {
    store.update({ globalError: err instanceof Error ? err.message : "Failed to delete agent" });
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function render(state: AppState): void {
  if (!state.authenticated) {
    root.replaceChildren(renderLogin(state));
    return;
  }

  if (state.activeTabId) {
    const tab = state.tabs.find((t) => t.id === state.activeTabId);
    if (tab) {
      // Status changes fire store updates; avoid tearing down the live xterm
      // DOM by skipping the re-render when the same pane is already mounted.
      if (renderedTerminalTabId === tab.id && root.querySelector("[data-testid='terminal-pane']")) {
        return;
      }
      root.replaceChildren(renderTerminalPane(tab, state));
      renderedTerminalTabId = tab.id;
      // Defer session setup until the container is in the DOM.
      const container = root.querySelector<HTMLElement>("[data-testid='terminal-surface']");
      if (container) {
        queueMicrotask(() => ensureSession(tab, container));
      }
      return;
    }
    // Stale activeTabId: clear and fall through to list view.
    renderedTerminalTabId = null;
    store.update({ activeTabId: null });
  } else {
    renderedTerminalTabId = null;
  }

  const shell = el("div", { class: "app-shell" }, [
    el("div", { class: "topbar" }, [
      el("div", { class: "topbar-brand" }, ["pocket-ssh"]),
      el(
        "button",
        { class: "btn btn-icon", testid: "logout-btn", title: "Sign out", onClick: handleLogout },
        ["⏻"],
      ),
    ]),
    renderViewContainer(state),
    renderNavBar(state),
  ]);
  root.replaceChildren(shell);
}

function renderLogin(state: AppState): HTMLElement {
  const form = el("form", { class: "login-screen", onSubmit: handleLoginSubmit }, [
    el("div", { class: "login-brand" }, [
      el("div", { class: "login-brand-mark" }, ["pocket-ssh"]),
      el("div", { class: "login-brand-sub" }, ["Sign in with your access token"]),
    ]),
    state.loginError ? el("div", { class: "error-banner" }, [state.loginError]) : null,
    el("div", { class: "field-group" }, [
      el("label", { class: "field-label", for: "token-input" }, ["Token"]),
      el("input", {
        class: "field-input",
        type: "password",
        id: "token-input",
        name: "token",
        autocomplete: "off",
        autocapitalize: "off",
        spellcheck: "false",
        placeholder: "Bearer token",
        testid: "token-input",
        required: true,
      }),
    ]),
    el("button", { class: "btn btn-primary btn-block", type: "submit", testid: "token-submit" }, [
      "Sign in",
    ]),
  ]);
  return form;
}

function renderNavBar(state: AppState): HTMLElement {
  const buttons: Array<{ view: View; id: string; icon: string; label: string }> = [
    { view: "terminals", id: "nav-terminals", icon: ">_", label: "Terminals" },
    { view: "spaces", id: "nav-spaces", icon: "▢", label: "Spaces" },
    { view: "agents", id: "nav-agents", icon: "⚙", label: "Agents" },
  ];
  const items = buttons.map((b) =>
    el(
      "button",
      {
        class: `nav-btn${state.view === b.view ? " is-active" : ""}`,
        testid: b.id,
        onClick: () => switchView(b.view),
      },
      [el("span", { class: "nav-btn-icon" }, [b.icon]), el("span", {}, [b.label])],
    ),
  );
  return el("nav", { class: "nav-bar" }, items);
}

function renderViewContainer(state: AppState): HTMLElement {
  let content: HTMLElement;
  if (state.view === "terminals") content = renderTerminalsView(state);
  else if (state.view === "spaces") content = renderSpacesView(state);
  else content = renderAgentsView(state);

  return el("main", { class: "view-container" }, [content]);
}

// ----- Terminals view -----

function renderTerminalsView(state: AppState): HTMLElement {
  if (state.newTabFormOpen) {
    return renderNewTabForm(state);
  }
  const children: (HTMLElement | null)[] = [];

  children.push(
    el("div", { class: "view-header" }, [
      el("h1", { class: "view-title" }, ["Terminals"]),
      el(
        "button",
        {
          class: "btn btn-primary",
          testid: "new-tab-btn",
          onClick: () => store.update({ newTabFormOpen: true }),
        },
        ["+ New tab"],
      ),
    ]),
  );

  if (state.globalError) {
    children.push(el("div", { class: "error-banner" }, [state.globalError]));
  }

  if (state.tabs.length === 0) {
    children.push(
      el("div", { class: "empty-state" }, ["No tabs yet. Create one to open a live terminal."]),
    );
  } else {
    const rows = state.tabs.map((tab) => renderTabRow(tab, state));
    children.push(el("div", { class: "list", testid: "tab-list" }, rows));
  }

  return el("div", {}, children);
}

function renderTabRow(tab: Tab, state: AppState): HTMLElement {
  const space = state.spaces.find((s) => s.id === tab.spaceId);
  const status: ConnectionStatus = state.tabStatus[tab.id] ?? "idle";
  const dotClass = `status-dot${status === "connected" ? " is-connected" : status === "connecting" ? " is-connecting" : status === "error" ? " is-error" : ""}`;
  return el("div", { class: "row", testid: "tab-row", onClick: () => void openTerminal(tab) }, [
    el("span", { class: dotClass }, []),
    el("div", { class: "row-main" }, [
      el("div", { class: "row-title" }, [tab.title]),
      el("div", { class: "row-subtitle" }, [
        space ? `${space.name} · ${space.host}` : "Unknown space",
      ]),
    ]),
    el("div", { class: "row-actions" }, [
      el(
        "button",
        {
          class: "btn btn-icon btn-danger",
          title: "Delete tab",
          onClick: (e: Event) => {
            e.stopPropagation();
            void handleDeleteTab(tab.id);
          },
        },
        ["×"],
      ),
    ]),
  ]);
}

function renderNewTabForm(state: AppState): HTMLElement {
  if (state.spaces.length === 0) {
    return el("div", {}, [
      el("div", { class: "view-header" }, [
        el("h1", { class: "view-title" }, ["New tab"]),
        el("button", { class: "btn", onClick: () => store.update({ newTabFormOpen: false }) }, [
          "Back",
        ]),
      ]),
      el("div", { class: "empty-state" }, [
        "Create a space first, then you can open a tab into it.",
      ]),
    ]);
  }
  const agents = state.agents.filter((a) => state.spaces.some((s) => s.id === a.spaceId));

  const titleInput = el("input", {
    class: "field-input",
    type: "text",
    name: "title",
    placeholder: "Tab title",
    required: true,
  });
  const spaceSelect = el("select", { class: "field-select", name: "spaceId", required: true }, [
    ...state.spaces.map((s) => el("option", { value: s.id }, [s.name])),
  ]);
  const agentSelect = el("select", { class: "field-select", name: "agentId" }, [
    el("option", { value: "" }, ["None (raw shell)"]),
    ...agents.map((a) => el("option", { value: a.id }, [a.name])),
  ]);

  const form = el(
    "form",
    {
      class: "form",
      testid: "tab-form",
      onSubmit: async (e: Event) => {
        e.preventDefault();
        const fd = new FormData(form);
        const title = String(fd.get("title") ?? "").trim();
        const spaceId = String(fd.get("spaceId") ?? "");
        const agentIdRaw = String(fd.get("agentId") ?? "");
        if (!title || !spaceId) return;
        const input: TabInput = {
          title,
          spaceId,
          cols: 80,
          rows: 24,
        };
        if (agentIdRaw) input.agentId = agentIdRaw;
        await handleCreateTab(input);
      },
    },
    [
      el("div", { class: "field-group" }, [
        el("label", { class: "field-label" }, ["Title"]),
        titleInput,
      ]),
      el("div", { class: "field-group" }, [
        el("label", { class: "field-label" }, ["Space"]),
        spaceSelect,
      ]),
      el("div", { class: "field-group" }, [
        el("label", { class: "field-label" }, ["Agent (optional)"]),
        agentSelect,
      ]),
      el("div", { class: "form-actions" }, [
        el("button", { class: "btn btn-primary", type: "submit" }, ["Create tab"]),
        el(
          "button",
          { class: "btn", type: "button", onClick: () => store.update({ newTabFormOpen: false }) },
          ["Cancel"],
        ),
      ]),
    ],
  );

  return el("div", {}, [
    el("div", { class: "view-header" }, [
      el("h1", { class: "view-title" }, ["New tab"]),
      el("button", { class: "btn", onClick: () => store.update({ newTabFormOpen: false }) }, [
        "Back",
      ]),
    ]),
    form,
  ]);
}

// ----- Spaces view -----

function renderSpacesView(state: AppState): HTMLElement {
  if (state.spaceFormOpen) {
    return renderSpaceForm(state);
  }
  const children: (HTMLElement | null)[] = [
    el("div", { class: "view-header" }, [
      el("h1", { class: "view-title" }, ["Spaces"]),
      el(
        "button",
        {
          class: "btn btn-primary",
          onClick: () => store.update({ spaceFormOpen: true, editingSpaceId: null }),
        },
        ["+ Add"],
      ),
    ]),
  ];
  if (state.globalError) {
    children.push(el("div", { class: "error-banner" }, [state.globalError]));
  }
  if (state.spaces.length === 0) {
    children.push(
      el("div", { class: "empty-state" }, ["No spaces yet. Add one to connect to an SSH host."]),
    );
  } else {
    children.push(el("div", { class: "list" }, state.spaces.map(renderSpaceRow)));
  }
  return el("div", {}, children);
}

function renderSpaceRow(space: {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: { kind: string };
}): HTMLElement {
  return el("div", { class: "row" }, [
    el("div", { class: "row-main" }, [
      el("div", { class: "row-title" }, [space.name]),
      el("div", { class: "row-subtitle" }, [
        `${space.username}@${space.host}:${space.port} · auth: ${space.auth.kind}`,
      ]),
    ]),
    el("div", { class: "row-actions" }, [
      el(
        "button",
        {
          class: "btn btn-icon btn-danger",
          title: "Delete space",
          onClick: () => void handleDeleteSpace(space.id),
        },
        ["×"],
      ),
    ]),
  ]);
}

function renderSpaceForm(state: AppState): HTMLElement {
  const editing = state.editingSpaceId
    ? state.spaces.find((s) => s.id === state.editingSpaceId)
    : null;

  const nameInput = el("input", {
    class: "field-input",
    type: "text",
    name: "name",
    placeholder: "Name",
    value: editing?.name ?? "",
    required: true,
  });
  const hostInput = el("input", {
    class: "field-input",
    type: "text",
    name: "host",
    placeholder: "Host",
    value: editing?.host ?? "",
    required: true,
  });
  const portInput = el("input", {
    class: "field-input",
    type: "number",
    name: "port",
    placeholder: "22",
    value: String(editing?.port ?? 22),
    required: true,
  });
  const userInput = el("input", {
    class: "field-input",
    type: "text",
    name: "username",
    placeholder: "Username",
    value: editing?.username ?? "",
    required: true,
  });
  const cwdInput = el("input", {
    class: "field-input",
    type: "text",
    name: "cwd",
    placeholder: "/ (optional)",
    value: editing?.cwd ?? "",
  });

  const authSelect = el("select", { class: "field-select", name: "authKind" }, [
    el("option", { value: "agent" }, ["SSH agent"]),
    el("option", { value: "password" }, ["Password"]),
    el("option", { value: "key" }, ["Private key path"]),
  ]);

  const passwordGroup = el("div", { class: "field-group" }, [
    el("label", { class: "field-label" }, ["Password"]),
    el("input", {
      class: "field-input",
      type: "password",
      name: "password",
      placeholder: "Password",
    }),
  ]);
  const keyGroup = el("div", {}, [
    el("div", { class: "field-group" }, [
      el("label", { class: "field-label" }, ["Private key path"]),
      el("input", {
        class: "field-input",
        type: "text",
        name: "privateKeyPath",
        placeholder: "~/.ssh/id_ed25519",
      }),
    ]),
    el("div", { class: "field-group" }, [
      el("label", { class: "field-label" }, ["Passphrase (optional)"]),
      el("input", {
        class: "field-input",
        type: "password",
        name: "passphrase",
        placeholder: "Passphrase",
      }),
    ]),
  ]);

  const secretArea = el("div", {}, [passwordGroup]);
  authSelect.addEventListener("change", () => {
    const kind = (authSelect as HTMLSelectElement).value;
    secretArea.replaceChildren(
      kind === "password" ? passwordGroup : kind === "key" ? keyGroup : el("div", {}),
    );
  });
  if (editing) {
    authSelect.value = editing.auth.kind;
    secretArea.replaceChildren(
      editing.auth.kind === "password"
        ? passwordGroup
        : editing.auth.kind === "key"
          ? keyGroup
          : el("div", {}),
    );
  }

  const form = el(
    "form",
    {
      class: "form",
      testid: "space-form",
      onSubmit: async (e: Event) => {
        e.preventDefault();
        const fd = new FormData(form);
        const name = String(fd.get("name") ?? "").trim();
        const host = String(fd.get("host") ?? "").trim();
        const port = Number(fd.get("port"));
        const username = String(fd.get("username") ?? "").trim();
        const cwdRaw = String(fd.get("cwd") ?? "").trim();
        const authKind = String(fd.get("authKind") ?? "agent");
        if (!name || !host || !username || !Number.isInteger(port)) return;

        let auth: SpaceInput["auth"];
        if (authKind === "password") {
          auth = { kind: "password", password: String(fd.get("password") ?? "") };
        } else if (authKind === "key") {
          const passphrase = String(fd.get("passphrase") ?? "");
          const privateKeyPath = String(fd.get("privateKeyPath") ?? "").trim();
          auth = passphrase
            ? { kind: "key", privateKeyPath, passphrase }
            : { kind: "key", privateKeyPath };
        } else {
          auth = { kind: "agent" };
        }
        const input: SpaceInput = { name, host, port, username, auth };
        if (cwdRaw) input.cwd = cwdRaw;
        await handleCreateSpace(input);
      },
    },
    [
      el("div", { class: "field-group" }, [
        el("label", { class: "field-label" }, ["Name"]),
        nameInput,
      ]),
      el("div", { class: "form-row" }, [
        el("div", { class: "field-group" }, [
          el("label", { class: "field-label" }, ["Host"]),
          hostInput,
        ]),
        el("div", { class: "field-group" }, [
          el("label", { class: "field-label" }, ["Port"]),
          portInput,
        ]),
      ]),
      el("div", { class: "field-group" }, [
        el("label", { class: "field-label" }, ["Username"]),
        userInput,
      ]),
      el("div", { class: "field-group" }, [
        el("label", { class: "field-label" }, ["Working directory (optional)"]),
        cwdInput,
      ]),
      el("div", { class: "field-group" }, [
        el("label", { class: "field-label" }, ["Authentication"]),
        authSelect,
      ]),
      secretArea,
      el("div", { class: "form-actions" }, [
        el("button", { class: "btn btn-primary", type: "submit" }, [
          editing ? "Save space" : "Create space",
        ]),
        el(
          "button",
          {
            class: "btn",
            type: "button",
            onClick: () => store.update({ spaceFormOpen: false, editingSpaceId: null }),
          },
          ["Cancel"],
        ),
      ]),
    ],
  );

  return el("div", {}, [
    el("div", { class: "view-header" }, [
      el("h1", { class: "view-title" }, [editing ? "Edit space" : "New space"]),
      el(
        "button",
        {
          class: "btn",
          onClick: () => store.update({ spaceFormOpen: false, editingSpaceId: null }),
        },
        ["Back"],
      ),
    ]),
    form,
  ]);
}

// ----- Agents view -----

function renderAgentsView(state: AppState): HTMLElement {
  if (state.agentFormOpen) {
    return renderAgentForm(state);
  }
  const children: (HTMLElement | null)[] = [
    el("div", { class: "view-header" }, [
      el("h1", { class: "view-title" }, ["Agents"]),
      el(
        "button",
        { class: "btn btn-primary", onClick: () => store.update({ agentFormOpen: true }) },
        ["+ Add"],
      ),
    ]),
  ];
  if (state.globalError) {
    children.push(el("div", { class: "error-banner" }, [state.globalError]));
  }
  if (state.agents.length === 0) {
    children.push(
      el("div", { class: "empty-state" }, [
        "No agents yet. Add a named command to launch inside a space.",
      ]),
    );
  } else {
    children.push(
      el(
        "div",
        { class: "list" },
        state.agents.map((a) => renderAgentRow(a, state)),
      ),
    );
  }
  return el("div", {}, children);
}

function renderAgentRow(agent: Agent, state: AppState): HTMLElement {
  const space = state.spaces.find((s) => s.id === agent.spaceId);
  return el("div", { class: "row" }, [
    el("div", { class: "row-main" }, [
      el("div", { class: "row-title" }, [agent.name]),
      el("div", { class: "row-subtitle" }, [
        space ? `${space.name} · ${agent.command}` : agent.command,
      ]),
    ]),
    el("div", { class: "row-actions" }, [
      el(
        "button",
        {
          class: "btn btn-icon btn-danger",
          title: "Delete agent",
          onClick: () => void handleDeleteAgent(agent.id),
        },
        ["×"],
      ),
    ]),
  ]);
}

function renderAgentForm(state: AppState): HTMLElement {
  if (state.spaces.length === 0) {
    return el("div", {}, [
      el("div", { class: "view-header" }, [
        el("h1", { class: "view-title" }, ["New agent"]),
        el("button", { class: "btn", onClick: () => store.update({ agentFormOpen: false }) }, [
          "Back",
        ]),
      ]),
      el("div", { class: "empty-state" }, ["Create a space first, then you can add agents to it."]),
    ]);
  }

  const spaceSelect = el("select", { class: "field-select", name: "spaceId", required: true }, [
    ...state.spaces.map((s) => el("option", { value: s.id }, [s.name])),
  ]);
  const nameInput = el("input", {
    class: "field-input",
    type: "text",
    name: "name",
    placeholder: "Agent name",
    required: true,
  });
  const commandInput = el("input", {
    class: "field-input",
    type: "text",
    name: "command",
    placeholder: "e.g. tmux attach",
    required: true,
  });

  const envContainer = el("div", { class: "field-group" }, []);
  const envRows: Array<{ key: HTMLInputElement; value: HTMLInputElement }> = [];

  function addEnvRow(key = "", value = ""): void {
    const keyInput = el("input", {
      class: "field-input",
      type: "text",
      name: "envKey",
      placeholder: "KEY",
      value: key,
    });
    const valueInput = el("input", {
      class: "field-input",
      type: "text",
      name: "envValue",
      placeholder: "value",
      value,
    });
    const row = el("div", { class: "env-row" }, [
      keyInput,
      valueInput,
      el(
        "button",
        {
          class: "btn btn-icon",
          type: "button",
          title: "Remove",
          onClick: () => {
            row.remove();
            const idx = envRows.findIndex((r) => r.key === keyInput);
            if (idx >= 0) envRows.splice(idx, 1);
          },
        },
        ["−"],
      ),
    ]);
    envRows.push({ key: keyInput, value: valueInput });
    envContainer.appendChild(
      el("div", { class: "field-group" }, [
        el("label", { class: "field-label" }, [`Env var #${envRows.length}`]),
        row,
      ]),
    );
  }

  const addEnvBtn = el("button", { class: "btn", type: "button", onClick: () => addEnvRow() }, [
    "+ Env var",
  ]);
  addEnvRow();

  const form = el(
    "form",
    {
      class: "form",
      testid: "agent-form",
      onSubmit: async (e: Event) => {
        e.preventDefault();
        const fd = new FormData(form);
        const spaceId = String(fd.get("spaceId") ?? "");
        const name = String(fd.get("name") ?? "").trim();
        const command = String(fd.get("command") ?? "").trim();
        if (!spaceId || !name || !command) return;
        const env: Record<string, string> = {};
        for (const row of envRows) {
          const k = row.key.value.trim();
          const v = row.value.value;
          if (k) env[k] = v;
        }
        const input: AgentInput = { spaceId, name, command, env };
        await handleCreateAgent(input);
      },
    },
    [
      el("div", { class: "field-group" }, [
        el("label", { class: "field-label" }, ["Space"]),
        spaceSelect,
      ]),
      el("div", { class: "field-group" }, [
        el("label", { class: "field-label" }, ["Name"]),
        nameInput,
      ]),
      el("div", { class: "field-group" }, [
        el("label", { class: "field-label" }, ["Command"]),
        commandInput,
      ]),
      el("div", { class: "section-label" }, ["Environment variables (optional)"]),
      envContainer,
      addEnvBtn,
      el("div", { class: "form-actions" }, [
        el("button", { class: "btn btn-primary", type: "submit" }, ["Create agent"]),
        el(
          "button",
          { class: "btn", type: "button", onClick: () => store.update({ agentFormOpen: false }) },
          ["Cancel"],
        ),
      ]),
    ],
  );

  return el("div", {}, [
    el("div", { class: "view-header" }, [
      el("h1", { class: "view-title" }, ["New agent"]),
      el("button", { class: "btn", onClick: () => store.update({ agentFormOpen: false }) }, [
        "Back",
      ]),
    ]),
    form,
  ]);
}

// ----- Terminal pane -----

function renderTerminalPane(tab: Tab, _state: AppState): HTMLElement {
  const surface = el("div", { class: "terminal-surface", testid: "terminal-surface" }, []);
  const errorBanner = el(
    "div",
    { class: "terminal-error-banner", testid: "terminal-error-banner", hidden: true },
    [""],
  );

  const keyRow = el("div", { class: "terminal-keyrow" }, [
    keyButton("Esc", () => session?.sendRaw("\u001b")),
    keyButton("Tab", () => session?.sendRaw("\t")),
    ctrlButton(),
    keyButton("↑", () => session?.sendRaw("\u001b[A")),
    keyButton("↓", () => session?.sendRaw("\u001b[B")),
    keyButton("←", () => session?.sendRaw("\u001b[D")),
    keyButton("→", () => session?.sendRaw("\u001b[C")),
    keyButton("Ctrl-C", () => session?.sendCtrlC()),
  ]);

  return el("div", { class: "terminal-pane", testid: "terminal-pane" }, [
    el("div", { class: "terminal-topbar" }, [
      el(
        "button",
        { class: "btn btn-icon", testid: "terminal-back", title: "Back", onClick: closeTerminal },
        ["←"],
      ),
      el("div", { class: "terminal-title" }, [tab.title]),
    ]),
    surface,
    errorBanner,
    keyRow,
  ]);
}

function keyButton(label: string, onPress: () => void): HTMLElement {
  return el("button", { class: "key-btn", type: "button", onClick: onPress }, [label]);
}

function ctrlButton(): HTMLElement {
  const btn = el("button", { class: "key-btn", type: "button" }, ["Ctrl"]);
  btn.addEventListener("click", () => {
    if (!session) return;
    const active = session.toggleCtrlSticky();
    btn.classList.toggle("is-active", active);
  });
  // Keep the button visual in sync if Ctrl is consumed by the next key.
  btn.addEventListener("blur", () => {
    if (session && !session.isCtrlSticky()) btn.classList.remove("is-active");
  });
  return btn;
}

// ---------------------------------------------------------------------------
// DOM helper
// ---------------------------------------------------------------------------

type Attrs = Record<string, unknown>;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs,
  children: Array<HTMLElement | string | null> = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag) as HTMLElementTagNameMap[K];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") {
      node.className = String(value);
    } else if (key === "testid") {
      node.setAttribute("data-testid", String(value));
    } else if (key.startsWith("on") && typeof value === "function") {
      const type = key.slice(2).toLowerCase();
      node.addEventListener(type, value as EventListener);
    } else if (key === "hidden") {
      if (value === true) node.hidden = true;
    } else if (key === "value") {
      node.setAttribute("value", String(value));
    } else if (key === "required" || key === "disabled" || key === "autofocus") {
      if (value === true) node.setAttribute(key, key);
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null) continue;
    if (typeof child === "string") {
      node.appendChild(document.createTextNode(child));
    } else {
      node.appendChild(child);
    }
  }
  return node;
}
