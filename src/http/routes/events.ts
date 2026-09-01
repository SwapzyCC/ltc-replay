/**
 * /v1/events — the cursor feed.
 *
 * "I have seq N, what came after?" Cheap and monotonic: seq is an
 * AUTOINCREMENT column, so a consumer that persists the last seq it processed
 * can resume exactly, with no overlap and no gap, across a restart of either
 * side.
 */

import type { ServerResponse } from "node:http";
import type { ApiDeps } from "../context.js";
import { json, badRequest, intParam } from "../respond.js";

const MAX_EVENTS = 5_000;
const DEFAULT_EVENTS = 1_000;

export function events(deps: ApiDeps, url: URL, res: ServerResponse): void {
  const since = intParam(url, "since", 0, 0, Number.MAX_SAFE_INTEGER);
  if (since === null) return badRequest(res, "invalid since");

  const limit = intParam(url, "limit", DEFAULT_EVENTS, 1, MAX_EVENTS);
  if (limit === null) return badRequest(res, `invalid limit (1..${MAX_EVENTS})`);

  const rows = deps.journal.eventsSince(since, limit);
  const last = rows.at(-1);

  json(res, 200, {
    events: rows,
    // Falling back to `since` keeps the cursor still on an empty page rather
    // than resetting it to zero and replaying everything.
    next: last?.seq ?? since,
    hasMore: rows.length === limit,
    journalSeq: deps.journal.tipSeq(),
  });
}
