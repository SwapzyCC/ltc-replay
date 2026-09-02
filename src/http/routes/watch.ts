/**
 * /v1/watch — the address set the relay indexes.
 *
 * This is the endpoint that decides how large the database gets. Everything
 * else here is read-only against what the chain already said; this is the one
 * place a consumer tells the relay what it cares about.
 *
 * The list is also the only part of the journal that cannot be rebuilt from
 * the chain, which shapes the contract:
 *
 *   Adding is idempotent and bulk. The documented recovery from a rebuilt
 *   journal is for the consumer to re-push its whole registry, so `POST` takes
 *   an array, ignores duplicates, and reports how many were new rather than
 *   failing on the first one it already had.
 *
 *   `count` is on `GET`. A consumer syncing on a timer needs one cheap call to
 *   decide whether a full push is warranted — a relay whose count has dropped
 *   to zero has been rebuilt, and every deposit since then is unindexed.
 *
 *   A rescan is opt-in and bounded. Registering an address before publishing
 *   it to a user needs none: the filter only ever drops what arrived before
 *   the address did. It is for imports and out-of-sync registries, and it is
 *   capped by WATCH_RESCAN_MAX_BLOCKS because an unbounded one is a way to
 *   make the relay walk the chain on request.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiDeps } from "../context.js";
import { json, badRequest, intParam, readJsonBody } from "../respond.js";
import { looksLikeAddress } from "../../chain/address.js";
import { logger, errMsg } from "../../core/log.js";

const log = logger("http");

/** Enough for a large registry push; beyond it, page the sync. */
const MAX_ADD = 10_000;

const MAX_LIST = 1_000;
const DEFAULT_LIST = 200;

/** Labels are operator-facing text, not a place to park a payload. */
const MAX_LABEL_LENGTH = 128;

export function listWatched(deps: ApiDeps, url: URL, res: ServerResponse): void {
  const limit = intParam(url, "limit", DEFAULT_LIST, 0, MAX_LIST);
  if (limit === null) return badRequest(res, `invalid limit (0..${MAX_LIST})`);

  const offset = intParam(url, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
  if (offset === null) return badRequest(res, "invalid offset");

  json(res, 200, {
    // The count is the field a sync loop reads. `limit=0` returns it alone,
    // which is the cheap call that answers "has this relay been rebuilt?".
    count: deps.watchlist.size,
    enabled: deps.watchlist.enabled,
    query: { limit, offset },
    addresses: limit === 0 ? [] : deps.journal.listWatched(limit, offset),
  });
}

export async function addWatched(
  deps: ApiDeps,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await readJsonBody(req, res);
  if (body === null) return;

  const raw = collectAddresses(body);
  if (raw === null) {
    return badRequest(res, 'expected "address" (string) or "addresses" (array of strings)');
  }
  if (raw.length === 0) return badRequest(res, "no addresses given");
  if (raw.length > MAX_ADD) {
    return badRequest(res, `at most ${MAX_ADD} addresses per request; page the sync`);
  }

  const label = body["label"];
  if (label !== undefined && (typeof label !== "string" || label.length > MAX_LABEL_LENGTH)) {
    return badRequest(res, `label must be a string of at most ${MAX_LABEL_LENGTH} characters`);
  }

  // Rejected wholesale rather than partially applied. A consumer that pushes a
  // registry and gets a 200 must be able to conclude the whole registry is
  // being watched — a partial success it has to reconcile is worse than a
  // failure it retries.
  const invalid = raw.filter((a) => !looksLikeAddress(a));
  if (invalid.length > 0) {
    return badRequest(
      res,
      `${invalid.length} address(es) are not recognisable Litecoin addresses, ` +
        `starting with "${invalid[0] ?? ""}" — nothing was added`,
    );
  }

  const rows = raw.map((address) => ({ address, label: label ?? null }));
  const added = deps.watchlist.add(rows);

  const rescan = await maybeRescan(deps, body, res);
  if (rescan === null) return; // maybeRescan answered with the error itself.

  json(res, 200, {
    requested: rows.length,
    added,
    alreadyWatched: rows.length - added,
    count: deps.watchlist.size,
    rescan,
  });
}

export function removeWatched(deps: ApiDeps, address: string, res: ServerResponse): void {
  const removed = deps.watchlist.remove(address);

  // Rows already indexed for the address are deliberately left in place. They
  // are history that was true when it was written, and a consumer reconciling
  // an old deposit still needs to be able to look it up; they age out with the
  // retention window like everything else.
  json(res, removed ? 200 : 404, {
    address,
    removed,
    count: deps.watchlist.size,
    ...(removed ? {} : { error: "not_watched" }),
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Accepts either `{address}` or `{addresses:[...]}`. Null means neither. */
function collectAddresses(body: Record<string, unknown>): string[] | null {
  const one = body["address"];
  const many = body["addresses"];

  if (typeof one === "string") return [one.trim()];

  if (Array.isArray(many)) {
    if (many.some((a) => typeof a !== "string")) return null;
    // De-duplicated here so `added` counts addresses rather than list entries;
    // a consumer pushing its whole registry should not have to guarantee it.
    return [...new Set((many as string[]).map((a) => a.trim()).filter((a) => a !== ""))];
  }

  return null;
}

interface RescanReport {
  requested: number;
  blocks: number;
  fromHeight: number | null;
  toHeight: number | null;
  error?: string;
}

/**
 * Runs the optional rescan, or explains why it did not.
 *
 * Returns null only when it has already written an error response — the
 * request is over and the caller must return. A rescan that *fails* is
 * reported inside a 200 instead: the addresses were added, which is the part
 * that matters, and losing that outcome to a 500 would leave the consumer
 * believing nothing was watched.
 */
async function maybeRescan(
  deps: ApiDeps,
  body: Record<string, unknown>,
  res: ServerResponse,
): Promise<RescanReport | null> {
  const requested = body["rescanBlocks"];
  if (requested === undefined) {
    return { requested: 0, blocks: 0, fromHeight: null, toHeight: null };
  }

  if (typeof requested !== "number" || !Number.isInteger(requested) || requested < 0) {
    badRequest(res, "rescanBlocks must be a non-negative integer");
    return null;
  }
  if (requested > deps.cfg.watchRescanMaxBlocks) {
    badRequest(
      res,
      `rescanBlocks must be at most WATCH_RESCAN_MAX_BLOCKS ` +
        `(${deps.cfg.watchRescanMaxBlocks}) — nothing was added`,
    );
    return null;
  }
  if (requested === 0) {
    return { requested: 0, blocks: 0, fromHeight: null, toHeight: null };
  }

  if (deps.catchup.isRescanning) {
    return {
      requested,
      blocks: 0,
      fromHeight: null,
      toHeight: null,
      error: "a rescan is already running",
    };
  }

  try {
    const tip = await deps.rpc.getBlockCount();
    const from = Math.max(0, tip - requested + 1);
    const blocks = await deps.catchup.rescan(from, tip);
    return { requested, blocks, fromHeight: from, toHeight: tip };
  } catch (err: unknown) {
    log.warn("watch: rescan failed", errMsg(err));
    return {
      requested,
      blocks: 0,
      fromHeight: null,
      toHeight: null,
      error: errMsg(err),
    };
  }
}
