// node/src/identity.ts
// The node's ZIRA wallet keypair. It signs checkpoint votes (Proof of Resonance finality) and,
// when the node also serves as a provider, signs answers. This is separate from the libp2p peer
// identity. The private key is stored in the data dir and never gossiped.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { generateKeypair, keypairFromPrivate, type Keypair } from "@zira/protocol";

export function loadOrCreateIdentity(dataDir: string, seedPriv?: string): Keypair {
  const path = join(dataDir, "identity.json");
  if (seedPriv) {
    return keypairFromPrivate(seedPriv);
  }
  if (existsSync(path)) {
    const json = JSON.parse(readFileSync(path, "utf8"));
    return keypairFromPrivate(json.privateKey);
  }
  const kp = generateKeypair();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ privateKey: kp.privateKey, publicKey: kp.publicKey, address: kp.address }, null, 2));
  return kp;
}
