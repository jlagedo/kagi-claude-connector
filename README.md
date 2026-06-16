# Kagi → Claude connector

A remote [MCP](https://modelcontextprotocol.io) server on a **Cloudflare Worker** that exposes
[Kagi](https://kagi.com) search to Claude as a custom connector. It registers two tools —
`kagi_search` and `kagi_extract` — and wraps them in self-contained OAuth 2.1 so Claude can connect
to it directly. The tool surface mirrors the official
[`kagisearch/kagimcp`](https://github.com/kagisearch/kagimcp) server.

```
Claude (web/mobile) ──OAuth 2.1──▶ Cloudflare Worker ──Authorization: Bot <key>──▶ Kagi v1 API
```

Two technical constraints drive the design:

- Claude reaches a custom connector **from Anthropic's cloud**, so the server must be a public HTTPS
  endpoint — hence a Worker, not a local process.
- The Kagi key is a **Worker secret**; it never leaves the server or reaches Claude. The `/authorize`
  screen gates access behind a single password so the public URL can't be used by a stranger.

## Architecture

| File | Role |
| --- | --- |
| `src/index.ts` | Entrypoint. Wraps everything in `OAuthProvider`, registers the `KagiMCP` Durable Object and its two tools. |
| `src/kagi.ts` | Kagi v1 API client. Pure request/response logic, no Worker/MCP types (unit-testable in plain Node). |
| `src/auth.ts` | Hono app for the `/authorize` consent screen — a single-password gate that completes the OAuth grant. |
| `test/kagi.test.ts` | Unit tests for the Kagi request/response contract (mocked fetch, no network). |
| `scripts/smoke.mjs` | End-to-end check: drives the OAuth flow, then calls `kagi_search` over MCP. |

`OAuthProvider` implements `/token` and `/register` (Dynamic Client Registration) itself and
protects `/mcp` (Streamable HTTP) + `/sse` (legacy); the `/authorize` UI is delegated to `src/auth.ts`.

### Kagi v1 contract

- `POST /search` with `format: "markdown"` → response body is markdown.
- `POST /extract` with `format: "json"` → `{ data: [{ markdown }], meta, errors }`.
- Auth header is `Authorization: Bot <key>` (override with `KAGI_AUTH_SCHEME`).

## Prerequisites

- A **Cloudflare account** (`wrangler` is a dev dependency — no global install).
- A **Kagi API key** with v1 Search + Extract access, from the [API portal](https://kagi.com/settings/api).
- **Node 18+**.
- *(Optional)* a domain on Cloudflare for a custom hostname instead of `*.workers.dev`.

## Setup

### 1. Install

```bash
npm install
```

### 2. Create the OAuth KV namespace

`workers-oauth-provider` stores token hashes, grants, and registered clients in KV.

```bash
npx wrangler kv namespace create OAUTH_KV
```

Copy the printed `id` into `wrangler.jsonc` under `kv_namespaces`:

```jsonc
"kv_namespaces": [{ "binding": "OAUTH_KV", "id": "<the-id-you-got>" }]
```

> If you let wrangler "add it on your behalf", it **appends** a second `OAUTH_KV` binding instead of
> replacing the placeholder — keep only one. A KV namespace id is an identifier, not a secret.

### 3. Choose the hostname

By default the Worker deploys to `https://kagi-claude-connector.<subdomain>.workers.dev`.

For a custom hostname (the zone must be on the same Cloudflare account), set a route in
`wrangler.jsonc` — `custom_domain: true` auto-provisions the DNS record + TLS cert on deploy (do
**not** create the DNS record manually):

```jsonc
"routes": [{ "pattern": "kagi.yourdomain.com", "custom_domain": true }]
```

No code change is needed — the OAuth issuer is derived from the request host at runtime.

### 4. Set secrets

```bash
npx wrangler secret put KAGI_API_KEY      # Kagi v1 API key
npx wrangler secret put LOGIN_PASSWORD    # password typed on the consent screen
```

### 5. Deploy

```bash
npx wrangler deploy
```

A first deploy with a custom domain provisions the cert, which can take ~a minute. Confirm secrets
with `npx wrangler secret list`.

## Add it to Claude

Add the connector on **claude.ai (web)** or **Claude Desktop**; the mobile apps then use it
automatically (the add-connector flow is web/desktop only).

1. **Settings → Connectors → Add custom connector**.
2. **URL:** `https://kagi.yourdomain.com/mcp` (Streamable HTTP; `/sse` is also exposed).
3. Leave **OAuth Client ID / Secret blank** — the server supports DCR, so Claude self-registers.
4. **Add** → redirected to the login screen → enter `LOGIN_PASSWORD` → **Authorize**.
5. The connector shows **Connected** with `kagi_search` and `kagi_extract`.

## Local development

```bash
cp .dev.vars.example .dev.vars   # set KAGI_API_KEY + LOGIN_PASSWORD
npx wrangler dev                 # local server at http://localhost:8787

npm test                         # unit tests (no network)
node scripts/smoke.mjs           # E2E against the local dev server
```

`scripts/smoke.mjs` reads `LOGIN_PASSWORD` from `.dev.vars`. Run it against prod with
`BASE=https://kagi.yourdomain.com node scripts/smoke.mjs`.

## Configuration reference

| Name | Where | Purpose |
| --- | --- | --- |
| `KAGI_API_KEY` | secret | Kagi v1 API key, sent as `Authorization: Bot <key>`. |
| `LOGIN_PASSWORD` | secret | Password for the OAuth consent screen. |
| `KAGI_AUTH_SCHEME` | var | Auth header scheme; defaults to `Bot`. Set to `Bearer` only if Kagi returns 401. |
| `KAGI_API_BASE` | var | Kagi API base URL (`https://kagi.com/api/v1`). |
| `OAUTH_KV` | KV binding | OAuth token/grant/client storage. |
| `MCP_OBJECT` | Durable Object | Backs the `KagiMCP` agent; required by the `agents` library. |

## Troubleshooting

- **Connect fails:** confirm the URL ends in `/mcp`; if Claude rejects it, try `/sse`.
- **Kagi 401:** set `KAGI_AUTH_SCHEME` to `Bearer` in `wrangler.jsonc` and redeploy.
- **Revoke access:** remove the connector in Claude, and/or rotate `LOGIN_PASSWORD`.
- **Identity-based access:** swap the shared-password screen in `src/auth.ts` for GitHub/Google
  OAuth (see Cloudflare's `remote-mcp-github-oauth` template).
- **Build complains after a dep bump:** run `npm update` and `npx wrangler types`.
