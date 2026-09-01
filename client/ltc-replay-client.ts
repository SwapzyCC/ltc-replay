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

  private async getJson<T>(path: string): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        headers: this.headers(),
        signal: ac.signal,
      });
      if (!res.ok) {
        throw new LtcReplayError(`GET ${path} → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
   * Yields every block after `sinceHeight`, in order, paging until it reaches
   * the node's tip.
   *
   * Throws rather than ending quietly if a page is truncated — a silent short
   * read here would look exactly like "you are up to date", and the consumer
   * would skip the blocks it never received.
   */
  async *replayBlocks(sinceHeight: number): AsyncGenerator<ReplayBlock, void, void> {
    let cursor = sinceHeight;

    for (;;) {
      const url = `${this.baseUrl}/v1/replay?sinceHeight=${cursor}&maxBlocks=${this.pageSize}`;
      const res = await fetch(url, { headers: this.headers() });

      if (!res.ok) {
        throw new LtcReplayError(`replay → HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
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
