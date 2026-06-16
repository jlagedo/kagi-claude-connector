# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single Cloudflare Worker that acts as a **remote MCP server**, exposing Kagi search/extract to the Claude apps (web + mobile) as a custom connector. Claude connects from Anthropic's cloud over OAuth; the Worker proxies tool calls to the Kagi v1 API using a Kagi key held as a Worker secret.

```
Claude (web/mobile) --OAuth 2.1--> this Worker --Authorization: Bot <key>--> https://kagi.com/api/v1
```

## Commands

```bash
npm test                       # vitest run — unit tests, no network (mocked fetch)
npx vitest run test/kagi.test.ts -t "lens"   # single file / -t filters by test name
npx tsc --noEmit               # type-check
npx wrangler deploy --dry-run  # validate the bundle without deploying (no auth needed)
npx wrangler dev               # local server; reads secrets from .dev.vars
node scripts/smoke.mjs         # full local E2E: scripts the OAuth flow + a real kagi_search (dev server must be up)
npx wrangler types             # regenerate worker-configuration.d.ts — RERUN after editing wrangler.jsonc
```

The Worker is served on the custom domain `kagi.lagedo.dev` (`routes` in `wrangler.jsonc`, `custom_domain: true` — DNS + cert auto-provisioned on deploy). Connector URL for Claude: `https://kagi.lagedo.dev/mcp`.

There is no separate lint step; `tsc --noEmit` is the gate. The full local check is `npm test && npx tsc --noEmit && npx wrangler deploy --dry-run`.

First-time deploy setup (one-time, requires a Cloudflare + Kagi account): create the KV namespace (`npx wrangler kv namespace create OAUTH_KV`) and paste its id into `wrangler.jsonc`, then `npx wrangler secret put KAGI_API_KEY` and `npx wrangler secret put LOGIN_PASSWORD`, then `npx wrangler deploy`. A connector must be **added on claude.ai** (web) before it appears in the mobile apps; mobile cannot add connectors.

## Architecture

Three source files, each a distinct layer:

- **`src/index.ts`** — the entrypoint. Wires `OAuthProvider` (from `@cloudflare/workers-oauth-provider`) around everything: it implements `/token` and `/register` (DCR) itself, routes `/sse` + `/mcp` to the MCP server, and delegates everything else (the `/authorize` UI) to `src/auth.ts`. `KagiMCP extends McpAgent` (a Durable Object) and registers the two tools (`kagi_search`, `kagi_extract`) whose handlers call into `src/kagi.ts`.
- **`src/kagi.ts`** — the Kagi v1 API client. Pure request/response logic, no Worker/MCP types (it imports `Env` as a type only — that is why it is unit-testable in plain Node). This file is the one most worth testing because its request shape must match Kagi's contract.
- **`src/auth.ts`** — a Hono app implementing only the OAuth consent screen (`/authorize` GET form + POST password check) plus a landing page. On a correct password it calls `env.OAUTH_PROVIDER.completeAuthorization(...)`, which mints the code Claude exchanges for a token.

The MCP tool surface and request/response contract deliberately mirror the official Python server (`kagisearch/kagimcp`, `src/kagimcp/server.py`) — consult it when changing tool params or the Kagi request body.

## Non-obvious constraints (read before editing)

- **The Kagi v1 contract is inferred, not runtime-verified.** `kagi.ts` assumes `POST /search` with `format:"markdown"` returns markdown as the raw body, `POST /extract` with `format:"json"` returns `{data:[{markdown}]}`, and auth is `Bot <key>`. All of this is reverse-engineered from the official client. If search returns 401, flip `KAGI_AUTH_SCHEME` (a var in `wrangler.jsonc`) to `Bearer`. If it returns JSON instead of markdown, `kagiSearch` needs to parse rather than return `.text()`.
- **The `as any` casts in `index.ts` on the `apiHandlers`/`defaultHandler` are required and intentional.** `agents`, `workers-oauth-provider`, and the wrangler-generated runtime types each pull a slightly different `@cloudflare/workers-types` (the `getSetCookie`-on-`Headers` diff), so the structurally-identical handlers don't unify by name. The casts are type-only; runtime is correct. Do not try to "fix" them by changing handler signatures.
- **`agents` (≥0.16) requires `zod` v4 as a peer; the MCP SDK supports v3 or v4.** Keep `zod` on v4. Use zod-4 idioms: top-level `z.url()` (not `z.string().url()`).
- **The Kagi key stays server-side.** It lives in `env.KAGI_API_KEY` (a secret), never in OAuth `props` and never sent to Claude. Keep it that way — the OAuth password gate exists so a stranger who finds the URL can't spend Kagi credits.
- **`Env` extends the generated `Cloudflare.Env`** (`index.ts`) and only declares the secrets, because `wrangler types` already covers bindings + vars but not `wrangler secret` values.
- Use the MCP SDK's `server.registerTool(name, {title, description, inputSchema}, cb)` form (not the legacy `server.tool()`). Tool handlers may throw — the SDK converts thrown errors into an `isError` result, so no per-tool try/catch is needed.
