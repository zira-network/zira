// apps/console/src/App.tsx
import { useEffect } from "react";
import { Routes, Route } from "react-router-dom";
import { AppFrame } from "./components/shell";
import { useZira } from "./store/useZira";
import { Spinner } from "./components/ui";
import { Onboarding } from "./app/Onboarding";
import { UnlockHost } from "./components/UnlockHost";
import { CommandPalette } from "./components/CommandPalette";
import { useGlobalShortcuts } from "./lib/shortcuts";

import { Console } from "./app/Console";
import { Mine } from "./app/Mine";
import { Dashboard } from "./app/Dashboard";
import { Images } from "./app/Images";
import { WalletPage } from "./app/Wallet";
import { Resonators } from "./app/Resonators";
import { ResonatorDetail } from "./app/ResonatorDetail";
import { Marketplace } from "./app/Marketplace";
import { Explorer } from "./app/Explorer";
import { Anchors } from "./app/Anchors";
import { Lattice } from "./app/Lattice";
import { Founder } from "./app/Founder";
import { Learn } from "./app/Learn";
import { SettingsPage } from "./app/Settings";
import { Styleguide } from "./app/Styleguide";

export function App() {
  const { ready, init } = useZira();
  useGlobalShortcuts();

  useEffect(() => {
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!ready) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner size={32} />
      </div>
    );
  }

  return (
    <>
      <Onboarding />
      <UnlockHost />
      <CommandPalette />
      <AppFrame>
        <Routes>
          <Route path="/" element={<Console />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/images" element={<Images />} />
          <Route path="/mine" element={<Mine />} />
          <Route path="/wallet" element={<WalletPage />} />
          <Route path="/resonators" element={<Resonators />} />
          <Route path="/resonators/:id" element={<ResonatorDetail />} />
          <Route path="/marketplace" element={<Marketplace />} />
          <Route path="/explorer" element={<Explorer />} />
          <Route path="/anchors" element={<Anchors />} />
          <Route path="/lattice" element={<Lattice />} />
          <Route path="/founder" element={<Founder />} />
          <Route path="/learn" element={<Learn />} />
          <Route path="/settings" element={<SettingsPage />} />
          {import.meta.env.DEV && <Route path="/styleguide" element={<Styleguide />} />}
        </Routes>
      </AppFrame>
    </>
  );
}
