/**
 * Raw transaction bytes → the payments worth indexing.
 *
 * One function, used by both paths on purpose. The tap sees a transaction as
 * ZMQ bytes and catch-up sees the same transaction as hex inside a block; if
 * each derived addresses its own way, the mempool sighting and the confirmed
 * sighting could disagree, and an address query would show the same payment
 * twice under two different strings. Sharing the decoder makes the rows
 * identical, so the second write is a no-op that simply confirms the first.
 */

import { decodeTx } from "./tx.js";
import { scriptToAddress, type AddressParams, LTC_MAINNET } from "./address.js";
import type { AddressPayment } from "../journal/index.js";

export interface ExtractedTx {
  txid: string;
  payments: AddressPayment[];
}

/**
 * Decodes a transaction and lists the addressable outputs it pays.
 *
 * Outputs with no address — `OP_RETURN` data carriers, bare multisig,
 * non-standard scripts — are skipped rather than reported as failures. They
 * are not something a consumer can watch for, and a chain carries a steady
 * trickle of them.
 *
 * @throws RangeError if the buffer is not a well-formed transaction.
 */
export function extractPayments(raw: Buffer, params: AddressParams = LTC_MAINNET): ExtractedTx {
  const { txid, outputs } = decodeTx(raw);

  const payments: AddressPayment[] = [];
  for (const out of outputs) {
    // A zero-value output cannot be a deposit, and indexing it would add rows
    // for every data carrier and dust-marker on the chain.
    if (out.value === 0n) continue;

    const address = scriptToAddress(out.script, params);
    if (address === null) continue;

    payments.push({ address, vout: out.n, valueSat: out.value });
  }

  return { txid, payments };
}
