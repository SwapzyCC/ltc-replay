/**
 * test/zmq.test.ts
 *
 * Covers the LTC ZMQ transport layer: the URI parser, what it refuses, what it
 * is careful never to say out loud, and that both transports actually deliver
 * frames.
 *
 * The parser tests carry more weight than parser tests usually do. This is the
 * only thing standing between a config typo and a monitor that connects to
 * nothing and reports nothing — an endpoint that is wrong and an endpoint that
 * is quiet look identical from the outside, and the failure surfaces days
 * later as uncredited deposits.
 *
 * The redaction tests are the other half. A password that reaches a log is a
 * password that reaches log shipping, disk, and whoever can read either, so
 * "the error message does not contain the secret" is asserted directly rather
 * than assumed from reading the code.
 *
 * The TLS transport tests need a certificate. They generate a throwaway
 * self-signed one with openssl into a temp directory, and skip themselves if
 * openssl is not on PATH rather than failing a machine that has no reason to
 * have it.
 */

import { strict as assert } from "node:assert";
import { after, before, describe, it } from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import tls from "node:tls";
import { once } from "node:events";

import { Publisher } from "zeromq";

import {
  createLtcZmqSubscriber,
  LtcZmqUriError,
  parseLtcZmqEndpoint,
  redactLtcZmqEndpoint,
  redactLtcZmqUri,
  zmqConnectString,
} from "../src/chain/zmq/index.js";

const SECRET = "kD-I3W/jOy:GOy4@nTq%MNLZ";
const ENCODED = encodeURIComponent(SECRET);

describe("LTC ZMQ URI parsing", () => {
  it("parses a bare tcp endpoint", () => {
    assert.deepEqual(parseLtcZmqEndpoint("tcp://127.0.0.1:39034"), {
      transport: "tcp",
      host: "127.0.0.1",
      port: 39034,
    });
  });

  it("parses tcp with PLAIN credentials", () => {
    assert.deepEqual(parseLtcZmqEndpoint("tcp://litecoinzmq:hunter2@10.0.0.5:39034"), {
      transport: "tcp",
      host: "10.0.0.5",
      port: 39034,
      username: "litecoinzmq",
      password: "hunter2",
    });
  });

  it("parses tls with PLAIN credentials", () => {
    assert.deepEqual(parseLtcZmqEndpoint("tls://litecoinzmq:hunter2@zmq.backstacked.dev:28334"), {
      transport: "tls",
      host: "zmq.backstacked.dev",
      port: 28334,
      username: "litecoinzmq",
      password: "hunter2",
    });
  });

  it("decodes percent-encoded credentials", () => {
    // The documented example: p%40ss%3Aword is the password p@ss:word.
    const ep = parseLtcZmqEndpoint("tls://user:p%40ss%3Aword@host:28334");
    assert.equal(ep.username, "user");
    assert.equal(ep.password, "p@ss:word");
  });

  it("round-trips a password full of delimiters", () => {
    const ep = parseLtcZmqEndpoint(`tls://litecoinzmq:${ENCODED}@zmq.backstacked.dev:28334`);
    assert.equal(ep.password, SECRET);
  });

  it("keeps an IPv6 literal usable by net and tls", () => {
    const ep = parseLtcZmqEndpoint("tcp://[::1]:39034");
    // Unbracketed for the socket APIs...
    assert.equal(ep.host, "::1");
    // ...re-bracketed for anything that is a URI again.
    assert.equal(zmqConnectString(ep), "tcp://[::1]:39034");
  });

  it("strips credentials from the endpoint handed to libzmq", () => {
    // libzmq has no notion of userinfo: it would try to resolve
    // "user:pass@host" as a hostname. The credentials travel as socket
    // options instead.
    const ep = parseLtcZmqEndpoint("tcp://user:pass@10.0.0.5:39034");
    assert.equal(zmqConnectString(ep), "tcp://10.0.0.5:39034");
  });

  it("maps a tls endpoint to a plain tcp connect string too", () => {
    // The bridge overrides this with its own loopback address, but the helper
    // must never hand libzmq something starting with tls://.
    const ep = parseLtcZmqEndpoint("tls://u:p@host:28334");
    assert.ok(zmqConnectString(ep).startsWith("tcp://"));
  });
});

describe("LTC ZMQ URI rejection", () => {
  const bad: Array<[string, string, RegExp]> = [
    ["empty", "", /empty/i],
    ["no scheme", "127.0.0.1:39034", /not a valid URI|unsupported scheme/i],
    ["unsupported scheme", "http://host:39034", /unsupported scheme/i],
    ["ipc", "ipc:///tmp/x", /unsupported scheme/i],
    ["inproc", "inproc://x", /unsupported scheme/i],
    ["no port", "tls://user:pass@host", /no port/i],
    ["port out of range", "tcp://host:99999", /not a valid URI|out-of-range/i],
    ["trailing path", "tls://user:pass@host:28334/rawtx", /no path, query or fragment/i],
    ["query string", "tcp://host:28334?topic=rawtx", /no path, query or fragment/i],
    ["username without password", "tcp://user@host:28334", /needs both/i],
    ["password without username", "tcp://:pass@host:28334", /needs both/i],
    ["broken percent-encoding", "tls://user:%zz@host:28334", /percent-encoding/i],
  ];

  for (const [name, uri, pattern] of bad) {
    it(`refuses ${name}`, () => {
      assert.throws(
        () => parseLtcZmqEndpoint(uri, "LTC_ZMQ_TX_URL"),
        (err: unknown) => {
          assert.ok(err instanceof LtcZmqUriError, `expected LtcZmqUriError, got ${String(err)}`);
          assert.match(err.message, pattern);
          return true;
        },
      );
    });
  }

  it("never falls back from tls to tcp", () => {
    // Not a behaviour that can be asserted directly — it is the absence of a
    // code path — so pin the thing that would make a fallback possible: the
    // transport is taken from the scheme and nothing else.
    assert.equal(parseLtcZmqEndpoint("tls://u:p@host:1").transport, "tls");
    assert.equal(parseLtcZmqEndpoint("tcp://host:1").transport, "tcp");
  });

  it("names the offending variable", () => {
    assert.throws(
      () => parseLtcZmqEndpoint("wss://host:1", "LTC_ZMQ_BLOCK_URL"),
      /LTC_ZMQ_BLOCK_URL/,
    );
  });
});

describe("LTC ZMQ redaction", () => {
  const uri = `tls://litecoinzmq:${ENCODED}@zmq.backstacked.dev:28334`;

  it("masks the password but keeps everything an operator needs", () => {
    const shown = redactLtcZmqEndpoint(parseLtcZmqEndpoint(uri));
    assert.equal(shown, "tls://litecoinzmq:********@zmq.backstacked.dev:28334");
  });

  it("leaks nothing from a parsed endpoint", () => {
    const shown = redactLtcZmqEndpoint(parseLtcZmqEndpoint(uri));
    assert.ok(!shown.includes(SECRET));
    assert.ok(!shown.includes(ENCODED));
  });

  it("masks the whole userinfo of a string it could not parse", () => {
    // On the error path the structure is untrustworthy — the ':' might be
    // inside the password rather than before it — so the username goes too.
    assert.equal(
      redactLtcZmqUri("tls://litecoinzmq:s3cr3t@host:28334/nonsense"),
      "tls://***@host:28334/nonsense",
    );
    assert.equal(redactLtcZmqUri("not a uri at all"), "not a uri at all");
  });

  it("keeps the secret out of every error message", () => {
    // The reason this is a test and not a code comment: a parser that echoes
    // its input is the ordinary way a password reaches a log file.
    const malformed = [
      `tls://litecoinzmq:${ENCODED}@host`,
      `tls://litecoinzmq:${ENCODED}@host:28334/rawtx`,
      `wss://litecoinzmq:${ENCODED}@host:28334`,
      `tls://litecoinzmq:${ENCODED}@host:28334?x=1`,
    ];
    for (const uriUnderTest of malformed) {
      try {
        parseLtcZmqEndpoint(uriUnderTest, "LTC_ZMQ_TX_URL");
        assert.fail(`expected a throw for ${redactLtcZmqUri(uriUnderTest)}`);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        assert.ok(!message.includes(SECRET), "raw secret in error message");
        assert.ok(!message.includes(ENCODED), "encoded secret in error message");
      }
    }
  });
});

describe("LTC ZMQ tcp:// transport", () => {
  let pub: Publisher;
  let endpoint: string;

  before(async () => {
    pub = new Publisher();
    await pub.bind("tcp://127.0.0.1:0");
    endpoint = pub.lastEndpoint ?? "";
    assert.ok(endpoint.startsWith("tcp://"), "publisher did not report an endpoint");
  });

  after(() => {
    pub.close();
  });

  it("delivers subscribed frames", async () => {
    const sub = await createLtcZmqSubscriber(endpoint, { label: "TEST" });
    sub.subscribe("rawtx");
    try {
      const frames = await firstFrame(sub, pub, "rawtx");
      assert.equal(frames[0]?.toString("utf8"), "rawtx");
      assert.equal(frames[1]?.toString("hex"), "deadbeef");
    } finally {
      sub.close();
    }
  });

  it("sets PLAIN options from the URI, and only when credentials are present", async () => {
    const host = endpoint.replace("tcp://", "");
    const withAuth = await createLtcZmqSubscriber(`tcp://litecoinzmq:${ENCODED}@${host}`);
    const without = await createLtcZmqSubscriber(endpoint);
    try {
      // libzmq performs the PLAIN handshake itself from these options; the
      // decoded password is what must reach it, not the encoded form.
      assert.equal(withAuth.socket.plainUsername, "litecoinzmq");
      assert.equal(withAuth.socket.plainPassword, SECRET);
      // Setting either option selects PLAIN, so an endpoint without
      // credentials must leave both untouched or it cannot talk to a server
      // expecting NULL.
      assert.equal(without.socket.plainUsername, null);
      assert.equal(without.socket.plainPassword, null);
    } finally {
      withAuth.close();
      without.close();
    }
  });

  it("hides the password in describe()", async () => {
    const host = endpoint.replace("tcp://", "");
    const sub = await createLtcZmqSubscriber(`tcp://litecoinzmq:${ENCODED}@${host}`);
    try {
      assert.ok(!sub.describe().includes(SECRET));
      assert.ok(sub.describe().includes("********"));
      // The handle must not carry the password around either.
      assert.ok(!Object.hasOwn(sub.endpoint, "password"));
      assert.ok(!JSON.stringify(sub.endpoint).includes(SECRET));
    } finally {
      sub.close();
    }
  });

  it("closes twice without complaint", async () => {
    const sub = await createLtcZmqSubscriber(endpoint);
    sub.close();
    sub.close();
  });

  it("refuses to connect an unsupported scheme", async () => {
    await assert.rejects(
      () => createLtcZmqSubscriber("http://127.0.0.1:1", { label: "LTC_ZMQ_TX_URL" }),
      LtcZmqUriError,
    );
  });
});

// ── tls:// ──────────────────────────────────────────────────────────────────

interface Certs {
  cert: Buffer;
  key: Buffer;
}

/** A throwaway self-signed cert for "localhost", or null if openssl is absent. */
function makeCerts(): { dir: string; certs: Certs } | null {
  let dir: string | null = null;
  try {
    dir = mkdtempSync(join(tmpdir(), "ltc-zmq-tls-"));
    const key = join(dir, "key.pem");
    const cert = join(dir, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    return { dir, certs: { cert: readFileSync(cert), key: readFileSync(key) } };
  } catch {
    if (dir) rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

describe("LTC ZMQ tls:// transport", () => {
  const generated = makeCerts();
  let pub: Publisher;
  let zmqHost = "";
  let zmqPort = 0;
  let tlsServer: tls.Server | null = null;
  let tlsPort = 0;

  before(async () => {
    // Each test skips itself when there is no certificate; a suite hook has no
    // skip of its own to call.
    if (!generated) return;

    // A real ZMQ publisher…
    pub = new Publisher();
    await pub.bind("tcp://127.0.0.1:0");
    const parsed = new URL(pub.lastEndpoint ?? "");
    zmqHost = parsed.hostname;
    zmqPort = Number(parsed.port);

    // …behind a TLS terminator, which is what nginx does in production.
    tlsServer = tls.createServer(
      { cert: generated.certs.cert, key: generated.certs.key },
      (client) => {
        const upstream = net.connect(zmqPort, zmqHost);
        const kill = (): void => {
          client.destroy();
          upstream.destroy();
        };
        client.on("error", kill);
        upstream.on("error", kill);
        client.pipe(upstream);
        upstream.pipe(client);
      },
    );
    tlsServer.listen(0, "127.0.0.1");
    await once(tlsServer, "listening");
    tlsPort = (tlsServer.address() as net.AddressInfo).port;
  });

  after(() => {
    tlsServer?.close();
    if (zmqPort) pub.close();
    if (generated) rmSync(generated.dir, { recursive: true, force: true });
  });

  it("delivers frames over TLS", async (t) => {
    if (!generated) return t.skip("openssl unavailable");
    // "localhost" rather than 127.0.0.1 because the certificate names the
    // host, and hostname verification is on.
    const sub = await createLtcZmqSubscriber(`tls://localhost:${String(tlsPort)}`, {
      ca: generated.certs.cert,
    });
    sub.subscribe("rawtx");
    try {
      const frames = await firstFrame(sub, pub, "rawtx");
      assert.equal(frames[0]?.toString("utf8"), "rawtx");
      assert.equal(frames[1]?.toString("hex"), "deadbeef");
    } finally {
      sub.close();
    }
  });

  it("refuses a certificate it does not trust", async (t) => {
    if (!generated) return t.skip("openssl unavailable");
    // Same server, but without being told about the self-signed CA. The
    // handshake must fail and no frame may arrive — this is the test that
    // would catch someone "fixing" a certificate problem with
    // rejectUnauthorized: false.
    const warnings: string[] = [];
    const sub = await createLtcZmqSubscriber(`tls://localhost:${String(tlsPort)}`, {
      warn: (m) => warnings.push(m),
    });
    sub.subscribe("rawtx");
    try {
      await assert.rejects(
        () => firstFrame(sub, pub, "rawtx", 1_500),
        /timed out/,
        "a frame crossed an unverified TLS connection",
      );
      assert.ok(
        warnings.some((w) => /tunnel .* failed/i.test(w)),
        `expected a tunnel failure warning, got ${JSON.stringify(warnings)}`,
      );
    } finally {
      sub.close();
    }
  });

  it("enforces hostname verification", async (t) => {
    if (!generated) return t.skip("openssl unavailable");
    // The certificate is for "localhost" and carries no IP SAN, so connecting
    // by address must fail even though the CA is trusted.
    const warnings: string[] = [];
    const sub = await createLtcZmqSubscriber(`tls://127.0.0.1:${String(tlsPort)}`, {
      ca: generated.certs.cert,
      warn: (m) => warnings.push(m),
    });
    sub.subscribe("rawtx");
    try {
      await assert.rejects(() => firstFrame(sub, pub, "rawtx", 1_500), /timed out/);
      assert.ok(warnings.some((w) => /tunnel .* failed/i.test(w)));
    } finally {
      sub.close();
    }
  });

  it("tears the bridge down with the subscription", async (t) => {
    if (!generated) return t.skip("openssl unavailable");
    const sub = await createLtcZmqSubscriber(`tls://localhost:${String(tlsPort)}`, {
      ca: generated.certs.cert,
    });
    sub.subscribe("rawtx");
    await firstFrame(sub, pub, "rawtx");

    // The loopback listener the bridge owns must be gone afterwards, or every
    // reconnect of every monitor leaks a port.
    const local = new URL(sub.socket.lastEndpoint ?? "tcp://127.0.0.1:0");
    sub.close();
    await assert.rejects(
      () => connectTo(Number(local.port)),
      "the bridge listener outlived the subscription",
    );
  });
});

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Publishes until something is received, then returns the frames.
 *
 * ZMQ's slow joiner is real: a SUB that has connected has not necessarily
 * finished subscribing, and a PUB drops what nobody is subscribed to yet.
 * Re-sending is the standard answer.
 */
async function firstFrame(
  sub: AsyncIterable<Buffer[]>,
  pub: Publisher,
  topic: string,
  timeoutMs = 5_000,
): Promise<Buffer[]> {
  const deadline = Date.now() + timeoutMs;
  const pump = setInterval(() => {
    void pub.send([topic, Buffer.from("deadbeef", "hex")]).catch(() => undefined);
  }, 50);

  try {
    const iterator = sub[Symbol.asyncIterator]();
    const timer = new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error("timed out waiting for a frame")),
        Math.max(0, deadline - Date.now()),
      ).unref();
    });
    const result = await Promise.race([iterator.next(), timer]);
    if (result.done === true || result.value === undefined) {
      throw new Error("subscription ended before a frame arrived");
    }
    return result.value;
  } finally {
    clearInterval(pump);
  }
}

/** Resolves if a TCP connection to a loopback port succeeds. */
async function connectTo(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    socket.setTimeout(1_000);
    socket.on("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("timed out"));
    });
    socket.on("error", reject);
  });
}
