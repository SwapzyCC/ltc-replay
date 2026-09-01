/**
 * /v1/tx/:txid — confirmation status for one transaction.
 *
 * This is the endpoint that replaces `getrawtransaction` for consumers of a
 * pruned node, and the reason it exists is worth stating plainly:
 *
 * Litecoin Core refuses to run `txindex` together with `prune`. Without
 * txindex, `getrawtransaction` can only answer for transactions in the mempool
 * or in a loaded wallet — so it returns "No such mempool transaction" (RPC
 * code -5) for a *confirmed* payment to a watch-only address. A consumer that
 * reads that as "this transaction does not exist" discards the deposit at the
 * exact moment it becomes final. The relay keeps its own txid → block index
 * and answers from that instead.
 *
 * The three outcomes are deliberately distinct, because each calls for
 * different behaviour on the consumer's side:
 *
 *   mined    — height, hash, confirmations. Credit at your own threshold.
 *   mempool  — seen unconfirmed, still inside tx retention. Keep waiting.
 *   unknown  — not in the indexed window and not in the retained mempool set.
 *
 * Every answer carries `indexedFrom` / `indexedTo`. "Unknown" is only a
 * negative answer *within* that range; a consumer asking about a transaction
 * older than `indexedFrom` has been told nothing and must not treat it as a
 * denial.
 */

import type { ServerResponse } from "node:http";
import type { ApiDeps } from "../context.js";
import { json } from "../respond.js";
import { logger, errMsg } from "../../core/log.js";

const log = logger("http");

export async function txStatus(deps: ApiDeps, txid: string, res: ServerResponse): Promise<void> {
  const indexed = {
    indexedFrom: deps.journal.txIndexFloor(),
    indexedTo: deps.journal.lastBlock()?.height ?? null,
  };

  const mined = deps.journal.findTx(txid);
  if (mined) {
    let confirmations: number | null = null;
    try {
      confirmations = (await deps.rpc.getBlockCount()) - mined.height + 1;
    } catch (err: unknown) {
      // The height is the useful half of the answer regardless; the consumer
      // can derive confirmations from /v1/tip once the node is reachable.
      log.warn("tx: node unreachable for confirmation count", errMsg(err));
    }
    return json(res, 200, {
      txid,
      status: "mined",
      blockHeight: mined.height,
      blockHash: mined.hash,
      confirmations,
      firstSeenAt: mined.ts,
      ...indexed,
    });
  }

  const seen = deps.journal.findTxEvent(txid);
  if (seen) {
    return json(res, 200, {
      txid,
      status: "mempool",
      blockHeight: null,
      blockHash: null,
      confirmations: 0,
      firstSeenAt: seen.ts,
      ...indexed,
    });
  }

  json(res, 404, { txid, status: "unknown", ...indexed });
}
