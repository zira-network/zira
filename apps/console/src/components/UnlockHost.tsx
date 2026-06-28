// apps/web/src/components/UnlockHost.tsx
// The wallet unlock modal, mounted once. Any page can call useUnlock().request().
import { useState } from "react";
import { Modal, Button, Input } from "./ui";
import { useUnlock } from "../store/useUnlock";
import { useZira } from "../store/useZira";
import { Wallet } from "../lib/keys";

export function UnlockHost() {
  const { open, resolve } = useUnlock();
  const setUnlocked = useZira((s) => s.setUnlocked);
  const [pass, setPass] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function unlock() {
    setBusy(true);
    setError("");
    try {
      await Wallet.unlock(pass);
      setUnlocked(true);
      setPass("");
      resolve(true);
    } catch {
      setError("Wrong passphrase, or no wallet. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={open} onClose={() => resolve(false)} title="Unlock your wallet">
      <p className="mb-3 text-sm text-muted">
        Your key is encrypted in this browser. Enter your passphrase to sign locally. It is never sent anywhere.
      </p>
      <Input
        type="password" value={pass} placeholder="Passphrase"
        onChange={(e) => setPass(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && unlock()}
        autoFocus
      />
      {error && <p className="mt-2 text-xs text-[var(--danger)]">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={() => resolve(false)}>Cancel</Button>
        <Button variant="primary" onClick={unlock} disabled={busy || !pass}>Unlock</Button>
      </div>
    </Modal>
  );
}
