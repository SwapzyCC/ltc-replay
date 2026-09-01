/**
 * Transaction id from a raw serialisation.
 *
 * Core's `rawtx` ZMQ topic publishes the full wire serialisation, witness data
 * included. Hashing those bytes directly gives the *wtxid*, not the txid — for
 * a SegWit transaction the two differ, and every consumer, block explorer and
 * RPC call keys on the txid. So a SegWit transaction has to be re-serialised
 * without its marker, flag and witness stack before hashing.
 *
 * Litecoin's transaction format is Bitcoin's; only the network parameters
 * differ, and none of them appear here.
 */

import { createHash } from "node:crypto";

function sha256(b: Buffer): Buffer {
  return createHash("sha256").update(b).digest();
}

function hash256(b: Buffer): Buffer {
  return sha256(sha256(b));
}

interface Cursor {
  buf: Buffer;
  pos: number;
}

function u8(c: Cursor): number {
  if (c.pos + 1 > c.buf.length) throw new RangeError("truncated transaction");
  const v = c.buf.readUInt8(c.pos);
  c.pos += 1;
  return v;
}

function skip(c: Cursor, n: number): void {
  if (c.pos + n > c.buf.length) throw new RangeError("truncated transaction");
  c.pos += n;
}

/** Bitcoin's CompactSize. Returns the value and advances the cursor. */
function varint(c: Cursor): number {
  const first = u8(c);
  if (first < 0xfd) return first;
  if (first === 0xfd) {
    const v = c.buf.readUInt16LE(c.pos);
    skip(c, 2);
    return v;
  }
  if (first === 0xfe) {
    const v = c.buf.readUInt32LE(c.pos);
    skip(c, 4);
    return v;
  }
  const v = c.buf.readBigUInt64LE(c.pos);
  skip(c, 8);
  if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError("varint too large");
  return Number(v);
}

export interface TxOutput {
  /** Index within the transaction — the `vout` half of an outpoint. */
  n: number;
  /** Value in litoshis. Read as BigInt because 8 bytes can exceed 2^53. */
  value: bigint;
  /** The output script, from which an address is derived. */
  script: Buffer;
}

export interface DecodedTx {
  txid: string;
  outputs: TxOutput[];
}

/**
 * Computes the txid of a raw transaction.
 *
 * @returns the txid in the conventional big-endian hex display order.
 * @throws  RangeError if the buffer is not a well-formed transaction.
 */
export function computeTxid(raw: Buffer): string {
  return decodeTx(raw).txid;
}

/**
 * Decodes a raw transaction far enough to identify it and see who it paid.
 *
 * Only outputs are returned. Inputs identify their source by outpoint, not by
 * address, and resolving one to an address means fetching the transaction it
 * spends — which a pruned node cannot serve. So the index built from this
 * covers funds *received*, which is the question a deposit monitor asks.
 *
 * @throws RangeError if the buffer is not a well-formed transaction.
 */
export function decodeTx(raw: Buffer): DecodedTx {
  const c: Cursor = { buf: raw, pos: 0 };

  const versionStart = c.pos;
  skip(c, 4);
  const versionEnd = c.pos;

  // Marker 0x00 followed by a non-zero flag means SegWit. A legacy transaction
  // can never have a zero input count, so the marker is unambiguous.
  const isSegwit = raw.length > 5 && raw.readUInt8(4) === 0x00 && raw.readUInt8(5) !== 0x00;
  if (isSegwit) skip(c, 2);

  const bodyStart = c.pos;

  const vinCount = varint(c);
  if (vinCount === 0) throw new RangeError("transaction has no inputs");
  for (let i = 0; i < vinCount; i++) {
    skip(c, 36); // 32-byte previous hash + 4-byte index
    skip(c, varint(c)); // scriptSig
    skip(c, 4); // sequence
  }

  const voutCount = varint(c);
  const outputs: TxOutput[] = [];
  for (let i = 0; i < voutCount; i++) {
    if (c.pos + 8 > raw.length) throw new RangeError("truncated transaction");
    const value = raw.readBigUInt64LE(c.pos);
    skip(c, 8);

    const scriptLen = varint(c);
    const scriptStart = c.pos;
    skip(c, scriptLen);
    outputs.push({ n: i, value, script: raw.subarray(scriptStart, c.pos) });
  }

  const bodyEnd = c.pos;

  if (isSegwit) {
    // One witness stack per input, each a varint count of varint-length items.
    for (let i = 0; i < vinCount; i++) {
      const items = varint(c);
      for (let j = 0; j < items; j++) skip(c, varint(c));
    }
  }

  const lockStart = c.pos;
  skip(c, 4);
  const lockEnd = c.pos;

  const stripped = isSegwit
    ? Buffer.concat([
        raw.subarray(versionStart, versionEnd),
        raw.subarray(bodyStart, bodyEnd),
        raw.subarray(lockStart, lockEnd),
      ])
    : raw;

  const txid = Buffer.from(hash256(stripped)).reverse().toString("hex");
  return { txid, outputs };
}
