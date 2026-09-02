/**
 * What every route handler is given.
 *
 * Routes receive this rather than reaching for module-level singletons, which
 * is what lets `test/api.test.ts` stand the API up against a temp-file journal
 * and a stubbed node without a Litecoin daemon anywhere in sight.
 */

import type { Config } from "../config/index.js";
import type { Journal } from "../journal/index.js";
import type { LitecoinRpc } from "../chain/rpc.js";
import type { Tap } from "../services/tap.js";
import type { Catchup } from "../services/catchup.js";
import type { Watchlist } from "../services/watchlist.js";

export interface ApiDeps {
  cfg: Config;
  journal: Journal;
  rpc: LitecoinRpc;
  tap: Tap;
  /** The address set that decides what is indexed. Owned by /v1/watch. */
  watchlist: Watchlist;
  /** Needed by /v1/watch, which can ask for a bounded re-index. */
  catchup: Catchup;
  /** Process start, in epoch ms. Reported by /health and /v1/stats. */
  startedAt: number;
}

/** A block as the API shapes it, from Core's verbosity-2 form. */
export interface RawBlock {
  hash: string;
  height: number;
  time: number;
  nTx: number;
  previousblockhash?: string;
  tx: Array<{ txid: string; hex: string }>;
}

/**
 * @param txs Which transactions to include. Defaults to all of them.
 *   `nTx` always reports the block's real size, so a consumer can tell a
 *   filtered block from a small one — silently shrinking both numbers would
 *   make an empty block and a block with nothing for you indistinguishable.
 */
export function shapeBlock(
  block: RawBlock,
  txs: ReadonlyArray<{ txid: string; hex: string }> = block.tx,
): Record<string, unknown> {
  return {
    height: block.height,
    hash: block.hash,
    time: block.time,
    previousblockhash: block.previousblockhash ?? null,
    nTx: block.nTx,
    txs: txs.map((t) => ({ txid: t.txid, hex: t.hex })),
  };
}
