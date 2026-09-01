/**
 * Litoshi ↔ LTC formatting.
 *
 * Amounts cross the API as integer litoshi *strings*. A JS number holds 53
 * bits of integer precision, which covers any realistic balance, but the moment
 * a consumer sums outputs in floating point the totals stop reconciling — and a
 * deposit relay whose totals do not reconcile is worse than no relay. The
 * decimal form is provided alongside for display only.
 */

export const LITOSHIS_PER_LTC = 100_000_000n;

/** Fixed 8-decimal representation of a litoshi amount, e.g. "1.23450000". */
export function formatLtc(litoshis: bigint): string {
  const negative = litoshis < 0n;
  const abs = negative ? -litoshis : litoshis;
  const whole = abs / LITOSHIS_PER_LTC;
  const frac = abs % LITOSHIS_PER_LTC;
  return `${negative ? "-" : ""}${whole}.${frac.toString().padStart(8, "0")}`;
}

/** Parses a litoshi amount previously serialised as a decimal string. */
export function parseSat(value: string): bigint {
  return BigInt(value);
}
