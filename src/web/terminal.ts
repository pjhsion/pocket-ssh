/**
 * One live terminal session: an xterm.js instance wired to the /ws endpoint
 * for a single tab. Owns reconnect-once-with-backoff behaviour and surfaces
 * server-sent error frames through a callback instead of alert().
 */
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { ClientMessage, ServerMessage } from "../shared/contracts.js";
import { ServerMessageSchema } from "../shared/contracts.js";

const RECONNECT_DELAY_MS = 1500;

export interface TerminalSessionCallbacks {
  onStatusChange: (status: "connecting" | "connected" | "error") => void;
  onError: (message: string) => void;
  onExit: (code: number | null) => void;
}

export class TerminalSession {
  readonly term: Terminal;
  private readonly fitAddon: FitAddon;
  private socket: WebSocket | null = null;
  readonly tabId: string;
  private readonly token: string;
  private readonly callbacks: TerminalSessionCallbacks;
  private disposed = false;
  private hasReconnected = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** True once the server has explicitly closed or the caller called dispose(). */
  private intentionalClose = false;
  private ctrlSticky = false;

  constructor(
    container: HTMLElement,
    tabId: string,
    token: string,
    callbacks: TerminalSessionCallbacks,
  ) {
    this.tabId = tabId;
    this.token = token;
    this.callbacks = callbacks;

    this.term = new Terminal({
      cursorBlink: true,
      fontFamily: '"JetBrains Mono", "Cascadia Code", ui-monospace, Menlo, Consolas, monospace',
      fontSize: 14,
      theme: {
        background: "#070910",
        foreground: "#d7e0f0",
        cursor: "#3ddc97",
        selectionBackground: "#3ddc9748",
      },
    });
    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(container);
    this.fitAddon.fit();

    this.term.onData((data) => this.sendInput(data));

    this.connect();
  }

  private connect(): void {
    if (this.disposed) return;
    this.callbacks.onStatusChange("connecting");

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${protocol}//${window.location.host}/ws?tabId=${encodeURIComponent(this.tabId)}&token=${encodeURIComponent(this.token)}`;
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.sendResize();
    });

    socket.addEventListener("message", (event) => {
      this.handleServerMessage(event.data);
    });

    socket.addEventListener("close", () => {
      if (this.disposed || this.intentionalClose) return;
      this.attemptReconnect();
    });

    socket.addEventListener("error", () => {
      // The subsequent close event drives reconnect; here we just surface status.
      this.callbacks.onStatusChange("error");
    });
  }

  private attemptReconnect(): void {
    if (this.hasReconnected) {
      this.callbacks.onStatusChange("error");
      this.callbacks.onError("Connection lost. Go back and reopen this tab to reconnect.");
      return;
    }
    this.hasReconnected = true;
    this.callbacks.onStatusChange("connecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private handleServerMessage(raw: unknown): void {
    if (typeof raw !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const result = ServerMessageSchema.safeParse(parsed);
    if (!result.success) return;
    const message: ServerMessage = result.data;

    switch (message.type) {
      case "ready":
        this.callbacks.onStatusChange("connected");
        break;
      case "output":
        this.term.write(message.data);
        break;
      case "error":
        this.callbacks.onError(message.message);
        break;
      case "exit":
        this.intentionalClose = true;
        this.callbacks.onExit(message.code);
        break;
    }
  }

  private send(message: ClientMessage): void {
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  private sendInput(data: string): void {
    if (this.ctrlSticky) {
      this.ctrlSticky = false;
      this.send({ type: "input", data: applyCtrl(data) });
      return;
    }
    this.send({ type: "input", data });
  }

  /** Sends the current xterm dimensions after a fit. */
  sendResize(): void {
    const proposed = this.fitAddon.proposeDimensions();
    const cols = proposed?.cols ?? this.term.cols;
    const rows = proposed?.rows ?? this.term.rows;
    this.term.resize(cols, rows);
    this.send({ type: "resize", cols, rows });
  }

  fit(): void {
    this.fitAddon.fit();
    this.sendResize();
  }

  /** Sends a raw key sequence directly (used by the on-screen key row). */
  sendRaw(data: string): void {
    if (this.ctrlSticky) {
      this.ctrlSticky = false;
      this.send({ type: "input", data: applyCtrl(data) });
      return;
    }
    this.send({ type: "input", data });
  }

  sendCtrlC(): void {
    this.send({ type: "input", data: "\u0003" });
  }

  toggleCtrlSticky(): boolean {
    this.ctrlSticky = !this.ctrlSticky;
    return this.ctrlSticky;
  }

  isCtrlSticky(): boolean {
    return this.ctrlSticky;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.intentionalClose = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket && this.socket.readyState === WebSocket.OPEN) {
      this.send({ type: "close" });
      this.socket.close();
    }
    this.socket = null;
    this.term.dispose();
  }
}

/** Maps a single printable character to its Ctrl+<key> control code. */
function applyCtrl(data: string): string {
  if (data.length !== 1) return data;
  const code = data.toUpperCase().charCodeAt(0);
  if (code >= 65 && code <= 90) {
    return String.fromCharCode(code - 64);
  }
  return data;
}
