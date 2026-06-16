/**
 * Thin client for the Kagi v1 API, matching the request/response contract used
 * by the official MCP server (kagisearch/kagimcp, src/kagimcp/server.py):
 *
 *   - POST {base}/search   with `format: "markdown"`  -> body IS markdown text
 *   - POST {base}/extract  with `format: "json"`      -> { data: [{ markdown }], meta, errors }
 *
 * Auth is a single Authorization header. Every public Kagi doc uses the
 * `Bot <token>` scheme, so that is the default; it is overridable via the
 * KAGI_AUTH_SCHEME var in case an account is provisioned for `Bearer`.
 */

import type { Env } from "./index";

function authHeader(env: Env): string {
  const scheme = (env.KAGI_AUTH_SCHEME || "Bot").trim();
  return `${scheme} ${env.KAGI_API_KEY}`;
}

export interface SearchParams {
  query: string;
  workflow?: "search" | "news" | "videos" | "podcasts" | "images";
  limit?: number;
  extractCount?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  timeRelative?: "day" | "week" | "month";
  after?: string;
  before?: string;
  fileType?: string;
  lensId?: string;
}

/** Pull human-readable messages out of Kagi's `{ errors: [{ message }] }` envelope. */
async function errorMessage(resp: Response): Promise<string> {
  const text = await resp.text().catch(() => "");
  try {
    const parsed = JSON.parse(text);
    const errs = parsed?.errors;
    if (Array.isArray(errs) && errs.length) {
      return errs.map((e: { message?: string }) => e?.message).filter(Boolean).join("; ") || text;
    }
  } catch {
    /* not JSON — fall through */
  }
  return text || resp.statusText;
}

/** Throw a formatted error if a Kagi response is not OK. `label` is e.g. "Search". */
async function ensureOk(resp: Response, label: string): Promise<void> {
  if (!resp.ok) {
    throw new Error(`Kagi ${label} API error (${resp.status}): ${await errorMessage(resp)}`);
  }
}

export async function kagiSearch(env: Env, p: SearchParams): Promise<string> {
  if (p.timeRelative && (p.after || p.before)) {
    throw new Error("'time_relative' is mutually exclusive with 'after'/'before'.");
  }

  // The lens (sites/time/file filters) and an explicit lens_id are mutually
  // exclusive on Kagi's side — mirror the official server's guard.
  const lens: Record<string, unknown> = {};
  if (p.includeDomains?.length) lens.sites_included = p.includeDomains;
  if (p.excludeDomains?.length) lens.sites_excluded = p.excludeDomains;
  if (p.timeRelative) lens.time_relative = p.timeRelative;
  if (p.fileType) lens.file_type = p.fileType;
  const hasLens = Object.keys(lens).length > 0;
  if (p.lensId && hasLens) {
    throw new Error(
      "'lensId' is mutually exclusive with includeDomains/excludeDomains/timeRelative/fileType.",
    );
  }

  const filters: Record<string, unknown> = {};
  if (p.after) filters.after = p.after;
  if (p.before) filters.before = p.before;

  const body: Record<string, unknown> = {
    query: p.query,
    workflow: p.workflow ?? "search",
    format: "markdown",
    limit: p.limit ?? 10,
  };
  if (p.extractCount && p.extractCount > 0) body.extract = { count: p.extractCount };
  if (p.lensId) body.lens_id = p.lensId;
  if (hasLens) body.lens = lens;
  if (Object.keys(filters).length) body.filters = filters;

  const resp = await fetch(`${env.KAGI_API_BASE}/search`, {
    method: "POST",
    headers: {
      Authorization: authHeader(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  await ensureOk(resp, "Search");
  // With format=markdown the entire response body is ready-to-use markdown.
  return await resp.text();
}

export async function kagiExtract(env: Env, url: string): Promise<string> {
  const resp = await fetch(`${env.KAGI_API_BASE}/extract`, {
    method: "POST",
    headers: {
      Authorization: authHeader(env),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pages: [{ url }], format: "json" }),
  });

  await ensureOk(resp, "Extract");

  const json = (await resp.json()) as {
    data?: Array<{ markdown?: string }>;
    errors?: unknown;
    meta?: { trace?: string };
  };
  const markdown = json.data?.[0]?.markdown;
  if (!markdown) {
    const suffix = json.meta?.trace ? ` (trace id: ${json.meta.trace})` : "";
    if (json.errors) throw new Error(`Kagi Extract API error: ${JSON.stringify(json.errors)}${suffix}`);
    throw new Error(`Kagi Extract API returned no content.${suffix}`);
  }
  return markdown;
}
