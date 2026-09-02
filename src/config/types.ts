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
  /**
   * Index only transactions that pay a watched address.
   *
   * This is the difference between a database sized by your deposits and one
   * sized by Litecoin. Off, the relay stores every addressable output on the
   * chain.
   */
  watchlistOnly: boolean;
  /** Largest rescan a single POST /v1/watch may ask for. 0 disables rescans. */
  watchRescanMaxBlocks: number;

  catchupIntervalMs: number;
  /** First-run floor. Null means "start at the node's current tip". */
  startHeight: number | null;
}
