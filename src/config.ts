/**
 * Configuration is read once at boot and validated hard. Anything required
 * that is missing stops the process with a named reason, rather than becoming
 * a confusing failure once traffic arrives.
 *
 * On `??`: it fires only on null/undefined, so `process.env.X ?? "default"`
 * happily hands back "" for a `X=` line in a .env file. Every read below goes
 * through `str()`, which treats empty and whitespace-only as unset.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  rpcUrl: string;
  rpcUser: string;
  rpcPassword: string;
  rpcWallet: string | null;

  zmqTxUrl: string;
  zmqBlockUrl: string;

  pubBind: string;

  httpBind: string;
  httpPort: number;
  authToken: string;

  dbPath: string;
  txRetentionHours: number;
  catchupIntervalMs: number;
  startHeight: number | null;
}

/** Reads a .env file into process.env without overwriting anything already set. */
export function loadDotEnv(path?: string): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const file = path ?? resolve(here, "..", ".env");

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return; // No .env is fine — the environment may be supplied by systemd.
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

class ConfigError extends Error {}

function str(key: string): string | null {
  const v = process.env[key];
  if (v === undefined) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function required(key: string): string {
  const v = str(key);
  if (v === null) throw new ConfigError(`${key} is required and is not set`);
  return v;
}

function int(key: string, fallback: number, min: number, max: number): number {
  const v = str(key);
  if (v === null) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) {
    throw new ConfigError(`${key} must be an integer, got "${v}"`);
  }
  if (n < min || n > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max}, got ${n}`);
  }
  return n;
}

function zmqUrl(key: string, fallback: string): string {
  const v = str(key) ?? fallback;
  if (!/^(tcp|ipc|inproc):\/\//.test(v)) {
    throw new ConfigError(`${key} must be a ZMQ endpoint such as tcp://host:port, got "${v}"`);
  }
  return v;
}

export function loadConfig(): Config {
  const cfg: Config = {
    rpcUrl: str("LTC_RPC_URL") ?? "http://127.0.0.1:9332",
    rpcUser: required("LTC_RPC_USER"),
    rpcPassword: required("LTC_RPC_PASSWORD"),
    rpcWallet: str("LTC_RPC_WALLET"),

    zmqTxUrl: zmqUrl("LTC_ZMQ_TX_URL", "tcp://127.0.0.1:28332"),
    zmqBlockUrl: zmqUrl("LTC_ZMQ_BLOCK_URL", "tcp://127.0.0.1:28333"),

    pubBind: zmqUrl("PUB_BIND", "tcp://127.0.0.1:28340"),

    httpBind: str("HTTP_BIND") ?? "127.0.0.1",
    httpPort: int("HTTP_PORT", 28350, 1, 65535),
    // Fail closed: an unauthenticated replay endpoint hands anyone the full
    // deposit history of every watched address.
    authToken: required("AUTH_TOKEN"),

    dbPath: str("DB_PATH") ?? "./data/journal.sqlite",
    txRetentionHours: int("TX_RETENTION_HOURS", 72, 1, 24 * 365),
    catchupIntervalMs: int("CATCHUP_INTERVAL_MS", 60_000, 5_000, 3_600_000),
    startHeight: str("START_HEIGHT") === null ? null : int("START_HEIGHT", 0, 0, 100_000_000),
  };

  if (cfg.authToken.length < 24) {
    throw new ConfigError(
      "AUTH_TOKEN is too short to be a credential — use at least 24 characters " +
        '(node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))")',
    );
  }

  if (cfg.zmqTxUrl === cfg.zmqBlockUrl) {
    throw new ConfigError("LTC_ZMQ_TX_URL and LTC_ZMQ_BLOCK_URL must be different endpoints");
  }

  return cfg;
}

/** True when a bind address is reachable from outside the machine. */
export function isPublicBind(addr: string): boolean {
  return !/^(127\.|::1$|localhost$)/.test(addr);
}
