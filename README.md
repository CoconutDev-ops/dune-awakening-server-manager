# Dune: Awakening — Server Manager

> [!CAUTION]
> **This is an experimental assistant dashboard.** I am not associated with Funcom or the Dune: Awakening team and cannot guarantee this will work perfectly for you. Always take backups. This works for me and I thought the community might find it helpful. I ran this myself including the server setup and played on it no problem. I hope you experience the same.

A local web-based UI for managing **Dune: Awakening Self-Hosted Servers**. Replaces the clunky `battlegroup.bat` terminal menu with a clean, modern dashboard that handles everything from first-time setup to daily operations and game configuration.

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?logo=nodedotjs&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-blue)

![Dashboard](docs/screenshots/dashboard.png)

---

### Table of Contents

- [Features](#features)
- [Prerequisites](#prerequisites)
- [Quick Start](#quick-start)
- [Setup Wizard](#setup-wizard)
- [Tabs](#tabs)
  - [Dashboard](#dashboard)
  - [Battlegroup](#battlegroup)
  - [Monitoring](#monitoring)
  - [Database](#database)
  - [Characters](#characters)
  - [Game Config](#game-config)
  - [Settings](#settings)
  - [Experimental](#experimental)
- [How It Works](#how-it-works)
- [Project Structure](#project-structure)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)
- [Ports](#ports)
- [License](#license)

---

## Features

- **Setup Wizard** — Guided 6-step first-time installation (VM import, network, SSH, bootstrap — no bat file needed)
- **Dashboard** — VM status, memory, uptime, IP, and battlegroup health at a glance
- **Battlegroup Controls** — Start, stop, restart, and update with one click
- **Character Editor** — Edit stats (health, tech points, hydration, spice, Eyes of Ibad) and manage inventory with a searchable 1,127-entry catalog; 105 confirmed augment templates and 22 clearly marked current-package-only candidates support native online attempts, while three reviewed database shapes support guarded offline Backpack creation
- **Game Config** — Edit PvP, sandstorms, sandworm behavior, mining rates, decay, building limits, and more through a visual editor
- **Monitoring** — Direct links to the File Browser and Director web interfaces
- **Database** — Take and import backups
- **Log Export** — Download battlegroup and operator logs
- **Settings** — Change VM password, rotate SSH keys, enable swap memory
- **Live Console** — Real-time command output streamed to the browser via WebSocket

## Prerequisites

Before using this tool, you need the following installed and ready:

1. **Windows 10/11 Pro** with hardware virtualization enabled in BIOS
2. **Hyper-V** enabled (Settings → Apps → Optional Features → More Windows Features → Hyper-V)
3. **Dune: Awakening Self-Hosted Server** downloaded via Steam (search "Dune Awakening Self-Hosted Server" in your Steam library under Tools)
4. **Node.js 18+** — [download here](https://nodejs.org) (LTS recommended)
5. **OpenSSH Client** — included with Windows 10/11 by default (verify: run `ssh` in a command prompt)
6. **A server token** from [account.duneawakening.com](https://account.duneawakening.com/)

The app assumes the default Steam install path:

```
C:\Program Files (x86)\Steam\steamapps\common\Dune Awakening Self-Hosted Server\
```

If yours differs, edit `DEFAULT_SERVER_PATH` at the top of `server.js`.

## Quick Start

1. **Clone** this repo anywhere on your server machine:

   ```
   git clone https://github.com/YOUR_USER/dune-server-manager.git
   cd dune-server-manager
   ```

2. **Double-click `start_as_admin.bat`** in Windows Explorer.

   It will:
   - Request **Administrator** privileges (UAC prompt) — required for Hyper-V
   - Install npm dependencies automatically on first run
   - Open `http://localhost:3000` in your default browser

3. If this is a **fresh install**, click the **Setup** tab and follow the wizard. If you've already run the official `battlegroup.bat` initial-setup before, go straight to the **Dashboard**.

> [!IMPORTANT]
> **The app must run as Administrator.** Hyper-V commands require elevated privileges. If you see permission errors, the Node process is not running as admin.
>
> - **Use `start_as_admin.bat`** — it auto-elevates via UAC.
> - Or open an **Administrator Command Prompt / PowerShell**, `cd` into the project folder, and run `npm start`.
> - **Do not run from WSL** — WSL cannot elevate to Windows admin for Hyper-V operations.

## Setup Wizard

The **Setup** tab provides a guided walkthrough that replaces the entire `battlegroup.bat → initial-setup` flow:

![Setup Wizard](docs/screenshots/setup-wizard.png)

| Step | What happens |
|------|-------------|
| **1. Pre-flight** | Verifies Hyper-V is enabled, server files (`.vmcx`) are present, and a drive has 100GB+ free |
| **2. Configuration** | Enter your server token, choose install drive, VM memory (10–40 GB), network mode, and NIC |
| **3. Installing** | Imports the VM, creates the network switch, resizes the virtual disk, sets memory, and starts the VM — progress streams live |
| **4. Security** | Generates and installs an SSH key, then sets a new password for the `dune` user |
| **5. Networking** | DHCP vs static IP, auto-detects your public IP, lets you pick the player-facing IP |
| **6. Finalize** | Enter your world name and region, upload bootstrap files, run first-time battlegroup setup, optional swap memory |

After setup, flip to the **Dashboard** to start your battlegroup.

## Tabs

### Dashboard

Live overview of your VM and battlegroup with one-click controls.

![Dashboard](docs/screenshots/dashboard.png)

### Battlegroup

Start, stop, restart, check for updates, and enable swap memory.

![Battlegroup](docs/screenshots/battlegroup.png)

### Monitoring

Quick access to the VM's built-in File Browser and Director interfaces, plus log exports.

![Monitoring](docs/screenshots/monitoring.png)

The **File Browser** lets you browse config files, logs, database dumps, and UserSettings directly:

![File Browser](docs/screenshots/file-browser.png)

The **Director** shows live battlegroup stats, player counts, character transfer settings, and per-server details:

![Director](docs/screenshots/director.png)

### Database

Back up and restore the battlegroup database. Stop the battlegroup first for best results.

![Database](docs/screenshots/database.png)

### Characters

The character page has two deliberately separate paths. **Online Actions** send typed, allowlisted commands through the running game's native Version 2 notification channel; the selected character must be fully online. Available actions are additive XP, unspent skill points, reviewed individual skill modules, items from the 1,127-entry combined catalog, three reviewed bulk training actions, and a bulk grant of exactly one of each metadata-confirmed augment. The item set includes 105 metadata-confirmed augment base templates plus 22 clearly marked current-package-only candidates. The bulk augment button validates an exact 105-ID confirmed subset server-side and queues one native `AddItemToInventory` command per template; it deliberately excludes all 22 package-only candidates, which remain individual experimental actions requiring their existing warning. Recipe, schematic, asset-only, partial, and typo strings are deliberately excluded. The bulk actions expand server-side into fixed native messages rather than relying on retail-incompatible `CheatScript` commands. Messages are paced about 300 ms apart, and success requires an exact broker count; an ambiguous result is never retried automatically. Broker acceptance means the actions were queued, not that the client has applied them, so verify the result in-game and check nearby ground for inventory overflow.

Online Actions also includes additive **carried Solari**. It queues the fixed `SolarisCoin` template through the same live `AddItemToInventory` command as working item grants; check the character's inventory or nearby ground to confirm delivery. The separate Economy editor changes the saved virtual-wallet balance and remains an offline database operation.

The individual module picker is pinned to 145 observed skill and ability modules, including each module's reviewed maximum level. Its catalog was imported from the persisted-player-derived `admin-skill-modules.json` in `snapetech/DuneAwakeningSelfHost`; the backend enforces the exact ID and per-module maximum rather than accepting typed module names.

The remaining controls are **direct database edits**. Stop the battlegroup and have the player logged out before using those controls. Current game builds can leave a stopped character labelled `LoggingOut` with its previous `server_id`; guarded offline workflows treat that label as stale only when the ID is null or no longer exists in `active_server_ids`. A non-offline label that still matches an active server remains blocked by those guarded workflows.

Edit player stats and inventory directly in the game database. **Stop the battlegroup and have the player logged out before editing.** The combined picker contains **1,127 entries**: 1,000 standard entries, 105 metadata-confirmed augment base templates, and 22 current-package-only experimental candidates. Augments never use the generic raw Add Item route. The dedicated **Create Offline** action remains restricted to the three templates whose standalone database shapes have been reviewed; it targets the selected character's single Backpack, creates one item in the lowest free slot, creates a verified backup, locks and rechecks ownership/capacity, and verifies the exact inserted row before commit.

The Online Actions Give Item picker and offline Add Item search include all 105 confirmed templates and 22 package-only candidates under **Augments**. Native online grant is preferred because the running game creates the item and its correct roll structure. Augment grants are fixed to quantity 1; package-only candidates require an additional warning and may be ignored or unfinished. Only Heavy Caliber Upgrade, House Heavy Caliber Upgrade, and Barrel Extender expose **Create Offline**: Heavy Caliber uses a loose persisted-item seed, while the other two use reviewed installed-item-derived seeds and are marked experimental. After offline creation, keep the battlegroup stopped and the character logged out and use **Max + Grade 5** on the new standalone item.

| Template | Name | Applies to | Reviewed effect ranges |
|---|---|---|---|
| `T6_Augment_Damage1` | Heavy Caliber Upgrade | Any ranged weapon | Ranged Damage: G1 +2–8%, G2 +9–15%, G3 +18–26%, G4 +28–44%, G5 +48–70% |
| `T6_Augment_Damage2` | House Heavy Caliber Upgrade | Any ranged weapon | Ranged Damage: G1 +8–10%, G2 +9–15%, G3 +18–26%, G4 +28–44%, G5 +48–70% theoretical; local metadata marks it non-gradeable, so forced G5 still needs in-game verification |
| `T6_Augment_Range1` | Barrel Extender | Any ranged weapon | Effective Range and Maximum Range: G1 +2–5%, G2 +6–10%, G3 +11–15%, G4 +17–20%, G5 +22–25% |

Eligible standalone augment rows show their current grade and a **Max + Grade 5** action. It safely raises every positive numeric roll to the confirmed maximum `1.003398`, preserves non-positive sentinels and non-numeric entries, and sets `quality_level` to 5. **Max All Supported Augments + Grade 5** applies the same operation only to supported standalone augments in the selected character's owned inventories; it never uses a world-wide or hard-coded inventory scope. The manager validates the selected item before backup, creates a verified database backup, confirms the battlegroup is fully stopped and the character has no active game-server session on both sides of that backup, then locks and verifies the targeted rows inside one transaction.

Augments already installed into a weapon or other equipment are represented under `FAugmentedItemStats`, not the standalone `FAugmentItemStats.StatRolls` array handled here. They are intentionally left unchanged until a separate slot-aware editor is implemented.

![Character Editor](docs/screenshots/character-editor.png)

Search for any item by display name **or template ID** (e.g. `TreadwheelChassis_5`, `Patent`), filter by category, and add it to a character's inventory:

![Add Items](docs/screenshots/character-editor-items.png)

> [!WARNING]
> Editing characters directly modifies the game database. This may corrupt save data and cause total character loss. Always take a database backup first.

| Section | What you can edit |
|---------|------------------|
| **Online Actions** | Live XP, skill points, reviewed skill modules, fixed reviewed bulk training actions, catalogued items, one of every confirmed augment, and carried Solari through the game-native item channel |
| **Stats** | Max Health, Tech Knowledge Points, Hydration, Heat Exhaustion, Spice, Addiction Level, Tolerance, Eyes of Ibad |
| **Inventory** | View all items and grades, max an eligible standalone augment plus set Grade 5, remove items, search 105 confirmed augments plus 22 package-only candidates, or create one of the three reviewed database shapes through the guarded offline Backpack workflow; native Online Actions grant remains preferred |
| **Augment Attributes** | Backup-first maximum positive rolls plus Grade 5 for supported standalone augment items in the selected character's owned inventories; installed augments are intentionally excluded |
| **Stack limits** | Equipment (weapons/armor/tools) enforced at 1, resources at 100, consumables at 20 — warns before exceeding |
| **Tech Tree** | Safely unlock the game-created fabrication and blueprint entries already present in the character save; guessed pak-only nodes are never injected |
| **Specializations** | Set level and XP for Combat, Crafting, Exploration, Gathering, Sabotage, or max all tracks to level 100 / 44,182 XP and unlock all 205 keystones using the player-controller record |
| **Economy** | Set Solari and House Scrip balances |
| **Faction Reputation** | Set reputation with Atreides, Harkonnen, and Smuggler factions |
| **Cosmetics & Skins** | Searchable reviewed catalog of **391** customization IDs observed in persisted player data — exact Add/Remove or backup-first bulk unlock; inventory swatch tokens are excluded |

Tech tree, specializations, economy, and faction reputation:

![Character Unlocks](docs/screenshots/character-unlocks.png)

Cosmetics and skins — searchable list with Add/Remove toggle and bulk unlock:

![Cosmetics](docs/screenshots/character-cosmetics.png)

> **Patents vs skins:** Building/furniture vendor packs are **Patent** items in inventory (search `furniture` or `CHOAM`). Weapon, armor, and vehicle looks are **cosmetics** — use the Cosmetics section above, not the item catalog. **Unlock All Recipes** only covers the fabrication tech tree.

### Game Config

Visual editor for all gameplay settings. **Stop the battlegroup before editing** — changes apply on next start.

![Game Config](docs/screenshots/game-config.png)

Available settings:

| Category | Settings |
|----------|----------|
| **PvP & Security** | Force PvP on all partitions, security zones |
| **Environment** | Coriolis storms, sandstorms, sandstorm treasure |
| **Sandworm** | Enable/disable, danger zones, vehicle collision, invulnerability timers |
| **Economy & Resources** | Mining multipliers, PvP resource multiplier, item decay rate, vehicle durability |
| **Building** | Max landclaims, blueprint extensions, base backup extensions, restriction limits |
| **Server** | Display name, login password, game port, IGW port |

### Settings

Change the VM password and rotate SSH keys.

![Settings](docs/screenshots/settings.png)

### Experimental

> [!WARNING]
> Features on this tab are untested and may break your battlegroup. Always take a database backup before making changes.

**Multi-Sietch** allows you to add additional Hagga Basin instances (sietches) to your battlegroup. All sietches share the same Overmap, Deep Desert, Arrakeen, Harkonnen Village, and instanced content (dungeons, story missions). Players from different sietches will see each other in shared areas but not in their respective Hagga Basin maps.

| Sietches | Estimated RAM |
|----------|--------------|
| 1 (default) | ~18 GB |
| 2 | ~30 GB |
| 3 | ~42 GB |

Each sietch requires approximately **12 GB RAM**. The Overmap and infrastructure (database, RabbitMQ, Kubernetes) use an additional ~6 GB on top of that.

**Port forwarding:** Each additional sietch adds a game server pod using host networking. When in doubt, forward **UDP 7777–7900** to your VM to cover any additional game server ports.

After adding or removing a sietch, **restart the battlegroup** for changes to take effect.

## How It Works

The app is a lightweight Node.js server that:

1. Calls **PowerShell** for Hyper-V operations (start/stop VM, query status, import, configure)
2. Uses **SSH** to communicate with the VM for battlegroup commands (same key and mechanism as the official scripts)
3. Reads and writes **INI config files** on the VM for game settings
4. Queries the **PostgreSQL** database via `kubectl exec` for character editing
5. Publishes allowlisted live player actions through the running `mq-game` RabbitMQ pod
6. Serves a static web UI that talks to the REST API and receives real-time output over WebSocket

No data leaves your machine. The manager listens only on `127.0.0.1:3000` and rejects non-local HTTP and WebSocket hosts.

## Project Structure

```
├── server.js              # Express + WebSocket server, all API routes
├── lib/
│   ├── powershell.js      # PowerShell execution wrapper
│   └── ssh.js             # SSH execution wrapper (with timeout + TTY support)
├── public/
│   ├── index.html         # UI (dashboard, setup wizard, game config, character editor, all tabs)
│   ├── css/style.css      # Dune-themed dark UI
│   ├── js/app.js          # Frontend logic (tabs, wizard, config editor, character editor, API calls)
│   └── data/
│       ├── item-catalog.json      # 1,003 base entries (including 3 database-observed augments)
│       ├── augment-catalog.json   # 105 metadata-confirmed + 22 package-only augment candidates
│       ├── cosmetic-catalog.json  # 391 reviewed persisted cosmetic IDs
│       └── stat-reference.json    # Character stat keys and inventory type mapping
├── scripts/
│   └── build-cosmetic-catalog.py  # Regenerate cosmetic-catalog.json from game paks
├── tools/
│   └── Cue4ParsePatents/          # CUE4Parse scanner for item/patent/module IDs in game files
├── start_as_admin.bat     # One-click Windows launcher (auto-elevates to admin)
├── docs/screenshots/      # README screenshots
└── package.json
```

## Configuration

| Setting | Default | Where to change |
|---------|---------|----------------|
| Server install path | `C:\Program Files (x86)\Steam\steamapps\common\Dune Awakening Self-Hosted Server\` | `DEFAULT_SERVER_PATH` in `server.js` |
| SSH key path | `%LOCALAPPDATA%\DuneAwakeningServer\sshKey` | `getKeyPath()` in `lib/ssh.js` |
| VM name | `dune-awakening` | `VM_NAME` in `server.js` |
| Web UI port | `3000` | `PORT` in `server.js` or `PORT` env variable |
| Server-command token | Official self-host default | Optional `DUNE_SERVER_COMMANDS_AUTH_TOKEN` environment override; never returned by the API |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| _"You do not have the required permission"_ | Run the app as **Administrator** (use `start_as_admin.bat` or an admin terminal) |
| _"Cannot find module 'express'"_ | Dependencies weren't installed. Run `npm install` in the project folder, then try again |
| _"running scripts is disabled on this system"_ | PowerShell execution policy is blocking npm. Open PowerShell as Admin and run: `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` |
| _"EADDRINUSE: address already in use :::3000"_ | Another process is on port 3000. Kill it or set a different port: `set PORT=3001 && npm start` |
| _"Node.js is required but not found"_ | Install Node.js 18+ from [nodejs.org](https://nodejs.org) and restart your terminal |
| Battlegroup says "Starting" then nothing | Check the console output — it may be a timeout or SSH issue. Make sure the VM is fully booted and SSH is reachable. The battlegroup can take several minutes to start on first boot |
| Battlegroup shows as inactive despite VM running | The battlegroup may not have been started yet — click Start and wait. If it was recently started, the game servers take a few minutes to reach "Running" state |
| SSH connection failures | Make sure the VM is running and you've completed initial setup (the SSH key is generated in step 4) |
| _"No .vmcx file found"_ | Verify the Dune Awakening Self-Hosted Server is installed in Steam and the path is correct |
| VM fails to start with memory error | Your system doesn't have enough free RAM. Lower the memory allocation and enable swap memory |
| _"No battlegroup found"_ on start | The initial setup didn't complete. Re-run the setup wizard or use `battlegroup.bat → initial-setup` |
| Database stuck on "Modifying" after first start | The app auto-detects and fixes this (placeholder image tags). If it persists, restart the battlegroup — the app will patch the Kubernetes CRD with the correct image versions on the next start |
| Server not in finder / 0 ping | Set visibility to your **public IP** in Game Config, forward **TCP 31982**, **Director NodePort**, and **UDP 7777–7810** to the **VM IP**, then **stop and start** the battlegroup. Look under **Servers → Experimental** in-game (not Official/Private). |
| Server visible in browser but players can't connect | Make sure **Server Visibility** is set to your public IP (not a private/LAN IP), the battlegroup was **stopped and started** after changing it, and the required ports are forwarded on your router to the VM (see Game Config port-forward panel) |
| Visibility IP reverts to LAN after applying | Update the app — this was a bug in older versions where `settings.conf` wasn't being read correctly |

## Ports

If players outside your LAN need to connect, forward these on your router **to your VM's IP address** (not your Windows host IP):

| Port | Protocol | Purpose |
|------|----------|---------|
| 7777–7800 | UDP | Game server traffic |
| Director NodePort | TCP | Client matchmaking (check `kubectl get svc -A` for the actual port — it's randomized by Kubernetes, typically 30000–32767) |

> [!TIP]
> To find the Director NodePort, look at the Dashboard — it's shown in the Quick Links section. You can also SSH into the VM and run:
> ```
> sudo kubectl get svc -A | grep bgd-svc
> ```
> The number after `11717:` (e.g. `11717:31642`) is the NodePort to forward.

The web UI itself (`localhost:3000`) does **not** need to be exposed — it's for local management only.

## License

MIT
