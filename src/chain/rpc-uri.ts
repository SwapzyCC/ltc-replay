/**
 * One URI format for the Litecoin Core JSON-RPC endpoint, matching the form
 * already used for the ZMQ endpoints.
 *
 *   http://host:port                     loopback or a private network
 *   http://user:password@host:port       credentials carried in the URI
 *   https://user:password@host:port      the same through a TLS terminator
 *   https://user:password@host:port/prefix   behind a path-mounted proxy
 *
 * Why the credentials belong in the URI at all: an endpoint and the identity
 * that may use it are one fact, and splitting them across three environment
 * variables makes it possible — easy, in practice — to point a host at one
 * node while still holding another node's password. One string cannot drift
 * against itself.
 *
 * Two details are easy to get wrong, and wrong in silence:
 *
 * The password is percent-decoded here, exactly as for ZMQ. Core's rpcauth
 * generator emits passwords containing `$`, and a `$` is not the problem —
 * `@`, `:`, `/` and `%` are, because they are the URI's own delimiters. A
 * password containing them must be encoded (`%40`, `%3A`, `%2F`, `%25`) or the
 * URI silently means something else.
 *
 * And the credentials never travel in the URL that reaches the HTTP client.
 * They go in an Authorization header built by the caller. A userinfo-bearing
 * URL leaks the password into redirect targets, proxy logs, and the error
 * messages of most HTTP libraries, so rpcBaseUrl() strips it.
 *
 * Nothing here logs, and no error message contains a password.
 */

import { formatHost, redactUriUserinfo } from "./zmq/uri.js";

export interface LtcRpcEndpoint {
  scheme: "http" | "https";
  /** Bare host — an IPv6 literal is stored unbracketed. */
  host: string;
  port: number;
  /** Path prefix with no trailing slash; "" for the usual bare host. */
  basePath: string;
  username?: string;
  password?: string;
}

/** Thrown for anything unusable. The message never contains credentials. */
export class LtcRpcUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LtcRpcUriError";
  }
}

const DEFAULT_PORT: Record<string, number> = { "http:": 80, "https:": 443 };

/** The safe rendering of an endpoint: username kept, password never. */
export function redactLtcRpcEndpoint(ep: LtcRpcEndpoint): string {
  const auth = ep.username === undefined ? "" : `${ep.username}:********@`;
  return `${ep.scheme}://${auth}${formatHost(ep.host)}:${String(ep.port)}${ep.basePath}`;
}

/**
 * The URL to POST to — credential-free by construction.
 *
 * The port is always explicit even when it is the scheme's default, so that a
 * log line and a firewall rule can be compared without a second lookup.
 */
export function rpcBaseUrl(ep: LtcRpcEndpoint): string {
  return `${ep.scheme}://${formatHost(ep.host)}:${String(ep.port)}${ep.basePath}`;
}

/** The Authorization header value for HTTP Basic, or undefined when unset. */
export function rpcAuthHeader(username: string, password: string): string | undefined {
  if (username === "" && password === "") return undefined;
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function decodeOrThrow(value: string, what: string, label: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new LtcRpcUriError(
      `${label}: the ${what} is not valid percent-encoding. A password ` +
        "containing @ : / or % must be URL-encoded (@ becomes %40, : becomes %3A, " +
        "/ becomes %2F, % becomes %25).",
    );
  }
}

/**
 * Parses one JSON-RPC endpoint URI, or throws.
 *
 * @param label Names the setting in errors, e.g. "LTC_RPC_HOST".
 */
export function parseLtcRpcEndpoint(uri: string, label = "LTC RPC endpoint"): LtcRpcEndpoint {
  const raw = uri.trim();
  if (raw === "") throw new LtcRpcUriError(`${label} is empty`);

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new LtcRpcUriError(
      `${label} is not a valid URI (got "${redactUriUserinfo(raw)}"). ` +
        "Expected http://host:port, http://user:password@host:port or " +
        "https://user:password@host:port.",
    );
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    // tcp:// and tls:// are the ZMQ endpoint forms. Pasting one here is a
    // plausible mistake once both sets of variables use the same shape, and
    // it is worth naming rather than folding into "unsupported scheme".
    const extra =
      url.protocol === "tcp:" || url.protocol === "tls:"
        ? " tcp:// and tls:// are the ZMQ endpoint forms — JSON-RPC speaks HTTP."
        : "";
    throw new LtcRpcUriError(
      `${label} has unsupported scheme "${url.protocol.replace(":", "")}" — ` +
        `use http:// or https://.${extra}`,
    );
  }

  if (url.search !== "" || url.hash !== "") {
    throw new LtcRpcUriError(
      `${label} must not carry a query string or fragment — JSON-RPC parameters ` +
        "go in the request body.",
    );
  }

  const host = url.hostname.replace(/^\[|]$/g, "");
  if (host === "") throw new LtcRpcUriError(`${label} has no host`);

  // Unlike the ZMQ endpoints, a default here is meaningful rather than a
  // guess: the scheme fixes it. Core's own 9332 is not assumed — a missing
  // port on an http:// URI means 80, and saying so beats quietly inventing.
  const port = url.port === "" ? (DEFAULT_PORT[url.protocol] ?? 0) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new LtcRpcUriError(`${label} has an out-of-range port`);
  }

  const basePath = url.pathname.replace(/\/+$/, "");
  if (/\/wallet(\/|$)/.test(basePath)) {
    // The client appends /wallet/<name> itself from LTC_RPC_WALLET. A prefix
    // that already contains it produces /wallet/a/wallet/b, which Core
    // answers with a 404 that says nothing about the cause.
    throw new LtcRpcUriError(
      `${label} must not include a /wallet/ path — the wallet is selected by ` +
        "the wallet-name setting and appended to this URL.",
    );
  }

  // Both or neither: half a credential produces a 401 that reads like a
  // wrong password rather than a missing one.
  const hasUser = url.username !== "";
  const hasPass = url.password !== "";
  if (hasUser !== hasPass) {
    throw new LtcRpcUriError(
      `${label} has ${hasUser ? "a username but no password" : "a password but no username"} — ` +
        "supply both in the URI, or neither and use the separate user/password settings.",
    );
  }

  if (!hasUser) return { scheme: url.protocol === "https:" ? "https" : "http", host, port, basePath };

  const username = decodeOrThrow(url.username, "username", label);
  const password = decodeOrThrow(url.password, "password", label);
  if (username === "" || password === "") {
    throw new LtcRpcUriError(`${label} has empty credentials after decoding`);
  }

  return {
    scheme: url.protocol === "https:" ? "https" : "http",
    host,
    port,
    basePath,
    username,
    password,
  };
}

/**
 * Reconciles credentials from the URI with the separate user/password
 * settings, which stay supported so existing deployments keep working.
 *
 * The URI wins when it carries credentials. Two *different* non-empty sources
 * throw instead: one of them is stale, there is no way to tell which, and
 * picking silently means a 401 nobody can explain.
 */
export function resolveLtcRpcAuth(
  ep: LtcRpcEndpoint,
  envUser: string,
  envPassword: string,
  label = "LTC RPC endpoint",
): { username: string; password: string } {
  const uriUser = ep.username ?? "";
  const uriPass = ep.password ?? "";

  if (uriUser === "") return { username: envUser, password: envPassword };

  const conflicting =
    (envUser !== "" && envUser !== uriUser) || (envPassword !== "" && envPassword !== uriPass);
  if (conflicting) {
    throw new LtcRpcUriError(
      `${label} carries credentials that disagree with the separate user/password ` +
        "settings. Keep one of the two — clear the separate settings to use the URI.",
    );
  }

  return { username: uriUser, password: uriPass };
}
