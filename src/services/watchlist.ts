/**
 * The set of addresses this relay actually indexes.
 *
 * Without it, the relay stores a row for every addressable output on the
 * chain — roughly 1.5 KB per transaction, about 5.4 GB at Litecoin's mainnet
 * rate on the default index window — to answer questions about a few thousand
 * addresses. Every other row is paid for and never read.
 *
 * With it, a transaction that pays nothing on the list is dropped before it is
 * journalled, indexed or re-published. On a typical deposit-monitoring
 * deployment that is upwards of 99.9% of chain traffic, and the database
 * settles at a size proportional to the deposits rather than to Litecoin.
 *
 * Two things make that safe rather than merely cheap:
 *
 *   The membership test is in memory. It runs once per output of every
 *   transaction on the network — a SQLite round trip there would cost more
 *   than the writes it saves. The table is the durable copy; this Set is the
 *   one that is read.
 *
 *   The list is not reconstructible from the chain. Every other byte in the
 *   journal can be rebuilt by re-walking blocks; this cannot. So the consumer
 *   owns it, re-pushes it at boot, and the relay says loudly when it is empty —
 *   because an empty watchlist in WATCHLIST_ONLY mode is a relay that captures
 *   nothing at all, and that failure is otherwise perfectly silent.
 */

import type { Journal, WatchedInput } from "../journal/index.js";
import type { AddressPayment } from "../journal/index.js";
import { logger } from "../core/log.js";

const log = logger("watchlist");

export interface WatchlistOptions {
  /** When false, every address is watched and this becomes a pass-through. */
  enabled: boolean;
}

export class Watchlist {
  private readonly set = new Set<string>();

  constructor(
    private readonly journal: Journal,
    private readonly opts: WatchlistOptions,
  ) {
    for (const address of journal.allWatched()) this.set.add(address);

    if (!opts.enabled) {
      log.warn(
        "WATCHLIST_ONLY is off — every addressable output on the chain will be " +
          "indexed. Expect the journal to grow by gigabytes; see docs/operations.md.",
      );
      return;
    }

    log.info(`filtering to ${this.set.size} watched address(es)`);
    if (this.set.size === 0) this.warnEmpty();
  }

  /** True when filtering is on. Reported by /v1/stats so this is not a guess. */
  get enabled(): boolean {
    return this.opts.enabled;
  }

  get size(): number {
    return this.set.size;
  }

  has(address: string): boolean {
    return this.set.has(address);
  }

  /**
   * The payments worth storing.
   *
   * Returns the input array itself when filtering is off, so the common path
   * allocates nothing.
   */
  filter(payments: readonly AddressPayment[]): readonly AddressPayment[] {
    if (!this.opts.enabled) return payments;
    if (payments.length === 0) return payments;
    return payments.filter((p) => this.set.has(p.address));
  }

  /** True when a transaction pays at least one watched address. */
  matches(payments: readonly AddressPayment[]): boolean {
    if (!this.opts.enabled) return true;
    for (const p of payments) if (this.set.has(p.address)) return true;
    return false;
  }

  /**
   * Adds addresses, durably and in memory. Returns how many were new.
   *
   * The table is written first. If the process dies between the two, the next
   * boot loads the address from disk — the reverse order would lose it while
   * the consumer had already been told it was accepted.
   */
  add(rows: readonly WatchedInput[], source = "api"): number {
    if (rows.length === 0) return 0;

    const added = this.journal.addWatched(rows, source);
    const before = this.set.size;
    for (const r of rows) this.set.add(r.address);

    const grew = this.set.size - before;
    if (grew > 0) log.info(`watching ${grew} new address(es) (${this.set.size} total)`);
    return added;
  }

  remove(address: string): boolean {
    const removed = this.journal.removeWatched(address);
    this.set.delete(address);
    if (removed && this.set.size === 0 && this.opts.enabled) this.warnEmpty();
    return removed;
  }

  private warnEmpty(): void {
    log.warn(
      "watchlist is empty and WATCHLIST_ONLY is on — NOTHING is being indexed. " +
        "Push the consumer's address registry to POST /v1/watch, or set " +
        "WATCHLIST_ONLY=false to index the whole chain.",
    );
  }
}
