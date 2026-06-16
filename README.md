# Kagi → Claude connector

A remote [MCP](https://modelcontextprotocol.io) server running on a **Cloudflare Worker** that
gives the **Claude mobile and web apps** access to [Kagi](https://kagi.com) search via your Kagi
API key. It exposes two tools — `kagi_search` and `kagi_extract` — mirroring the official
[`kagisearch/kagimcp`](https://github.com/kagisearch/kagimcp) server, but packaged as a public
HTTPS endpoint with **self-contained OAuth** so it works as a Claude custom connector.

```
Claude (web/mobile) ──OAuth 2.1──▶ Cloudflare Worker ──Authorization: Bot <key>──▶ Kagi v1 API
```

## Why this shape

- Claude connects to custom connectors **from Anthropic's cloud**, so the server must be on the
  public internet. A Worker gives you that for free.
- The Claude **mobile** apps can *use* connectors but can't *add* them — you add it once on
  [claude.ai](https://claude.ai) and it then appears on iOS/Android.
- Your Kagi key stays a **Worker secret**; it is never sent to Claude. Access is gated by a single
  password via OAuth, so a stranger who finds the URL can't spend your Kagi credits.

## How it works

| File | Role |
| --- | --- |
| `src/index.ts` | Wires `OAuthProvider` around the Worker and registers the `KagiMCP` agent (the two tools). |
| `src/kagi.ts` | Thin Kagi v1 API client (`POST /search` → markdown, `POST /extract` → JSON envelope). |
| `src/auth.ts` | The `/authorize` consent screen — a single-password gate that completes the OAuth grant. |
| `test/kagi.test.ts` | Unit tests for the Kagi request/response contract (no network). |
| `scripts/smoke.mjs` | Full end-to-end check: scripts the OAuth flow + a real `kagi_search`. |

`OAuthProvider` implements `/token` and `/register` (Dynamic Client Registration) itself and
protects `/sse` + `/mcp`; everything else (the login UI) is handled by `src/auth.ts`. The Kagi key
lives in `env.KAGI_API_KEY` (a Worker secret) and never reaches Claude.

## Prerequisites

- A **Cloudflare account**. `wrangler` comes in via `npm install` (no global install needed).
- A **Kagi Search API** key from [kagi.com/settings/api](https://kagi.com/settings/api). The Search
  API is in closed beta — email `support@kagi.com` for access. Pricing is ~$0.025/search.
- **Node 18+**.
- *(Optional)* a domain on Cloudflare if you want a custom hostname instead of `*.workers.dev`.

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
> replacing the placeholder — delete the old placeholder entry so only one binding remains.
> A KV namespace id is an identifier, not a secret, so it is safe to commit.

### 3. Choose the hostname

By default the Worker deploys to `https://kagi-claude-connector.<your-subdomain>.workers.dev`.

To serve it on **your own domain** (the zone must be on the same Cloudflare account), set a custom
domain route in `wrangler.jsonc` — `custom_domain: true` auto-provisions the DNS record + TLS cert
on deploy (do **not** create the DNS record manually):

```jsonc
"routes": [{ "pattern": "kagi.yourdomain.com", "custom_domain": true }]
```

No code change is needed — the OAuth issuer is derived from the request host at runtime. If you
don't want a custom domain, remove the `routes` block and use the `workers.dev` URL.

### 4. Set secrets

You'll be prompted to paste each value; they are stored encrypted and never committed.

```bash
npx wrangler secret put KAGI_API_KEY      # your Kagi Search API key
npx wrangler secret put LOGIN_PASSWORD    # the password you'll type when connecting (pick a long random one)
```

### 5. Deploy

```bash
npx wrangler deploy
```

First deploy provisions the custom domain + cert, which can take ~a minute to go active. Confirm the
secrets are set with `npx wrangler secret list`.

## Add it to Claude

You must add the connector on **claude.ai (web)** or the desktop app — mobile can't add connectors,
but inherits this one automatically once added.

1. **claude.ai** → **Settings → Connectors** → scroll down → **Add custom connector**.
2. **Name:** `Kagi`. **URL:** `https://kagi.yourdomain.com/mcp` (Streamable HTTP; `/sse` is also
   exposed for older clients).
3. Leave **OAuth Client ID / Secret blank** — the server supports Dynamic Client Registration, so
   Claude registers itself.
4. Click **Add** → you're redirected to the login screen → enter your **`LOGIN_PASSWORD`** →
   **Authorize**.
5. The connector shows **Connected** with tools `kagi_search` and `kagi_extract`. Enable it in a
   chat via the composer's connectors menu, then ask anything searchy.
6. Open Claude on your **phone** (same account) — the tools are already there.

> Custom connectors require a Pro/Max/Team/Enterprise plan (Free has limits). If you don't see
> "Add custom connector", it's a plan/rollout gate on the account.

## Verify

```bash
npx wrangler secret list                                  # confirm KAGI_API_KEY + LOGIN_PASSWORD are set
BASE=https://kagi.yourdomain.com node scripts/smoke.mjs   # full OAuth flow + a real kagi_search
```

`smoke.mjs` reads `LOGIN_PASSWORD` from `.dev.vars`, so set the same password locally as in the
secret. A successful run prints `✓ OAuth flow OK`, the tool list, and live Kagi results.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in KAGI_API_KEY + LOGIN_PASSWORD
npx wrangler dev                 # local server at http://localhost:8787

npm test                         # unit tests (no network)
node scripts/smoke.mjs           # full E2E against the local dev server
```

## Configuration reference

| Name | Where | Purpose |
| --- | --- | --- |
| `KAGI_API_KEY` | secret | Kagi Search API key, sent to Kagi as `Authorization: Bot <key>`. |
| `LOGIN_PASSWORD` | secret | Password for the OAuth consent screen. |
| `KAGI_AUTH_SCHEME` | var (`wrangler.jsonc`) | Auth header scheme; defaults to `Bot`. Switch to `Bearer` only if Kagi returns 401. |
| `KAGI_API_BASE` | var (`wrangler.jsonc`) | Kagi API base URL (`https://kagi.com/api/v1`). |
| `OAUTH_KV` | KV binding | OAuth token/grant/client storage. |
| `MCP_OBJECT` | Durable Object | Backs the `KagiMCP` agent; required by the `agents` library. |

## Notes / troubleshooting

- **Connect fails:** confirm the URL is exactly `…/mcp`; if Claude rejects it, try `…/sse`.
- **Kagi 401:** set `KAGI_AUTH_SCHEME` to `Bearer` in `wrangler.jsonc` and redeploy.
- **Revoke access:** remove the connector in Claude, and/or rotate with `wrangler secret put LOGIN_PASSWORD`.
- **Tighter access:** swap the shared-password screen in `src/auth.ts` for GitHub/Google OAuth
  (see Cloudflare's `remote-mcp-github-oauth` template) if you want identity-based access.
- Package versions track fast-moving libraries (`agents`, `@modelcontextprotocol/sdk`,
  `@cloudflare/workers-oauth-provider`); run `npm update` and `npx wrangler types` if the build complains.
