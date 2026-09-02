/**
 * Typed readers over `process.env`.
 *
 * On `??`: it fires only on null/undefined, so `process.env.X ?? "default"`
 * happily hands back "" for an `X=` line in a .env file — and an empty string
 * is a perfectly valid-looking password right up until the node rejects it.
 * Every read here goes through `str()`, which treats empty and whitespace-only
 * as unset, so a blank line and a missing line mean the same thing.
 */

import { ConfigError } from "../core/errors.js";
import { parseLtcZmqEndpoint, redactLtcZmqUri } from "../chain/zmq/index.js";
import {
  parseLtcRpcEndpoint,
  resolveLtcRpcAuth,
  rpcBaseUrl,
} from "../chain/rpc-uri.js";

/** A present, non-blank value, or null. */
export function str(key: string): string | null {
  const v = process.env[key];
  if (v === undefined) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function required(key: string): string {
  const v = str(key);
  if (v === null) throw new ConfigError(`${key} is required and is not set`);
  return v;
}

export function int(key: string, fallback: number, min: number, max: number): number {
  const v = str(key);
  if (v === null) return fallback;

  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new ConfigError(`${key} must be an integer, got "${v}"`);
  if (n < min || n > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max}, got ${n}`);
  }
  return n;
}

export function bool(key: string, fallback: boolean): boolean {
  const v = str(key);
  if (v === null) return fallback;

  const lowered = v.toLowerCase();
  if (["1", "true", "yes", "on"].includes(lowered)) return true;
  if (["0", "false", "no", "off"].includes(lowered)) return false;
  throw new ConfigError(`${key} must be true or false, got "${v}"`);
}

/**
 * A ZMQ endpoint this process *binds*. Always a real ZMQ transport: there is
 * nothing to bind for tls://, which is a client-side tunnel rather than a
 * transport libzmq knows about.
 */
export function zmqUrl(key: string, fallback: string): string {
  const v = str(key) ?? fallback;
  if (!/^(tcp|ipc|inproc):\/\//.test(v)) {
    throw new ConfigError(`${key} must be a ZMQ endpoint such as tcp://host:port, got "${v}"`);
  }
  return v;
}

/**
 * A ZMQ endpoint this process *subscribes to*, in the unified URI form:
 *
 *   tcp://host:port                  direct, unauthenticated
 *   tcp://user:password@host:port    direct, ZMQ PLAIN
 *   tls://user:password@host:port    ZMTP inside TLS, ZMQ PLAIN inside that
 *
 * Parsed at boot so a typo fails here, with the variable's name attached,
 * rather than at the first frame that never arrives. The value is returned
 * unchanged — the transport layer re-parses it — and the error never carries
 * the password.
 */
export function zmqEndpoint(key: string, fallback: string): string {
  const v = str(key) ?? fallback;
  try {
    parseLtcZmqEndpoint(v, key);
  } catch (err: unknown) {
    throw new ConfigError(err instanceof Error ? err.message : `${key} is not a valid endpoint`);
  }
  return v;
}

/** The safe rendering of a possibly-credentialled endpoint, for logs. */
export function redactEndpoint(uri: string): string {
  return redactLtcZmqUri(uri);
}

/**
 * Splits LTC_RPC_URL into the URL to post to and the credentials to send.
 *
 *   http://host:port                     credentials in the separate settings
 *   http://user:password@host:port       credentials in the URI
 *   https://user:password@host:port      the same through a TLS terminator
 *
 * Carrying the credentials in the URI keeps a node and the identity allowed to
 * use it in one string, which cannot drift against itself the way three
 * variables can. LTC_RPC_USER / LTC_RPC_PASSWORD still work, and are still
 * required when the URI does not supply them — an unauthenticated relay is a
 * relay that indexes nothing, so this fails at boot either way.
 *
 * The URL returned is credential-free: the password goes in an Authorization
 * header, never in a string that could end up in a redirect, a proxy log, or
 * an HTTP client's error message.
 */
export function rpcEndpoint(
  key: string,
  fallback: string,
): { url: string; user: string; password: string } {
  const raw = str(key) ?? fallback;

  let resolved;
  try {
    const endpoint = parseLtcRpcEndpoint(raw, key);
    resolved = {
      url: rpcBaseUrl(endpoint),
      ...resolveLtcRpcAuth(
        endpoint,
        str("LTC_RPC_USER") ?? "",
        str("LTC_RPC_PASSWORD") ?? "",
        key,
      ),
    };
  } catch (err: unknown) {
    throw new ConfigError(err instanceof Error ? err.message : `${key} is not a valid endpoint`);
  }

  if (resolved.username === "" || resolved.password === "") {
    throw new ConfigError(
      `${key} has no credentials. Put them in the URI as ` +
        `http://user:password@host:port, or set LTC_RPC_USER and LTC_RPC_PASSWORD.`,
    );
  }

  return { url: resolved.url, user: resolved.username, password: resolved.password };
}
