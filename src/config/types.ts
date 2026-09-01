/** The validated shape every module reads its settings from. */
export interface Config {
  // ── Litecoin Core JSON-RPC ─────────────────────────────────────────────────
  rpcUrl: string;
  rpcUser: string;
  rpcPassword: string;
  rpcWallet: string | null;

  // ── Core's ZMQ publishers (the live tap) ───────────────────────────────────
  zmqTxUrl: string;
  zmqBlockUrl: string;

  /** Where the relay re-publishes what it taps, for live consumers. */
  pubBind: string;

  // ── Replay HTTP API ────────────────────────────────────────────────────────
  httpBind: string;
  httpPort: number;
  authToken: string;

  // ── Journal and indexes ────────────────────────────────────────────────────
  dbPath: string;
  /** How long a raw mempool sighting stays replayable. */
  txRetentionHours: number;
  /** Depth of the relay's own txid → block index. 0 disables it. */
  txIndexBlocks: number;
  /** Whether to index which addresses each transaction paid. */
  addressIndex: boolean;

  catchupIntervalMs: number;
  /** First-run floor. Null means "start at the node's current tip". */
  startHeight: number | null;
}
