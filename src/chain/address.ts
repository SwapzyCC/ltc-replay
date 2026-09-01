/**
 * Output script → Litecoin address.
 *
 * Every address the relay indexes is derived here, from the raw script bytes,
 * rather than read out of Core's JSON. That is deliberate: Core's `getblock`
 * has reported decoded addresses under two different field names across
 * versions (`scriptPubKey.addresses[]`, then `scriptPubKey.address`), and a
 * mempool transaction arrives over ZMQ as bare bytes with no JSON at all.
 * Deriving them here means the live path and the catch-up path produce
 * byte-identical results, which is what lets a mempool sighting and its later
 * confirmation collapse onto the same index row.
 *
 * Litecoin's script encoding is Bitcoin's; only the version bytes and the
 * bech32 prefix differ, and those are the constants below.
 */

import { createHash } from "node:crypto";

/**
 * Everything the encoder needs to know about a network.
 *
 * A named interface rather than `typeof LTC_MAINNET`: the constant is `as
 * const`, so deriving the type from it would pin every field to Litecoin's
 * exact literal values and make the parameter uninhabitable by any other
 * network — including the reference vectors the tests check against.
 */
export interface AddressParams {
  /** Base58 version byte for pay-to-public-key-hash. */
  p2pkhVersion: number;
  /** Base58 version byte for pay-to-script-hash. */
  p2shVersion: number;
  /** An older version byte the network still accepts, if it has one. */
  p2shVersionLegacy?: number;
  /** Human-readable part for native SegWit addresses. */
  bech32Hrp: string;
}

/** Mainnet Litecoin address parameters. */
export const LTC_MAINNET: AddressParams = {
  /** Base58 version byte for pay-to-public-key-hash — addresses starting "L". */
  p2pkhVersion: 0x30,
  /** Base58 version byte for pay-to-script-hash — addresses starting "M". */
  p2shVersion: 0x32,
  /**
   * Litecoin also still accepts Bitcoin's 0x05 for P2SH, producing the legacy
   * "3..." form. Both encode the same script hash; the relay emits the modern
   * one, so a consumer holding a legacy string should normalise before
   * comparing.
   */
  p2shVersionLegacy: 0x05,
  /** Human-readable part for native SegWit — addresses starting "ltc1". */
  bech32Hrp: "ltc",
};

// ── Script classification ────────────────────────────────────────────────────

const OP_0 = 0x00;
const OP_1 = 0x51;
const OP_DUP = 0x76;
const OP_EQUAL = 0x87;
const OP_EQUALVERIFY = 0x88;
const OP_HASH160 = 0xa9;
const OP_CHECKSIG = 0xac;
const OP_RETURN = 0x6a;

/**
 * Derives the address a script pays to, or null when it pays to nothing a
 * consumer could watch.
 *
 * Null is the right answer, not a failure, for `OP_RETURN` data carriers, bare
 * multisig, non-standard scripts, and pay-to-public-key — none of which a
 * wallet hands out as a deposit address. Callers index what they get and
 * ignore the rest.
 */
export function scriptToAddress(
  script: Buffer,
  params: AddressParams = LTC_MAINNET,
): string | null {
  // P2PKH: OP_DUP OP_HASH160 <20 bytes> OP_EQUALVERIFY OP_CHECKSIG
  if (
    script.length === 25 &&
    script[0] === OP_DUP &&
    script[1] === OP_HASH160 &&
    script[2] === 20 &&
    script[23] === OP_EQUALVERIFY &&
    script[24] === OP_CHECKSIG
  ) {
    return base58Check(params.p2pkhVersion, script.subarray(3, 23));
  }

  // P2SH: OP_HASH160 <20 bytes> OP_EQUAL
  if (
    script.length === 23 &&
    script[0] === OP_HASH160 &&
    script[1] === 20 &&
    script[22] === OP_EQUAL
  ) {
    return base58Check(params.p2shVersion, script.subarray(2, 22));
  }

  if (script.length > 0 && script[0] === OP_RETURN) return null;

  // SegWit: a version opcode followed by a single 2–40 byte push. Witness
  // version 0 uses bech32 and 1+ uses bech32m; encoding a v1 output with the
  // v0 constant would produce a string that looks right and is not spendable.
  const witness = decodeWitnessProgram(script);
  if (witness) {
    return encodeSegwit(params.bech32Hrp, witness.version, witness.program);
  }

  return null;
}

function decodeWitnessProgram(script: Buffer): { version: number; program: Buffer } | null {
  if (script.length < 4 || script.length > 42) return null;

  const first = script[0];
  if (first === undefined) return null;

  let version: number;
  if (first === OP_0) version = 0;
  else if (first >= OP_1 && first <= OP_1 + 15) version = first - OP_1 + 1;
  else return null;

  const pushLen = script[1];
  if (pushLen === undefined || pushLen < 2 || pushLen > 40) return null;
  if (script.length !== pushLen + 2) return null;

  // Version 0 is defined only for 20-byte (P2WPKH) and 32-byte (P2WSH)
  // programs. Anything else at v0 is non-standard and has no address.
  if (version === 0 && pushLen !== 20 && pushLen !== 32) return null;

  return { version, program: script.subarray(2) };
}

// ── Base58Check ──────────────────────────────────────────────────────────────

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function sha256(b: Buffer): Buffer {
  return createHash("sha256").update(b).digest();
}

export function base58Check(version: number, payload: Buffer): string {
  const body = Buffer.concat([Buffer.from([version]), payload]);
  const checksum = sha256(sha256(body)).subarray(0, 4);
  return base58Encode(Buffer.concat([body, checksum]));
}

function base58Encode(buf: Buffer): string {
  // Leading zero bytes carry no value but are significant: each encodes as a
  // literal "1", which is what gives Litecoin's P2SH addresses their length.
  let zeros = 0;
  while (zeros < buf.length && buf[zeros] === 0) zeros += 1;

  const digits: number[] = [0];
  for (let i = zeros; i < buf.length; i++) {
    let carry = buf[i] as number;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] as number) << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i] as number];
  return out;
}

// ── Bech32 / bech32m ─────────────────────────────────────────────────────────

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32_CONST = 1;
const BECH32M_CONST = 0x2bc830a3;

function polymod(values: readonly number[]): number {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) {
      if ((top >>> i) & 1) chk ^= GEN[i] as number;
    }
  }
  return chk >>> 0;
}

function hrpExpand(hrp: string): number[] {
  const high: number[] = [];
  const low: number[] = [];
  for (const ch of hrp) {
    const code = ch.charCodeAt(0);
    high.push(code >>> 5);
    low.push(code & 31);
  }
  return [...high, 0, ...low];
}

/** Repacks 8-bit bytes into the 5-bit groups bech32 encodes. */
function toFiveBit(data: Buffer): number[] {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const byte of data) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >>> bits) & 31);
    }
  }
  if (bits > 0) out.push((acc << (5 - bits)) & 31);
  return out;
}

/**
 * Encodes a SegWit address. Witness version 0 uses bech32; versions 1 and
 * above use bech32m, which differs only in the checksum constant — an address
 * encoded with the wrong one is rejected by every conforming wallet, so the
 * distinction is not cosmetic.
 */
export function encodeSegwit(hrp: string, version: number, program: Buffer): string {
  const data = [version, ...toFiveBit(program)];
  const constant = version === 0 ? BECH32_CONST : BECH32M_CONST;

  const values = [...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0];
  const mod = polymod(values) ^ constant;

  let checksum = "";
  for (let i = 0; i < 6; i++) {
    checksum += BECH32_CHARSET[(mod >>> (5 * (5 - i))) & 31];
  }

  let body = "";
  for (const v of data) body += BECH32_CHARSET[v];
  return `${hrp}1${body}${checksum}`;
}

/**
 * A cheap sanity check on a user-supplied address, used to reject obvious
 * junk at the API edge. It deliberately does not verify a checksum: the relay
 * looks addresses up in its own index, where an unknown string is simply a
 * miss, and rejecting a valid address because of a stricter-than-Core parser
 * would be the worse failure.
 */
export function looksLikeAddress(value: string): boolean {
  if (/^(ltc|tltc|rltc)1[02-9ac-hj-np-z]{6,87}$/i.test(value)) return true;
  return /^[123LM][1-9A-HJ-NP-Za-km-z]{25,39}$/.test(value);
}
