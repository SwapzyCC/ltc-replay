/**
 * /v1/block/:hash and /v1/replay — recovering blocks that were missed.
 *
 * /v1/events replays what the relay journalled. /v1/replay goes further and
 * re-reads the chain itself, which is what recovers a gap longer than tx
 * retention or older than the relay's own history.
 *
 * Because it reads the node rather than the index, /v1/replay is not limited
 * to what the watchlist was when the block arrived — an address registered
 * today can be recovered from a block that landed last week. But the response
 * is still filtered to the watchlist, and that matters more here than
 * anywhere: an unfiltered replay of a thousand blocks is hundreds of megabytes
 * of transaction hex the consumer decodes only to discard. `?all=1` returns
 * every transaction, for an operator who genuinely wants the whole block.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiDeps, RawBlock } from "../context.js";
import { shapeBlock } from "../context.js";
import { json, badRequest, intParam, boolParam, beginNdjson, writeLine } from "../respond.js";
import { isNotFound } from "../../chain/rpc.js";
import { extractPayments } from "../../chain/payments.js";
import { errMsg, logger } from "../../core/log.js";

const log = logger("http");

const MAX_REPLAY_BLOCKS = 500;
const DEFAULT_REPLAY_BLOCKS = 50;

/**
 * One block by hash, whole.
 *
 * Deliberately unfiltered: asking for a specific block by its hash is an
 * operator's question, not a sync loop's, and the useful answer to it is the
 * block. The bulk path that needed the filter is /v1/replay.
 */
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

  const all = boolParam(url, "all", false);
  if (all === null) return badRequest(res, "invalid all (expected a boolean)");

  let tipHeight: number;
  try {
    tipHeight = await deps.rpc.getBlockCount();
  } catch (err: unknown) {
    // Refused before the stream opens, so this can still be a status code.
    return json(res, 503, { error: "node_unavailable", detail: errMsg(err) });
  }

  const from = sinceHeight + 1;
  const to = Math.min(tipHeight, from + maxBlocks - 1);

  const filtered = deps.watchlist.enabled && !all;
  beginNdjson(res, {
    "x-tip-height": String(tipHeight),
    // Stated in the response, not left to be inferred: a consumer holding an
    // empty result needs to know whether the chain was quiet or the relay
    // filtered everything out.
    "x-filtered": filtered ? "watchlist" : "none",
  });

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
      const raw = await deps.rpc.getBlockWithTxs(hash);
      block = filtered ? shapeBlock(raw, watchedTxs(deps, raw)) : shapeBlock(raw);
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

/**
 * The transactions in a block that pay a watched address.
 *
 * An undecodable transaction is kept rather than dropped. The consumer decodes
 * it too and can decide for itself; excluding it here would be asserting it
 * pays nothing on the strength of bytes we could not read, and the one place
 * that assertion could be wrong is the one that costs a deposit.
 */
function watchedTxs(deps: ApiDeps, block: RawBlock): Array<{ txid: string; hex: string }> {
  const keep: Array<{ txid: string; hex: string }> = [];

  for (const tx of block.tx) {
    try {
      const { payments } = extractPayments(Buffer.from(tx.hex, "hex"));
      if (deps.watchlist.matches(payments)) keep.push(tx);
    } catch (err: unknown) {
      log.warn(`replay: undecodable tx ${tx.txid} in block ${block.height}`, errMsg(err));
      keep.push(tx);
    }
  }

  return keep;
}
