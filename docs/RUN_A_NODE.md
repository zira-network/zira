# Run a ZIRA Core node

A node is the whole network in one process: a libp2p peer, the ledger, Proof of Resonance, your
wallet, and the Console GUI. Run one and you are on the network. Run your own and you trust no one.

## Prerequisites

- Node.js 20 or newer.
- pnpm (`npm install -g pnpm`).
- To serve intelligence and earn answer rewards, either enable native model mining when available or
  provide an OpenAI-compatible endpoint you control, for example Ollama at `http://localhost:11434/v1`.

## Build

```bash
pnpm install
bash scripts/build-all.sh      # Windows: powershell -ExecutionPolicy Bypass -File scripts\build-all.ps1
```

This builds the protocol, the node, and the Console, and stages the Console into the node so the node
serves the GUI at its root.

## Run

```bash
# a local devnet node that is the genesis steward and seeds the field, so you can explore at once
ZIRA_NETWORK=devnet ZIRA_STEWARD=1 ZIRA_SEED=1 node node/dist/index.js
# open http://127.0.0.1:8645
```

To join mainnet, run the node. Automatic peer discovery is on by default: the node loads cached peers,
fetches the public registry from `https://zira.network/bootstrap-seeds.json`, verifies launch-authority
signatures, falls back to the bundled registry, and remembers discovered peers for future restarts.
The node also starts as a small P2P storage peer by default with a `1GB` cap. Users can disable storage
or raise the cap from the Mine page. This is how the field distributes authorized model bytes and future
field artifacts across many ordinary peers instead of depending on one host.

```bash
ZIRA_NETWORK=mainnet node node/dist/index.js
```

On Windows, prefer the wrapper because it also performs best-effort TCP setup for the node:
it opens Windows Firewall, asks compatible routers for UPnP IGD or NAT-PMP public port mappings,
detects the public host, and advertises public TCP addresses only after public TCP is actually
reachable.

```powershell
pnpm node:windows
```

If Windows asks for Administrator approval, accept it to allow inbound ZIRA P2P traffic. You can also
run the setup directly:

```powershell
pnpm open:node-ports
pnpm open:public-node-ports
```

Manual bootstrap addresses are still supported for recovery, private networks, or a temporary seed
before it is published in the signed registry:

```bash
ZIRA_NETWORK=mainnet ZIRA_BOOTSTRAP=/dns4/seed1.zira.network/tcp/9645/p2p/<peerId> node node/dist/index.js
```

## WordPress bootstrap registry

`https://zira.network/bootstrap-seeds.json` is the public phone book for clean nodes. WordPress can host
that JSON file, but the JSON must point to at least one reachable ZIRA seed node. If `seeds` is empty,
new users can fetch the registry but they will not sync.

If you do not have a seed subdomain yet, use a public IP multiaddr in the uploaded registry:

```bash
/ip4/<public-ip>/tcp/9645/p2p/<peerId>
```

This is less polished than `/dns4/seed.zira.network/...`, but it works if TCP `9645` reaches the node.
Keep this generated file in `local-private` and upload it to WordPress as the raw JSON at
`https://zira.network/bootstrap-seeds.json`; do not copy public IP seed registries into `docs`,
`source`, or `release`.

From the running bootstrap node:

```powershell
pnpm prepare:bootstrap-upload
```

This writes `local-private/bootstrap-seeds.wordpress-upload.json`. Upload that file's contents to
WordPress so the URL returns plain JSON. Then verify:

```powershell
pnpm check:public-bootstrap
pnpm check:new-user-sync
```

`check:new-user-sync` starts a temporary clean mainnet node with no manual `ZIRA_BOOTSTRAP`. It only
passes when automatic discovery finds peers.

Founder/steward operators can also build the upload file from the active local mainnet mesh:

```powershell
pnpm download:steward-bootstrap
```

That command asks the steward node for bootstrap candidates, scans the local launch ports
(`8645/8745/8845/8945` -> `9645/9745/9845/9945`), signs the resulting seed set with a local founder
key, and writes `local-private/bootstrap-seeds.wordpress-upload.json`. The first seed is marked
`master`; the rest are marked `master-candidate`. Upload that JSON unchanged to WordPress.

The Founder page also has a WordPress bootstrap registry card. With an unlocked founder wallet, no IP
typing is required: click **Detect public seeds** and the steward node detects this machine's public
address, scans active local mesh nodes and field peers, excludes loopback/LAN/websocket addresses,
checks TCP reachability, ranks the strongest live seeds first, and enables download only when at least
one seed is ready. The downloaded file promotes the highest-ranked reachable seed first and marks the
remaining reachable seeds as master candidates. This is useful when a founder wallet is operating from
the Console instead of the command line.

If TCP is blocked, ZIRA keeps the node online for local/outbound participation but does not auto-export
that address as a public seed. That prevents new users from downloading a registry full of dead peers.

As the network grows, keep the same URL but promote several reliable public peers into it:

```powershell
pnpm prepare:bootstrap-upload `
  -Seed "/ip4/<seed-a-ip>/tcp/9645/p2p/<peerIdA>" `
  -Seed "/ip4/<seed-b-ip>/tcp/9645/p2p/<peerIdB>" `
  -Roles "master,bootstrap,community-seed"
```

Founder signatures make the registry tamper-evident. Seed roles make clean nodes dial master/master
candidate peers first, then community seeds. After first contact, each node caches successful peers so
later restarts do not depend on a single seed.

## Public bootstrap reachability

For far-away users, a peer ID is not enough. Publish a full public multiaddr and make the port
reachable:

```bash
ZIRA_NETWORK=mainnet \
ZIRA_ANNOUNCE=/ip4/<public-ip>/tcp/9645 \
node node/dist/index.js
```

Open or forward TCP `9645` to the node. Then copy the full address from Settings, Peers, or
`GET /rpc/net`; it should look like `/ip4/<public-ip>/tcp/9645/p2p/<peerId>`. Seed operators should
publish this address through `pnpm seed:bootstrap-registry` so new users do not have to copy it
manually. Keep RPC private unless you intentionally expose it with an admin token.

Windows Firewall can be opened automatically by `pnpm open:node-ports` or by the Windows launch
wrappers. Router forwarding is attempted automatically by `pnpm open:public-node-ports` through direct
UPnP IGD discovery and NAT-PMP, similar to other P2P clients. If the router disables these protocols,
the ISP uses CGNAT, or the router refuses hairpin checks, manual router forwarding or a public VPS seed
can still be required. Forward TCP `9645` to the PC running ZIRA. If you launch the local four-node
mesh and want every role to be a public seed, also forward TCP `9745`, `9845`, and `9945`.
`pnpm check:public-bootstrap` is the source of truth for whether the outside world can actually reach
the node.

To refresh the signed registry after a reachable public seed is running, either use the upload helper
above or call the lower-level generator directly:

```bash
pnpm seed:bootstrap-registry --seed=/ip4/<public-ip>/tcp/9645/p2p/<peerId> --output=local-private/bootstrap-seeds.wordpress-upload.json
```

The command signs `docs/bootstrap-seeds.json` with a launch-authority key and refuses to update the
registry if the TCP check fails, unless you pass `--allow-unreachable` after an outside-network check.

## Earn by serving the field

Mining is off until the operator enables it. To mine through a configured endpoint, set:

```bash
ZIRA_MINE=1 \
ZIRA_PROVIDE=1 \
ZIRA_PROVIDE_ENDPOINT=http://localhost:11434/v1 \
ZIRA_PROVIDE_MODEL=qwen2.5-coder:14b \
ZIRA_PROVIDE_DOMAINS=general,code \
node node/dist/index.js
```

For native engine mining, keep `ZIRA_PROVIDE` off and tune hardware with `ZIRA_GPU_LAYERS`,
`ZIRA_THREADS`, or the Mine page's recommendation/maximum controls.

Storage is separate from mining. With the default `ZIRA_STORAGE=1` and `ZIRA_STORAGE_GB=1`, a node can
help distribute verified model chunks without answering AI queries or storing unlimited data. Raise
`ZIRA_STORAGE_GB` only when you want this machine to carry more of the decentralized model field.

## Configuration (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `ZIRA_NETWORK` | `devnet` | `devnet`, `testnet`, or `mainnet` |
| `ZIRA_DATA_DIR` | `~/.zira/<network>` | where the ledger, snapshot, and identities live |
| `ZIRA_RPC_PORT` | `8645` | HTTP and WebSocket for the Console |
| `ZIRA_RPC_HOST` | `127.0.0.1` | bind address for the RPC (set `0.0.0.0` to serve others) |
| `ZIRA_P2P_PORT` | `9645` | libp2p TCP |
| `ZIRA_WS_PORT` | `9646` | libp2p WebSocket (for browser light peers and cross host) |
| `ZIRA_BOOTSTRAP` | empty | comma separated peer multiaddrs to dial on start |
| `ZIRA_BOOTSTRAP_AUTO` | `1` | load signed cached/remote/bundled bootstrap registries automatically |
| `ZIRA_BOOTSTRAP_REGISTRY_URL` | `https://zira.network/bootstrap-seeds.json` on mainnet | HTTPS JSON registry URL to fetch before bundled fallback |
| `ZIRA_BOOTSTRAP_REGISTRY_PATH` | unset | optional local registry file for tests or private deployments |
| `ZIRA_BOOTSTRAP_REQUIRE_SIGNATURE` | `1` on mainnet | reject registries not signed by a launch-authority founder |
| `ZIRA_ANNOUNCE` | empty | public multiaddrs to advertise if behind NAT or on a known host |
| `ZIRA_SERVE_CONSOLE` | `1` | serve the staged Console at the RPC root |
| `ZIRA_MINE` | `0` | enable mining/work serving for this node |
| `ZIRA_STORAGE` | `1` | enable P2P model/storage bytes |
| `ZIRA_STORAGE_GB` | `1` | local storage cap in GB |
| `ZIRA_LOCAL_TASKS` | `0` | allow workspace-style routed tasks when mining is enabled |
| `ZIRA_GPU_LAYERS` | detected | native GGUF GPU offload layers |
| `ZIRA_THREADS` | detected | native GGUF CPU threads |
| `ZIRA_USE_RECOMMENDED_HARDWARE` | `1` | let hardware detection apply recommended mining settings |
| `ZIRA_PROVIDE` | `0` | enable endpoint-backed answer provider mode |
| `ZIRA_PROVIDE_ENDPOINT` | unset | OpenAI-compatible endpoint for provider mode |
| `ZIRA_PROVIDE_MODEL` | default | model name served by the endpoint |
| `ZIRA_PROVIDE_DOMAINS` | empty | comma separated answer domains |
| `ZIRA_STEWARD` | unset | devnet only: use the well known steward key as this node's identity |
| `ZIRA_SEED` | unset | devnet only: post simulated observations so Locks form |
| `ZIRA_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |

## Run a local two node testnet

```bash
node scripts/run-testnet.mjs
```

Node A is the steward and seeds the field. Node B bootstraps to A. Open both Consoles
(`http://127.0.0.1:8645` and `http://127.0.0.1:8745`) and watch them stay in sync over libp2p.

## Becoming a bootstrap or master node

- A bootstrap node is just a node with a stable identity and a reachable address. Publish its multiaddr
  (`/ip4/<public-ip>/tcp/9645/p2p/<peerId>` now, or `/dns4/your.host/tcp/9645/p2p/<peerId>` later)
  through the signed WordPress registry so others discover it automatically. The peer id is printed on
  start and persisted in the data dir.
- As reliable miners/peers appear, add several of them to the signed registry with priorities and
  regions/roles (`master`, `master-candidate`, `bootstrap`, `community-seed`). New users then dial
  multiple seeds, fast sync from whichever answers first, and cache the healthy peers. This turns the
  first seed into a seed set rather than a single point of failure.
- A master node is any node whose ZTI reaches 0.70 by serving the field accurately over time. Master
  nodes sign checkpoints and provide finality. You do not buy this, you earn it.
