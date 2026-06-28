// apps/web/src/store/useUnlock.ts
// A tiny store to request a wallet unlock from anywhere, resolving when the user unlocks.
import { create } from "zustand";
import { Wallet } from "../lib/keys";

interface UnlockState {
  open: boolean;
  resolver: ((ok: boolean) => void) | null;
  request: () => Promise<boolean>;
  resolve: (ok: boolean) => void;
}

export const useUnlock = create<UnlockState>((set, get) => ({
  open: false,
  resolver: null,
  request: () => {
    if (Wallet.isUnlocked()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => set({ open: true, resolver: resolve }));
  },
  resolve: (ok) => {
    get().resolver?.(ok);
    set({ open: false, resolver: null });
  },
}));
