// apps/web/src/lib/keys.ts
// Self custodial wallet. Keys are generated and held in the browser, never sent anywhere.
// The private key is encrypted with a passphrase (PBKDF2 + AES-GCM) and stored in IndexedDB.
import { get, set, del } from "idb-keyval";
import {
  generateKeypair, keypairFromPrivate, sign as protoSign, type Keypair,
} from "@zira/protocol";

const BLOB_KEY = "zira.wallet.v1";
const enc = new TextEncoder();
const dec = new TextDecoder();

interface EncryptedBlob {
  address: string;
  publicKey: string;
  salt: string;   // hex
  iv: string;     // hex
  cipher: string; // hex of encrypted private key
}

// Cast helper: the web crypto types want BufferSource backed by ArrayBuffer, while
// new Uint8Array is typed Uint8Array<ArrayBufferLike> under recent TS lib. Bytes are
// always ArrayBuffer backed here, so the cast is safe.
function bs(u: Uint8Array): BufferSource {
  return u as unknown as BufferSource;
}
function toHex(b: Uint8Array): string {
  return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function fromHex(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", bs(enc.encode(passphrase)), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: bs(salt), iterations: 150_000, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function encryptPrivateKey(privateKey: string, passphrase: string): Promise<{ salt: string; iv: string; cipher: string }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt);
  const cipherBuf = await crypto.subtle.encrypt({ name: "AES-GCM", iv: bs(iv) }, key, bs(enc.encode(privateKey)));
  return { salt: toHex(salt), iv: toHex(iv), cipher: toHex(new Uint8Array(cipherBuf)) };
}

async function decryptPrivateKey(blob: EncryptedBlob, passphrase: string): Promise<string> {
  const key = await deriveKey(passphrase, fromHex(blob.salt));
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bs(fromHex(blob.iv)) }, key, bs(fromHex(blob.cipher)));
  return dec.decode(plain);
}

// In memory unlocked key. Cleared on lock and on timeout. Never persisted in plain text.
let unlocked: Keypair | null = null;
let lockTimer: ReturnType<typeof setTimeout> | null = null;

export function extractPrivateKeyInput(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error("paste a private key");

  const labeled = [...raw.matchAll(/(?:privateKey|private_key|private\s+key)\s*[:=]?\s*(?:\r?\n)?\s*(?:0x)?([0-9a-fA-F]{64})/gi)];
  if (labeled.length > 0) return labeled[0]![1]!.toLowerCase();

  if (/\bpublicKey\b|\bpublic\s+key\b/i.test(raw)) {
    throw new Error("that looks like a public key. Paste the privateKey line instead");
  }

  const exact = raw.match(/^(?:0x)?([0-9a-fA-F]{64})$/);
  if (exact) return exact[1]!.toLowerCase();

  const loose = [...raw.matchAll(/(?:^|[^0-9a-fA-F])(?:0x)?([0-9a-fA-F]{64})(?=$|[^0-9a-fA-F])/g)];
  if (loose.length === 1) return loose[0]![1]!.toLowerCase();

  throw new Error("paste a raw private key or a labeled privateKey= line");
}

export const Wallet = {
  async exists(): Promise<boolean> {
    return (await get(BLOB_KEY)) !== undefined;
  },

  async address(): Promise<string | null> {
    const blob = (await get(BLOB_KEY)) as EncryptedBlob | undefined;
    return blob?.address ?? null;
  },

  async create(passphrase: string): Promise<Keypair> {
    const kp = generateKeypair();
    const { salt, iv, cipher } = await encryptPrivateKey(kp.privateKey, passphrase);
    const blob: EncryptedBlob = { address: kp.address, publicKey: kp.publicKey, salt, iv, cipher };
    await set(BLOB_KEY, blob);
    unlocked = kp;
    return kp;
  },

  async importPrivateKey(privateKey: string, passphrase: string): Promise<Keypair> {
    const kp = keypairFromPrivate(extractPrivateKeyInput(privateKey));
    const { salt, iv, cipher } = await encryptPrivateKey(kp.privateKey, passphrase);
    await set(BLOB_KEY, { address: kp.address, publicKey: kp.publicKey, salt, iv, cipher } as EncryptedBlob);
    unlocked = kp;
    return kp;
  },

  // Adopt a private key as the in-memory unlocked wallet WITHOUT persisting it to IndexedDB. Used for the
  // node-custody wallet on a local node: the Console loads the node's own mining key (fetched over the
  // loopback-only /wallet/export) so every signed action works, but the key is never written to browser
  // storage and is gone when the tab closes. No auto-lock timer, so the session stays usable.
  adoptInMemory(privateKey: string): Keypair {
    unlocked = keypairFromPrivate(privateKey);
    if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
    return unlocked;
  },

  async unlock(passphrase: string, autoLockMs = 10 * 60 * 1000): Promise<Keypair> {
    const blob = (await get(BLOB_KEY)) as EncryptedBlob | undefined;
    if (!blob) throw new Error("no wallet found");
    const privateKey = await decryptPrivateKey(blob, passphrase);
    unlocked = keypairFromPrivate(privateKey);
    if (lockTimer) clearTimeout(lockTimer);
    lockTimer = setTimeout(() => { unlocked = null; }, autoLockMs);
    return unlocked;
  },

  lock(): void {
    unlocked = null;
    if (lockTimer) { clearTimeout(lockTimer); lockTimer = null; }
  },

  isUnlocked(): boolean {
    return unlocked !== null;
  },

  /** The unlocked public key, or null. */
  publicKey(): string | null {
    return unlocked?.publicKey ?? null;
  },

  unlockedAddress(): string | null {
    return unlocked?.address ?? null;
  },

  /** Sign a canonical body with the unlocked key. Throws if locked. */
  sign(canonicalBody: string): string {
    if (!unlocked) throw new Error("wallet is locked");
    return protoSign(canonicalBody, unlocked.privateKey);
  },

  /** Export the private key for backup. Requires the wallet to be unlocked. */
  exportPrivateKey(): string {
    if (!unlocked) throw new Error("unlock the wallet first");
    return unlocked.privateKey;
  },

  async destroy(): Promise<void> {
    await del(BLOB_KEY);
    this.lock();
  },
};
