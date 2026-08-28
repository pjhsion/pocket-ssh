# pocket-ssh

Mobile-first SSH terminal for your phone. Configure **spaces** (hosts), **agents**
(launch commands), and **tabs** (live terminals), then drive real SSH sessions from
a browser sized for a phone.

Inspired by [herdr](https://herdr.dev) and [luvus](https://luvus.dev), which give you
agent mission control through an SSH client. pocket-ssh flips it: the terminal itself
lives in a PWA, so the phone needs nothing but a browser.

## What it gives you

- **Spaces** - an SSH destination (host, port, user, auth) plus the working directory
  agents start in.
- **Agents** - a named launch command run inside a space, e.g. `claude`, `codex`,
  `omo`, or a plain `htop`.
- **Tabs** - concurrent live terminals. Each tab is one SSH channel with its own pty;
  tabs never see each other's output.
- **Mobile UI** - one focused pane at phone width, 44px touch targets, an on-screen
  key row for Esc / Tab / Ctrl / arrows, safe-area insets, installable as a PWA.

## Requirements

- Node.js 22 or newer (developed on Node 26)
- An SSH server you can reach from the machine running pocket-ssh

## Setup

```bash
npm install
npm run build          # compiles the server to dist/ and the web app to dist-web/
POCKET_SSH_TOKEN=$(openssl rand -hex 32) npm start
```

The server prints the URL and, when you did not supply `POCKET_SSH_TOKEN`, a freshly
generated token. Open the URL on your phone, paste the token once, and it is stored in
`localStorage`.

### Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `POCKET_SSH_PORT` | `8790` | HTTP port |
| `POCKET_SSH_HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` to reach it from your phone on the LAN. |
| `POCKET_SSH_TOKEN` | generated | Bearer token required by every API call and websocket. |
| `POCKET_SSH_CONFIG` | `~/.pocket-ssh/config.json` | Where spaces, agents, and tabs are stored. |
| `POCKET_SSH_WEB_ROOT` | `dist-web` | Static web root. |

### Development

```bash
npm run dev        # server with tsx on :8790
npx vite           # web client with /api and /ws proxied to the server
npm test           # vitest
npm run typecheck
npm run lint
```

## Security model

- **Every** API route and the websocket upgrade require the bearer token; comparison is
  constant-time. A wrong token on `/ws` is rejected before any SSH session is created.
- Passwords, key passphrases, and key paths never leave the process: space reads are
  filtered through `toPublicSpace`, and secrets are never logged.
- Reach the server over your **LAN or Tailscale only**. Do not port-forward it to the
  public internet and do not put it behind a plain-HTTP tunnel: the bearer token and
  your terminal traffic would both be exposed. If you need remote access, use Tailscale
  or an authenticated reverse proxy with TLS.
- The config file holds SSH credentials in plaintext. It lives under your home
  directory; keep its permissions tight and prefer `agent` or `key` auth over passwords.

## Architecture

```
src/shared/contracts.ts     zod schemas for every boundary (HTTP bodies, ws frames)
src/server/config/store.ts  atomic JSON store for spaces/agents/tabs
src/server/ssh/manager.ts   ssh2 sessions: pty, resize, multiplexing, teardown
src/server/http/server.ts   node:http + ws, bearer auth, REST CRUD, /ws terminals
src/server/main.ts          CLI entry
src/web/                    vite + xterm.js mobile PWA
```

## License

MIT
