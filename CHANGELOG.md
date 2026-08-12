# Changelog

## Stale offline presence handling - 2026-08-11

- **Stopped characters no longer blocked by stale labels** - Offline database actions now accept a raw `LoggingOut` or other stale status when `server_id` is null or has no matching row in `active_server_ids`. This matches the game's effective-offline behaviour after a hard battlegroup or VM stop.
- **Active sessions remain blocked** - The existing strict stopped-battlegroup parse is unchanged. Guarded offline workflows require exactly one player-state row and a valid controller during preflight, then lock that row and repeat the same active-server predicate inside their transaction. Missing, ambiguous, or non-offline state attached to an active server still fails closed; `farm_state` is not used for offline safety.

## Bulk online augment grant — 2026-08-11

- **One of every confirmed augment** — Added an Online Actions button that queues exactly one native `AddItemToInventory` grant for each of the 105 metadata-confirmed augment templates while the selected character is fully online.
- **Strict reviewed boundary** — The backend derives the batch only from the augment catalog, requires exactly 105 unique non-package-only IDs, fixes quantity and durability to 1, and excludes all 22 package-only experimental candidates. Those remain available only as individual warned grants.
- **Safe bulk delivery** — Reuses the per-character action lock, online identity checks, base64/SSH RabbitMQ publisher, ~300 ms pacing, and exact broker receipt. Ambiguous delivery is never retried automatically, and the UI reports queued/broker accepted rather than claiming the game applied the items.

## Reviewed augment creation — 2026-08-11

- **Expanded augment catalog** — Added 105 grantable base templates from game-derived item metadata and checked them against the installed July 23 `Systems.pak`. The 14 former `T6_Augment_Ch5_*` entries use their current `T6_Augment_B1C4_*` identifiers. A further 22 Polar-cap/cold/volume IDs found as current 1.4 item-name candidates are included as clearly marked package-only experiments with an additional confirmation. Recipe/schematic, asset-only, partial, and typo strings remain excluded. Online augment grants are fixed to quantity 1, bringing the merged picker to 1,127 entries.
- **Three offline-reviewed templates** — `T6_Augment_Damage1` (Heavy Caliber Upgrade), `T6_Augment_Damage2` (House Heavy Caliber Upgrade), and `T6_Augment_Range1` (Barrel Extender) remain the only guarded offline creation choices because their standalone shapes have database evidence.
- **Dedicated offline creation** — The three augments now appear as special **Create Offline** rows in Add Item. The backend accepts only the exact allowlist and quantity 1, requires a stopped battlegroup and Offline character before and after a verified backup, targets exactly one pawn-owned Backpack, locks and validates its rows and positions, inserts into the lowest free slot, and performs an exact readback before commit. The generic raw Add Item route still rejects augments.
- **Reviewed shape boundary** — Heavy Caliber Upgrade uses a loose-item seed observed in the database. House Heavy Caliber Upgrade and Barrel Extender use reviewed installed-item-derived seeds and are clearly marked experimental; native Online Actions grant remains preferred. House Heavy Caliber Upgrade is marked non-gradeable in local game-derived metadata, so forced Grade 5 requires in-game verification.
- **Effects documented** — Added the reviewed damage/range grade bands to the Characters documentation and player-facing catalog names/effect summaries.

## Augment attributes — 2026-08-10

- **Per-item augment action** — Eligible standalone augment rows now show grade, positive numeric roll count, and a **Max + Grade 5** button. The action sets positive numeric `FAugmentItemStats.StatRolls` values to `1.003398`, preserves non-positive and non-numeric entries, and sets `quality_level` to 5.
- **Selected-character Max All** — The bulk action now applies the same roll and Grade 5 changes only to supported standalone augment templates in the selected character's owned inventories. It does not use hard-coded inventory IDs or touch world-wide rows.
- **Transaction safety** — Per-item changes preflight exact ownership and eligibility before creating a backup, then require a fully stopped battlegroup and Offline character again after backup. The transaction locks the exact item and inventory, rechecks ownership/template/JSON shape, and verifies exact rolls, grade, and affected row counts before commit. Bulk changes use the same stopped/offline, pawn-scope, lock, and readback rules.
- **Installed augment boundary** — Augments already installed into equipment move to `FAugmentedItemStats` and are intentionally excluded from this standalone-item workflow pending a separate slot-aware editor.

## Online actions — 2026-08-09

- **Native live actions** — Added allowlisted XP, skill-point, reviewed skill-module, reviewed item, and safe training-script actions through the game's Version 2 notification channel. Targets must be fully Online and attached to a game server. Broker acceptance is reported as queued, not as proof the client applied it.
- **Live Solari delivery** — Online Solari now sends the fixed, game-native `SolarisCoin` item through `AddItemToInventory`. The previous virtual-wallet database function updated PostgreSQL but did not notify an already-running game session, so the client could show no change until later reconciliation.
- **Reliable bulk training** — Replaced the retail-incompatible bulk `CheatScript` calls with fixed server-built batches of native XP and module-level commands. The manager sends them about 300 ms apart in one broker operation, verifies the exact queued count, excludes Hidden modules and `Skills.Ability.VoiceStop`, and never automatically retries an ambiguous result.
- **Web security** — The manager now listens only on `127.0.0.1` and rejects non-local HTTP and WebSocket hosts.

## Local safety repair — 2026-08-09

- **Tech tree** — Removed the unsafe 356-node pak-catalog injection. Unlock All now marks only game-created save entries as purchased, preserves the separate known-recipes collection, caps Intel at 2,779, requires the battlegroup stopped/player offline, and creates a backup first.
- **Specializations** — Uses `player_controller_id`, validates the real XP/level range, and adds a backup-first Max All action (44,182 XP, level 100, all 205 keystones). It also removes junk rows written under the pawn ID by older versions.
- **Cosmetics** — Replaced pak-string guesses with 391 customization IDs observed in live persisted player data. Add/remove is catalog-confined and idempotent; bulk unlock preserves existing entries and creates a backup first.
- **Database writes** — PostgreSQL mutations now stop on the first SQL error instead of continuing after a failed statement.
- **Offline currency editor** — Solari and House Scrip balance changes now enforce the stopped/offline contract on the server, create a safety backup, lock and recheck the player, validate bounded currency values, and verify the committed balance.

## 1.0.7 — 2026-06-02

### SSH — fix false "SSH exited with code 1" on battlegroup commands

- **Root cause** — Interactive SSH (`-tt`) was spawned with stdin closed. OpenSSH exits code 1 with no output in that case, so status/start/stop looked broken even when the VM was fine.
- **`lib/ssh.js`** — Pipe stdin when a pseudo-TTY is requested; treat PTY sessions with stdout as success when stderr is only "Connection closed".

## 1.0.6 — 2026-06-02

### SSH key path — fix battlegroup failure after reboot (WSL)

- **Root cause** — When the manager runs from WSL, `LOCALAPPDATA` is unset. SSH was given a relative path (`AppData/Local/DuneAwakeningServer/sshKey`) instead of the real key at `C:\Users\<you>\AppData\Local\DuneAwakeningServer\sshKey`.
- **`lib/paths.js`** — Resolves Windows `LOCALAPPDATA` via PowerShell when env vars are missing; mirrors the key into `~/.dune-awakening-server-manager/sshKey` with `0600` permissions for WSL OpenSSH.
- **Status / battlegroup** — `/api/status` reports `ssh.keyPresent`; battlegroup routes fail fast with a clear message; dashboard shows an SSH key warning banner.

## 1.0.5 — 2026-06-02

### Start VM — fix silent failure on low host RAM

- **Root cause** — Dashboard **Start VM** called Hyper-V with the VM's configured startup RAM (often 30 GB). When the Windows host couldn't allocate that much, Hyper-V returned `OutOfMemory` / `0x8007000E`. The error only appeared in the collapsed console, so it looked like nothing happened.
- **`lib/vm.js`** — Shared `startVm()` helper with automatic memory step-down (40→32→30→24→20→18→16→14→12 GB) when the host is low on RAM, plus clearer error messages.
- **`POST /api/vm/start`** — Uses `startVm()`; accepts optional `{ memoryGB }` for manual retry; returns HTTP 507 with `startFailed: true` on OOM.
- **Dashboard UI** — Shows an alert on failure, auto-expands the console, and displays a **Retry Start** panel with a memory selector when start fails.
- **Status** — VM card shows configured startup memory when the VM is off.
- **Setup import** — Also uses auto step-down on first start.

## 1.0.4 — 2026-06-02

### Tech tree — Unlock All Recipes fix

- **Root cause** — The old endpoint only flipped `UnlockedState` on recipes already present in the character save (~128 entries). The in-game tech tree has **356** nodes (`DA_GRP_*` groups + `DA_REC_*` recipes) that were never added to the save, so they stayed locked even after “Unlock All.”
- **`public/data/tech-recipe-catalog.json`** — Full tech node list extracted from game pak files via `tools/Cue4ParsePatents` (regenerate with `dotnet run` in that folder).
- **`POST /api/characters/:id/tech/unlock-all`** — Merges every catalog node into `m_TechKnowledgeData` as `Purchased`, preserves existing `RCP_*` / `BLD_*` save entries, and sets `m_TechKnowledgePoints` to 99999.
- **UI** — Tech Tree badge shows `purchased / in save / in game`; unlock result reports how many nodes were added. Reminder to stop battlegroup and relog after changes.

## 1.0.3 — 2026-06-03

### Incomplete bootstrap repair

- **`needsBootstrap` in `/api/status`** — Detects the “No resources found in funcom-seabass-… namespace” state (VM imported but bootstrap never finished).
- **`POST /api/setup/repair`** — Deletes empty seabass namespace(s) when no battlegroup CR exists, then re-runs bootstrap automatically.
- **Dashboard repair panel** — Yellow banner with token/world/region form when incomplete setup is detected.

## 1.0.2 — 2026-06-03

### Setup — delete and start fresh

- **Setup tab → Delete & Start Fresh** — When pre-flight detects an existing `dune-awakening` VM, a reset panel appears on step 1.
- **`POST /api/setup/reset`** — Stops the battlegroup (if reachable), removes the Hyper-V VM, deletes `DuneAwakeningServer` folders on all drives, removes SSH keys, and clears cached manager state.
- Requires typing **DELETE** to confirm. Re-runs pre-flight automatically after reset so you can walk through the wizard again.

## 1.0.1 — 2026-06-03

### Server finder / WAN visibility fixes

- **Reliable visibility IP writes** — `settings.conf` is now written via base64 over SSH instead of fragile `printf` escaping. Line 4 is what the gateway reads at startup as `GameRmqAddress` when registering with Funcom.
- **Stop then start required** — UI and console now clearly state that visibility changes require a full battlegroup **stop → start** (not just restart-in-place). The gateway only publishes the join address on startup.
- **WAN port-forward guide** — When Public (WAN) or custom public IP is selected in **Game Config → Server Visibility**, a port-forward checklist appears:
  - **31982 TCP** — queue/matchmaking (commonly missed; required for server finder)
  - **Director NodePort TCP** — from your Dashboard (e.g. 31402)
  - **7777–7810 UDP** — game traffic  
  All forwards must target the **VM IP**, not the Windows host.
- **Setup wizard** — Same port-forward notice when choosing a public/custom player IP during initial setup.
- **Experimental tab reminder** — Self-hosted worlds appear under **Servers → Experimental** in the game client, not Official or Private.
- **API** — `GET /api/server-visibility` now returns `directorPort`, `isWan`, and structured `portForward` info. `POST` returns restart guidance.

### Other

- Improved **Server Display Name** field hint in Game Config (empty sietch names can hide servers in the browser).
