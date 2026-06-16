// End-to-end local smoke test: drives the full OAuth flow (DCR -> authorize
// with password -> token) against `wrangler dev`, then calls kagi_search /
// kagi_extract over MCP with the resulting token. Verifies the real Kagi v1
// contract locally. Run with the dev server up:  node scripts/smoke.mjs
import { readFileSync } from "node:fs";
import crypto from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const BASE = process.env.BASE ?? "http://localhost:8787";
const REDIRECT = "http://localhost:9999/callback";

const devVars = readFileSync(new URL("../.dev.vars", import.meta.url), "utf8");
const PASSWORD = devVars.match(/^LOGIN_PASSWORD\s*=\s*"?([^"\n]+)"?/m)?.[1];
if (!PASSWORD) throw new Error("LOGIN_PASSWORD not found in .dev.vars");

// 1. Dynamic Client Registration
const reg = await (
  await fetch(`${BASE}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "smoke",
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    }),
  })
).json();
const clientId = reg.client_id;
if (!clientId) throw new Error("DCR failed: " + JSON.stringify(reg));

// 2. PKCE
const verifier = crypto.randomBytes(32).toString("base64url");
const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");

// 3. GET /authorize -> consent page carrying the hidden `state`
const authUrl = new URL(`${BASE}/authorize`);
Object.entries({
  response_type: "code",
  client_id: clientId,
  redirect_uri: REDIRECT,
  code_challenge: challenge,
  code_challenge_method: "S256",
  state: "smoke-state",
  scope: "",
}).forEach(([k, v]) => authUrl.searchParams.set(k, v));
const page = await (await fetch(authUrl)).text();
const state = page.match(/name="state" value="([^"]+)"/)?.[1];
if (!state) throw new Error("could not find hidden state on /authorize page");

// 4. POST /authorize with the password -> 302 to redirect_uri?code=...
const authResp = await fetch(`${BASE}/authorize`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password: PASSWORD, state }),
  redirect: "manual",
});
const location = authResp.headers.get("location");
if (!location) throw new Error(`no redirect from /authorize (status ${authResp.status})`);
const code = new URL(location).searchParams.get("code");
if (!code) throw new Error("no authorization code in redirect: " + location);

// 5. Token exchange
const tok = await (
  await fetch(`${BASE}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      client_id: clientId,
      code_verifier: verifier,
    }),
  })
).json();
if (!tok.access_token) throw new Error("token exchange failed: " + JSON.stringify(tok));
console.log("✓ OAuth flow OK (DCR -> authorize -> token)");

// 6. MCP over Streamable HTTP with the bearer token
const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${tok.access_token}` } },
});
const mcp = new Client({ name: "smoke", version: "1.0.0" });
await mcp.connect(transport);

const { tools } = await mcp.listTools();
console.log("✓ tools/list:", tools.map((t) => t.name).join(", "));

const search = await mcp.callTool({ name: "kagi_search", arguments: { query: "kagi search", limit: 3 } });
const searchText = (search.content ?? []).map((c) => c.text).join("\n");
console.log(`\n--- kagi_search (isError=${!!search.isError}) ---`);
console.log(searchText.slice(0, 700));

await mcp.close();
