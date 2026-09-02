/**
 * Consumer client for ltc-replay. Zero dependencies — copy this file into the
 * consuming service.
 *
 * The live path does not need this client at all. Point the existing Core ZMQ
 * subscriber at the relay's PUB socket instead of the node's and it behaves
 * exactly as before: same `rawtx` and `hashblock` topics, same frames.
 *
 *   LTC_ZMQ_TX_URL=tcp://<relay-host>:28340
 *   LTC_ZMQ_BLOCK_URL=tcp://<relay-host>:28340
 *
 * What this client adds is the part ZMQ cannot do: asking for what was missed.
 * Call `replayBlocks()` on boot, feed every transaction through whatever
 * matches outputs against watched addresses, and persist the returned height
 * so the next start resumes there.
 *
 * Sketch of the integration:
 *
 *   const client = new LtcReplayClient({ baseUrl, token });
 *   const cursor = Number(await redis.get("ltc:replay:height") ?? 0)
 *     || (await client.tip()).node.height;
 *
 *   for await (const block of client.replayBlocks(cursor)) {
 *     for (const tx of block.txs) await handleRawTx(tx.hex);
 *     await redis.set("ltc:replay:height", String(block.height));
 *   }
 *
 * Persisting inside the loop is deliberate: an interrupted catch-up resumes
 * from the last block it actually finished, and re-processing one block is
 * harmless as long as credits are keyed on txid:vout.
 *
 * Two further methods exist for the pruned-node case specifically, where
 * `getrawtransaction` cannot answer at all:
 *
 *   txStatus(txid)              mined / mempool / unknown, with depth.
 *   addressHistory(address)     every payment seen to an address, split into
 *                               confirmed and unconfirmed.
 *
 * Both report the range they can speak for, so "not found" is never confused
 * with "never happened".
 *
 * One method writes rather than reads. The relay only indexes transactions
 * paying an address on its watchlist, and that list is the one thing it cannot
 * work out from the chain, so the consumer owns it:
 *
 *   await client.watch([address]);   // when an address is derived
 *   await client.syncWatched(all);   // at boot, and on a timer
 *
 * Register the address *before* handing it to a user and no rescan is ever
 * needed: the filter only drops what arrived before the address did.
 */

export interface ReplayTip {
  journal: { seq: number; height: number | null; hash: string | null };
  node: { height: number | null };
  lagBlocks: number | null;
}

export interface ReplayTx {
  txid: string;
  hex: string;
}

export interface ReplayBlock {
  height: number;
  hash: string;
  time: number;
  previousblockhash: string | null;
  nTx: number;
  txs: ReplayTx[];
}

export type ReplayEvent =
  | { seq: number; type: "block"; ts: number; height: number; hash: string; source: string }
  | { seq: number; type: "tx"; ts: number; txid: string; hex: string; source: string }
  | {
      seq: number;
      type: "reorg";
      ts: number;
      height: number;
      hash: string;
      orphanedHash: string;
      source: string;
    };

/**
 * Confirmation status for one transaction.
 *
 * `unknown` is returned with HTTP 404 and is only a negative answer *within*
 * `indexedFrom`..`indexedTo`. Asking about a transaction older than
 * `indexedFrom` tells you nothing — check the range before concluding a
 * payment did not happen.
 */
export interface TxStatus {
  txid: string;
  status: "mined" | "mempool" | "unknown";
  blockHeight: number | null;
  blockHash: string | null;
  /** null when the node was unreachable; 0 for a mempool sighting. */
  confirmations: number | null;
  firstSeenAt?: number;
  indexedFrom: number | null;
  indexedTo: number | null;
}

/** One output paying the queried address. Amounts are integer litoshi strings. */
export interface AddressEntry {
  txid: string;
  vout: number;
  /** Integer litoshis, as a string. Parse with BigInt, never Number. */
  valueSat: string;
  /** The same amount to 8 dp, for display only. */
  valueLtc: string;
  status: "confirmed" | "unconfirmed";
  confirmations: number;
  blockHeight: number | null;
  blockHash: string | null;
  firstSeenAt: number;
  /** Raw transaction hex, only when includeHex was requested. */
  hex: string | null;
}

export interface AddressHistory {
  address: string;
  query: { limit: number; minConfirmations: number; includeHex: boolean };
  /** What the relay could possibly know. Read this before trusting an empty list. */
  coverage: {
    addressIndexEnabled: boolean;
    indexedFrom: number | null;
    indexedTo: number | null;
    nodeHeight: number | null;
    lagBlocks: number | null;
  };
  totals: {
    confirmedSat: string;
    confirmedLtc: string;
    unconfirmedSat: string;
    unconfirmedLtc: string;
    totalSat: string;
    totalLtc: string;
    confirmedCount: number;
    unconfirmedCount: number;
  };
  confirmed: AddressEntry[];
  unconfirmed: AddressEntry[];
  /** True when more entries exist than were returned; totals cover this page only. */
  truncated: boolean;
  totalEntries: number;
}

export interface AddressHistoryOptions {
  /** Max entries to return. The relay caps this at 1000. */
  limit?: number;
  /** Depth at which this caller considers a payment final. Defaults to 1. */
  minConfirmations?: number;
  /** Include raw transaction hex. Large; off by default. */
  includeHex?: boolean;
}

/** One row of the relay's watchlist. */
export interface WatchedAddress {
  address: string;
  label: string | null;
  addedAt: number;
  source: string;
}

export interface WatchList {
  /** How many addresses the relay is watching in total, not just on this page. */
  count: number;
  /** False when WATCHLIST_ONLY is off and the relay indexes the whole chain. */
  enabled: boolean;
  query: { limit: number; offset: number };
  addresses: WatchedAddress[];
}

export interface WatchResult {
  requested: number;
  /** New to the relay. The difference from `requested` was already watched. */
  added: number;
  alreadyWatched: number;
  count: number;
  rescan: {
    requested: number;
    blocks: number;
    fromHeight: number | null;
    toHeight: number | null;
    /** Present when the rescan failed. The addresses were still added. */
    error?: string;
  };
}

export interface WatchOptions {
  /** Operator-facing note stored with each address. */
  label?: string;
  /**
   * Re-index this many recent blocks against the new addresses.
   *
   * Only needed when an address may already have been paid — an import, or a
   * registry that fell out of sync. Capped by the relay's
   * WATCH_RESCAN_MAX_BLOCKS, and a request over that cap is rejected outright.
   */
  rescanBlocks?: number;
}

export interface LtcReplayClientOptions {
  /** e.g. http://10.0.0.4:28350 */
  baseUrl: string;
  /** The relay's AUTH_TOKEN. */
  token: string;
  /** Per-request timeout for the non-streaming endpoints. */
  timeoutMs?: number;
  /** Blocks requested per streamed page. The relay caps this at 500. */
  pageSize?: number;
}

export class LtcReplayError extends Error {}

export class LtcReplayClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly pageSize: number;

  constructor(opts: LtcReplayClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.token = opts.token;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
    this.pageSize = Math.min(Math.max(opts.pageSize ?? 50, 1), 500);
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, accept: "application/json" };
  }

  private async getJson<T>(path: string, allow404 = false): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: this.headers(),
        signal: ac.signal,
      });
      // /v1/tx answers 404 with a full, meaningful body: status "unknown" plus
      // the indexed range that makes the absence interpretable. Throwing it
      // away would lose exactly the information the caller needs.
      if (res.status === 404 && allow404) return (await res.json()) as T;
      if (!res.ok) {
        throw new LtcReplayError(
          `GET ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          ...this.headers(),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: ac.signal,
      });
      if (!res.ok) {
        throw new LtcReplayError(
          `${method} ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
      }
      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Where the relay and the node currently are. */
  async tip(): Promise<ReplayTip> {
    return await this.getJson<ReplayTip>("/v1/tip");
  }

  /** Cursor-based journal read, including mempool sightings still in retention. */
  async eventsSince(
    seq: number,
    limit = 1_000,
  ): Promise<{ events: ReplayEvent[]; next: number; hasMore: boolean; journalSeq: number }> {
    return await this.getJson(`/v1/events?since=${seq}&limit=${limit}`);
  }

  /**
   * Confirmation status for one transaction — the replacement for
   * `getrawtransaction` against a pruned node, which cannot answer for a
   * confirmed watch-only payment at all.
   *
   * Never treat `unknown` as "did not happen" without checking `indexedFrom`
   * against the height you care about.
   */
  async txStatus(txid: string): Promise<TxStatus> {
    return await this.getJson<TxStatus>(`/v1/tx/${encodeURIComponent(txid)}`, true);
  }

  /**
   * Every payment the relay has seen to an address, split into confirmed and
   * unconfirmed at `minConfirmations`.
   *
   *   const h = await client.addressHistory(addr, { minConfirmations: 6 });
   *   for (const e of h.confirmed) credit(e.txid, e.vout, BigInt(e.valueSat));
   *
   * Two things to check before acting on the result. `coverage.lagBlocks` says
   * how far behind the node the relay is — an empty list from a relay that has
   * not caught up is not evidence of anything. And `truncated` says the totals
   * describe the returned page rather than the address, so raise `limit`
   * before reconciling a balance from them.
   *
   * Credits must be keyed on (txid, vout): the same entry is returned again on
   * every poll, and returns once more with a block attached when it confirms.
   */
  async addressHistory(address: string, opts: AddressHistoryOptions = {}): Promise<AddressHistory> {
    const q = new URLSearchParams();
    if (opts.limit !== undefined) q.set("limit", String(opts.limit));
    if (opts.minConfirmations !== undefined) {
      q.set("minConfirmations", String(opts.minConfirmations));
    }
    if (opts.includeHex) q.set("includeHex", "true");

    const query = q.size > 0 ? `?${q.toString()}` : "";
    return await this.getJson<AddressHistory>(`/v1/address/${encodeURIComponent(address)}${query}`);
  }

  /**
   * Registers addresses to index. Idempotent, so re-sending the whole registry
   * is a normal thing to do rather than an error.
   *
   * Call this when an address is derived, before it is shown to anyone. The
   * relay drops transactions paying addresses it does not know about, so an
   * address that is published before it is registered has a window in which a
   * deposit to it is not indexed — recoverable only by a rescan.
   */
  async watch(addresses: readonly string[], opts: WatchOptions = {}): Promise<WatchResult> {
    if (addresses.length === 0) {
      return {
        requested: 0,
        added: 0,
        alreadyWatched: 0,
        count: (await this.watchedCount()).count,
        rescan: { requested: 0, blocks: 0, fromHeight: null, toHeight: null },
      };
    }

    return await this.send<WatchResult>("POST", "/v1/watch", {
      addresses,
      ...(opts.label === undefined ? {} : { label: opts.label }),
      ...(opts.rescanBlocks === undefined ? {} : { rescanBlocks: opts.rescanBlocks }),
    });
  }

  /**
   * Stops watching an address. Rows already indexed for it are kept — they are
   * history a reconciliation may still need — and age out with retention.
   */
  async unwatch(address: string): Promise<{ removed: boolean; count: number }> {
    return await this.send("DELETE", `/v1/watch/${encodeURIComponent(address)}`);
  }

  /** A page of the watchlist, most recently added first. */
  async watched(limit = 200, offset = 0): Promise<WatchList> {
    return await this.getJson<WatchList>(`/v1/watch?limit=${limit}&offset=${offset}`);
  }

  /** Just the size of the watchlist — the cheap call a sync loop makes. */
  async watchedCount(): Promise<{ count: number; enabled: boolean }> {
    return await this.getJson<{ count: number; enabled: boolean }>("/v1/watch?limit=0");
  }

  /**
   * Makes sure the relay is watching every address the consumer knows about.
   *
   * The watchlist is the only part of the relay's database that cannot be
   * rebuilt from the chain, so a relay that was reinstalled, or whose journal
   * was deleted to reclaim disk, comes back watching nothing — and indexes
   * nothing, silently, until someone notices deposits have stopped. Call this
   * at boot and on a timer.
   *
   * The count check first is what makes it cheap enough to run often: pushing
   * only when the relay knows fewer addresses than we do turns the periodic
   * case into one small GET.
   *
   * @returns how many addresses were newly registered.
   */
  async syncWatched(addresses: readonly string[], chunkSize = 5_000): Promise<number> {
    const { count } = await this.watchedCount();
    if (count >= addresses.length) return 0;

    let added = 0;
    for (let i = 0; i < addresses.length; i += chunkSize) {
      const res = await this.watch(addresses.slice(i, i + chunkSize));
      added += res.added;
    }
    return added;
  }

  /**
   * Yields every block after `sinceHeight`, in order, paging until it reaches
   * the node's tip.
   *
   * Throws rather than ending quietly if a page is truncated — a silent short
   * read here would look exactly like "you are up to date", and the consumer
   * would skip the blocks it never received.
   *
   * Each block's `txs` carries only transactions paying a watched address,
   * while `nTx` reports the block's real size — so a block with two entries
   * out of three thousand is normal, not a truncated read. The filtering
   * happens against the watchlist as it is *now*, not as it was when the block
   * arrived, because this reads the node rather than the index.
   */
  async *replayBlocks(sinceHeight: number): AsyncGenerator<ReplayBlock, void, void> {
    let cursor = sinceHeight;

    for (;;) {
      const url = `${this.baseUrl}/v1/replay?sinceHeight=${cursor}&maxBlocks=${this.pageSize}`;
      const res = await fetch(url, { headers: this.headers() });

      if (!res.ok) {
        throw new LtcReplayError(
          `replay → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`,
        );
      }
      if (!res.body) throw new LtcReplayError("replay returned no body");

      let sawTerminator = false;
      let nextCursor = cursor;
      let hasMore = false;

      for await (const line of ndjson(res.body)) {
        const row = JSON.parse(line) as Record<string, unknown>;

        if (row["error"] !== undefined) {
          throw new LtcReplayError(
            `relay failed mid-stream at height ${String(row["height"])}: ${String(row["detail"])}`,
          );
        }
        if (row["done"] === true) {
          sawTerminator = true;
          nextCursor = Number(row["nextHeight"]);
          hasMore = row["hasMore"] === true;
          break;
        }

        yield row as unknown as ReplayBlock;
      }

      if (!sawTerminator) {
        throw new LtcReplayError(
          `replay stream ended without a terminator after height ${cursor} — ` +
            "treat this as incomplete and retry rather than advancing the cursor",
        );
      }

      if (!hasMore || nextCursor <= cursor) return;
      cursor = nextCursor;
    }
  }
}

/** Splits a byte stream into NDJSON lines, tolerating chunk boundaries mid-line. */
async function* ndjson(body: ReadableStream<Uint8Array>): AsyncGenerator<string, void, void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl = buffer.indexOf("\n");
      while (nl !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line !== "") yield line;
        nl = buffer.indexOf("\n");
      }
    }
    const tail = buffer.trim();
    if (tail !== "") yield tail;
  } finally {
    reader.releaseLock();
  }
}
