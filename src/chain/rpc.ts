/**
 * Minimal Litecoin Core JSON-RPC client.
 *
 * Only read methods are exposed. The relay never touches a wallet, never
 * signs, and never broadcasts — if a change here ever needs a write method,
 * that is a signal the responsibility belongs in a different service.
 *
 * Built on the platform's `fetch` rather than an HTTP client library: the
 * whole protocol is one POST with basic auth, and a dependency that ships its
 * own agent, retry policy and connection pool would be more surface area than
 * the code it replaces.
 */

import type { Config } from "../config/index.js";
import { RpcError } from "../core/errors.js";
import { errMsg } from "../core/log.js";

export { RpcError, isNotFound } from "../core/errors.js";

export interface BlockHeader {
  hash: string;
  height: number;
  time: number;
  previousblockhash?: string;
  nTx: number;
  confirmations: number;
}

/** Verbosity 2: every transaction decoded, each carrying its raw serialisation. */
export interface BlockWithTxs extends BlockHeader {
  tx: Array<{ txid: string; hex: string }>;
}

/** Verbosity 1: the same header, with txids in place of transaction bodies. */
export interface BlockTxids extends BlockHeader {
  tx: string[];
}

export interface ChainInfo {
  chain: string;
  blocks: number;
  headers: number;
  bestblockhash: string;
  initialblockdownload: boolean;
  /** True when the node runs with -prune. */
  pruned?: boolean;
  /** Lowest height whose full block data the node still holds. Pruned nodes only. */
  pruneheight?: number;
}

interface RpcResponse<T> {
  result: T | null;
  error: { code: number; message: string } | null;
}

/** Default per-call ceiling. A healthy loopback node answers in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** A full block at verbosity 2 is large; give it room without hanging forever. */
const BLOCK_TIMEOUT_MS = 120_000;

export class LitecoinRpc {
  private readonly url: string;
  private readonly auth: string;
  private id = 0;

  constructor(cfg: Pick<Config, "rpcUrl" | "rpcUser" | "rpcPassword" | "rpcWallet">) {
    const base = cfg.rpcUrl.replace(/\/+$/, "");
    this.url = cfg.rpcWallet ? `${base}/wallet/${encodeURIComponent(cfg.rpcWallet)}` : base;
    this.auth = `Basic ${Buffer.from(`${cfg.rpcUser}:${cfg.rpcPassword}`).toString("base64")}`;
  }

  async call<T>(
    method: string,
    params: unknown[] = [],
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: this.auth },
        body: JSON.stringify({ jsonrpc: "1.0", id: ++this.id, method, params }),
        signal: ac.signal,
      });
    } catch (err: unknown) {
      throw new RpcError(`${method}: transport failure — ${errMsg(err)}`, undefined);
    } finally {
      clearTimeout(timer);
    }

    // Core answers 500 with a JSON-RPC error body for application errors, so a
    // non-2xx status is only fatal when the body is not parseable.
    const text = await res.text();
    let body: RpcResponse<T>;
    try {
      body = JSON.parse(text) as RpcResponse<T>;
    } catch {
      throw new RpcError(`${method}: HTTP ${res.status} — ${text.slice(0, 200)}`, undefined);
    }

    if (body.error) throw new RpcError(`${method}: ${body.error.message}`, body.error.code);
    if (body.result === null || body.result === undefined) {
      throw new RpcError(`${method}: empty result`, undefined);
    }
    return body.result;
  }

  async getBlockCount(): Promise<number> {
    return await this.call<number>("getblockcount");
  }

  async getBlockHash(height: number): Promise<string> {
    return await this.call<string>("getblockhash", [height]);
  }

  async getBlockHeader(hash: string): Promise<BlockHeader> {
    return await this.call<BlockHeader>("getblockheader", [hash, true]);
  }

  async getBlockWithTxs(hash: string): Promise<BlockWithTxs> {
    return await this.call<BlockWithTxs>("getblock", [hash, 2], BLOCK_TIMEOUT_MS);
  }

  /**
   * The header plus the list of txids, without transaction bodies. Catch-up
   * walks every block, so the difference is not academic: a full block at
   * verbosity 2 is orders of magnitude larger, and the txids are all the
   * confirmation index needs.
   */
  async getBlockTxids(hash: string): Promise<BlockTxids> {
    return await this.call<BlockTxids>("getblock", [hash, 1], BLOCK_TIMEOUT_MS);
  }

  async getChainInfo(): Promise<ChainInfo> {
    return await this.call<ChainInfo>("getblockchaininfo");
  }

  /**
   * Which optional indexes the node runs.
   *
   * A pruned node cannot run `txindex` at all — Core refuses to start with
   * both — so this is reported rather than required; the relay maintains its
   * own txid → block mapping instead. Older builds lack `getindexinfo`, and an
   * empty list ("could not tell") is treated the same as "none", which is the
   * conservative reading.
   */
  async getIndexNames(): Promise<string[]> {
    try {
      const info = await this.call<Record<string, unknown>>("getindexinfo");
      return Object.keys(info);
    } catch {
      return [];
    }
  }
}
