/**
 * The one place that turns an LTC ZMQ URI into something you can read frames
 * from.
 *
 *   const sub = await createLtcZmqSubscriber(cfg.ltcZmqTxUrl, { label: "LTC_ZMQ_TX_URL" });
 *   sub.subscribe("rawtx");
 *   for await (const frames of sub) { ... }
 *   sub.close();
 *
 * The caller never learns which transport it got. tcp:// is a libzmq socket
 * pointed at the host; tls:// is the same libzmq socket pointed at a loopback
 * bridge that terminates TLS (see tls-bridge.ts, which explains why that is
 * the honest implementation rather than a shortcut). Both hand back the same
 * Subscriber semantics — subscribe, async iteration over multipart frames,
 * close — which is what keeps the deposit monitor free of transport logic.
 *
 * The subscription is the unit of lifetime rather than the socket, because a
 * tls:// subscription owns a listener as well as a socket and closing only
 * half of it leaks the other.
 */

import { Subscriber } from "zeromq";

import { LtcZmqTlsBridge } from "./tls-bridge.js";
import {
  parseLtcZmqEndpoint,
  redactLtcZmqEndpoint,
  zmqConnectString,
  type LtcZmqEndpoint,
} from "./uri.js";

export {
  LtcZmqUriError,
  parseLtcZmqEndpoint,
  redactLtcZmqEndpoint,
  redactLtcZmqUri,
  zmqConnectString,
  type LtcZmqEndpoint,
} from "./uri.js";
export { LtcZmqTlsBridge, type TlsBridgeOptions } from "./tls-bridge.js";

/** An endpoint with the secret removed — safe to log, safe to hand around. */
export type PublicLtcZmqEndpoint = Readonly<Omit<LtcZmqEndpoint, "password">>;

export interface LtcZmqSubscriberOptions {
  /** Names the setting in errors and logs, e.g. "LTC_ZMQ_TX_URL". */
  label?: string;
  /** ZMQ_RCVHWM. Must be set before connecting, so it belongs here. */
  receiveHighWaterMark?: number;
  /** Extra CA certificate(s) for tls://. Adds trust; never relaxes it. */
  ca?: string | Buffer | Array<string | Buffer>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

/**
 * A live subscription. Async-iterable over multipart frames, exactly like the
 * Subscriber it wraps.
 */
export class LtcZmqSubscription implements AsyncIterable<Buffer[]> {
  readonly socket: Subscriber;
  readonly endpoint: PublicLtcZmqEndpoint;
  private readonly bridge: LtcZmqTlsBridge | null;
  private closed = false;

  constructor(socket: Subscriber, endpoint: LtcZmqEndpoint, bridge: LtcZmqTlsBridge | null) {
    this.socket = socket;
    this.bridge = bridge;
    const { password: _password, ...rest } = endpoint;
    this.endpoint = Object.freeze(rest);
  }

  /** The endpoint as it is safe to print: password masked, everything else kept. */
  describe(): string {
    return redactLtcZmqEndpoint(this.endpoint);
  }

  subscribe(...topics: string[]): void {
    this.socket.subscribe(...topics);
  }

  unsubscribe(...topics: string[]): void {
    this.socket.unsubscribe(...topics);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Buffer[]> {
    for await (const frames of this.socket) {
      yield frames as Buffer[];
    }
  }

  /** Idempotent. Closes the socket and, for tls://, the bridge behind it. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.close();
    } finally {
      this.bridge?.close();
    }
  }
}

/**
 * Validates an endpoint without connecting, and returns its safe rendering.
 *
 * Config validation calls this so a typo fails at boot with the variable's
 * name in the message, rather than at the first frame that never arrives.
 */
export function assertLtcZmqEndpoint(uri: string, label: string): string {
  return redactLtcZmqEndpoint(parseLtcZmqEndpoint(uri, label));
}

/**
 * Connects a SUB socket to `uri`, choosing the transport from its scheme.
 *
 * Throws on a malformed URI or an unsupported scheme. There is no fallback
 * from tls:// to tcp://: a deployment that asked for TLS and silently got
 * cleartext is worse than one that refuses to start.
 */
export async function createLtcZmqSubscriber(
  uri: string,
  opts: LtcZmqSubscriberOptions = {},
): Promise<LtcZmqSubscription> {
  const endpoint = parseLtcZmqEndpoint(uri, opts.label ?? "LTC ZMQ endpoint");

  const socket = new Subscriber();
  if (opts.receiveHighWaterMark !== undefined) {
    socket.receiveHighWaterMark = opts.receiveHighWaterMark;
  }

  // PLAIN is negotiated by libzmq itself, inside the tunnel for tls:// and
  // directly on the wire for tcp://. Setting either option is what selects the
  // mechanism, so an endpoint with no credentials must leave both null.
  if (endpoint.username !== undefined && endpoint.password !== undefined) {
    socket.plainUsername = endpoint.username;
    socket.plainPassword = endpoint.password;
  }

  let bridge: LtcZmqTlsBridge | null = null;
  try {
    if (endpoint.transport === "tls") {
      bridge = await LtcZmqTlsBridge.open(endpoint, {
        ...(opts.ca === undefined ? {} : { ca: opts.ca }),
        ...(opts.log === undefined ? {} : { log: opts.log }),
        ...(opts.warn === undefined ? {} : { warn: opts.warn }),
      });
      socket.connect(bridge.localEndpoint);
    } else {
      socket.connect(zmqConnectString(endpoint));
    }
  } catch (err: unknown) {
    bridge?.close();
    socket.close();
    throw err;
  }

  return new LtcZmqSubscription(socket, endpoint, bridge);
}
