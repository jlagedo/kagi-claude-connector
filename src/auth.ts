/**
 * Self-contained OAuth authorization UI.
 *
 * workers-oauth-provider implements the token, registration (DCR) and
 * bookkeeping endpoints for us. The one thing it does NOT implement is the
 * `/authorize` consent screen — that is this file. We gate it with a single
 * shared password (the LOGIN_PASSWORD secret), which is all a personal,
 * single-user connector needs. On success we hand control back to the provider
 * via completeAuthorization(), which mints the code Claude exchanges for a token.
 */

import { Hono } from "hono";
import { html } from "hono/html";
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./index";

type Bindings = Env & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: Bindings }>();

// btoa/atob only handle Latin-1, so encode through UTF-8 first. This lets any
// OAuth request (e.g. a redirect_uri or state with multibyte chars) round-trip
// through the hidden form field without throwing.
function encodeState(req: AuthRequest): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(req))));
}

function decodeState(raw: string): AuthRequest {
  const bytes = Uint8Array.from(atob(raw), (ch) => ch.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function page(title: string, bodyInner: ReturnType<typeof html>) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        <style>
          :root { color-scheme: light dark; }
          body { font-family: -apple-system, system-ui, sans-serif; display: grid;
                 place-items: center; min-height: 100vh; margin: 0; background: #0b0b0c; color: #eee; }
          .card { background: #16161a; padding: 2rem; border-radius: 14px; width: min(92vw, 360px);
                  box-shadow: 0 10px 40px rgba(0,0,0,.5); }
          h1 { font-size: 1.15rem; margin: 0 0 .25rem; }
          p { color: #9a9aa2; font-size: .85rem; margin: .25rem 0 1.25rem; }
          input { width: 100%; box-sizing: border-box; padding: .7rem .8rem; border-radius: 9px;
                  border: 1px solid #2a2a31; background: #0e0e11; color: #eee; font-size: 1rem; }
          button { width: 100%; margin-top: 1rem; padding: .7rem; border: 0; border-radius: 9px;
                   background: #ffb000; color: #111; font-weight: 600; font-size: 1rem; cursor: pointer; }
          .err { color: #ff6b6b; font-size: .82rem; margin-top: .6rem; }
        </style>
      </head>
      <body>
        <div class="card">${bodyInner}</div>
      </body>
    </html>`;
}

/** The password consent screen, with an optional error message. */
function loginPage(state: string, error?: string) {
  return page(
    "Connect Kagi",
    html`
      <h1>Connect Kagi to Claude</h1>
      <p>Enter the connector password to authorize this client.</p>
      <form method="post" action="/authorize">
        <input type="hidden" name="state" value="${state}" />
        <input
          type="password"
          name="password"
          placeholder="Connector password"
          autocomplete="current-password"
          autofocus
          required
        />
        <button type="submit">Authorize</button>
      </form>
      ${error ? html`<div class="err">${error}</div>` : ""}
    `,
  );
}

/**
 * GET /authorize — Claude redirects the user here. Parse the OAuth request,
 * stash it in a hidden field, and show the password prompt.
 */
app.get("/authorize", async (c) => {
  const oauthReq = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
  if (!oauthReq.clientId) {
    return c.text("Invalid authorization request: missing client_id", 400);
  }
  return c.html(loginPage(encodeState(oauthReq)));
});

/**
 * POST /authorize — verify the password, then complete the OAuth flow.
 */
app.post("/authorize", async (c) => {
  const form = await c.req.parseBody();
  const password = String(form.password ?? "");
  const stateRaw = String(form.state ?? "");

  let oauthReq: AuthRequest;
  try {
    oauthReq = decodeState(stateRaw);
  } catch {
    return c.text("Invalid or expired authorization request.", 400);
  }

  // Constant-time-ish comparison; for a single shared secret this is sufficient.
  const expected = c.env.LOGIN_PASSWORD ?? "";
  if (!expected || password.length !== expected.length || password !== expected) {
    return c.html(loginPage(encodeState(oauthReq), "Incorrect password."), 401);
  }

  const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
    request: oauthReq,
    userId: "owner",
    metadata: { label: "Kagi connector owner" },
    scope: oauthReq.scope ?? [],
    // Props are encrypted and forwarded to the MCP Durable Object as `this.props`.
    // The Kagi key lives in env (a Worker secret), so nothing sensitive here.
    props: { userId: "owner" },
  });

  return c.redirect(redirectTo, 302);
});

// Small landing page so hitting the root in a browser isn't a 404.
app.get("/", (c) =>
  c.html(
    page(
      "Kagi connector",
      html`<h1>Kagi → Claude connector</h1>
        <p>This is a remote MCP server. Add it in Claude via
        Settings → Connectors → Add custom connector, using the
        <code>/sse</code> URL of this Worker.</p>`,
    ),
  ),
);

export default app;
