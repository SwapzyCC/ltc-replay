/**
 * Address decoding, checked against the reference vectors.
 *
 * This is the one place in the service where a bug is silent and expensive: a
 * decoder that produces a *plausible but wrong* address indexes a real deposit
 * under a string nobody will ever query, and /v1/address answers "never paid"
 * for a payment that arrived. Nothing downstream can detect that — the row
 * exists, the totals are self-consistent, and the money is simply invisible.
 *
 * So the assertions are against BIP-173 and BIP-350's published vectors rather
 * than against this implementation's own output. bech32 is parameterised by
 * its human-readable part, and the checksum covers it, so exercising the
 * "bc" vectors validates exactly the code path "ltc" takes — with the
 * advantage that the expected strings are authoritative.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  scriptToAddress,
  encodeSegwit,
  looksLikeAddress,
  LTC_MAINNET,
  type AddressParams,
} from "../src/chain/address.js";

/** Bitcoin's parameters, purely so the published vectors can be used verbatim. */
const BTC_MAINNET: AddressParams = {
  bech32Hrp: "bc",
  p2pkhVersion: 0x00,
  p2shVersion: 0x05,
};

const PUBKEY_HASH = Buffer.from("751e76e8199196d454941c45d1b3a323f1433bd6", "hex");

const p2wpkh = (hash: Buffer): Buffer => Buffer.concat([Buffer.from([0x00, 0x14]), hash]);

const p2pkh = (hash: Buffer): Buffer =>
  Buffer.concat([Buffer.from([0x76, 0xa9, 0x14]), hash, Buffer.from([0x88, 0xac])]);

const p2sh = (hash: Buffer): Buffer =>
  Buffer.concat([Buffer.from([0xa9, 0x14]), hash, Buffer.from([0x87])]);

test("bech32 P2WPKH matches the BIP-173 vector", () => {
  assert.equal(
    scriptToAddress(p2wpkh(PUBKEY_HASH), BTC_MAINNET),
    "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
  );
});

test("bech32m is used for witness v1, per BIP-350", () => {
  // Witness v0 and v1 differ only in the checksum constant. Using the v0
  // constant for a v1 program produces a string that looks entirely valid and
  // fails every consumer's validation — which is why the vector is asserted.
  const taproot = Buffer.from(
    "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798",
    "hex",
  );
  assert.equal(
    encodeSegwit("bc", 1, taproot),
    "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
  );
});

test("base58check P2PKH matches the all-zeros vector", () => {
  // The classic burn address: version 0x00 over twenty zero bytes. Its leading
  // run of '1's is what catches a base58 encoder that drops leading zeros.
  assert.equal(
    scriptToAddress(p2pkh(Buffer.alloc(20)), BTC_MAINNET),
    "1111111111111111111114oLvT2",
  );
});

test("Litecoin's version bytes produce L and M prefixes", () => {
  const pkh = scriptToAddress(p2pkh(Buffer.alloc(20)), LTC_MAINNET);
  const sh = scriptToAddress(p2sh(Buffer.alloc(20)), LTC_MAINNET);

  assert.ok(pkh?.startsWith("L"), `P2PKH should start with L, got ${pkh}`);
  // 0x32, not Bitcoin's 0x05 — a node configured with the legacy version byte
  // yields a '3' address, which Litecoin wallets still accept but which will
  // not match what the rest of the platform stores.
  assert.ok(sh?.startsWith("M"), `P2SH should start with M, got ${sh}`);
  assert.ok(scriptToAddress(p2wpkh(PUBKEY_HASH), LTC_MAINNET)?.startsWith("ltc1q"));
});

test("scripts with no address form are skipped rather than guessed", () => {
  // OP_RETURN carries data, not value, and has no address. Returning some
  // placeholder here would put unspendable outputs into the address index.
  const opReturn = Buffer.from([0x6a, 0x04, 0xde, 0xad, 0xbe, 0xef]);
  assert.equal(scriptToAddress(opReturn, LTC_MAINNET), null);

  assert.equal(scriptToAddress(Buffer.alloc(0), LTC_MAINNET), null);
  // A P2PKH template of the wrong length is malformed, not a shorter address.
  assert.equal(scriptToAddress(Buffer.from([0x76, 0xa9, 0x14, 0x00]), LTC_MAINNET), null);
});

test("witness programs outside the valid length range are rejected", () => {
  // BIP-141 fixes the program at 2..40 bytes. Anything else is not a segwit
  // output at all, whatever the leading opcode suggests.
  const tooLong = Buffer.concat([Buffer.from([0x00, 0x29]), Buffer.alloc(41)]);
  assert.equal(scriptToAddress(tooLong, LTC_MAINNET), null);
});

test("looksLikeAddress accepts both Litecoin forms and rejects obvious junk", () => {
  assert.ok(looksLikeAddress("ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9"));
  assert.ok(looksLikeAddress("LKDxGDJq5fF4FohAB8zJH24mDDNHDNtqsE"));
  assert.ok(looksLikeAddress("M7uAERuQW2AotfyLDyewFGcLUDtAYu9v5V"));

  assert.equal(looksLikeAddress(""), false);
  assert.equal(looksLikeAddress("../../etc/passwd"), false);
  assert.equal(looksLikeAddress("0x1234567890abcdef1234567890abcdef12345678"), false);
  // Base58 excludes 0, O, I and l precisely so these cannot be confused.
  assert.equal(looksLikeAddress("L0OIl000000000000000000000000000000"), false);
});
