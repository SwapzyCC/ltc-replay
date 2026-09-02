/**
 * The JSON-RPC endpoint URI: parsing, credential handling, and the two
 * guarantees that matter more than the parsing.
 *
 * A password reaches this code percent-encoded and must come out byte-exact —
 * Core's own rpcauth generator emits `$` and other characters that a naive
 * split on `:` and `@` would mangle into a 401 nobody can explain.
 *
 * And no error message, anywhere, may contain the password.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  LtcRpcUriError,
  parseLtcRpcEndpoint,
  redactLtcRpcEndpoint,
  resolveLtcRpcAuth,
  rpcAuthHeader,
  rpcBaseUrl,
} from "../src/chain/rpc-uri.js";

/**
 * Shaped like a real Core rpcauth password: hex with a `$` in the middle,
 * which is exactly the character that has to survive percent-encoding.
 */
const SECRET = "5a2d8ce0$58363a8c/2dcf:a615@77535";
const ENCODED = encodeURIComponent(SECRET);

describe("parseLtcRpcEndpoint", () => {
  it("parses a bare http endpoint", () => {
    const ep = parseLtcRpcEndpoint("http://127.0.0.1:9332");
    assert.deepEqual(ep, {
      scheme: "http",
      host: "127.0.0.1",
      port: 9332,
      basePath: "",
    });
  });

  it("parses credentials and percent-decodes the password", () => {
    const ep = parseLtcRpcEndpoint(`https://litecoinrpc:${ENCODED}@rpc.example.dev:9332`);
    assert.equal(ep.scheme, "https");
    assert.equal(ep.host, "rpc.example.dev");
    assert.equal(ep.port, 9332);
    assert.equal(ep.username, "litecoinrpc");
    // The point of the whole exercise: byte-exact, delimiters included.
    assert.equal(ep.password, SECRET);
  });

  it("defaults the port from the scheme", () => {
    assert.equal(parseLtcRpcEndpoint("http://node.example").port, 80);
    assert.equal(parseLtcRpcEndpoint("https://node.example").port, 443);
  });

  it("keeps a path prefix and drops its trailing slash", () => {
    const ep = parseLtcRpcEndpoint("https://proxy.example/ltc/rpc/");
    assert.equal(ep.basePath, "/ltc/rpc");
    assert.equal(rpcBaseUrl(ep), "https://proxy.example:443/ltc/rpc");
  });

  it("unbrackets an IPv6 host and re-brackets it for the URL", () => {
    const ep = parseLtcRpcEndpoint("http://[::1]:9332");
    assert.equal(ep.host, "::1");
    assert.equal(rpcBaseUrl(ep), "http://[::1]:9332");
  });
});

describe("parseLtcRpcEndpoint rejects", () => {
  const cases: Array<[string, string, RegExp]> = [
    ["an empty value", "", /is empty/],
    // A scheme-less string is not unparseable: WHATWG reads "rpc.example.dev:"
    // as the scheme. The rejection is right, only the wording differs.
    ["a bare host", "rpc.example.dev:9332", /unsupported scheme/],
    ["a ZMQ scheme", "tls://rpc.example.dev:9332", /ZMQ endpoint forms/],
    ["another scheme", "ftp://rpc.example.dev:9332", /unsupported scheme/],
    ["a query string", "http://host:9332/?wallet=x", /query string or fragment/],
    ["a fragment", "http://host:9332/#x", /query string or fragment/],
    ["a /wallet/ prefix", "http://host:9332/wallet/main", /must not include a \/wallet\/ path/],
    ["an out-of-range port", "http://host:99999", /not a valid URI|out-of-range port/],
    ["a username with no password", "http://user@host:9332", /username but no password/],
    ["bad percent-encoding", "http://user:%zz@host:9332", /percent-encoding/],
  ];

  for (const [name, uri, expected] of cases) {
    it(`rejects ${name}`, () => {
      assert.throws(
        () => parseLtcRpcEndpoint(uri, "LTC_RPC_HOST"),
        (err: unknown) => {
          assert.ok(err instanceof LtcRpcUriError, `expected LtcRpcUriError, got ${String(err)}`);
          assert.match(err.message, expected);
          return true;
        },
      );
    });
  }
});

describe("credentials never reach a log or an error", () => {
  it("masks the password when rendering an endpoint", () => {
    const ep = parseLtcRpcEndpoint(`https://litecoinrpc:${ENCODED}@rpc.example.dev:9332`);
    const shown = redactLtcRpcEndpoint(ep);
    assert.equal(shown, "https://litecoinrpc:********@rpc.example.dev:9332");
    assert.ok(!shown.includes(SECRET));
  });

  it("strips credentials from the URL the HTTP client is given", () => {
    const ep = parseLtcRpcEndpoint(`https://litecoinrpc:${ENCODED}@rpc.example.dev:9332`);
    const url = rpcBaseUrl(ep);
    assert.equal(url, "https://rpc.example.dev:9332");
    assert.ok(!url.includes(SECRET));
    assert.ok(!url.includes("litecoinrpc"));
  });

  it("keeps the secret out of every rejection message", () => {
    const malformed = [
      `ftp://litecoinrpc:${ENCODED}@rpc.example.dev:9332`,
      `tls://litecoinrpc:${ENCODED}@rpc.example.dev:9332`,
      `http://litecoinrpc:${ENCODED}@rpc.example.dev:9332/wallet/main`,
      `http://litecoinrpc:${ENCODED}@rpc.example.dev:9332/?x=1`,
      `litecoinrpc:${ENCODED}@rpc.example.dev:9332`,
    ];

    for (const uri of malformed) {
      try {
        parseLtcRpcEndpoint(uri, "LTC_RPC_HOST");
        assert.fail("expected a throw");
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        assert.ok(!msg.includes(SECRET), `leaked the password: ${msg}`);
        assert.ok(!msg.includes(ENCODED), `leaked the encoded password: ${msg}`);
      }
    }
  });
});

describe("rpcAuthHeader", () => {
  it("encodes a password containing delimiters", () => {
    const header = rpcAuthHeader("litecoinrpc", SECRET);
    assert.ok(header !== undefined);
    assert.ok(header.startsWith("Basic "));
    const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString();
    // Basic splits on the FIRST colon, so a password full of them is fine.
    assert.equal(decoded, `litecoinrpc:${SECRET}`);
  });

  it("is undefined when there is nothing to send", () => {
    assert.equal(rpcAuthHeader("", ""), undefined);
  });
});

describe("resolveLtcRpcAuth", () => {
  const withCreds = parseLtcRpcEndpoint(`https://litecoinrpc:${ENCODED}@rpc.example.dev:9332`);
  const without = parseLtcRpcEndpoint("http://127.0.0.1:9332");

  it("prefers the URI's credentials", () => {
    const auth = resolveLtcRpcAuth(withCreds, "", "");
    assert.deepEqual(auth, { username: "litecoinrpc", password: SECRET });
  });

  it("falls back to the separate settings", () => {
    const auth = resolveLtcRpcAuth(without, "olduser", "oldpass");
    assert.deepEqual(auth, { username: "olduser", password: "oldpass" });
  });

  it("accepts settings that agree with the URI", () => {
    const auth = resolveLtcRpcAuth(withCreds, "litecoinrpc", SECRET);
    assert.deepEqual(auth, { username: "litecoinrpc", password: SECRET });
  });

  it("refuses to guess between two different passwords", () => {
    assert.throws(
      () => resolveLtcRpcAuth(withCreds, "litecoinrpc", "a-different-password", "LTC_RPC_HOST"),
      (err: unknown) => {
        assert.ok(err instanceof LtcRpcUriError);
        assert.match(err.message, /disagree with the separate user\/password/);
        assert.ok(!err.message.includes(SECRET));
        return true;
      },
    );
  });

  it("returns empty strings when nothing supplies credentials", () => {
    assert.deepEqual(resolveLtcRpcAuth(without, "", ""), { username: "", password: "" });
  });
});
