// packages/protocol/src/index.ts
// The shared spine. The ZIRA Core node and the Console GUI both import from here.
export * from "./constants";
export * from "./math";
export * from "./types";
export * from "./crypto";
export * from "./serialize";
export * from "./client";
export * from "./anchors";
export * from "./resonators";
export * from "./reserve";

// Text-to-image perceptual-hash agreement (2.9.0 Track A): fork-safe settler verification of non-bitwise
// image outputs.
export * from "./imageAgreement";

// Genesis and Proof of Resonance finality (the consensus spine)
export * from "./genesis";
export * from "./consensus";

// Proof of Resonance
export * from "./por/zti";
export * from "./por/field";
export * from "./por/rewards";

// Ledger
export * from "./ledger/tx";
export * from "./ledger/supply";
export * from "./ledger/validate";
