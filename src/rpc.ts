/**
 * Minimal Litecoin Core JSON-RPC client.
 *
 * Only read methods are used. The relay never touches a wallet, never signs,
 * and never broadcasts — if a change here ever needs a write method, that is a
 * signal the responsibility belongs somewhere else.
 */

import type { Config } from "./config.js";
import { errMsg } from "./log.js";

export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number | undefined,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

/** Core's "block not found" / "no such transaction" family. */
export function isNotFound(err: unknown): boolean {
  return err instanceof RpcError && (err.code === -5 || err.code === -8);
}

export interface BlockHeader {
  hash: string;
  height: number;
  time: number;
  previousblockhash?: string;
  nTx: number;
  confirmations: number;
}

export interface BlockWithTxs extends BlockHeader {
  tx: Array<{ txid: string; hex: string }>;
}

interface RpcResponse<T> {
  result: T | null;
  error: { code: number; message: string } | null;
}

export class LitecoinRpc {
  private readonly url: string;
  private readonly auth: string;
  private id = 0;

  constructor(cfg: Pick<Config, "rpcUrl" | "rpcUser" | "rpcPassword" | "rpcWallet">) {
    const base = cfg.rpcUrl.replace(/\/+$/, "");
    this.url = cfg.rpcWallet ? `${base}/wallet/${encodeURIComponent(cfg.rpcWallet)}` : base;
    this.auth = `Basic ${Buffer.from(`${cfg.rpcUser}:${cfg.rpcPassword}`).toString("base64")}`;
  }

  async call<T>(method: string, params: unknown[] = [], timeoutMs = 30_000): Promise<T> {
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

  /** Verbosity 2 returns every transaction decoded, each carrying its raw hex. */
  async getBlockWithTxs(hash: string): Promise<BlockWithTxs> {
    return await this.call<BlockWithTxs>("getblock", [hash, 2], 120_000);
  }

  async getChainInfo(): Promise<{
    chain: string;
    blocks: number;
    headers: number;
    bestblockhash: string;
    initialblockdownload: boolean;
  }> {
    return await this.call("getblockchaininfo");
  }

  /**
   * `txindex` is not optional for this service: replay resolves transactions
   * that belong to no loaded wallet, which Core will only serve from the
   * transaction index.
   */
  async hasTxIndex(): Promise<boolean> {
    try {
      const info = await this.call<Record<string, { synced?: boolean }>>("getindexinfo");
      return info["txindex"] !== undefined;
    } catch {
      // Older builds lack getindexinfo. Treat as unknown rather than absent.
      return true;
    }
  }
}
