/**
 * The error types that cross module boundaries.
 *
 * Each one exists because a caller has to *do* something different about it,
 * not merely to give a failure a nicer name.
 */

/** A rejected configuration. Always fatal, always before the service listens. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/**
 * A JSON-RPC failure from the node.
 *
 * `code` is Core's application error code and is the part callers branch on —
 * -5 in particular means "no such transaction or block", which on a pruned
 * node is a routine answer rather than an outage.
 */
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
