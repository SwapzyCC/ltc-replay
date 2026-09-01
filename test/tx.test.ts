/**
 * The txid parser is the one piece of real algorithmic risk in this service:
 * Core publishes the full wire serialisation on `rawtx`, and hashing those
 * bytes directly yields the wtxid for any SegWit transaction. Getting it wrong
 * would mean every SegWit deposit is journalled under an id nothing else
 * recognises — and it would fail silently.
 *
 * The vector below is the first peer-to-peer Bitcoin transaction (block 170).
 * Litecoin shares the serialisation format exactly, and a known-good legacy
 * txid is what anchors the rest of these assertions.
 *
 * The SegWit cases are derived from it: re-serialising a transaction with a
 * marker, flag and witness stack must not change its txid, because the txid is
 * defined over the stripped form. That property is precisely what the parser
 * has to get right, and it lets the same known-good id validate all three.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeTxid } from "../src/chain/tx.js";

const LEGACY_HEX =
  "0100000001c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd37" +
  "04000000004847304402204e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c6" +
  "1548ab5fb8cd410220181522ec8eca07de4860a4acdd12909d831cc56cbbac4622082221" +
  "a8768d1d0901ffffffff0200ca9a3b00000000434104ae1a62fe09c5f51b13905f07f06b" +
  "99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a" +
  "0626f1baded5c72a704f7e6cd84cac00286bee0000000043410411db93e1dcdb8a016b49" +
  "840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e16" +
  "0bfa9b8b64f9d4c03f999b8643f656b412a3ac00000000";

const EXPECTED_TXID = "f4184fc596403b9d638783cf57adfe4c75c605f6356fbc91338530e9831e9e16";

const legacy = Buffer.from(LEGACY_HEX, "hex");

/** Re-serialises the legacy vector in SegWit form with the given witness bytes. */
function asSegwit(witness: Buffer): Buffer {
  const version = legacy.subarray(0, 4);
  const body = legacy.subarray(4, legacy.length - 4); // inputs + outputs
  const locktime = legacy.subarray(legacy.length - 4);
  return Buffer.concat([version, Buffer.from([0x00, 0x01]), body, witness, locktime]);
}

test("legacy transaction hashes to its known txid", () => {
  assert.equal(computeTxid(legacy), EXPECTED_TXID);
});

test("segwit serialisation with an empty witness keeps the same txid", () => {
  // One input, zero stack items.
  assert.equal(computeTxid(asSegwit(Buffer.from([0x00]))), EXPECTED_TXID);
});

test("segwit serialisation with a populated witness keeps the same txid", () => {
  // One input, two stack items of 3 and 5 bytes — the bytes the parser must
  // walk past and exclude from the hash.
  const witness = Buffer.concat([
    Buffer.from([0x02]),
    Buffer.from([0x03]),
    Buffer.from([0xaa, 0xbb, 0xcc]),
    Buffer.from([0x05]),
    Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55]),
  ]);
  assert.equal(computeTxid(asSegwit(witness)), EXPECTED_TXID);
});

test("witness data is genuinely excluded, not merely tolerated", () => {
  // Two different witnesses over the same transaction must agree, or the
  // parser is hashing bytes it should have stripped.
  const a = computeTxid(asSegwit(Buffer.from([0x01, 0x02, 0xde, 0xad])));
  const b = computeTxid(asSegwit(Buffer.from([0x01, 0x04, 0xde, 0xad, 0xbe, 0xef])));
  assert.equal(a, b);
  assert.equal(a, EXPECTED_TXID);
});

test("a truncated transaction is rejected rather than mis-hashed", () => {
  assert.throws(() => computeTxid(legacy.subarray(0, 40)), RangeError);
  assert.throws(() => computeTxid(Buffer.alloc(0)), RangeError);
});

test("txid is returned in display order", () => {
  const txid = computeTxid(legacy);
  assert.equal(txid.length, 64);
  assert.match(txid, /^[0-9a-f]{64}$/);
});
