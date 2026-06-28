// apps/console/src/client/ZiraClient.ts
// Re-export the protocol client interface. The UI only ever talks through this interface, so it
// stays decoupled from the concrete node transport.
export type { ZiraClient } from "@zira/protocol";
