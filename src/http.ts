/**
 * The replay API.
 *
 * Two ways to catch up, because consumers arrive in two states:
 *
 *   /v1/events   — "I have seq N, what came after?" Cheap, cursor-based, and
 *                  includes the raw mempool sightings still inside retention.
 *
 *   /v1/replay   — "I processed up to block H, stream me the rest." Blocks with
 *                  their full transactions, as NDJSON so a thousand-block gap
 *                  does not have to fit in memory at either end. This is the
 *                  endpoint that actually recovers a missed deposit.
 *
 * Everything except /health requires a bearer token. The history here maps
 * every watched address to its funding transactions, which is not public data.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.js";
import type { Journal } from "./journal.js";
import type { LitecoinRpc } from "./rpc.js";
import { isNotFound } from "./rpc.js";
import type { Tap } from "./tap.js";
import { logger, errMsg } from "./log.js";

const log = logger("http");

const MAX_EVENTS = 5_000;
const DEFAULT_EVENTS = 1_000;
const MAX_REPLAY_BLOCKS = 500;
const DEFAULT_REPLAY_BLOCKS = 50;

export interface ApiDeps {
  cfg: Config;
  journal: Journal;
  rpc: LitecoinRpc;
  tap: Tap;
  startedAt: number;
}

export function createApi(deps: ApiDeps): Server {
  // Comparing digests keeps the comparison constant-time regardless of how the
  // supplied token's length relates to the real one.
  const expected = createHash("sha256").update(deps.cfg.authToken).digest();

  function authorised(req: IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match?.[1]) return false;
    const given = createHash("sha256").update(match[1]).digest();
    return timingSafeEqual(given, expected);
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log.error(`${req.method} ${req.url} failed`, errMsg(err));
      if (!res.headersSent) json(res, 500, { error: "internal_error", detail: errMsg(err) });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method !== "GET") return json(res, 405, { error: "method_not_allowed" });

    // Unauthenticated so a load balancer or uptime probe needs no secret. It
    // deliberately exposes nothing about the chain or the watched set.
    if (path === "/health") {
      return json(res, 200, {
        ok: true,
        service: "ltc-replay",
        uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
      });
    }

    if (!authorised(req)) {
      res.setHeader("www-authenticate", 'Bearer realm="ltc-replay"');
      return json(res, 401, { error: "unauthorized" });
    }

    switch (path) {
      case "/v1/tip":
        return await tip(res);
      case "/v1/events":
        return events(url, res);
      case "/v1/stats":
        return stats(res);
      case "/v1/replay":
        return await replay(url, req, res);
      default: {
        const block = /^\/v1\/block\/([0-9a-fA-F]{64})$/.exec(path);
        if (block?.[1]) return await oneBlock(block[1], res);
        return json(res, 404, { error: "not_found" });
      }
    }
  }

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function tip(res: ServerResponse): Promise<void> {
    const journalTip = deps.journal.lastBlock();
    let nodeHeight: number | null = null;
    try {
      nodeHeight = await deps.rpc.getBlockCount();
    } catch (err: unknown) {
      log.warn("tip: node unreachable", errMsg(err));
    }

    json(res, 200, {
      journal: {
        seq: deps.journal.tipSeq(),
        height: journalTip?.height ?? null,
        hash: journalTip?.hash ?? null,
      },
      node: { height: nodeHeight },
      // Non-zero means catch-up has not finished; a consumer should retry
      // before concluding it has seen everything.
      lagBlocks:
        nodeHeight !== null && journalTip ? Math.max(0, nodeHeight - journalTip.height) : null,
    });
  }

  function events(url: URL, res: ServerResponse): void {
    const since = intParam(url, "since", 0, 0, Number.MAX_SAFE_INTEGER);
    if (since === null) return json(res, 400, { error: "bad_request", detail: "invalid since" });

    const limit = intParam(url, "limit", DEFAULT_EVENTS, 1, MAX_EVENTS);
    if (limit === null) return json(res, 400, { error: "bad_request", detail: "invalid limit" });

    const rows = deps.journal.eventsSince(since, limit);
    const last = rows.at(-1);

    json(res, 200, {
      events: rows,
      next: last?.seq ?? since,
      hasMore: rows.length === limit,
      journalSeq: deps.journal.tipSeq(),
    });
  }

  function stats(res: ServerResponse): void {
    json(res, 200, {
      journal: deps.journal.stats(),
      tap: deps.tap.getStats(),
      retentionHours: deps.cfg.txRetentionHours,
      startedAt: deps.startedAt,
    });
  }

  async function oneBlock(hash: string, res: ServerResponse): Promise<void> {
    try {
      const block = await deps.rpc.getBlockWithTxs(hash);
      json(res, 200, shapeBlock(block));
    } catch (err: unknown) {
      if (isNotFound(err)) return json(res, 404, { error: "unknown_block" });
      throw err;
    }
  }

  /**
   * Streams blocks after `sinceHeight` as NDJSON — one JSON object per line,
   * then a terminating `{"done":true,...}` line carrying the next cursor.
   *
   * The terminator matters: a truncated response and a complete one are
   * otherwise indistinguishable, and a consumer that mistakes one for the
   * other silently skips blocks.
   */
  async function replay(url: URL, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const sinceHeight = intParam(url, "sinceHeight", null, 0, Number.MAX_SAFE_INTEGER);
    if (sinceHeight === null) {
      return json(res, 400, { error: "bad_request", detail: "sinceHeight is required" });
    }
    const maxBlocks = intParam(url, "maxBlocks", DEFAULT_REPLAY_BLOCKS, 1, MAX_REPLAY_BLOCKS);
    if (maxBlocks === null) return json(res, 400, { error: "bad_request", detail: "invalid maxBlocks" });

    let tipHeight: number;
    try {
      tipHeight = await deps.rpc.getBlockCount();
    } catch (err: unknown) {
      return json(res, 503, { error: "node_unavailable", detail: errMsg(err) });
    }

    const from = sinceHeight + 1;
    const to = Math.min(tipHeight, from + maxBlocks - 1);

    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-tip-height": String(tipHeight),
    });

    let aborted = false;
    req.on("close", () => {
      aborted = true;
    });

    let height = sinceHeight;
    for (let h = from; h <= to && !aborted; h++) {
      let line: string;
      try {
        const hash = await deps.rpc.getBlockHash(h);
        line = JSON.stringify(shapeBlock(await deps.rpc.getBlockWithTxs(hash)));
      } catch (err: unknown) {
        // Mid-stream failures cannot change the status code, so they are
        // reported as an error object in the stream itself. No `done` line
        // follows, which is how the consumer knows not to advance its cursor.
        await write(res, `${JSON.stringify({ error: "block_failed", height: h, detail: errMsg(err) })}\n`);
        res.end();
        return;
      }
      if (!(await write(res, `${line}\n`))) return;
      height = h;
    }

    if (aborted) return void res.end();

    await write(
      res,
      `${JSON.stringify({ done: true, nextHeight: height, tipHeight, hasMore: height < tipHeight })}\n`,
    );
    res.end();
  }

  return server;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function shapeBlock(block: {
  hash: string;
  height: number;
  time: number;
  nTx: number;
  previousblockhash?: string;
  tx: Array<{ txid: string; hex: string }>;
}): Record<string, unknown> {
  return {
    height: block.height,
    hash: block.hash,
    time: block.time,
    previousblockhash: block.previousblockhash ?? null,
    nTx: block.nTx,
    txs: block.tx.map((t) => ({ txid: t.txid, hex: t.hex })),
  };
}

/** Writes a chunk, waiting for drain so a slow consumer cannot balloon memory. */
function write(res: ServerResponse, chunk: string): Promise<boolean> {
  if (res.destroyed) return Promise.resolve(false);
  if (res.write(chunk)) return Promise.resolve(true);
  return new Promise((resolve) => {
    res.once("drain", () => resolve(!res.destroyed));
    res.once("close", () => resolve(false));
  });
}

/**
 * Parses an integer query parameter. Returns `fallback` when absent and null
 * when present but invalid, so a typo is a 400 rather than a silent default.
 */
function intParam(url: URL, key: string, fallback: number | null, min: number, max: number): number | null {
  const raw = url.searchParams.get(key);
  if (raw === null || raw.trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) return null;
  return n;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}
