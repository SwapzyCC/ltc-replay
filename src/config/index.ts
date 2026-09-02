/**
 * Configuration is read once at boot and validated hard.
 *
 * Everything required that is missing stops the process with a named reason.
 * The alternative — starting anyway and failing later — is much worse here
 * than in most services: a replay relay that boots with no auth token looks
 * completely healthy while serving the deposit history of every watched
 * address to anyone who asks.
 */

import { ConfigError } from "../core/errors.js";
import { str, required, int, bool, zmqUrl, zmqEndpoint, rpcEndpoint } from "./env.js";
import type { Config } from "./types.js";

export type { Config } from "./types.js";
export { loadDotEnv } from "./dotenv.js";

/** Shortest token accepted. Below this it is a password, not a credential. */
const MIN_TOKEN_LENGTH = 24;

export function loadConfig(): Config {
  // The credentials may live in the URI or in the separate settings; either
  // way what comes back is a credential-free URL and the pair to authenticate
  // with. See rpcEndpoint() for why the URI form is preferred.
  const rpc = rpcEndpoint("LTC_RPC_URL", "http://127.0.0.1:9332");

  const cfg: Config = {
    rpcUrl: rpc.url,
    rpcUser: rpc.user,
    rpcPassword: rpc.password,
    rpcWallet: str("LTC_RPC_WALLET"),

    // 28334 is Core's conventional -zmqpubrawtx port. 28332 is usually
    // -zmqpubhashtx, which publishes bare txids: subscribing to that would
    // leave the tap with nothing to journal and nothing to re-publish.
    zmqTxUrl: zmqEndpoint("LTC_ZMQ_TX_URL", "tcp://127.0.0.1:28334"),
    zmqBlockUrl: zmqEndpoint("LTC_ZMQ_BLOCK_URL", "tcp://127.0.0.1:28333"),

    pubBind: zmqUrl("PUB_BIND", "tcp://127.0.0.1:28340"),

    httpBind: str("HTTP_BIND") ?? "127.0.0.1",
    httpPort: int("HTTP_PORT", 28350, 1, 65535),
    // Fail closed: an unauthenticated replay endpoint hands anyone the full
    // deposit history of every watched address.
    authToken: required("AUTH_TOKEN"),

    dbPath: str("DB_PATH") ?? "./data/journal.sqlite",
    txRetentionHours: int("TX_RETENTION_HOURS", 72, 1, 24 * 365),
    // Depth of the txid → block mapping the relay maintains itself. This is
    // the stand-in for Core's txindex, which a pruned node is not allowed to
    // run, and it is what lets a consumer count confirmations for a
    // transaction belonging to no loaded wallet.
    txIndexBlocks: int("TX_INDEX_BLOCKS", 20_000, 0, 1_000_000),
    // Indexing which addresses each transaction paid is what /v1/address
    // answers from. It costs catch-up a fuller read of every block — the
    // transaction bodies, not just their ids — so it is switchable for
    // deployments that only ever replay blocks wholesale.
    addressIndex: bool("ADDRESS_INDEX", true),
    // On by default, because the default deployment is a deposit monitor with
    // a known address set. Indexing the whole chain to answer about a few
    // thousand addresses costs gigabytes and buys nothing.
    watchlistOnly: bool("WATCHLIST_ONLY", true),
    // A rescan re-reads blocks from the node at full verbosity, so it is
    // bounded rather than open-ended: an address registered before its deposit
    // needs none, and an unbounded one would be a way to make the relay walk
    // the whole chain on request.
    watchRescanMaxBlocks: int("WATCH_RESCAN_MAX_BLOCKS", 2_000, 0, 100_000),

    catchupIntervalMs: int("CATCHUP_INTERVAL_MS", 60_000, 5_000, 3_600_000),
    startHeight: str("START_HEIGHT") === null ? null : int("START_HEIGHT", 0, 0, 100_000_000),
  };

  if (cfg.authToken.length < MIN_TOKEN_LENGTH) {
    throw new ConfigError(
      `AUTH_TOKEN is too short to be a credential — use at least ${MIN_TOKEN_LENGTH} ` +
        "characters (node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\")",
    );
  }

  if (cfg.zmqTxUrl === cfg.zmqBlockUrl) {
    throw new ConfigError("LTC_ZMQ_TX_URL and LTC_ZMQ_BLOCK_URL must be different endpoints");
  }

  if (cfg.zmqTxUrl === cfg.pubBind || cfg.zmqBlockUrl === cfg.pubBind) {
    throw new ConfigError(
      "PUB_BIND must differ from the Core ZMQ endpoints — the relay would be " +
        "subscribing to its own output",
    );
  }

  return cfg;
}

/** True when a bind address is reachable from outside the machine. */
export function isPublicBind(addr: string): boolean {
  return !/^(127\.|::1$|localhost$)/.test(addr);
}
