// apps/web/src/app/Onboarding.tsx
// First run flow: what ZIRA is, connect to the live network, create or import a wallet with the
// backup warning, and the honest note about real vs test ZIR.
import { useEffect, useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { Modal, Button, Input, Textarea } from "../components/ui";
import { ResonanceField } from "../components/ResonanceField";
import { Wallet, extractPrivateKeyInput } from "../lib/keys";
import { useZira } from "../store/useZira";
import { setClientMode, isLocalNode } from "../client/createClient";
import { NodeApi } from "../lib/nodeApi";

const KEY = "zira.onboarded";
// Bump this on a major privacy/terms change to re-show the gate to everyone (spec §1).
const PRIVACY_VERSION = "1";

export function Onboarding() {
  const { refreshIdentity, reconnect } = useZira();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [importKey, setImportKey] = useState("");
  const [created, setCreated] = useState<{ address: string; privateKey: string } | null>(null);
  const [error, setError] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [analytics, setAnalytics] = useState(true);

  useEffect(() => {
    // Show on first run, OR again whenever the accepted privacy version is behind the current one.
    const onboarded = localStorage.getItem(KEY);
    const acceptedVersion = localStorage.getItem("zira.privacy.version");
    if (!onboarded || acceptedVersion !== PRIVACY_VERSION) setOpen(true);
  }, []);

  // The privacy + terms gate must be accepted before the modal can be dismissed (no skip): closing is
  // only honored once the current privacy version has been accepted.
  const privacyAccepted = () => localStorage.getItem("zira.privacy.version") === PRIVACY_VERSION;

  function finish() {
    localStorage.setItem(KEY, "true");
    setOpen(false);
  }

  async function chooseMode(_mode: "node") {
    setClientMode("auto");
    await reconnect();
    setStep(2);
  }

  async function createWallet() {
    setError("");
    if (pass.length < 6) { setError("Use a passphrase of at least 6 characters."); return; }
    if (confirm && confirm !== pass) { setError("The two passphrases do not match."); return; }
    try {
      const kp = await Wallet.create(pass);
      setCreated({ address: kp.address, privateKey: kp.privateKey });
      await refreshIdentity();
      setStep(4);
    } catch (e) {
      setError(e instanceof Error ? e.message : "could not create wallet");
    }
  }

  async function importWallet() {
    setError("");
    if (pass.length < 6) { setError("Use a passphrase of at least 6 characters."); return; }
    try {
      await Wallet.importPrivateKey(importKey.trim(), pass);
      await refreshIdentity();
      setStep(5);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That private key did not import. Check it and try again.");
    }
  }

  // Desktop / own-node import: the wallet the app shows IS the node's mining identity, so an import must be
  // adopted by the NODE (loopback /wallet/import), not only by the browser. Importing only browser-side left
  // the app pinned back to the node's fresh identity on the next status poll, the imported wallet's balance
  // never appeared. The passphrase still encrypts the local backup copy of the key on this device.
  async function importWalletLocal() {
    setError("");
    if (pass.length < 6) { setError("Use a passphrase of at least 6 characters."); return; }
    try {
      const raw = extractPrivateKeyInput(importKey);
      await Wallet.importPrivateKey(raw, pass);
      const r = await NodeApi.walletImport(raw);
      if (!r.ok) { setError(r.reason ?? "The node could not adopt that key."); return; }
      // Persist completion BEFORE the relaunch so onboarding does not repeat.
      localStorage.setItem(KEY, "true");
      setStep(7);
      const bridge = (window as unknown as { zira?: { relaunchApp?: () => void } }).zira;
      if (bridge?.relaunchApp) setTimeout(() => bridge.relaunchApp!(), 1200);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That private key did not import. Check it and try again.");
    }
  }

  return (
    <Modal open={open} onClose={() => { if (privacyAccepted()) finish(); }} title="Welcome to ZIRA" wide>
      {step === 0 && (
        <div className="flex flex-col items-center gap-6 py-2 text-center">
          <div className="flex flex-col items-center gap-3">
            <ResonanceField size={160} live intensity={0.82} />
            <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--teal)]">Ignite the field</div>
          </div>
          <div className="flex flex-col items-center gap-2.5">
            <h3 className="text-2xl font-semibold tracking-tight text-text">AI you run, own, and verify</h3>
            <p className="max-w-md text-sm leading-relaxed text-muted">
              ZIRA is AI that runs on people&apos;s machines instead of one company&apos;s servers. Ask the network
              and get an answer you can verify, or work privately on your own machine. You can also earn by
              contributing your computer, or build AI workers that work for you. No central server. No subscription.
            </p>
          </div>
          <Button variant="primary" onClick={() => setStep(1)}>Get started</Button>
        </div>
      )}

      {step === 1 && (
        <div className="flex flex-col gap-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--teal)]">Step one</div>
          <h4 className="text-lg font-semibold tracking-tight">Connect to the live network</h4>
          <p className="text-sm text-muted">ZIRA connects to a node and joins the live network. There is no demo mode, this is the real thing. New here? For the network's first year, the contributing community covers a free allowance of questions, no ZIR or machine needed. After that, add ZIR or run your own machine to keep asking; contributing your machine keeps it free with no limit.</p>
          <div className="grid grid-cols-1 gap-3">
            <Button variant="primary" onClick={() => chooseMode("node")}>Connect to the live network</Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--teal)]">Before you begin</div>
          <h4 className="text-lg font-semibold tracking-tight">Your privacy, and a few honest terms</h4>
          <p className="text-sm text-muted">ZIRA keeps your data with you. A few honest things to know before you make a wallet.</p>
          <ul className="space-y-1.5 text-sm text-muted">
            <li><span className="text-text">Your data stays on your machine.</span> Your chats and files live on this device and are never sent to a company. When you ask the network, only your question travels to the models that answer it, and only to complete that answer.</li>
            <li>ZIRA is run by its users, not a company. There is no account to sign into and no support desk. You run it, you own it.</li>
            <li>Your wallet key stays on this device. Lose it and your funds are gone, and no one can reset it for you.</li>
            <li>ZIR is earned, never sold by us. It has no guaranteed value and may never have one. None of this is investment advice.</li>
            <li>How you use ZIRA, and the laws and taxes where you live, are yours to handle.</li>
            <li>The software is provided as is, with no warranty.</li>
          </ul>
          <label className="mt-1 flex items-start gap-2 text-sm text-text">
            <input type="checkbox" checked={termsAccepted} onChange={(e) => setTermsAccepted(e.target.checked)} className="mt-0.5" />
            <span>I've read the privacy note and accept these terms.</span>
          </label>
          <label className="flex items-start gap-2 text-sm text-muted">
            <input type="checkbox" checked={analytics} onChange={(e) => setAnalytics(e.target.checked)} className="mt-0.5" />
            <span>Share anonymous usage analytics to help improve ZIRA. Optional, and changeable any time in Settings.</span>
          </label>
          <Button variant="primary" onClick={async () => {
            const now = new Date().toISOString();
            localStorage.setItem("zira.terms.accepted", now);
            localStorage.setItem("zira.privacy.version", PRIVACY_VERSION);
            localStorage.setItem("zira.privacy.accepted.date", now);
            localStorage.setItem("zira.analytics", analytics ? "on" : "off");
            // On your own node (desktop app), the wallet is the node's mining identity. Offer to keep
            // the wallet this device generated, or import an existing one the node adopts.
            if (isLocalNode()) { await refreshIdentity(); setStep(6); return; }
            setStep(3);
          }} disabled={!termsAccepted}>Accept and continue</Button>
        </div>
      )}

      {step === 3 && (
        <div className="flex flex-col gap-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--teal)]">Your wallet</div>
          <h4 className="text-lg font-semibold tracking-tight">Create or import a wallet</h4>
          <p className="text-sm text-muted">Choose a passphrase. It encrypts your private key, which stays only on this device. If you lose the passphrase, no one can recover your funds, not even us.</p>
          <div className="relative">
            <Input
              type={show ? "text" : "password"} autoFocus
              placeholder="Choose a passphrase (at least 6 characters)"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") createWallet(); }}
              className="pr-10"
            />
            <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide passphrase" : "Show passphrase"}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-text">
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <Input
            type={show ? "text" : "password"}
            placeholder="Confirm passphrase"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") createWallet(); }}
          />
          {error && <p className="text-xs text-[var(--danger)]">{error}</p>}
          <Button variant="primary" onClick={createWallet} disabled={pass.length < 6}>Create new wallet</Button>
          <div className="mt-2 border-t border-hairline pt-3">
            <p className="mb-2 text-xs text-muted">Or import an existing private key. You can paste a raw private key, a privateKey= line, or a full ZIRA local-private wallet section. Public keys are refused.</p>
            <Textarea rows={4} placeholder="privateKey=... or paste the wallet backup section" value={importKey} onChange={(e) => setImportKey(e.target.value)} className="mono" />
            <Button variant="secondary" className="mt-2" onClick={importWallet} disabled={!importKey || pass.length < 6}>Import wallet</Button>
          </div>
        </div>
      )}

      {step === 4 && created && (
        <div className="flex flex-col gap-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--warn)]">Keep this safe</div>
          <h4 className="text-lg font-semibold tracking-tight">Back up your key now</h4>
          <p className="text-sm text-[var(--warn)]">Write this down and keep it safe and offline. This is the only way to restore your wallet. We cannot recover it for you.</p>
          <div className="rounded-lg border border-hairline bg-base p-3">
            <div className="text-xs text-faint">Address</div>
            <div className="mono break-all text-sm">{created.address}</div>
            <div className="mt-2 text-xs text-faint">Private key</div>
            <div className="mono break-all text-sm">{created.privateKey}</div>
          </div>
          <Button variant="primary" onClick={() => setStep(5)}>I saved it</Button>
        </div>
      )}

      {step === 6 && (
        <div className="flex flex-col gap-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--teal)]">Your wallet</div>
          <h4 className="text-lg font-semibold tracking-tight">This device is ready</h4>
          <p className="text-sm text-muted">This device already created a wallet, and everything it earns goes there. Keep it, or bring a wallet you already have.</p>
          <Button variant="primary" onClick={() => setStep(5)}>Keep this device&apos;s wallet</Button>
          <div className="mt-1 border-t border-hairline pt-3">
            <p className="mb-2 text-xs text-muted">Import an existing wallet instead. Paste a raw private key, a privateKey= line, or a full ZIRA backup section. The node restarts once to mine into it.</p>
            <div className="relative">
              <Input
                type={show ? "text" : "password"}
                placeholder="Choose an app passphrase (at least 6 characters)"
                value={pass}
                onChange={(e) => setPass(e.target.value)}
                className="pr-10"
              />
              <button type="button" onClick={() => setShow((v) => !v)} aria-label={show ? "Hide passphrase" : "Show passphrase"}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-text">
                {show ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <Textarea rows={4} placeholder="privateKey=... or paste the wallet backup section" value={importKey} onChange={(e) => setImportKey(e.target.value)} className="mono mt-2" />
            {error && <p className="mt-1 text-xs text-[var(--danger)]">{error}</p>}
            <Button variant="secondary" className="mt-2" onClick={importWalletLocal} disabled={!importKey || pass.length < 6}>Import and restart</Button>
          </div>
        </div>
      )}

      {step === 7 && (
        <div className="flex flex-col items-center gap-4 py-2 text-center">
          <div className="flex flex-col items-center gap-2.5">
            <ResonanceField size={120} live intensity={0.6} />
            <div className="text-[11px] uppercase tracking-[0.16em] text-faint">syncing</div>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <h4 className="text-lg font-semibold tracking-tight">Wallet imported</h4>
            <p className="max-w-sm text-sm leading-relaxed text-muted">ZIRA is restarting to load your wallet. Your balance appears once the node finishes syncing, usually under a minute.</p>
          </div>
        </div>
      )}

      {step === 5 && (
        <div className="flex flex-col gap-3">
          <div className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--teal)]">You&apos;re in</div>
          <h4 className="text-lg font-semibold tracking-tight">Pick a starting point</h4>
          <p className="text-sm text-muted">You can do all of these and switch any time. The roles stack.</p>
          <div className="grid gap-2">
            <button onClick={finish} className="rounded-lg border border-hairline px-3 py-2 text-left text-sm hover:border-hairline-strong">
              <span className="font-medium">Ask the network</span><div className="text-xs text-faint">Ask the network, hire AI workers, and explore what&apos;s out there.</div>
            </button>
            <button onClick={() => { localStorage.setItem("zira.role", "node"); finish(); }} className="rounded-lg border border-hairline px-3 py-2 text-left text-sm hover:border-hairline-strong">
              <span className="font-medium">Contribute your machine and earn</span><div className="text-xs text-faint">Your computer already helps run the network. Turn on Mining to do more of the work and earn ZIR.</div>
            </button>
            <button onClick={() => { localStorage.setItem("zira.role", "builder"); finish(); }} className="rounded-lg border border-hairline px-3 py-2 text-left text-sm hover:border-hairline-strong">
              <span className="font-medium">Build AI workers</span><div className="text-xs text-faint">Create Resonators, AI workers you own, that earn ZIR by doing useful work.</div>
            </button>
          </div>
          <p className="text-[11px] text-faint">Test ZIR has no value. Only mainnet ZIR is a live asset. Your keys are yours; the ledger is peer to peer.</p>
          <Button variant="primary" onClick={finish}>Enter ZIRA</Button>
        </div>
      )}
    </Modal>
  );
}
