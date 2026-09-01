/**
 * /v1/block/:hash and /v1/replay — recovering blocks that were missed.
 *
 * /v1/events replays what the relay journalled. /v1/replay goes further and
 * re-reads the chain itself, which is what recovers a gap longer than tx
 * retention or older than the relay's own history.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiDeps } from "../context.js";
import { shapeBlock } from "../context.js";
import { json, badRequest, intParam, beginNdjson, writeLine } from "../respond.js";
import { isNotFound } from "../../chain/rpc.js";
import { errMsg } from "../../core/log.js";

const MAX_REPLAY_BLOCKS = 500;
const DEFAULT_REPLAY_BLOCKS = 50;

export async function oneBlock(deps: ApiDeps, hash: string, res: ServerResponse): Promise<void> {
  try {
    json(res, 200, shapeBlock(await deps.rpc.getBlockWithTxs(hash)));
  } catch (err: unknown) {
    // On a pruned node this also covers "known block, body discarded", which
    // is the same answer from the consumer's side: ask the chain, not us.
    if (isNotFound(err)) return json(res, 404, { error: "unknown_block" });
    throw err;
  }
}

/**
 * Streams blocks after `sinceHeight` as NDJSON — one block per line, then a
 * terminating `{"done":true,...}` line carrying the next cursor.
 *
 * NDJSON rather than a JSON array because a thousand-block gap must not have
 * to fit in memory at either end. The terminator is what makes that safe: a
 * truncated response and a complete one are otherwise indistinguishable, and a
 * consumer that mistakes one for the other advances its cursor past blocks it
 * never received.
 */
export async function replay(
  deps: ApiDeps,
  url: URL,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const sinceHeight = intParam(url, "sinceHeight", null, 0, Number.MAX_SAFE_INTEGER);
  if (sinceHeight === null) return badRequest(res, "sinceHeight is required");

  const maxBlocks = intParam(url, "maxBlocks", DEFAULT_REPLAY_BLOCKS, 1, MAX_REPLAY_BLOCKS);
  if (maxBlocks === null) return badRequest(res, `invalid maxBlocks (1..${MAX_REPLAY_BLOCKS})`);

  let tipHeight: number;
  try {
    tipHeight = await deps.rpc.getBlockCount();
  } catch (err: unknown) {
    // Refused before the stream opens, so this can still be a status code.
    return json(res, 503, { error: "node_unavailable", detail: errMsg(err) });
  }

  const from = sinceHeight + 1;
  const to = Math.min(tipHeight, from + maxBlocks - 1);

  beginNdjson(res, { "x-tip-height": String(tipHeight) });

  let aborted = false;
  req.on("close", () => {
    aborted = true;
  });

  let height = sinceHeight;
  // `aborted` is set by the 'close' handler above, which the analysis cannot see.
  // oxlint-disable-next-line no-unmodified-loop-condition
  for (let h = from; h <= to && !aborted; h++) {
    let block: Record<string, unknown>;
    try {
      const hash = await deps.rpc.getBlockHash(h);
      block = shapeBlock(await deps.rpc.getBlockWithTxs(hash));
    } catch (err: unknown) {
      // Once the stream is open the status code is spent, so a mid-stream
      // failure is reported as an error object in the stream. No `done` line
      // follows it, which is how the consumer knows not to advance.
      await writeLine(res, { error: "block_failed", height: h, detail: errMsg(err) });
      res.end();
      return;
    }
    if (!(await writeLine(res, block))) return;
    height = h;
  }

  if (aborted) return void res.end();

  await writeLine(res, { done: true, nextHeight: height, tipHeight, hasMore: height < tipHeight });
  res.end();
}
