/**
 * One URI format for every LTC ZMQ endpoint, with the scheme choosing the
 * transport.
 *
 *   tcp://host:port                     plain ZMTP, no authentication
 *   tcp://user:password@host:port       plain ZMTP, ZMQ PLAIN authentication
 *   tls://user:password@host:port       ZMTP inside TLS, ZMQ PLAIN inside that
 *
 * Two things are worth being precise about, because getting either wrong is
 * silent rather than loud.
 *
 * The credentials are ZMQ PLAIN credentials, not HTTP ones. libzmq performs
 * that handshake itself from the socket's plainUsername/plainPassword options
 * — which is also why the userinfo must be stripped before the endpoint is
 * handed to libzmq. `connect("tcp://user:pass@host:1")` is not a ZMQ endpoint;
 * libzmq would either refuse it or try to resolve "user:pass@host" as a
 * hostname.
 *
 * And a password may contain any byte, including the `@` and `:` that
 * delimit the URI, so credentials are percent-encoded in the URI and decoded
 * here. `p%40ss%3Aword` is the password `p@ss:word`.
 *
 * Nothing in this file logs, and nothing puts a raw URI in an error message:
 * every path out goes through the redaction helpers below.
 */

import { isIP } from "node:net";

export interface LtcZmqEndpoint {
  transport: "tcp" | "tls";
  /** Bare host — an IPv6 literal is stored unbracketed, ready for net/tls. */
  host: string;
  port: number;
  username?: string;
  password?: string;
}

/** Thrown for anything unusable. The message never contains credentials. */
export class LtcZmqUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LtcZmqUriError";
  }
}

const SUPPORTED = new Set(["tcp:", "tls:"]);

/**
 * Masks the userinfo of a string that may not even be a valid URI.
 *
 * Used on the error paths, where the input could not be parsed and so cannot
 * be trusted to have the shape the structured redactor assumes. The whole
 * userinfo goes, username included — a string we failed to parse is a string
 * whose `:` might be inside the password rather than before it.
 *
 * Never throws. It is called from error handlers, and a redactor that can
 * throw is a redactor that leaks the thing it was hiding.
 */
export function redactLtcZmqUri(raw: string): string {
  try {
    return raw.replace(/^([A-Za-z0-9+.-]*:\/\/)[^@/]*@/, "$1***@");
  } catch {
    return "<unprintable endpoint>";
  }
}

/**
 * Scheme-neutral alias.
 *
 * Masking userinfo is a property of URI syntax, not of ZMQ: the JSON-RPC
 * endpoint parser needs exactly the same guarantee, and a second copy of a
 * redaction regex is a second place for it to be wrong.
 */
export const redactUriUserinfo = redactLtcZmqUri;

/** Formats a host for a URI, re-bracketing an IPv6 literal. */
export function formatHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

/** The safe rendering of an endpoint: username kept, password never. */
export function redactLtcZmqEndpoint(ep: LtcZmqEndpoint): string {
  const auth = ep.username === undefined ? "" : `${ep.username}:********@`;
  return `${ep.transport}://${auth}${formatHost(ep.host)}:${String(ep.port)}`;
}

/**
 * The libzmq endpoint for a direct connection — credentials stripped, because
 * they travel as socket options rather than in the address.
 */
export function zmqConnectString(ep: LtcZmqEndpoint): string {
  return `tcp://${formatHost(ep.host)}:${String(ep.port)}`;
}

function decodeOrThrow(value: string, what: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new LtcZmqUriError(
      `${label}: the ${what} is not valid percent-encoding. A password ` +
        "containing @ : / or % must be URL-encoded (@ becomes %40, : becomes %3A).",
    );
  }
}

/**
 * Parses one endpoint URI, or throws.
 *
 * @param label Names the setting in errors, e.g. "LTC_ZMQ_TX_URL". Errors are
 *   read at boot by someone who needs to know which of two variables is wrong.
 */
export function parseLtcZmqEndpoint(uri: string, label = "LTC ZMQ endpoint"): LtcZmqEndpoint {
  const raw = uri.trim();
  if (raw === "") throw new LtcZmqUriError(`${label} is empty`);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LtcZmqUriError(
      `${label} is not a valid URI (got "${redactLtcZmqUri(raw)}"). ` +
        "Expected tcp://host:port, tcp://user:password@host:port or " +
        "tls://user:password@host:port.",
    );
  }

  if (!SUPPORTED.has(url.protocol)) {
    // Named explicitly rather than folded into "unsupported scheme": ipc and
    // inproc are valid ZMQ transports, just not ones this reaches for, and
    // saying so saves a round of guessing.
    const extra =
      url.protocol === "ipc:" || url.protocol === "inproc:"
        ? " ipc:// and inproc:// are ZMQ transports but are not supported here."
        : "";
    throw new LtcZmqUriError(
      `${label} has unsupported scheme "${url.protocol.replace(":", "")}" — ` +
        `use tcp:// or tls://.${extra}`,
    );
  }

  // A ZMQ endpoint is a host and a port. Anything after them is a typo that
  // would otherwise be dropped in silence — tls://host:28334/rawtx looks
  // plausible and means nothing.
  if (url.pathname !== "" || url.search !== "" || url.hash !== "") {
    throw new LtcZmqUriError(
      `${label} must be only a scheme, optional credentials, host and port — ` +
        "no path, query or fragment. The ZMQ topic is chosen in code, not in the URI.",
    );
  }

  const host = url.hostname.replace(/^\[|]$/g, "");
  if (host === "") throw new LtcZmqUriError(`${label} has no host`);

  if (url.port === "") {
    throw new LtcZmqUriError(
      `${label} has no port. There is no default: rawtx and hashblock are ` +
        "different ports on the same host.",
    );
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new LtcZmqUriError(`${label} has an out-of-range port`);
  }

  const transport = url.protocol === "tls:" ? "tls" : "tcp";

  // Both or neither. ZMQ PLAIN has no concept of a username without a
  // password, and half a credential produces a handshake failure that reads
  // like a network problem.
  const hasUser = url.username !== "";
  const hasPass = url.password !== "";
  if (hasUser !== hasPass) {
    throw new LtcZmqUriError(
      `${label} has ${hasUser ? "a username but no password" : "a password but no username"} — ` +
        "ZMQ PLAIN needs both, or neither.",
    );
  }

  if (!hasUser) return { transport, host, port };

  const username = decodeOrThrow(url.username, "username", label);
  const password = decodeOrThrow(url.password, "password", label);
  if (username === "" || password === "") {
    throw new LtcZmqUriError(`${label} has empty credentials after decoding`);
  }

  return { transport, host, port, username, password };
}
