/**
 * /v1/address/:address — everything the relay has seen paying one address,
 * split into confirmed and unconfirmed.
 *
 * This is the deposit-monitor endpoint. One GET answers "has this address been
 * paid, by what, and is it final yet" without the caller having to correlate
 * the ZMQ feed against block replays itself.
 *
 * Two properties matter more than the shape of the JSON:
 *
 *   Mempool and mined rows are the *same* rows. Both paths decode outputs with
 *   `extractPayments`, and the index is keyed (address, txid, vout), so a
 *   payment first seen over ZMQ and later mined collapses into one entry that
 *   gains a block — it is never counted twice.
 *
 *   Absence is qualified. `indexedFrom` / `indexedTo` bound what the relay
 *   could possibly know, and `addressIndexEnabled` says whether it was even
 *   recording. An empty list from a relay that has not caught up is not the
 *   same claim as an empty list from one that has, and a consumer that
 *   conflates them will credit nothing and think it is correct.
 *
 * Only outputs are indexed — what an address *received*. Resolving an input's
 * address requires the transaction it spends, which a pruned node may no
 * longer hold. "What did this address receive" is the question a deposit
 * monitor asks, so the limit costs it nothing.
 */

import type { ServerResponse } from "node:http";
import type { AddressEntry } from "../../journal/index.js";
import type { ApiDeps } from "../context.js";
import { json, badRequest, intParam, boolParam } from "../respond.js";
import { looksLikeAddress } from "../../chain/address.js";
import { formatLtc } from "../../chain/units.js";
import { logger, errMsg } from "../../core/log.js";

const log = logger("http");

const MAX_ENTRIES = 1_000;
const DEFAULT_ENTRIES = 200;

interface ShapedEntry {
  txid: string;
  vout: number;
  valueSat: string;
  valueLtc: string;
  status: "confirmed" | "unconfirmed";
  confirmations: number;
  blockHeight: number | null;
  blockHash: string | null;
  firstSeenAt: number;
  hex: string | null;
}

export async function addressHistory(
  deps: ApiDeps,
  address: string,
  url: URL,
  res: ServerResponse,
): Promise<void> {
  if (!looksLikeAddress(address)) {
    return badRequest(res, "not a recognisable Litecoin address");
  }

  const limit = intParam(url, "limit", DEFAULT_ENTRIES, 1, MAX_ENTRIES);
  if (limit === null) return badRequest(res, `invalid limit (1..${MAX_ENTRIES})`);

  // Raw transaction hex is large and most callers do not want it, so it is
  // opt-in rather than something every poll pays for.
  const includeHex = boolParam(url, "includeHex", false);
  if (includeHex === null) return badRequest(res, "invalid includeHex");

  // The threshold at which the caller considers a payment final. The relay has
  // no policy of its own here — it reports `confirmations` on every entry and
  // splits the lists wherever the caller says.
  const minConfirmations = intParam(url, "minConfirmations", 1, 0, 10_000);
  if (minConfirmations === null) return badRequest(res, "invalid minConfirmations");

  let tipHeight: number | null = null;
  try {
    tipHeight = await deps.rpc.getBlockCount();
  } catch (err: unknown) {
    // Without a tip, confirmation counts are unknowable but the entries
    // themselves are not. Reported as nulls below rather than as a 503.
    log.warn("address: node unreachable for confirmation count", errMsg(err));
  }

  const journalTip = deps.journal.lastBlock();
  const entries = deps.journal.addressEntries(address, limit, includeHex);
  const totalEntries = deps.journal.addressEntryCount(address);

  const confirmed: ShapedEntry[] = [];
  const unconfirmed: ShapedEntry[] = [];
  let confirmedSat = 0n;
  let unconfirmedSat = 0n;

  for (const entry of entries) {
    const confirmations = confirmationsFor(entry, tipHeight);
    // A mined entry counts as confirmed once it clears the caller's threshold.
    // With the tip unknown we cannot prove depth, so a mined entry is reported
    // as confirmed only when the caller asked for none — anything else would
    // be asserting finality we cannot currently see.
    const isConfirmed =
      entry.blockHeight !== null &&
      (minConfirmations === 0 || (confirmations !== null && confirmations >= minConfirmations));

    const shaped: ShapedEntry = {
      txid: entry.txid,
      vout: entry.vout,
      valueSat: entry.valueSat,
      valueLtc: formatLtc(BigInt(entry.valueSat)),
      status: isConfirmed ? "confirmed" : "unconfirmed",
      confirmations: confirmations ?? 0,
      blockHeight: entry.blockHeight,
      blockHash: entry.blockHash,
      firstSeenAt: entry.firstSeenAt,
      hex: entry.hex,
    };

    if (isConfirmed) {
      confirmed.push(shaped);
      confirmedSat += BigInt(entry.valueSat);
    } else {
      unconfirmed.push(shaped);
      unconfirmedSat += BigInt(entry.valueSat);
    }
  }

  json(res, 200, {
    address,
    query: { limit, minConfirmations, includeHex },
    // What the relay could possibly know. Read this before reading an empty
    // list as "this address was never paid".
    coverage: {
      addressIndexEnabled: deps.cfg.addressIndex,
      indexedFrom: deps.journal.txIndexFloor(),
      indexedTo: journalTip?.height ?? null,
      nodeHeight: tipHeight,
      lagBlocks:
        tipHeight !== null && journalTip ? Math.max(0, tipHeight - journalTip.height) : null,
    },
    totals: {
      confirmedSat: confirmedSat.toString(),
      confirmedLtc: formatLtc(confirmedSat),
      unconfirmedSat: unconfirmedSat.toString(),
      unconfirmedLtc: formatLtc(unconfirmedSat),
      totalSat: (confirmedSat + unconfirmedSat).toString(),
      totalLtc: formatLtc(confirmedSat + unconfirmedSat),
      confirmedCount: confirmed.length,
      unconfirmedCount: unconfirmed.length,
    },
    confirmed,
    unconfirmed,
    // Totals above cover the returned page only. When this is true, raise
    // `limit` before reconciling a balance from them.
    truncated: totalEntries > entries.length,
    totalEntries,
  });
}

/**
 * Depth of an entry, or null when it cannot be determined.
 *
 * A mined entry is at depth 1 in its own block, so the count includes it.
 * Unconfirmed is 0, which is a fact rather than an unknown — hence the
 * distinction from null, which means the node was unreachable.
 */
function confirmationsFor(entry: AddressEntry, tipHeight: number | null): number | null {
  if (entry.blockHeight === null) return 0;
  if (tipHeight === null) return null;
  return Math.max(0, tipHeight - entry.blockHeight + 1);
}
