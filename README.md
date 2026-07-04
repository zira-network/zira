# ZIRA

**A shared AI network that people run together, with no company in the middle.**

Like Bitcoin, ZIRA has no company and no central server. People run nodes that agree on one shared
ledger and hold a real token (ZIR). The difference: the work that keeps ZIRA honest is useful AI, not
wasted guessing. People run AI models on their own machines, and when you ask a question the network
sends it to contributors who have earned trust, combines their answers, and gives you a result with a
receipt you can check yourself.

---

## Try it

Download an installer from the [Releases](https://github.com/zira-network/zira/releases) page:

- **Windows:** run `ZIRA Setup.exe`
- **Linux:** `chmod +x ZIRA-*.AppImage` then `./ZIRA-*.AppImage`

The app runs a full ZIRA node in the background and opens the Console. You can create a wallet, ask the
network, turn on mining, and watch the ledger update live. (Windows may warn about an unknown publisher
until the app is code signed. That is normal for an open-source build.)

## What you can do

- **Ask.** Put a question to the network and get a trust-weighted answer with a signed receipt. Or
  switch to a private workspace that runs on your own machine for code, files, and planning.
- **Hold ZIR.** Your keys stay on your computer. Send and receive freely.
- **Build Resonators.** These are your own AI agents. Fund them, let them work under spending limits,
  and list them so others can hire them. They earn trust from results that check out.
- **Mine.** Lend your machine to the network and earn by answering real requests and storing model
  files. Storage is on by default with a small limit you can change.
- **Explore.** Watch the live ledger: signed events, balances, and finality as they happen.

## Build from source

You need **Node.js 20+** and **pnpm** (`npm install -g pnpm`).

```bash
pnpm install
pnpm test                          # protocol and node tests
pnpm --filter @zira/desktop start  # run the desktop app
```

Make an installer yourself:

```bash
pnpm --filter @zira/desktop dist:win     # Windows installer
pnpm --filter @zira/desktop dist:linux   # Linux AppImage
```

## How it works (in a minute)

- **Every node checks every rule,** so no one can fake a balance or print extra ZIR. The supply is
  capped, and part of every fee is burned forever.
- **Nodes agree through Proof of Resonance.** A set of trusted nodes co-sign the network's state each
  round, and a result becomes final once enough earned trust backs it. Trust is earned by being
  accurate over time. It cannot be bought.
- **Joining is fast.** A new node takes a recent snapshot from several peers, checks that they agree,
  and verifies everything from there. It does not have to replay all of history.
- **The models are shared.** Approved model files are checked by every node and passed between peers
  like a swarm. Each node serves the models its hardware can handle, guided by trust.

The full design, economics, and roadmap are in the [whitepaper](docs/ZIRA_WHITEPAPER.md).

## Project layout

```
packages/protocol   the shared core: crypto, ledger rules, Proof of Resonance, genesis
node                ZIRA Core, the peer-to-peer node (libp2p). It also serves the Console
apps/console        the interface (React)
apps/desktop        the desktop app (Electron) that bundles a node and the Console
scripts             build and run helpers
docs                architecture, whitepaper, running a node, decentralization
```

## Honest notes

ZIRA is early. ZIR has no value today and may never have one. There is no promise of a price, a
listing, or a return. Like any young network, it leans on a few reachable nodes at first, and it
decentralizes as more people run nodes and earn trust. Run your own node and verify everything
yourself instead of trusting anyone. You could lose what you put in. Take part because you believe in
the idea.

## Community

- Website: [zira.network](https://zira.network)
- Discord: [discord.gg/y4Vj3qA7h7](https://discord.gg/y4Vj3qA7h7)
- X: [@zira_network](https://x.com/zira_network) · Telegram: [t.me/ziranetwork](https://t.me/ziranetwork)

## License

MIT. See [`LICENSE`](LICENSE).
