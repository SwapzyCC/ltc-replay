/**
 * Liveness and position: /health, /v1/tip and /v1/stats.
 *
 * These are what an operator and a monitoring system read. None of them touch
 * the chain harder than a single `getblockcount`.
 */

import type { ServerResponse } from "node:http";
import type { ApiDeps } from "../context.js";
import { json } from "../respond.js";
import { logger, errMsg } from "../../core/log.js";

const log = logger("http");

/**
 * Unauthenticated, so a load balancer or uptime probe needs no secret. It
 * deliberately reveals nothing about the chain or the watched address set.
 */
export function health(deps: ApiDeps, res: ServerResponse): void {
  json(res, 200, {
    ok: true,
    service: "ltc-replay",
    uptimeSeconds: Math.floor((Date.now() - deps.startedAt) / 1000),
  });
}

/**
 * How far the journal has got, and how far behind the node it is.
 *
 * `lagBlocks` is the number consumers should gate on: non-zero means catch-up
 * has not finished, so an empty answer from any other endpoint is "not yet",
 * not "never".
 */
export async function tip(deps: ApiDeps, res: ServerResponse): Promise<void> {
  const journalTip = deps.journal.lastBlock();

  let nodeHeight: number | null = null;
  try {
    nodeHeight = await deps.rpc.getBlockCount();
  } catch (err: unknown) {
    // The journal's own position is still worth answering with; the node
    // being unreachable is reported as a null height rather than a 503.
    log.warn("tip: node unreachable", errMsg(err));
  }

  json(res, 200, {
    journal: {
      seq: deps.journal.tipSeq(),
      height: journalTip?.height ?? null,
      hash: journalTip?.hash ?? null,
    },
    node: { height: nodeHeight },
    lagBlocks:
      nodeHeight !== null && journalTip ? Math.max(0, nodeHeight - journalTip.height) : null,
  });
}

export function stats(deps: ApiDeps, res: ServerResponse): void {
  json(res, 200, {
    journal: deps.journal.stats(),
    tap: deps.tap.getStats(),
    retention: {
      txHours: deps.cfg.txRetentionHours,
      txIndexBlocks: deps.cfg.txIndexBlocks,
      addressIndex: deps.cfg.addressIndex,
    },
    startedAt: deps.startedAt,
  });
}
