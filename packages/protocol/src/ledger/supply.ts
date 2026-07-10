// packages/protocol/src/ledger/supply.ts
//
// Enforce the 28.7B cap, track issuance and burn. auditSupply recomputes every
// balance and the issuance and burn totals from the signed event log, the function
// an exchange would run. See Part 3.5.
import { PROTOCOL } from "../constants";
import { feeAndBurn, parseBatchOutputs, parsePoolPayout } from "./tx";
import type { Address, SignedTx, uZIR } from "../types";

const EARNED_CAP_UZIR = Math.round(PROTOCOL.MAX_SUPPLY_UZIR * PROTOCOL.EARNED_SHARE);

export class SupplyTracker {
  emitted: uZIR;   // earned ZIR brought into existence as rewards
  burned: uZIR;    // fees burned forever
  reserve: uZIR;   // genesis reserve still held / granted from

  constructor(init?: { emitted?: uZIR; burned?: uZIR; reserve?: uZIR }) {
    this.emitted = init?.emitted ?? 0;
    this.burned = init?.burned ?? 0;
    this.reserve = init?.reserve ?? 0;
  }

  /** Total ZIR ever issued: the genesis reserve plus earned emissions. */
  get issued(): uZIR { return PROTOCOL.RESERVE_UZIR + this.emitted; }

  /** ZIR in circulation: issued minus burned. */
  get circulating(): uZIR { return this.issued - this.burned; }

  /** True only if emitting amount stays within the earned cap (59% of supply). */
  canEmit(amount: uZIR): boolean {
    return amount >= 0 && this.emitted + amount <= EARNED_CAP_UZIR;
  }

  recordEmission(amount: uZIR): void {
    if (!this.canEmit(amount)) throw new Error("emission would exceed the earned cap");
    this.emitted += amount;
    if (this.issued > PROTOCOL.MAX_SUPPLY_UZIR) throw new Error("issuance would exceed MAX_SUPPLY_UZIR");
  }

  recordBurn(amount: uZIR): void {
    if (amount < 0) throw new Error("burn cannot be negative");
    this.burned += amount;
  }

  recordReserveGrant(amount: uZIR): void {
    if (amount < 0) throw new Error("grant cannot be negative");
    if (amount > this.reserve) throw new Error("grant exceeds the remaining reserve");
    this.reserve -= amount;
  }
}

export interface AuditResult {
  balances: Record<Address, uZIR>;
  emitted: uZIR;
  burned: uZIR;
  reserveGranted: uZIR;
  issued: uZIR;
  circulating: uZIR;
  withinCap: boolean;
}

/**
 * Recompute balances, emitted, burned, and reserve grants purely from the signed
 * event log. The genesis event seeds the founder; rewards add emission; transfers
 * move balance and burn half the fee; reserve grants move from the founder.
 */
export function auditSupply(events: SignedTx[], founderAddress: Address): AuditResult {
  const balances: Record<Address, uZIR> = {};
  let emitted = 0;
  let burned = 0;
  let reserveGranted = 0;

  const credit = (addr: Address, amount: uZIR) => { balances[addr] = (balances[addr] ?? 0) + amount; };
  const debit = (addr: Address, amount: uZIR) => { balances[addr] = (balances[addr] ?? 0) - amount; };

  for (const tx of events) {
    if (tx.kind === "reward") {
      // minted from the earned pool to the recipient, no sender debit
      credit(tx.to, tx.amountUZIR);
      emitted += tx.amountUZIR;
      continue;
    }
    if (tx.kind === "reserve_grant") {
      // moved out of the founder reserve to the recipient
      debit(tx.from, tx.amountUZIR);
      credit(tx.to, tx.amountUZIR);
      if (tx.from === founderAddress) reserveGranted += tx.amountUZIR;
      const { burned: b } = feeAndBurn(tx.feeUZIR);
      debit(tx.from, tx.feeUZIR);
      burned += b;
      continue;
    }
    if (tx.kind === "founder_delegate" || tx.kind === "founder_revoke") {
      continue;
    }
    if (tx.kind === "batch_transfer") {
      // One tx, many recipients (from the signed memo). Debit the sender the full amount + fee and credit each
      // output, so the audit matches how State applies it. amountUZIR == sum(outputs) is enforced at ingest.
      const { burned: b } = feeAndBurn(tx.feeUZIR);
      debit(tx.from, tx.amountUZIR + tx.feeUZIR);
      const outs = parseBatchOutputs(tx.memo);
      if (outs) for (const [to, amt] of outs) credit(to, amt);
      burned += b;
      continue;
    }
    if (tx.kind === "pool_payout") {
      // Pool-funded community payout: the emission POOL (tx.to names it) funds BOTH the outputs and the fee;
      // the sender pays nothing. Matches how State applies it, so the audit stays exact.
      const { burned: b } = feeAndBurn(tx.feeUZIR);
      debit(tx.to, tx.amountUZIR + tx.feeUZIR);
      const meta = parsePoolPayout(tx.memo);
      if (meta) for (const [to, amt] of meta.outputs) credit(to, amt);
      burned += b;
      continue;
    }
    // transfer, agent_spend, bond_post/return/burn
    const { burned: b } = feeAndBurn(tx.feeUZIR);
    debit(tx.from, tx.amountUZIR + tx.feeUZIR);
    if (tx.kind !== "bond_burn") credit(tx.to, tx.amountUZIR);
    else burned += tx.amountUZIR; // a burned bond is destroyed
    burned += b;
  }

  const issued = PROTOCOL.RESERVE_UZIR + emitted;
  return {
    balances,
    emitted,
    burned,
    reserveGranted,
    issued,
    circulating: issued - burned,
    withinCap: emitted <= EARNED_CAP_UZIR && issued <= PROTOCOL.MAX_SUPPLY_UZIR,
  };
}

export const EARNED_CAP_UZIR_CONST = EARNED_CAP_UZIR;
