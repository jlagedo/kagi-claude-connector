# Kagi → Claude connector

A remote [MCP](https://modelcontextprotocol.io) server running on a **Cloudflare Worker** that
gives the **Claude mobile and web apps** access to [Kagi](https://kagi.com) search via your Kagi
API key. It exposes two tools — `kagi_search` and `kagi_extract` — mirroring the official
[`kagisearch/kagimcp`](https://github.com/kagisearch/kagimcp) server, but packaged as a public
HTTPS endpoint with **self-contained OAuth** so it works as a Claude custom connector.

## Why this shape

- Claude connects to custom connectors **from Anthropic's cloud**, so the server must be on the
  public internet. A Worker gives you that for free.
- The Claude **mobile** apps can *use* connectors but can't *add* them — you add it once on
  [claude.ai](https://claude.ai) and it then appears on iOS/Android.
- Your Kagi key stays a **Worker secret**; it is never sent to Claude. Access is gated by a single
  password via OAuth, so a stranger who finds the URL can't spend your Kagi credits.

```
Claude (web/mobile) ──OAuth 2.1──▶ Cloudflare Worker ──Authorization: Bot <key>──▶ Kagi v1 API
```

## Prerequisites

- A Cloudflare account + [`wrangler`](https://developers.cloudflare.com/workers/wrangler/) (`npm i`).
- A **Kagi Search API** key (`https://kagi.com/settings/api`). The Search API is in closed beta —
  email `support@kagi.com` for access. Pricing is ~$0.025/search.

## Setup

```bash
npm install

# 1. Create the KV namespace the OAuth provider needs, then paste the printed id
#    into wrangler.jsonc -> kv_namespaces[0].id
npx wrangler kv namespace create OAUTH_KV

# 2. Set secrets (you'll be prompted to paste each value)
npx wrangler secret put KAGI_API_KEY
npx wrangler secret put LOGIN_PASSWORD     # the password you'll type when adding the connector

# 3. Deploy
npx wrangler deploy
```

This Worker is served on a custom domain (`kagi.lagedo.dev`, configured via `routes` in
`wrangler.jsonc`); `wrangler deploy` provisions the DNS record + TLS cert automatically. Without a
custom domain it would be `https://kagi-claude-connector.<you>.workers.dev`.

## Add it to Claude

1. On **claude.ai** → **Settings → Connectors → Add custom connector**.
2. URL: `https://kagi.lagedo.dev/mcp` (Streamable HTTP). `/sse` is also exposed for older clients.
3. Complete the login — enter your `LOGIN_PASSWORD` on the consent screen.
4. Open Claude on your phone. `kagi_search` / `kagi_extract` are now available in chats.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in KAGI_API_KEY + LOGIN_PASSWORD
npx wrangler dev

npm test                         # unit tests for the Kagi request/response contract (no network)
node scripts/smoke.mjs           # full E2E: OAuth flow + real kagi_search, against the dev server
```

## Notes

- **Auth scheme:** every Kagi doc uses `Authorization: Bot <token>`; if your account is provisioned
  for `Bearer`, change `KAGI_AUTH_SCHEME` in `wrangler.jsonc`.
- **Tighter access:** swap the shared-password screen in `src/auth.ts` for GitHub/Google OAuth
  (see Cloudflare's `remote-mcp-github-oauth` template) if you want identity-based access.
- Package versions in `package.json` track fast-moving libraries (`agents`,
  `@modelcontextprotocol/sdk`, `@cloudflare/workers-oauth-provider`); run `npm update` and
  `npx wrangler types` if the build complains.
