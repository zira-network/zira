# Releasing ZIRA (GitHub, Windows, Ubuntu)

ZIRA is open source. The repository holds the code; the runnable apps are attached to a GitHub
Release as downloads. The large Windows folder is not committed to git (see `.gitignore`); you upload
it as a release asset instead.

## Publish the source on GitHub

```bash
git init
git add .
git commit -m "ZIRA"
git branch -M main
git remote add origin https://github.com/<you>/zira.git
git push -u origin main
```

Anyone can then build from source:

```bash
pnpm install
pnpm test
bash scripts/build-all.sh
pnpm --filter @zira/desktop start
```

## Build the Windows app

```bash
bash scripts/build-all.sh
pnpm --filter @zira/desktop exec electron-builder --win --config.directories.output=dist-refined
```

The installer step uses a code signing toolkit that needs Windows Developer Mode (Settings, Privacy
and security, For developers) or admin. If you cannot enable it, ship the runnable folder: zip
`apps/desktop/dist-refined/win-unpacked`, rename it `ZIRA-Windows`, and attach the zip to the release.

## Build the Ubuntu app

On Ubuntu (or any Linux):

```bash
sudo apt-get install -y libfuse2     # needed to run AppImages
pnpm install
bash scripts/build-all.sh
pnpm --filter @zira/desktop exec electron-builder --linux --config.directories.output=dist-ubuntu
chmod +x apps/desktop/dist-ubuntu/*.AppImage
```

Attach the `.AppImage` to the GitHub Release. Users download it, `chmod +x`, and run it.

On Windows-only release days, prepare the Ubuntu source and instructions, but do not claim an
Ubuntu artifact exists until this Linux/WSL build has completed.

## Make a GitHub Release

1. Tag a version: `git tag v1.0.0 && git push --tags`.
2. On GitHub, draft a release from the tag.
3. Attach the Windows zip and the Linux AppImage as assets.
4. In the notes, include your node's address so people can connect (see below).

## Letting others connect to your node

Other people's apps need to reach at least one node. For launch, run a reachable bootstrap node that
others can dial:

1. Run a stable node. It listens on TCP port 9645 by default.
2. Make that port reachable from the internet (port forward on your router, or run on a host or VPS
   with a public IP or domain). Set `ZIRA_ANNOUNCE` to your public address, for example
   `/ip4/<your-public-ip>/tcp/9645` or `/dns4/node.yourdomain.com/tcp/9645`.
3. Find your full node address in the app: Settings, Peers, "Your node address". It looks like
   `/dns4/node.yourdomain.com/tcp/9645/p2p/<peerId>`.
4. Share that address (in your release notes, your site, anywhere). Other users paste it into
   Settings, Peers, Connect, and their node syncs with yours. From there the network gossips and
   peers find each other.

That is all that is needed for people in other places to run ZIRA and sync.

## Mainnet safety checklist

Before telling the public to join mainnet:

1. Run at least two stable bootstrap nodes and publish their DNS multiaddrs.
2. Keep `ZIRA_RPC_HOST=127.0.0.1` unless you intentionally expose RPC.
3. If exposing RPC, set `ZIRA_RPC_ADMIN_TOKEN`; sensitive POST routes are blocked without it.
4. Keep `ZIRA_FAST_SYNC` unset on mainnet unless you trust and independently monitor bootstrap peers.
5. Keep launch-authority keys offline and never include them in public source or release artifacts.
