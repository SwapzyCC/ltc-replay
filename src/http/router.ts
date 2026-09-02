/**
 * Request dispatch.
 *
 * A table rather than a framework: the API is eleven endpoints, and a router
 * dependency would be more code than the thirty lines it replaces — plus a
 * middleware chain to audit every time this service is reviewed.
 *
 * Order matters only in that literal paths are matched before patterns.
 *
 * All but /v1/watch are reads. The watchlist is the one thing a consumer
 * writes, because it is the one thing the chain cannot tell the relay.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiDeps } from "./context.js";
import { json } from "./respond.js";
import { health, tip, stats } from "./routes/meta.js";
import { events } from "./routes/events.js";
import { txStatus } from "./routes/tx.js";
import { addressHistory } from "./routes/address.js";
import { oneBlock, replay } from "./routes/blocks.js";
import { listWatched, addWatched, removeWatched } from "./routes/watch.js";

const BLOCK_PATH = /^\/v1\/block\/([0-9a-fA-F]{64})$/;
const TX_PATH = /^\/v1\/tx\/([0-9a-fA-F]{64})$/;
// Deliberately permissive: the address route validates the encoding itself and
// answers 400 with a reason, which is more useful than a bare 404 from here.
const ADDRESS_PATH = /^\/v1\/address\/([A-Za-z0-9]{25,90})$/;
const WATCH_PATH = /^\/v1\/watch\/([A-Za-z0-9]{25,90})$/;

export interface Dispatch {
  /** True when the route may be served without a bearer token. */
  isPublic: boolean;
  run: () => void | Promise<void>;
}

/**
 * Resolves a request to a handler, or null when nothing matches.
 *
 * Resolution happens before authentication so that /health stays open while
 * everything else is closed, and so an unauthenticated request to a route that
 * does not exist still answers 401 rather than leaking which paths are real.
 */
export function resolve(
  deps: ApiDeps,
  method: string,
  path: string,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Dispatch | null {
  if (method === "POST" && path === "/v1/watch") {
    return { isPublic: false, run: () => addWatched(deps, req, res) };
  }

  const unwatch = WATCH_PATH.exec(path);
  if (method === "DELETE" && unwatch?.[1]) {
    const value = unwatch[1];
    return { isPublic: false, run: () => removeWatched(deps, value, res) };
  }

  if (method !== "GET" && method !== "HEAD") return null;

  switch (path) {
    case "/health":
      return { isPublic: true, run: () => health(deps, res) };
    case "/v1/tip":
      return { isPublic: false, run: () => tip(deps, res) };
    case "/v1/events":
      return { isPublic: false, run: () => events(deps, url, res) };
    case "/v1/stats":
      return { isPublic: false, run: () => stats(deps, res) };
    case "/v1/replay":
      return { isPublic: false, run: () => replay(deps, url, req, res) };
    case "/v1/watch":
      return { isPublic: false, run: () => listWatched(deps, url, res) };
  }

  const block = BLOCK_PATH.exec(path);
  if (block?.[1]) {
    const hash = block[1].toLowerCase();
    return { isPublic: false, run: () => oneBlock(deps, hash, res) };
  }

  const tx = TX_PATH.exec(path);
  if (tx?.[1]) {
    const txid = tx[1].toLowerCase();
    return { isPublic: false, run: () => txStatus(deps, txid, res) };
  }

  const address = ADDRESS_PATH.exec(path);
  if (address?.[1]) {
    // Addresses are case-sensitive in base58 and case-insensitive in bech32,
    // so the value is passed through exactly as given; the index stores the
    // canonical form the decoder produced.
    const value = address[1];
    return { isPublic: false, run: () => addressHistory(deps, value, url, res) };
  }

  return null;
}

export function notFound(res: ServerResponse): void {
  json(res, 404, { error: "not_found" });
}

export function methodNotAllowed(res: ServerResponse): void {
  res.setHeader("allow", "GET, HEAD, POST, DELETE");
  json(res, 405, { error: "method_not_allowed" });
}
