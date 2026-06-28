// Anchor payment watcher (spec §2.5): the on-chain verification logic. parseEvmReceipt is pure (no
// network), so we exercise the matching rules directly: a receipt confirms a contribution only when it
// contains a USDT Transfer to the steward's receiving address for the EXACT class x quantity amount.
import test from "node:test";
import assert from "node:assert/strict";
import { parseEvmReceipt, expectedBaseUnits } from "../src/anchor/paymentWatcher.ts";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const USDT_ETH = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const RECEIVER = "0xA19af8f182D5ea55276F3Eb050B80Ec90635bF9B";
const SENDER = "0x1111111111111111111111111111111111111111";
const topicAddr = (a: string) => "0x" + a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const valueHex = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");

function receipt(opts: { status?: string; to?: string; value?: bigint; contract?: string; block?: string } = {}) {
  return {
    status: opts.status ?? "0x1",
    blockNumber: opts.block ?? "0x10", // 16
    logs: [{
      address: opts.contract ?? USDT_ETH,
      topics: [TRANSFER_TOPIC, topicAddr(SENDER), topicAddr(opts.to ?? RECEIVER)],
      data: valueHex(opts.value ?? expectedBaseUnits("F", 1, "Ethereum")),
    }],
  };
}
const HEAD = "0x14"; // block 20 -> 5 confirmations over block 16

test("expectedBaseUnits uses the class ladder x quantity at the chain's decimals", () => {
  assert.equal(expectedBaseUnits("F", 1, "Ethereum"), 150_000_000n);          // 150 * 10^6
  assert.equal(expectedBaseUnits("A", 1, "Ethereum"), 5_000_000_000n);        // 5000 * 10^6
  assert.equal(expectedBaseUnits("F", 2, "Ethereum"), 300_000_000n);          // x2
  assert.equal(expectedBaseUnits("F", 1, "BSC"), 150n * (10n ** 18n));        // BSC USDT is 18 decimals
});

test("a matching USDT transfer to the receiving address confirms, with sender + confirmations", () => {
  const r = parseEvmReceipt(receipt(), HEAD, USDT_ETH, RECEIVER, expectedBaseUnits("F", 1, "Ethereum"));
  assert.equal(r.confirmed, true);
  assert.equal(r.confirmations, 5);
  assert.equal(r.sender.toLowerCase(), SENDER.toLowerCase());
});

test("a wrong amount, wrong recipient, wrong contract, or failed tx does NOT confirm", () => {
  const expected = expectedBaseUnits("F", 1, "Ethereum");
  assert.equal(parseEvmReceipt(receipt({ value: expected + 1n }), HEAD, USDT_ETH, RECEIVER, expected).confirmed, false, "amount mismatch");
  assert.equal(parseEvmReceipt(receipt({ to: SENDER }), HEAD, USDT_ETH, RECEIVER, expected).confirmed, false, "recipient mismatch");
  assert.equal(parseEvmReceipt(receipt({ contract: SENDER }), HEAD, USDT_ETH, RECEIVER, expected).confirmed, false, "wrong token contract");
  assert.equal(parseEvmReceipt(receipt({ status: "0x0" }), HEAD, USDT_ETH, RECEIVER, expected).confirmed, false, "failed tx");
  assert.equal(parseEvmReceipt(null, HEAD, USDT_ETH, RECEIVER, expected).confirmed, false, "tx not found yet");
});

test("over-claiming a higher class is rejected: a Foundation payment cannot confirm a Genesis seat", () => {
  // Contributor paid the Foundation (F) amount but the entry claims Genesis (A): amounts differ -> no match.
  const paidFoundation = receipt({ value: expectedBaseUnits("F", 1, "Ethereum") });
  const r = parseEvmReceipt(paidFoundation, HEAD, USDT_ETH, RECEIVER, expectedBaseUnits("A", 1, "Ethereum"));
  assert.equal(r.confirmed, false);
});
