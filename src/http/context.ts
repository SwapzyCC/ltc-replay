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

export interface ApiDeps {
  cfg: Config;
  journal: Journal;
  rpc: LitecoinRpc;
  tap: Tap;
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

export function shapeBlock(block: RawBlock): Record<string, unknown> {
  return {
    height: block.height,
    hash: block.hash,
    time: block.time,
    previousblockhash: block.previousblockhash ?? null,
    nTx: block.nTx,
    txs: block.tx.map((t) => ({ txid: t.txid, hex: t.hex })),
  };
}
