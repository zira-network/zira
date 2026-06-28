# The ZIRA desktop app

The desktop app is the full experience: it runs a complete ZIRA Core node in the background and opens
the Console in its own window. It is the miner app, so running a model on your CPU or GPU happens
here. There is no separate server to run.

## Run it from source

```bash
pnpm install
pwsh scripts/build-all.ps1           # Windows: build protocol, node, console; stage GUI into node
# or: bash scripts/build-all.sh      # macOS/Linux
pnpm --filter @zira/desktop start    # opens the ZIRA window
```

## Build the executable

```bash
pwsh scripts/build-all.ps1
pnpm --filter @zira/desktop dist:win     # full installer (Windows)
pnpm --filter @zira/desktop dist:linux   # Ubuntu/Linux AppImage
```

Where the build lands (Windows):

- **Runnable app folder:** `apps/desktop/dist-refined/win-unpacked/ZIRA.exe` when built with the launch command below.
- **Windows installer:** `apps/desktop/dist-refined/ZIRA Setup 1.0.0.exe`
- **Ubuntu AppImage:** `apps/desktop/dist-ubuntu/ZIRA-1.0.0.AppImage` when built on Linux/WSL.

For macOS use `dist:mac` on macOS (a dmg).

After building, assemble the clean GitHub launch folder:

```powershell
pwsh scripts/prepare-launch.ps1
```

This creates `..\gui\source\` and `..\gui\release\` from this working folder.

For the final Windows installer used by `prepare-launch.ps1`, run:

```powershell
pnpm --filter @zira/desktop exec electron-builder --win --config.directories.output=dist-refined
```

For Ubuntu, build on Linux or WSL:

```bash
pnpm --filter @zira/desktop exec electron-builder --linux --config.directories.output=dist-ubuntu
```

### Note on the installer on Windows

electron-builder's code signing toolkit unpacks symlinks, which Windows blocks unless you have
admin rights or Developer Mode turned on. If `dist:win` fails on that step, either turn on Developer
Mode (Settings, Privacy and security, For developers) and retry, or use `dist:dir`, which produces a
fully runnable `win-unpacked/ZIRA.exe` without the installer.

## What it does on launch

1. Starts a ZIRA Core node in the background (using the app's bundled runtime, no Node install needed).
2. Waits for the node, then opens the Console window pointed at it.
3. On devnet it runs as the genesis steward and seeds the field, so you can explore immediately.

The app stores its data under your user profile (`%APPDATA%/ZIRA/zira-data` on Windows).

## Mining

You do not pick a provider endpoint or paste a model link as a regular user. Open the Mine tab and
switch mining on. The node detects CPU, RAM, GPUs, VRAM, recommended GPU layers, CPU threads, and an
adaptive mining mode. Strong GPUs answer more field work; lighter machines still relay, observe,
sync, and help coordination.

Model provision lives behind launch-authority controls. An authorized steward adds signed GGUF links
and publishes recommendations. The field distributes authorized models across available storage
addresses and peers.

## Models

Only active launch authority adds models, and only by link. In the Mine tab an authorized steward
pastes a GGUF URL (for example a Hugging Face download link); the node fetches it once to hash and
sign it, then the field distributes it peer to peer with the link as a fallback source. Every node
verifies a model is signed by active launch authority before accepting it, so the field stays curated.
Miners run whatever the field policy recommends, and ZIRA coordinates answers with trust weighting
and signed receipts. The work you do answering the field is what earns ZIR and secures the network.
