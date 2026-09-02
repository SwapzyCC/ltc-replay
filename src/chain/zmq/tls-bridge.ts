/**
 * The tls:// transport, and the honest explanation of what it is.
 *
 * libzmq has no TLS transport. There is no `tls://` endpoint to connect to,
 * and no API for handing libzmq a socket you established yourself — the
 * closest thing it offers is CURVE, which is a different wire protocol that
 * the nginx/PLAIN setup in front of Litecoin Core does not speak. So there are
 * exactly two ways to run ZMTP over TLS from Node:
 *
 *   1. Reimplement the ZMTP client — greeting, PLAIN handshake, command and
 *      message framing, SUBSCRIBE — over a tls.TLSSocket.
 *   2. Terminate TLS here and let libzmq speak its own protocol over a
 *      loopback socket.
 *
 * This is (2). It is the smaller risk by a wide margin: (1) means owning a
 * hand-written implementation of a binary protocol on the path that credits
 * customer money, where libzmq's own implementation is already present,
 * tested, and the thing every other deployment runs.
 *
 * Concretely: a listener on 127.0.0.1:0, and for each connection libzmq makes
 * to it, one TLS connection out to the real endpoint with the bytes piped
 * between them. libzmq sees an ordinary tcp:// peer and performs its own ZMTP
 * and PLAIN handshake; nginx sees TLS; the auth proxy behind nginx sees the
 * PLAIN handshake it expects. Nothing about the ZMQ protocol is emulated.
 *
 * The trade-off, stated plainly: the loopback leg is not encrypted, so the
 * PLAIN password crosses it in clear. That leg never leaves the machine and is
 * inside the same trust boundary as the process holding the password in
 * memory, which is why this is acceptable — but it is the reason the listener
 * binds to 127.0.0.1 explicitly and refuses any peer that is not loopback.
 *
 * Reconnection needs no code. libzmq reconnects on its own, which opens a
 * fresh loopback connection, which opens a fresh TLS connection.
 */

import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";

import { redactLtcZmqEndpoint, type LtcZmqEndpoint } from "./uri.js";

/**
 * More than one live tunnel means libzmq is reconnecting faster than old
 * connections drain, not that anything needs more. The cap turns a runaway
 * into a logged refusal instead of an unbounded pile of TLS handshakes
 * against someone else's server.
 */
const MAX_TUNNELS = 8;

/** Failed handshakes repeat every reconnect; log the first, then throttle. */
const ERROR_LOG_INTERVAL_MS = 30_000;

export interface TlsBridgeOptions {
  /**
   * Extra CA certificate(s) to trust, for an endpoint fronted by a private
   * CA. This *adds* to the system trust store; it does not relax verification.
   */
  ca?: string | Buffer | Array<string | Buffer>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return false;
  const addr = address.startsWith("::ffff:") ? address.slice(7) : address;
  return addr === "127.0.0.1" || addr === "::1" || addr.startsWith("127.");
}

/**
 * A loopback TCP listener that tunnels every accepted connection to one TLS
 * endpoint. One bridge belongs to one subscription and dies with it.
 */
export class LtcZmqTlsBridge {
  private readonly server: net.Server;
  private readonly tunnels = new Set<net.Socket>();
  private lastErrorLoggedAt = 0;
  private closed = false;

  /** `tcp://127.0.0.1:PORT` — what libzmq is told to connect to. */
  readonly localEndpoint: string;

  private constructor(
    server: net.Server,
    localEndpoint: string,
    private readonly endpoint: LtcZmqEndpoint,
    private readonly opts: TlsBridgeOptions,
  ) {
    this.server = server;
    this.localEndpoint = localEndpoint;
  }

  static async open(
    endpoint: LtcZmqEndpoint,
    opts: TlsBridgeOptions = {},
  ): Promise<LtcZmqTlsBridge> {
    const server = net.createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    const address = server.address();
    if (address === null || typeof address === "string") {
      server.close();
      throw new Error("ltc-zmq TLS bridge: the loopback listener reported no port");
    }

    const bridge = new LtcZmqTlsBridge(
      server,
      `tcp://127.0.0.1:${String(address.port)}`,
      endpoint,
      opts,
    );
    server.on("connection", (local) => {
      bridge.accept(local);
    });
    server.on("error", (err: Error) => {
      bridge.opts.warn?.(`ltc-zmq TLS bridge listener error: ${err.message}`);
    });
    return bridge;
  }

  private accept(local: net.Socket): void {
    // The listener is bound to 127.0.0.1, so this should be unreachable. It
    // stays because the check is one comparison and the thing on the other
    // side of it is a cleartext credential.
    if (!isLoopback(local.remoteAddress)) {
      this.opts.warn?.("ltc-zmq TLS bridge refused a non-loopback connection");
      local.destroy();
      return;
    }
    if (this.closed || this.tunnels.size >= MAX_TUNNELS) {
      if (!this.closed) {
        this.opts.warn?.(
          `ltc-zmq TLS bridge refused a connection: ${String(MAX_TUNNELS)} tunnels already open`,
        );
      }
      local.destroy();
      return;
    }

    const { host, port } = this.endpoint;
    const remote = tls.connect({
      host,
      port,
      // SNI, and the name the certificate is checked against. Omitted for an
      // IP literal, where SNI is not valid and Node matches against the IP's
      // SAN entry instead.
      ...(net.isIP(host) === 0 ? { servername: host } : {}),
      // Not configurable, deliberately. A flag to turn certificate or hostname
      // verification off is a flag that ends up on in production during an
      // incident, and this is the only thing standing between the password and
      // whoever answers the DNS query.
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      ...(this.opts.ca === undefined ? {} : { ca: this.opts.ca }),
    });

    this.tunnels.add(local);
    this.tunnels.add(remote);

    // Nagle off on both legs: ZMTP frames are small and latency here is the
    // delay before a deposit is seen.
    local.setNoDelay(true);
    remote.setNoDelay(true);

    const teardown = (err?: Error): void => {
      this.tunnels.delete(local);
      this.tunnels.delete(remote);
      if (err) this.logTunnelError(err);
      local.destroy();
      remote.destroy();
    };

    local.on("error", teardown);
    remote.on("error", teardown);
    local.on("close", () => {
      teardown();
    });
    remote.on("close", () => {
      teardown();
    });

    remote.on("secureConnect", () => {
      if (!remote.authorized) {
        // Belt and braces: with rejectUnauthorized the handshake fails before
        // this fires. If that ever stops being true, the tunnel must not be
        // the place we find out.
        teardown(new Error(remote.authorizationError?.message ?? "certificate not authorized"));
        return;
      }
      this.opts.log?.(
        `ltc-zmq TLS tunnel up to ${redactLtcZmqEndpoint(this.endpoint)} ` +
          `(${remote.getProtocol() ?? "unknown"})`,
      );
    });

    // tls.connect buffers writes until the handshake completes, so piping
    // immediately is safe and keeps the ZMTP greeting from being dropped.
    local.pipe(remote);
    remote.pipe(local);
  }

  /**
   * Logs at most one tunnel failure per interval.
   *
   * libzmq reconnects on a timer, so a rejected certificate produces a failure
   * every couple of seconds for as long as it is wrong. Logging each one buries
   * everything else; logging none makes a fatal misconfiguration look like a
   * quiet chain.
   */
  private logTunnelError(err: Error): void {
    const now = Date.now();
    if (now - this.lastErrorLoggedAt < ERROR_LOG_INTERVAL_MS) return;
    this.lastErrorLoggedAt = now;
    this.opts.warn?.(
      `ltc-zmq TLS tunnel to ${redactLtcZmqEndpoint(this.endpoint)} failed: ${err.message}`,
    );
  }

  /** Idempotent. Destroys every tunnel, then stops accepting. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.tunnels) socket.destroy();
    this.tunnels.clear();
    this.server.close();
  }
}
