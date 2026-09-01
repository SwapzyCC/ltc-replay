/**
 * Response writers and query-parameter parsing.
 *
 * Every response body the API produces goes through here, so the caching and
 * content-type headers are decided once rather than per route.
 */

import type { ServerResponse } from "node:http";

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

export function badRequest(res: ServerResponse, detail: string): void {
  json(res, 400, { error: "bad_request", detail });
}

/** Opens an NDJSON stream. One JSON object per line, no array wrapper. */
export function beginNdjson(res: ServerResponse, headers: Record<string, string> = {}): void {
  res.writeHead(200, {
    "content-type": "application/x-ndjson; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
}

/**
 * Writes one chunk, waiting for drain when the socket is full.
 *
 * Without the wait, a consumer slower than the node is fast lets the response
 * buffer grow without bound inside the relay. Resolves false once the socket
 * is gone, which is the caller's signal to stop producing.
 */
export function write(res: ServerResponse, chunk: string): Promise<boolean> {
  if (res.destroyed) return Promise.resolve(false);
  if (res.write(chunk)) return Promise.resolve(true);
  return new Promise((resolve) => {
    res.once("drain", () => resolve(!res.destroyed));
    res.once("close", () => resolve(false));
  });
}

export function writeLine(res: ServerResponse, value: unknown): Promise<boolean> {
  return write(res, `${JSON.stringify(value)}\n`);
}

/**
 * Parses an integer query parameter.
 *
 * Returns `fallback` when the parameter is absent and null when it is present
 * but unparseable or out of range — a typo becomes a 400 instead of silently
 * taking the default, which is how a consumer ends up believing it asked for
 * something it did not.
 */
export function intParam(
  url: URL,
  key: string,
  fallback: number | null,
  min: number,
  max: number,
): number | null {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

/** Same contract as `intParam`, for flags. `?flag` with no value means true. */
export function boolParam(url: URL, key: string, fallback: boolean): boolean | null {
  const raw = url.searchParams.get(key);
  if (raw === null) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "") return true;
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  return null;
}
