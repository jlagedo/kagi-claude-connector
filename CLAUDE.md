# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single Cloudflare Worker acting as a **remote MCP server**: it exposes Kagi search/extract to the Claude apps as a custom connector, proxying tool calls to the Kagi v1 API with a Kagi key held as a Worker secret. Claude connects from Anthropic's cloud over OAuth, implemented in-Worker.

```
Claude (web/mobile) --OAuth 2.1--> this Worker --Authorization: Bot <key>--> https://kagi.com/api/v1
```

## Commands

```bash
npm test                       # vitest run — unit tests, no network (mocked fetch)
npx vitest run test/kagi.test.ts -t "lens"   # single file / -t filters by test name
npx tsc --noEmit               # type-check — there is no separate lint step; this is the gate
npx wrangler deploy --dry-run  # validate the bundle without deploying (no auth needed)
npx wrangler dev               # local server; reads secrets from .dev.vars
node scripts/smoke.mjs         # full E2E: OAuth flow + a real kagi_search (needs dev server up)
npx wrangler types             # regenerate worker-configuration.d.ts — RERUN after editing wrangler.jsonc
```

Full local check before pushing: `npm test && npx tsc --noEmit && npx wrangler deploy --dry-run`. First-time deploy (KV namespace + secrets) is documented in the README.

## Architecture

Three layers, one file each:

- **`src/index.ts`** — entrypoint. Wraps everything in `OAuthProvider` (which implements `/token` + `/register`/DCR and protects `/mcp` + `/sse`) and delegates the `/authorize` UI to `src/auth.ts`. `KagiMCP extends McpAgent` (a Durable Object) registers the two tools.
- **`src/kagi.ts`** — Kagi v1 client. No Worker/MCP types (imports `Env` as a type only), so it is unit-testable in plain Node. Contract: `POST /search` with `format:"markdown"` → markdown body; `POST /extract` with `format:"json"` → `{data:[{markdown}]}`; auth `Authorization: Bot <key>`. Mirrors the official server (`kagisearch/kagimcp`, `rehan/v1-api` branch) — consult it when changing the request body.
- **`src/auth.ts`** — Hono app for the `/authorize` consent screen (password gate). On success it calls `completeAuthorization(...)` to mint the OAuth code.

## Non-obvious constraints (read before editing)

- **The `as any` casts in `index.ts` on `apiHandlers`/`defaultHandler` are intentional.** `agents`, `workers-oauth-provider`, and the generated runtime types each pull a slightly different `@cloudflare/workers-types`, so the structurally-identical handlers don't unify by name. The casts are type-only; runtime is correct. Don't "fix" them.
- **Keep `zod` on v4.** `agents` (≥0.16) requires it as a peer; the MCP SDK accepts v3 or v4. Use zod-4 idioms: top-level `z.url()`, not `z.string().url()`.
- **Use `server.registerTool(name, {title, description, inputSchema}, cb)`** (not the legacy `server.tool()`). Handlers may throw — the SDK converts thrown errors into an `isError` result, so no per-tool try/catch.
- **The Kagi key stays server-side** — `env.KAGI_API_KEY` (a secret), never in OAuth `props`, never sent to Claude.
- **`KAGI_AUTH_SCHEME` (var in `wrangler.jsonc`) defaults to `Bot`** — an escape hatch only; flip to `Bearer` if a key 401s. Don't change the default.
- **`Env` (in `index.ts`) extends the generated `Cloudflare.Env`** and declares only the secrets — `wrangler types` covers bindings + vars but not `wrangler secret` values.
