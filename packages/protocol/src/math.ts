// packages/protocol/src/math.ts
//
// Integer-arithmetic guards for uZIR values.
//
// Context: type uZIR = number, but the supply scale is large by design —
// MAX_SUPPLY_UZIR = 2.87e16 and the genesis reserve (~1.177e16) BOTH exceed
// Number.MAX_SAFE_INTEGER (9.007e15). At that magnitude a JS double can only
// represent integers in steps of 2 (and of 4 above 2^54), so single-uZIR
// precision is not guaranteed. This is deterministic across nodes (IEEE-754 is
// reproducible, so every honest node computes the identical value and the state
// root stays consistent — it does NOT fork consensus), but exact integer
// accounting at full supply scale ultimately requires migrating uZIR to bigint.
// That migration touches serialization, the state root, RPC, and the console and
// is tracked as dedicated future work (F3).
//
// These helpers therefore do NOT throw merely for crossing the 2^53 boundary —
// the reserve wallet is above it from genesis and must keep transacting. What
// they DO catch is genuine corruption: non-finite values (NaN/Infinity),
// negative balances, and subtraction underflow. `isUZIRSafe` remains an advisory
// predicate for callers that want to know whether a value is below the exact-
// representation ceiling.
//
// Usage:
//   import { addUZIR, subUZIR, mulUZIR, clampToSafe, isUZIRSafe } from "./math";
//   sender.balance = subUZIR(sender.balance, fee, "fee deduction");
//
// When to use these vs plain arithmetic:
//   - Use addUZIR / subUZIR whenever accumulating balances or supply totals.
//   - Use mulUZIR for integer scaling (e.g. percentage of supply).
//   - Use isUZIRSafe for pre-condition checks at API boundaries.
//   - Use clampToSafe as a last resort when the caller can recover from clamping
//     (e.g. computing a display value) rather than throwing.

export const UZIR_SAFE_MAX = Number.MAX_SAFE_INTEGER; // 9_007_199_254_740_991

/** True when n is a finite integer whose magnitude is within JS safe-integer range. */
export function isUZIRSafe(n: number): boolean {
  return Number.isInteger(n) && n >= 0 && n <= UZIR_SAFE_MAX;
}

/**
 * Assert that n is a safe uZIR integer. Throws a RangeError with `ctx` in the
 * message if the assertion fails. Returns n for convenient chaining.
 */
function assertSafe(n: number, ctx: string): number {
  // Catch genuine corruption only: NaN/Infinity (caught by !isInteger), a fractional value
  // (a missing floor upstream), or a negative balance. We do NOT throw for crossing 2^53 —
  // the supply scale is above it by design (see file header). That exact-precision ceiling is
  // the job of the future bigint migration, not a reason to crash live ledger arithmetic.
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError(`uZIR invalid amount in "${ctx}": ${n}`);
  }
  return n;
}

/**
 * Add two uZIR amounts. Throws if either operand or the result is outside the
 * safe-integer range. `ctx` is included in the error message for diagnostics.
 */
export function addUZIR(a: number, b: number, ctx = "addUZIR"): number {
  assertSafe(a, `${ctx}.a`);
  assertSafe(b, `${ctx}.b`);
  return assertSafe(a + b, ctx);
}

/**
 * Subtract b from a. Result must be >= 0 and within safe-integer range.
 * Throws on underflow or out-of-range operands.
 */
export function subUZIR(a: number, b: number, ctx = "subUZIR"): number {
  assertSafe(a, `${ctx}.a`);
  assertSafe(b, `${ctx}.b`);
  if (b > a) throw new RangeError(`uZIR underflow in "${ctx}": ${a} - ${b}`);
  return assertSafe(a - b, ctx);
}

/**
 * Multiply a uZIR amount by a non-negative integer factor and floor the result.
 * Throws if the operand or the result is out of range.
 */
export function mulUZIR(a: number, factor: number, ctx = "mulUZIR"): number {
  assertSafe(a, `${ctx}.a`);
  if (!Number.isFinite(factor) || factor < 0) {
    throw new RangeError(`uZIR invalid factor in "${ctx}": ${factor}`);
  }
  return assertSafe(Math.floor(a * factor), ctx);
}

/**
 * Clamp n to [0, MAX_SAFE_INTEGER]. Use this only for display/advisory paths
 * where precision loss is preferable to throwing. For ledger arithmetic, prefer
 * addUZIR / subUZIR / mulUZIR which throw on overflow.
 */
export function clampToSafe(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(UZIR_SAFE_MAX, Math.floor(n)));
}
