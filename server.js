const express = require('express');
const http = require('http');
const fs = require('fs');
const { WebSocketServer } = require('ws');
const path = require('path');
const ps = require('./lib/powershell');
const ssh = require('./lib/ssh');
const vmCtl = require('./lib/vm');
const dunePaths = require('./lib/paths');

const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1';
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  verifyClient(info, done) {
    const requestHost = String(info.req.headers.host || '').toLowerCase();
    const origin = String(info.origin || '').toLowerCase();
    const localHost = /^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(requestHost);
    const localOrigin = /^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin);
    done(localHost && localOrigin, localHost && localOrigin ? 101 : 403, 'Local access only');
  },
});
const VM_NAME = vmCtl.VM_NAME;
const VM_IP_OVERRIDE = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(process.env.DUNE_VM_IP || '')
  ? process.env.DUNE_VM_IP
  : null;

const DEFAULT_SERVER_PATH = path.join(
  'C:', 'Program Files (x86)', 'Steam', 'steamapps', 'common',
  'Dune Awakening Self-Hosted Server'
);

app.use((req, res, next) => {
  const requestHost = String(req.headers.host || '').toLowerCase();
  if (!/^(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(requestHost)) {
    return res.status(403).json({ error: 'The Server Manager is available only on this PC.' });
  }
  next();
});
app.use(express.json());

// ---------------------------------------------------------------------------
// WebSocket — broadcast helper
// ---------------------------------------------------------------------------
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach((c) => {
    if (c.readyState === 1) c.send(msg);
  });
}

function log(text) {
  broadcast('output', text);
}

// ---------------------------------------------------------------------------
// VM helpers
// ---------------------------------------------------------------------------
const VM_STATUS_CMD = `
$vm = Get-VM -Name '${VM_NAME}' -ErrorAction SilentlyContinue
if ($vm) {
  $ip = $null
  if ($vm.State -eq 'Running') {
    $ip = (Get-VMNetworkAdapter -VMName '${VM_NAME}').IPAddresses |
          Where-Object { $_ -match '^\\d+\\.\\d+\\.\\d+\\.\\d+$' } |
          Select-Object -First 1
  }
  [PSCustomObject]@{
    exists   = $true
    state    = $vm.State.ToString()
    ip       = $ip
    memoryMB = [math]::Round($vm.MemoryAssigned / 1MB)
    startupMemoryMB = [math]::Round($vm.MemoryStartup / 1MB)
    uptime   = $vm.Uptime.ToString()
  } | ConvertTo-Json -Compress
} else {
  '{"exists":false}'
}`.trim();

let cachedVmStatus = null;

async function getVmStatus() {
  try {
    cachedVmStatus = await ps.runJson(VM_STATUS_CMD);
  } catch {
    cachedVmStatus = { exists: false, error: 'Failed to query Hyper-V' };
  }
  return cachedVmStatus;
}

async function getVmIp() {
  if (VM_IP_OVERRIDE) return VM_IP_OVERRIDE;
  const st = cachedVmStatus || (await getVmStatus());
  return st && st.ip ? st.ip : null;
}

// Auto-sync is disabled once the user explicitly sets an IP via the dashboard.
// It only runs on first boot to seed settings.conf when it's empty.
let lastKnownVmIp = null;
let visibilityManuallySet = false;

// Funcom reads line 4 of settings.conf at gateway startup as GameRmqAddress.
const PORT_FORWARD_INFO = {
  rmqTcp: 31982,
  gameUdpStart: 7777,
  gameUdpEnd: 7810,
};

// Canonical token used by the self-hosted game's built-in Version 2
// notification consumer. An explicit override keeps this compatible with
// servers that intentionally changed the token at game-map startup.
const SERVER_COMMAND_AUTH_TOKEN =
  process.env.DUNE_SERVER_COMMANDS_AUTH_TOKEN || 'Nu6VmPWUMvdPMeB7qErr';

const REVIEWED_BULK_TRAINING_ACTIONS = Object.freeze([
  { id: 'award-all-xp', name: 'Add 10,000 XP to all three categories' },
  { id: 'unlock-all-trainer-skills', name: 'Unlock all reviewed trainer skills and capstones' },
  { id: 'unlock-all-abilities', name: 'Unlock all reviewed active abilities' },
]);
const BULK_TRAINING_MESSAGE_DELAY_MS = 300;
const EXCLUDED_BULK_ABILITY_MODULES = new Set(['Skills.Ability.VoiceStop']);
const REVIEWED_BULK_MODULE_COUNTS = Object.freeze({
  trainerSkills: 30,
  abilities: 33,
});
const REVIEWED_BULK_AUGMENT_COUNT = 105;
const REVIEWED_PACKAGE_ONLY_AUGMENT_COUNT = 22;

const ONLINE_ACTION_LIMITS = Object.freeze({
  xp: { min: 1, max: 10000000 },
  skillPoints: { min: 0, max: 100000 },
  itemCount: { min: 1, max: 1000 },
  itemDurability: { min: 0.01, max: 1 },
  solari: { min: 1, max: 1000000000 },
});
const MAX_CURRENCY_BALANCE = 1000000000;

// These are the only standalone augment templates and seed shapes reviewed
// against this server's persisted data. Offline creation is deliberately kept
// separate from the generic raw-item insert path.
const REVIEWED_OFFLINE_AUGMENTS = Object.freeze({
  T6_Augment_Damage1: Object.freeze({
    name: 'Heavy Caliber Upgrade',
    seed: '0.004815',
    installedDerived: false,
  }),
  T6_Augment_Damage2: Object.freeze({
    name: 'House Heavy Caliber Upgrade',
    seed: '1.0',
    installedDerived: true,
  }),
  T6_Augment_Range1: Object.freeze({
    name: 'Barrel Extender',
    seed: '0.333894',
    installedDerived: true,
  }),
});

async function readSettingsConfIp(vmIp) {
  return (await ssh.run(vmIp,
    "sed -n '4p' /home/dune/.dune/settings.conf 2>/dev/null",
    null, { timeout: 10000 })).trim();
}

async function writeSettingsConfIp(vmIp, advertisedIp) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(advertisedIp)) {
    throw new Error(`Invalid IP address: ${advertisedIp}`);
  }
  const content = `\n\n\n${advertisedIp}\n`;
  const b64 = Buffer.from(content).toString('base64');
  await ssh.run(vmIp, `echo ${b64} | base64 -d > /home/dune/.dune/settings.conf`, null, { timeout: 10000 });
}

async function syncSettingsConfIp(ip) {
  if (!ip || ip === lastKnownVmIp || visibilityManuallySet) return;
  try {
    const currentIpInConf = await readSettingsConfIp(ip);
    if (!currentIpInConf) {
      // settings.conf has no IP yet — seed it with the VM's private IP
      log(`Seeding settings.conf with VM IP ${ip}...\n`);
      await writeSettingsConfIp(ip, ip);
    }
    lastKnownVmIp = ip;
  } catch { /* non-critical */ }
}

async function getDirectorPort(ip) {
  try {
    const raw = await ssh.run(ip,
      "sudo kubectl get svc -A -o jsonpath='{.items[*].spec.ports[?(@.port==11717)].nodePort}' 2>/dev/null"
    );
    const port = raw.replace(/'/g, '').trim();
    return /^\d+$/.test(port) ? port : null;
  } catch {
    return null;
  }
}

function battlegroupOutputNeedsBootstrap(output) {
  return /No resources found/i.test(output || '');
}

async function cleanOrphanBattlegroupNamespaces(ip) {
  const bgCount = (await ssh.run(ip,
    "sudo kubectl get battlegroups -A --no-headers 2>/dev/null | wc -l",
    null, { timeout: 15000 })).trim();
  if (parseInt(bgCount, 10) > 0) return false;

  log('No battlegroup CR found — removing empty seabass namespace(s)...\n');
  await ssh.run(ip, [
    "for ns in $(sudo kubectl get ns -o jsonpath='{.items[*].metadata.name}' 2>/dev/null | tr ' ' '\\n' | grep '^funcom-seabass-'); do",
    '  sudo kubectl delete ns "$ns" --wait=false 2>/dev/null || true',
    'done',
    'echo CLEAN_OK',
  ].join(' '), log, { timeout: 120000 });
  await new Promise((r) => setTimeout(r, 8000));
  return true;
}

async function runBootstrapSetup(ip, { token, worldName, region, enableSwap }) {
  log('Uploading bootstrap files...\n');
  const psUpload = `
    $scriptDir = '${DEFAULT_SERVER_PATH}\\battlegroup-management'
    $sshKey = "$env:LOCALAPPDATA\\DuneAwakeningServer\\sshKey"
    $bootstrapSetup = Join-Path $scriptDir 'bootstrap\\setup'
    $setupText = (Get-Content $bootstrapSetup -Raw) -replace "\`r\`n", "\`n"
    $b64Setup = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($setupText))
    $uploadScript = @"
#!/bin/sh
set -e
echo $b64Setup | base64 -d | sudo -n tee /home/dune/.dune/bin/setup > /dev/null
sudo -n chmod +x /home/dune/.dune/bin/setup
echo UPLOAD_OK
"@
    $uploadScript = $uploadScript -replace "\`r\`n", "\`n"
    $b64Upload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($uploadScript))
    $uploadCmd = "echo $b64Upload | base64 -d | sh"
    $out = & ssh -o StrictHostKeyChecking=no -o LogLevel=QUIET -i "$sshKey" "dune@${ip}" $uploadCmd 2>&1
    $out | Out-String
  `;
  const uploadOut = await ps.run(psUpload, log);
  if (!uploadOut.includes('UPLOAD_OK')) {
    throw new Error('Bootstrap upload failed');
  }

  const stdinLines = [
    worldName || 'Dune Server',
    region || '3',
    token || '',
  ].join('\n') + '\n';

  log('\nRunning first-time battlegroup setup (this takes a while)...\n');
  await ssh.run(ip, '/home/dune/.dune/bin/setup 2>&1', log, {
    timeout: 900000,
    stdin: stdinLines,
  });
  log('\nBattlegroup setup complete.\n');

  if (enableSwap) {
    log('\nEnabling experimental swap memory...\n');
    await ssh.run(
      ip,
      'echo yes | /home/dune/.dune/bin/battlegroup enable-experimental-swap 2>&1',
      log,
      { timeout: 600000 }
    );
    log('Swap memory enabled.\n');
  }
}

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

// --- Status (with in-flight guard to prevent stacking from fast polls) ---
let statusInFlight = false;
let lastStatusResult = null;

app.get('/api/status', async (_req, res) => {
  if (statusInFlight && lastStatusResult) return res.json(lastStatusResult);

  statusInFlight = true;
  try {
    const vm = await getVmStatus();
    let bg = null;
    let directorPort = null;

    if (vm.exists && vm.state === 'Running' && vm.ip) {
      try {
        const raw = await ssh.run(vm.ip, '/home/dune/.dune/bin/battlegroup status 2>&1', null, { timeout: 10000 });
        const gameServersSection = raw.split(/Game Servers/i)[1] || '';
        const hasRunningServers = /\bRunning\b/i.test(gameServersSection);
        bg = {
          running: hasRunningServers,
          output: raw,
          needsBootstrap: battlegroupOutputNeedsBootstrap(raw),
        };
      } catch (e) {
        const out = e.stdout || e.message;
        bg = {
          running: false,
          output: out,
          needsBootstrap: battlegroupOutputNeedsBootstrap(out),
        };
      }
      directorPort = await getDirectorPort(vm.ip);
      syncSettingsConfIp(vm.ip);
    }

    lastStatusResult = {
      vm,
      battlegroup: bg,
      ssh: {
        keyPresent: dunePaths.sshKeyExists(),
        keyPath: dunePaths.sshKeyExists() ? dunePaths.getKeyPath() : null,
        wsl: dunePaths.isWsl(),
      },
      links: vm.ip ? {
        fileBrowser: `http://${vm.ip}:18888/`,
        director: directorPort ? `http://${vm.ip}:${directorPort}/` : null,
      } : null,
    };
    res.json(lastStatusResult);
  } catch (e) {
    if (lastStatusResult) return res.json(lastStatusResult);
    res.status(500).json({ error: e.message });
  } finally {
    statusInFlight = false;
  }
});

// --- VM controls ---
app.post('/api/vm/start', async (req, res) => {
  const memoryGB = req.body && req.body.memoryGB ? parseInt(req.body.memoryGB, 10) : null;
  try {
    const result = await vmCtl.startVm({
      memoryGB: Number.isFinite(memoryGB) ? memoryGB : null,
      log,
      autoStepDown: !memoryGB,
    });

    if (result.ip) await syncSettingsConfIp(result.ip);
    cachedVmStatus = null;
    res.json({
      success: true,
      ip: result.ip,
      memoryGB: result.memoryGB,
    });
  } catch (e) {
    const message = vmCtl.shortVmError(e.message);
    log(`Error: ${message}\n`);
    cachedVmStatus = null;
    res.status(e.code === 'OUT_OF_MEMORY' ? 507 : 500).json({
      success: false,
      error: message,
      code: e.code || 'START_FAILED',
      startFailed: true,
      attemptedGB: e.attemptedGB || null,
    });
  }
});

app.post('/api/vm/stop', async (_req, res) => {
  try {
    log('Stopping VM...\n');
    await ps.run(`Stop-VM -Name '${VM_NAME}' -Force`, log);
    log('VM stopped.\n');
    cachedVmStatus = null;
    res.json({ success: true });
  } catch (e) {
    log(`Error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- VM settings ---
app.post('/api/vm/password', async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Password required' });

  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    const b64 = Buffer.from(`dune:${password}\n`).toString('base64');
    const out = await ssh.run(ip, `echo ${b64} | base64 -d | sudo -n chpasswd && echo PWOK`);
    if (out.includes('PWOK')) {
      log('Password changed successfully.\n');
      res.json({ success: true });
    } else {
      throw new Error('Unexpected output');
    }
  } catch (e) {
    log(`Error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/vm/rotate-key', async (_req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    log('Rotating SSH key...\n');
    const psCmd = `
      $scriptDir = '${DEFAULT_SERVER_PATH}\\battlegroup-management'
      . "$scriptDir\\vm-utilities.ps1"
      Update-SshKey -Ip '${ip}'
    `;
    await ps.run(psCmd, log);
    log('SSH key rotated.\n');
    res.json({ success: true });
  } catch (e) {
    log(`Error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// --- Battlegroup commands ---
async function fixImageTagsIfNeeded(ip) {
  try {
    const ns = (await ssh.run(ip,
      "sudo kubectl get battlegroups -A --no-headers -o custom-columns=':metadata.namespace' 2>/dev/null | head -1",
      null, { timeout: 15000 })).trim();
    const bgName = (await ssh.run(ip,
      "sudo kubectl get battlegroups -A --no-headers -o custom-columns=':metadata.name' 2>/dev/null | head -1",
      null, { timeout: 15000 })).trim();
    if (!ns || !bgName) return;

    const raw = await ssh.run(ip,
      `sudo kubectl get battlegroup ${bgName} -n ${ns} -o json 2>/dev/null`,
      null, { timeout: 30000 });
    const bg = JSON.parse(raw);

    const serverImage = bg.spec?.serverGroup?.template?.spec?.sets?.[0]?.image || '';
    if (!/:0-0-shipping$/.test(serverImage)) return;

    log('Detected placeholder image tags (0-0-shipping). Looking up correct version...\n');

    const imgLine = (await ssh.run(ip,
      "sudo crictl images 2>/dev/null | grep 'seabass-server ' | head -1",
      null, { timeout: 15000 })).trim();
    const parts = imgLine.split(/\s+/);
    const correctTag = parts[1];
    if (!correctTag || correctTag === '0-0-shipping') {
      log('Could not determine correct image tag from local images.\n');
      return;
    }

    log(`Patching image tags from 0-0-shipping to ${correctTag}...\n`);
    await ssh.run(ip,
      `sudo kubectl get battlegroup ${bgName} -n ${ns} -o json 2>/dev/null | ` +
      `sed 's|:0-0-shipping|:${correctTag}|g' | ` +
      `sudo kubectl apply -f - 2>&1`,
      null, { timeout: 30000 });
    log('Image tags corrected.\n');

    // Clean up any pods stuck from the bad tags
    const stuckPods = (await ssh.run(ip,
      `sudo kubectl get pods -n ${ns} --no-headers 2>/dev/null | grep -E 'ImagePullBackOff|ErrImagePull|Init:ImagePullBackOff' | awk '{print $1}'`,
      null, { timeout: 15000 })).trim();
    if (stuckPods) {
      const podList = stuckPods.split('\n').filter(Boolean);
      log(`Cleaning up ${podList.length} stuck pod(s)...\n`);
      await ssh.run(ip,
        `sudo kubectl delete pods -n ${ns} ${podList.join(' ')} 2>&1`,
        null, { timeout: 15000 });
    }

    // Clean up Error pods from failed DB init jobs so the operator can retry
    const errorPods = (await ssh.run(ip,
      `sudo kubectl get pods -n ${ns} --no-headers 2>/dev/null | grep -E 'Error' | grep 'db-dbdepl-util' | awk '{print $1}'`,
      null, { timeout: 15000 })).trim();
    if (errorPods) {
      const podList = errorPods.split('\n').filter(Boolean);
      log(`Cleaning up ${podList.length} failed DB init pod(s)...\n`);
      await ssh.run(ip,
        `sudo kubectl delete pods -n ${ns} ${podList.join(' ')} 2>&1`,
        null, { timeout: 15000 });
    }

    log('Pre-start cleanup complete.\n');
  } catch (e) {
    log(`Image tag check warning: ${e.message}\n`);
  }
}

function bgRoute(action, label, timeoutMs) {
  app.post(`/api/bg/${action}`, async (_req, res) => {
    const ip = await getVmIp();
    if (!ip) {
      log(`Cannot ${action}: VM is not running.\n`);
      return res.status(400).json({ error: 'VM not running' });
    }

    if (!dunePaths.sshKeyExists()) {
      const msg = `SSH key not found at ${dunePaths.getKeyPath()}. Use Settings → Rotate SSH Key.`;
      log(`Cannot ${action}: ${msg}\n`);
      return res.status(500).json({ success: false, error: msg, code: 'SSH_KEY_MISSING' });
    }

    try {
      if (action === 'start' || action === 'restart') {
        // Fix placeholder image tags before starting
        await fixImageTagsIfNeeded(ip);

        // Re-apply the visibility IP so the gateway registers GameRmqAddress on startup
        try {
          const currentIp = await readSettingsConfIp(ip);
          if (currentIp && /^\d+\.\d+\.\d+\.\d+$/.test(currentIp)) {
            await writeSettingsConfIp(ip, currentIp);
            log(`Confirmed visibility IP: ${currentIp}\n`);
            if (currentIp !== ip) {
              log(`WAN mode: ensure TCP ${PORT_FORWARD_INFO.rmqTcp}, Director NodePort, and UDP ${PORT_FORWARD_INFO.gameUdpStart}-${PORT_FORWARD_INFO.gameUdpEnd} are forwarded to VM ${ip}\n`);
            }
          }
        } catch { /* non-critical */ }
      }

      log(`${label}...\n`);
      const out = await ssh.run(
        ip,
        `/home/dune/.dune/bin/battlegroup ${action} 2>&1`,
        log,
        { timeout: timeoutMs || 300000 }
      );
      log(`\n${label} complete.\n`);
      res.json({ success: true, output: out });
    } catch (e) {
      const hint = /timed out/i.test(e.message)
        ? `\nThe ${action} command timed out. The battlegroup may still be processing — check status in a minute.\n`
        : /ECONNREFUSED|connect/i.test(e.message)
        ? `\nCould not connect to the VM at ${ip}. Make sure the VM is running and SSH is reachable.\n`
        : /permission|denied/i.test(e.message)
        ? `\nSSH authentication failed. The VM may need its SSH key reconfigured.\n`
        : '';
      log(`Error: ${e.message}${hint}\n`);
      if (e.stdout) log(`Output before error:\n${e.stdout}\n`);
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

bgRoute('start', 'Starting battlegroup', 600000);
bgRoute('stop', 'Stopping battlegroup');
bgRoute('restart', 'Restarting battlegroup', 600000);
bgRoute('update', 'Updating battlegroup', 600000);
bgRoute('backup', 'Creating database backup', 600000);
bgRoute('import', 'Importing database backup', 600000);
bgRoute('enable-experimental-swap', 'Enabling swap memory', 600000);

// --- Logs ---
app.post('/api/logs/export', async (_req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    log('Exporting battlegroup logs...\n');
    const out = await ssh.run(ip, '/home/dune/.dune/bin/battlegroup logs-export 2>&1', log, { timeout: 300000 });
    log('\nLog export complete.\n');
    res.json({ success: true, output: out });
  } catch (e) {
    log(`Error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/api/logs/operators', async (_req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    log('Exporting operator logs...\n');
    const out = await ssh.run(ip, '/home/dune/.dune/bin/battlegroup operator-logs-export 2>&1', log, { timeout: 300000 });
    log('\nOperator log export complete.\n');
    res.json({ success: true, output: out });
  } catch (e) {
    log(`Error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Setup wizard
// ---------------------------------------------------------------------------

// Step 1 — Pre-flight: check Hyper-V, existing VM, available drives
app.get('/api/setup/preflight', async (_req, res) => {
  try {
    const out = await ps.run(`
      $result = @{ hyperv = $false; vmExists = $false; vmState = $null; drives = @() }

      if (Get-Module -ListAvailable -Name Hyper-V) {
        $svc = Get-Service -Name vmms -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq 'Running') { $result.hyperv = $true }
      }

      $vm = Get-VM -Name '${VM_NAME}' -ErrorAction SilentlyContinue
      if ($vm) {
        $result.vmExists = $true
        $result.vmState = $vm.State.ToString()
      }

      $result.drives = @(Get-PSDrive -PSProvider FileSystem |
        Where-Object { $_.Free -gt 100GB } |
        ForEach-Object { @{ name = $_.Name; freeGB = [math]::Round($_.Free / 1GB, 1) } })

      $vmcx = Get-Item '${DEFAULT_SERVER_PATH}\\Virtual Machines\\*.vmcx' -ErrorAction SilentlyContinue | Select-Object -First 1
      $result.vmcxFound = [bool]$vmcx

      $nics = @(Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Hyper-V|Virtual' } |
        ForEach-Object { @{ name = $_.Name; desc = $_.InterfaceDescription } })
      $result.nics = $nics

      $result | ConvertTo-Json -Depth 3 -Compress
    `);
    res.json(JSON.parse(out));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reset — remove VM, install folders, SSH keys (fresh setup)
app.post('/api/setup/reset', async (_req, res) => {
  const fs = require('fs');
  const os = require('os');

  try {
    log('=== Resetting Dune server installation ===\n');

    const vm = await getVmStatus();
    if (vm.exists && vm.state === 'Running' && vm.ip) {
      log('Stopping battlegroup (if running)...\n');
      try {
        await ssh.run(vm.ip, '/home/dune/.dune/bin/battlegroup stop 2>&1', log, { timeout: 180000 });
        log('Battlegroup stop sent.\n');
      } catch (e) {
        log(`Battlegroup stop skipped: ${e.message}\n`);
      }
    }

    log('Removing Hyper-V VM and install folders...\n');
    const psOut = await ps.run(`
      $removedVm = $false
      $vm = Get-VM -Name '${VM_NAME}' -ErrorAction SilentlyContinue
      if ($vm) {
        if ($vm.State -eq 'Running') { Stop-VM -Name '${VM_NAME}' -TurnOff -Force }
        Remove-VM -Name '${VM_NAME}' -Force
        $removedVm = $true
        Write-Output 'Removed VM dune-awakening.'
      }

      $cleared = @()
      Get-PSDrive -PSProvider FileSystem | ForEach-Object {
        $dest = "$($_.Name):\\DuneAwakeningServer"
        if (Test-Path $dest) {
          Remove-Item $dest -Recurse -Force -ErrorAction SilentlyContinue
          if (-not (Test-Path $dest)) { $cleared += $dest }
        }
      }
      if ($cleared.Count -gt 0) { Write-Output ("Cleared: " + ($cleared -join ', ')) }

      $sw = Get-VMSwitch -Name 'DuneAwakeningServerSwitch' -ErrorAction SilentlyContinue
      if ($sw) {
        $used = @(Get-VMNetworkAdapter -All | Where-Object { $_.SwitchName -eq 'DuneAwakeningServerSwitch' })
        if ($used.Count -eq 0) {
          Remove-VMSwitch -Name 'DuneAwakeningServerSwitch' -Force -ErrorAction SilentlyContinue
          Write-Output 'Removed unused DuneAwakeningServerSwitch.'
        }
      }

      @{ removedVm = $removedVm; vmExists = [bool](Get-VM -Name '${VM_NAME}' -ErrorAction SilentlyContinue) } | ConvertTo-Json -Compress
    `, log);

    let resetMeta = {};
    try { resetMeta = JSON.parse(psOut.trim().split('\n').pop()); } catch { /* ignore */ }

    const keyDir = dunePaths.getDuneKeyDir();
    if (fs.existsSync(keyDir)) {
      fs.rmSync(keyDir, { recursive: true, force: true });
      log(`Removed SSH keys at ${keyDir}\n`);
    }
    dunePaths.removeWslKeyMirror();

    visibilityManuallySet = false;
    lastKnownVmIp = null;
    cachedVmStatus = null;
    lastStatusResult = null;

    log('Reset complete. Run the setup wizard from step 1.\n');
    res.json({
      success: true,
      removedVm: !!resetMeta.removedVm,
      vmExists: !!resetMeta.vmExists,
    });
  } catch (e) {
    log(`Reset error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Step 2 — Import VM: remove old if needed, import, configure network+memory, start
app.post('/api/setup/import', async (req, res) => {
  const { drive, memoryGB, networkMode, nicName } = req.body;
  if (!drive || !memoryGB) return res.status(400).json({ error: 'drive and memoryGB required' });

  const dest = `${drive}:\\DuneAwakeningServer`;
  const memBytes = memoryGB * 1073741824; // 1GB in bytes
  const switchMode = networkMode === 'default' ? 'default' : 'external';

  try {
    log('=== Starting VM import ===\n');

    // Remove existing VM if present
    log('Checking for existing VM...\n');
    await ps.run(`
      $vm = Get-VM -Name '${VM_NAME}' -ErrorAction SilentlyContinue
      if ($vm) {
        if ($vm.State -eq 'Running') { Stop-VM -Name '${VM_NAME}' -TurnOff -Force }
        Remove-VM -Name '${VM_NAME}' -Force
        Write-Output 'Removed existing VM.'
      }
      if (Test-Path '${dest}') {
        Remove-Item '${dest}' -Recurse -Force -ErrorAction SilentlyContinue
        Write-Output 'Cleared destination folder.'
      }
    `, log);

    // Import
    log('\nImporting VM (this may take a few minutes)...\n');
    await ps.run(`
      $vmcx = Get-Item '${DEFAULT_SERVER_PATH}\\Virtual Machines\\*.vmcx' -ErrorAction Stop | Select-Object -First 1
      $compat = Compare-VM -Path $vmcx.FullName -Copy -VirtualMachinePath '${dest}' -VhdDestinationPath '${dest}\\Virtual Hard Disks' -ErrorAction Stop
      Import-VM -CompatibilityReport $compat -ErrorAction Stop | Out-Null
      Write-Output 'VM imported.'
    `, log);

    // Network switch
    log('\nConfiguring network...\n');
    if (switchMode === 'default') {
      await ps.run(`
        Connect-VMNetworkAdapter -VMName '${VM_NAME}' -SwitchName 'Default Switch' -ErrorAction Stop
        Write-Output 'Connected to Default Switch.'
      `, log);
    } else {
      const nicArg = nicName ? nicName.replace(/'/g, "''") : '';
      await ps.run(`
        $nicName = '${nicArg}'
        if (-not $nicName) {
          $nic = Get-NetAdapter | Where-Object { $_.Status -eq 'Up' -and $_.InterfaceDescription -notmatch 'Hyper-V|Virtual' } | Select-Object -First 1
          $nicName = $nic.Name
        }
        $existing = Get-VMSwitch -SwitchType External -ErrorAction SilentlyContinue |
          Where-Object { $_.NetAdapterInterfaceDescription -eq (Get-NetAdapter -Name $nicName).InterfaceDescription }
        if ($existing) {
          $switchName = $existing.Name
        } else {
          $switchName = 'DuneAwakeningServerSwitch'
          New-VMSwitch -Name $switchName -NetAdapterName $nicName -AllowManagementOS $true -ErrorAction Stop | Out-Null
          Write-Output "Created external switch '$switchName'."
        }
        Connect-VMNetworkAdapter -VMName '${VM_NAME}' -SwitchName $switchName -ErrorAction Stop
        Write-Output "Connected to switch '$switchName'."
      `, log);
    }

    // Resize disk
    log('\nInitializing virtual disk...\n');
    await ps.run(`
      $vhdx = Get-Item '${dest}\\Virtual Hard Disks\\*.vhdx' -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($vhdx) { Resize-VHD -Path $vhdx.FullName -SizeBytes 100GB -ErrorAction Stop; Write-Output 'Disk resized to 100GB.' }

      $boot = Get-VMHardDiskDrive -VMName '${VM_NAME}' | Select-Object -First 1
      if ($boot) { Set-VMFirmware -VMName '${VM_NAME}' -FirstBootDevice $boot }
    `, log);

    // Memory
    log('\nSetting memory to ' + memoryGB + 'GB...\n');
    await ps.run(`
      Set-VMMemory -VMName '${VM_NAME}' -StartupBytes ${memBytes}
      Write-Output 'Memory configured.'
    `, log);

    // Start VM (auto step-down if host is low on RAM)
    log('\nStarting VM...\n');
    let ip;
    try {
      const result = await vmCtl.startVm({ log, autoStepDown: true });
      ip = result.ip;
    } catch (startErr) {
      const message = vmCtl.shortVmError(startErr.message);
      log(`\nVM imported successfully but failed to start: ${message}\n`);
      log('You can adjust memory below and retry.\n');
      cachedVmStatus = null;
      return res.json({ success: false, imported: true, startFailed: true, error: message });
    }

    if (!ip) {
      log('Could not detect VM IP after 2 minutes.\n');
      return res.status(500).json({ success: false, error: 'VM started but no IP detected' });
    }

    log(`VM ready at ${ip}\n`);
    cachedVmStatus = null;
    res.json({ success: true, ip });
  } catch (e) {
    log(`\nError: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Retry start with different memory (VM already imported)
app.post('/api/setup/retry-start', async (req, res) => {
  const memoryGB = parseInt(req.body && req.body.memoryGB, 10);
  if (!Number.isFinite(memoryGB) || memoryGB < 1) {
    return res.status(400).json({ error: 'memoryGB required' });
  }

  try {
    const result = await vmCtl.startVm({ memoryGB, log, autoStepDown: false });
    cachedVmStatus = null;
    res.json({ success: true, ip: result.ip, memoryGB: result.memoryGB });
  } catch (e) {
    const message = vmCtl.shortVmError(e.message);
    log(`\nError: ${message}\n`);
    cachedVmStatus = null;
    res.status(e.code === 'OUT_OF_MEMORY' ? 507 : 500).json({
      success: false,
      error: message,
      code: e.code || 'START_FAILED',
      startFailed: true,
      attemptedGB: e.attemptedGB || memoryGB,
    });
  }
});

// Step 3 — SSH key + password (combined — uses ASKPASS for first-time key install)
app.post('/api/setup/security', async (req, res) => {
  const { ip, currentPassword, newPassword } = req.body;
  if (!ip || !newPassword) return res.status(400).json({ error: 'ip and newPassword required' });

  const curPw = currentPassword || 'dune';
  const fs = require('fs');
  const os = require('os');
  const { spawn: spawnProc } = require('child_process');

  const keyDir = dunePaths.getDuneKeyDir();
  const keyPath = dunePaths.getKeyPath();
  const tmpDir = os.tmpdir();
  const tempKey = path.join(tmpDir, `dunekey-${Date.now()}`);
  const askpassFile = path.join(tmpDir, `dune_askpass_${Date.now()}.bat`);

  try {
    fs.mkdirSync(keyDir, { recursive: true });

    // 1. Generate key pair
    log('Generating SSH key pair...\n');
    await new Promise((resolve, reject) => {
      const kg = spawnProc('ssh-keygen', ['-t', 'ed25519', '-f', tempKey, '-N', '', '-q', '-C', 'dune-server-manager'], {
        windowsHide: true, stdio: 'ignore',
      });
      kg.on('error', reject);
      kg.on('close', (code) => code === 0 ? resolve() : reject(new Error(`ssh-keygen exited ${code}`)));
    });

    // 2. Build the remote install command
    const pubKey = fs.readFileSync(tempKey + '.pub', 'utf8').trim();
    const b64Pub = Buffer.from(pubKey + '\n').toString('base64');
    const installSh = [
      'mkdir -p $HOME/.ssh',
      'chmod 700 $HOME/.ssh',
      `echo ${b64Pub} | base64 -d > $HOME/.ssh/authorized_keys`,
      'chmod 600 $HOME/.ssh/authorized_keys',
      'echo KEY_INSTALLED',
    ].join(' && ');

    // 3. Create askpass script that echoes the current password
    fs.writeFileSync(askpassFile, `@echo ${curPw}`);

    // 4. SSH with ASKPASS to install the public key
    log('Installing SSH key on VM (using current password)...\n');
    await new Promise((resolve, reject) => {
      const sshProc = spawnProc('ssh', [
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'LogLevel=QUIET',
        '-o', 'PubkeyAuthentication=no',
        '-o', 'PreferredAuthentications=keyboard-interactive,password',
        '-o', 'ConnectTimeout=15',
        `dune@${ip}`,
        installSh,
      ], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SSH_ASKPASS: askpassFile,
          SSH_ASKPASS_REQUIRE: 'force',
          DISPLAY: 'dummy',
        },
      });

      let out = '';
      sshProc.stdout.on('data', (d) => { out += d.toString(); log(d.toString()); });
      sshProc.stderr.on('data', (d) => { out += d.toString(); log(d.toString()); });

      const timer = setTimeout(() => { sshProc.kill(); reject(new Error('SSH key install timed out')); }, 60000);
      sshProc.on('error', (e) => { clearTimeout(timer); reject(e); });
      sshProc.on('close', (code) => {
        clearTimeout(timer);
        if (out.includes('KEY_INSTALLED')) resolve();
        else reject(new Error(`Key install failed (exit ${code}): ${out.slice(-200)}`));
      });
    });

    // Cleanup askpass
    try { fs.unlinkSync(askpassFile); } catch {}

    // 5. Verify the new key works
    log('Verifying key...\n');
    await new Promise((resolve, reject) => {
      const v = spawnProc('ssh', [
        '-o', 'StrictHostKeyChecking=no', '-o', 'LogLevel=QUIET',
        '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
        '-i', tempKey, `dune@${ip}`, 'echo VERIFY_OK',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

      let out = '';
      v.stdout.on('data', (d) => { out += d.toString(); });
      v.on('close', () => out.includes('VERIFY_OK') ? resolve() : reject(new Error('Key verification failed')));
      v.on('error', reject);
    });

    // 6. Move key into place
    try { fs.unlinkSync(keyPath); } catch {}
    try { fs.unlinkSync(keyPath + '.pub'); } catch {}
    fs.renameSync(tempKey, keyPath);
    fs.renameSync(tempKey + '.pub', keyPath + '.pub');
    log('SSH key installed.\n');

    // 7. Change password using the new key
    log('Changing password...\n');
    const b64Pw = Buffer.from(`dune:${newPassword}\n`).toString('base64');
    const pwOut = await ssh.run(ip, `echo ${b64Pw} | base64 -d | sudo -n chpasswd && echo PWOK`, null, { timeout: 30000 });
    if (!pwOut.includes('PWOK')) throw new Error('Password change failed');
    log('Password changed.\n');

    res.json({ success: true });
  } catch (e) {
    log(`Error: ${e.message}\n`);
    try { fs.unlinkSync(askpassFile); } catch {}
    try { fs.unlinkSync(tempKey); } catch {}
    try { fs.unlinkSync(tempKey + '.pub'); } catch {}
    res.status(500).json({ success: false, error: e.message });
  }
});

// Step 5 — Detect public IP from VM
app.post('/api/setup/detect-ip', async (req, res) => {
  const { ip } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip required' });

  let publicIp = null;
  for (const method of [
    () => ssh.run(ip, "wget -qO- --timeout=5 'https://api.ipify.org' 2>/dev/null"),
    () => ssh.run(ip, 'curl -s --max-time 5 https://api.ipify.org 2>/dev/null'),
    () => ps.run("(Invoke-WebRequest -Uri 'https://api.ipify.org' -UseBasicParsing -TimeoutSec 5).Content"),
  ]) {
    try {
      const out = await method();
      if (out && /^\d+\.\d+\.\d+\.\d+$/.test(out.trim())) { publicIp = out.trim(); break; }
    } catch { /* try next */ }
  }
  res.json({ privateIp: ip, publicIp });
});

// Step 6 — Configure networking (DHCP or static) + set player IP + write token
app.post('/api/setup/network', async (req, res) => {
  const { ip, mode, staticIp, staticCidr, staticGw, staticDns, playerIp, token } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip required' });

  let finalIp = ip;

  try {
    if (mode === 'static') {
      log('Applying static network config...\n');
      const iface = 'eth0';
      const cidr = staticCidr || '/24';
      const gw = staticGw;
      const dns = staticDns || '1.1.1.1';

      const ifContent = `auto lo\\niface lo inet loopback\\n\\nauto ${iface}\\niface ${iface} inet static\\n    address ${staticIp}${cidr}\\n    gateway ${gw}\\n`;
      const resolvContent = `nameserver ${dns}\\n`;
      const b64If = Buffer.from(ifContent.replace(/\\n/g, '\n')).toString('base64');
      const b64Resolv = Buffer.from(resolvContent.replace(/\\n/g, '\n')).toString('base64');

      const script = [
        `echo ${b64If} | base64 -d | sudo -n tee /etc/network/interfaces > /dev/null`,
        `echo ${b64Resolv} | base64 -d | sudo -n tee /etc/resolv.conf > /dev/null`,
        `echo APPLY_OK`,
        `nohup sudo -n sh -c 'sleep 2; rc-service networking restart' </dev/null >/dev/null 2>&1 &`,
      ].join(' && ');

      const out = await ssh.run(ip, script);
      if (!out.includes('APPLY_OK')) throw new Error('Failed to apply static config');

      log('Waiting for VM on new IP...\n');
      await new Promise((r) => setTimeout(r, 6000));

      let reachable = false;
      for (let i = 0; i < 30 && !reachable; i++) {
        try {
          await ssh.run(staticIp, 'true');
          reachable = true;
        } catch {
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (!reachable) throw new Error(`VM not reachable on ${staticIp}`);
      finalIp = staticIp;
      log(`VM now at ${finalIp}\n`);
    }

    // Write player IP to VM settings
    const pIp = playerIp || finalIp;
    log(`Setting player-facing IP to ${pIp}...\n`);
    await writeSettingsConfIp(finalIp, pIp);
    log('Player IP configured.\n');

    res.json({ success: true, vmIp: finalIp });
  } catch (e) {
    log(`Error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Step 7 — Upload bootstrap + run first-time setup on VM
app.post('/api/setup/bootstrap', async (req, res) => {
  const { ip, enableSwap, token, worldName, region } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip required' });

  try {
    await runBootstrapSetup(ip, { token, worldName, region, enableSwap });
    cachedVmStatus = null;
    lastStatusResult = null;
    res.json({ success: true });
  } catch (e) {
    log(`\nError: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Repair incomplete install (empty namespace / no battlegroup CR)
app.post('/api/setup/repair', async (req, res) => {
  const { token, worldName, region, enableSwap } = req.body;
  if (!token) return res.status(400).json({ error: 'token required' });

  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    log('=== Repairing incomplete battlegroup setup ===\n');
    await cleanOrphanBattlegroupNamespaces(ip);
    await runBootstrapSetup(ip, { token, worldName, region, enableSwap });
    cachedVmStatus = null;
    lastStatusResult = null;
    res.json({ success: true });
  } catch (e) {
    log(`\nRepair error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Game config (UserGame.ini + UserEngine.ini)
// ---------------------------------------------------------------------------
const CONFIG_PATHS = {
  game: '/home/dune/.dune/download/scripts/setup/config/UserGame.ini',
  engine: '/home/dune/.dune/download/scripts/setup/config/UserEngine.ini',
};

function parseIni(raw) {
  const result = {};
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('[')) continue;
    // Parse both active and commented-out key=value lines
    let active = true;
    let content = trimmed;
    if (trimmed.startsWith(';')) {
      // Only parse as a commented key=value if it looks like one (no spaces before =)
      const rest = trimmed.slice(1).trim();
      if (!/^[A-Za-z]/.test(rest)) continue; // pure comment
      const eq = rest.indexOf('=');
      if (eq === -1) continue;
      active = false;
      content = rest;
    }
    const eq = content.indexOf('=');
    if (eq === -1) continue;
    const key = content.slice(0, eq).trim();
    if (active) {
      result[key] = content.slice(eq + 1).trim();
    } else if (!(key in result)) {
      // Commented-out values shown as empty so UI knows the key exists but is off
      result[key] = '';
    }
  }
  return result;
}

function applyToIni(raw, updates) {
  const lines = raw.split('\n');
  const applied = new Set();
  const quotedKeys = new Set(['Bgd.ServerDisplayName', 'Bgd.ServerLoginPassword']);

  const result = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('[')) return line;

    let content = trimmed;
    if (trimmed.startsWith(';')) {
      content = trimmed.slice(1).trim();
      if (!/^[A-Za-z]/.test(content)) return line;
    }
    const eq = content.indexOf('=');
    if (eq === -1) return line;
    const key = content.slice(0, eq).trim();

    if (key in updates) {
      applied.add(key);
      const val = updates[key];
      if (!val && val !== '0' && val !== 0) {
        // Empty value → comment out the line
        const defaultVal = content.slice(eq + 1).trim();
        return `;${key}=${defaultVal || '""'}`;
      }
      // Wrap in quotes if this key expects quoted values
      const formatted = quotedKeys.has(key) && !String(val).startsWith('"')
        ? `"${val}"` : String(val);
      return `${key}=${formatted}`;
    }
    return line;
  });

  // Append any keys that weren't found in the file
  for (const [key, val] of Object.entries(updates)) {
    if (applied.has(key) || (!val && val !== '0' && val !== 0)) continue;
    const formatted = quotedKeys.has(key) && !String(val).startsWith('"')
      ? `"${val}"` : String(val);
    result.push(`${key}=${formatted}`);
  }

  return result.join('\n');
}

app.get('/api/config', async (_req, res) => {
  const vmIp = await getVmIp();
  if (!vmIp) return res.status(400).json({ error: 'VM not running' });

  try {
    const [gameRaw, engineRaw] = await Promise.all([
      ssh.run(vmIp, `cat ${CONFIG_PATHS.game} 2>/dev/null`, null, { timeout: 15000 }),
      ssh.run(vmIp, `cat ${CONFIG_PATHS.engine} 2>/dev/null`, null, { timeout: 15000 }),
    ]);
    res.json({
      game: parseIni(gameRaw),
      engine: parseIni(engineRaw),
      rawGame: gameRaw,
      rawEngine: engineRaw,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/config', async (req, res) => {
  const { game, engine } = req.body;
  const vmIp = await getVmIp();
  if (!vmIp) return res.status(400).json({ error: 'VM not running' });

  try {
    // Read current files, apply changes, write back
    const [gameRaw, engineRaw] = await Promise.all([
      ssh.run(vmIp, `cat ${CONFIG_PATHS.game} 2>/dev/null`, null, { timeout: 15000 }),
      ssh.run(vmIp, `cat ${CONFIG_PATHS.engine} 2>/dev/null`, null, { timeout: 15000 }),
    ]);

    if (game && Object.keys(game).length) {
      const updated = applyToIni(gameRaw, game);
      const b64 = Buffer.from(updated).toString('base64');
      await ssh.run(vmIp, `echo '${b64}' | base64 -d > ${CONFIG_PATHS.game}`, null, { timeout: 15000 });
    }

    if (engine && Object.keys(engine).length) {
      const updated = applyToIni(engineRaw, engine);
      const b64 = Buffer.from(updated).toString('base64');
      await ssh.run(vmIp, `echo '${b64}' | base64 -d > ${CONFIG_PATHS.engine}`, null, { timeout: 15000 });
    }

    // Deploy INI files to the Kubernetes pods so game servers pick them up
    log('Deploying settings to battlegroup pods…\n');
    const applyOut = await ssh.run(vmIp,
      '/home/dune/.dune/bin/battlegroup apply-default-usersettings 2>&1',
      null, { timeout: 30000 });
    log(applyOut + '\n');

    log('Config saved and deployed. Stop & start the battlegroup to apply changes.\n');
    res.json({ success: true });
  } catch (e) {
    log(`Config save error: ${e.message}\n`);
    res.status(500).json({ success: false, error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Character Editor
// ---------------------------------------------------------------------------

let dbPodCache = null;
let dbPodCacheTime = 0;
let mqPodCache = null;
let mqPodCacheTime = 0;
let onlineActionCatalogCache = null;
const onlineActionLocks = new Set();

async function getDbPod(vmIp) {
  if (dbPodCache && Date.now() - dbPodCacheTime < 120000) return dbPodCache;
  const raw = await ssh.run(vmIp,
    "sudo kubectl get pods --all-namespaces --no-headers 2>/dev/null | grep 'db-dbdepl-sts.*Running'",
    null, { timeout: 15000 }
  );
  const line = raw.trim().split('\n')[0];
  if (!line) throw new Error('Database pod not found — is the VM fully booted?');
  const parts = line.trim().split(/\s+/);
  dbPodCache = { ns: parts[0], name: parts[1] };
  dbPodCacheTime = Date.now();
  return dbPodCache;
}

async function runPsql(vmIp, sql, opts = {}) {
  const { ns, name } = await getDbPod(vmIp);
  const remoteCmd =
    `sudo kubectl exec -i -n ${ns} ${name} -- psql -U dune -d dune -p 15432 -v ON_ERROR_STOP=1 -t -A`;
  // Pipe SQL via SSH stdin — embedding large queries in the command line hits
  // Windows ENAMETOOLONG (e.g. unlock-all cosmetics with 600+ IDs).
  return ssh.run(vmIp, remoteCmd, null, {
    timeout: opts.timeout || 60000,
    stdin: sql,
  });
}

async function getMqPod(vmIp) {
  if (mqPodCache && Date.now() - mqPodCacheTime < 30000) return mqPodCache;
  const raw = await ssh.run(vmIp,
    "sudo kubectl get pods --all-namespaces -l role=igw-message-queue,messagequeue=game -o json",
    null, { timeout: 15000 }
  );
  let podList;
  try {
    podList = JSON.parse(raw);
  } catch {
    throw new Error('Game message broker discovery returned invalid Kubernetes data.');
  }
  const readyPods = (podList.items || []).filter((pod) =>
    pod?.status?.phase === 'Running' &&
    !pod?.metadata?.deletionTimestamp &&
    (pod?.status?.conditions || []).some((condition) => condition.type === 'Ready' && condition.status === 'True')
  );
  if (readyPods.length !== 1) {
    throw new Error(`Expected exactly one ready game message broker, found ${readyPods.length}.`);
  }
  const ns = String(readyPods[0].metadata?.namespace || '');
  const name = String(readyPods[0].metadata?.name || '');
  if (!/^[a-z0-9.-]+$/.test(ns) || !/^[a-z0-9.-]+$/.test(name)) {
    throw new Error('Game message broker discovery returned an invalid pod identity.');
  }
  mqPodCache = { ns, name };
  mqPodCacheTime = Date.now();
  return mqPodCache;
}

function readOnlineActionCatalog() {
  if (onlineActionCatalogCache) return onlineActionCatalogCache;
  const skillPath = path.join(__dirname, 'public', 'data', 'skill-module-catalog.json');
  const itemPath = path.join(__dirname, 'public', 'data', 'item-catalog.json');
  const augmentPath = path.join(__dirname, 'public', 'data', 'augment-catalog.json');
  const skillModules = JSON.parse(fs.readFileSync(skillPath, 'utf8'));
  const itemData = JSON.parse(fs.readFileSync(itemPath, 'utf8'));
  const augmentData = JSON.parse(fs.readFileSync(augmentPath, 'utf8'));
  if (
    !Array.isArray(skillModules) ||
    !itemData || typeof itemData.items !== 'object' ||
    !augmentData || typeof augmentData.items !== 'object'
  ) {
    throw new Error('Online action catalogs are invalid.');
  }
  onlineActionCatalogCache = {
    skillModules,
    itemTemplates: { ...itemData.items, ...augmentData.items },
    augmentTemplates: augmentData.items,
  };
  return onlineActionCatalogCache;
}

function boundedInteger(value, label, minimum, maximum) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${label} must be a whole number.`);
  if (parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum.toLocaleString()} and ${maximum.toLocaleString()}.`);
  }
  return parsed;
}

function boundedNumber(value, label, minimum, maximum) {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

async function getCharacterCommandTarget(vmIp, pawnId) {
  const raw = await runPsql(vmIp,
    `SELECT json_build_object(` +
    `'pawnId', act.id, ` +
     `'controllerId', ps.player_controller_id, ` +
     `'onlineStatus', ps.online_status::text, ` +
     `'serverId', ps.server_id, ` +
     `'farmReady', COALESCE(fs.ready, false), ` +
     `'farmAlive', COALESCE(fs.alive, false), ` +
     `'activeServer', (asi.server_id IS NOT NULL), ` +
     `'flsId', account.\"user\"` +
     `)::text FROM actors act ` +
     `JOIN accounts account ON account.id = act.owner_account_id ` +
     `LEFT JOIN player_state ps ON ps.player_pawn_id = act.id ` +
     `LEFT JOIN farm_state fs ON fs.server_id = ps.server_id ` +
     `LEFT JOIN active_server_ids asi ON asi.server_id = ps.server_id ` +
    `WHERE act.id = ${pawnId} LIMIT 1`
  );
  const line = raw.trim().split(/\r?\n/).find((value) => value.trim().startsWith('{'));
  if (!line) throw new Error(`Character pawn ${pawnId} was not found.`);
  const target = JSON.parse(line);
  const controllerId = Number.parseInt(target.controllerId, 10);
  if (!Number.isSafeInteger(controllerId) || controllerId <= 0) {
    throw new Error(`Character pawn ${pawnId} has no valid player controller.`);
  }
  target.controllerId = controllerId;
  return target;
}

async function requireOnlineCommandTarget(vmIp, pawnId) {
  const target = await getCharacterCommandTarget(vmIp, pawnId);
  // farm_state.ready is advisory on current builds and can remain false after
  // the map is accepting players. Online + alive + active is the reliable gate.
  if (String(target.onlineStatus).toLowerCase() !== 'online' || !target.serverId ||
      target.farmAlive !== true || target.activeServer !== true) {
    const err = new Error('This live action requires the selected character to be fully online in the game.');
    err.statusCode = 409;
    throw err;
  }
  const flsId = String(target.flsId || '').trim();
  if (!flsId || flsId.length > 256 || /[\x00-\x1f\x7f]/.test(flsId)) {
    throw new Error('The selected character has no valid Funcom player identity.');
  }
  target.flsId = flsId;
  return target;
}

async function publishServerCommand(vmIp, inner) {
  const pod = await getMqPod(vmIp);
  const outer = {
    Version: 2,
    AuthToken: SERVER_COMMAND_AUTH_TOKEN,
    MessageContent: JSON.stringify(inner),
  };
  const outerB64 = Buffer.from(JSON.stringify(outer)).toString('base64');
  const label = String(inner.ServerCommand || 'online-action').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 40);
  const erl = [
    `Outer = base64:decode(<<\"${outerB64}\">>),`,
    'XName = rabbit_misc:r(<<\"/\">>, exchange, <<\"heartbeats\">>),',
    'X = rabbit_exchange:lookup_or_die(XName),',
    `MsgId = list_to_binary(\"manager-${label}-\" ++ integer_to_list(erlang:system_time(millisecond))),`,
    'P = {list_to_atom(\"P_basic\"), <<\"Content\">>, undefined, [], undefined, undefined, undefined, undefined, undefined, MsgId, undefined, undefined, <<\"fls\">>, <<\"fls_backend\">>, undefined},',
    'Content = rabbit_basic:build_content(P, Outer),',
    '{ok, Msg} = rabbit_basic:message(XName, <<\"notifications\">>, Content),',
    'Result = rabbit_queue_type:publish_at_most_once(X, Msg),',
    'io:format(\"publish=~p~n\", [Result]),',
    'Result.',
  ].join(' ');
  const erlB64 = Buffer.from(erl).toString('base64');
  const runner = 'set -eu; export PATH=/opt/rabbitmq/sbin:/opt/erlang/lib/erlang/bin:/bin:/usr/bin:/usr/local/bin:$PATH; expr=$(cat); /opt/rabbitmq/sbin/rabbitmqctl eval "$expr"';
  const runnerB64 = Buffer.from(runner).toString('base64');
  const command =
    `echo ${erlB64} | base64 -d | sudo kubectl exec -i -n ${pod.ns} ${pod.name} -- ` +
    `sh -lc \"$(echo ${runnerB64} | base64 -d)\" 2>&1`;
  const output = await ssh.run(vmIp, command, null, { timeout: 30000 });
  const publishLine = String(output || '').split(/\r?\n/).map((line) => line.trim())
    .find((line) => line.startsWith('publish='));
  if (!/^publish=(?:ok|\{ok,enqueued\})\.?$/.test(publishLine || '')) {
    throw new Error('The game message broker did not accept the live action.');
  }
  return { queued: true, command: inner.ServerCommand };
}

function reviewedBulkModuleIds(catalog, prefix, expectedCount, excludedIds = new Set()) {
  const ids = catalog.skillModules
    .filter((module) => module && module.category !== 'Hidden' &&
      typeof module.id === 'string' && module.id.startsWith(prefix) &&
      !excludedIds.has(module.id))
    .map((module) => module.id);
  const uniqueCount = new Set(ids).size;
  if (ids.length !== expectedCount || uniqueCount !== expectedCount) {
    throw new Error(
      `The reviewed ${prefix} catalog subset is invalid: expected exactly ${expectedCount} unique modules, found ${ids.length} entries and ${uniqueCount} unique IDs.`
    );
  }
  return ids;
}

function reviewedBulkAugmentIds(catalog) {
  const entries = Object.entries(catalog.augmentTemplates || {});
  const expectedTotal = REVIEWED_BULK_AUGMENT_COUNT + REVIEWED_PACKAGE_ONLY_AUGMENT_COUNT;
  if (entries.length !== expectedTotal || entries.some(([templateId, item]) =>
    !templateId.startsWith('T6_Augment_') || !item || item.category !== 'Augments')) {
    throw new Error(`The reviewed augment catalog is invalid: expected exactly ${expectedTotal} T6 augment templates.`);
  }
  const ids = entries
    .filter(([, item]) => item.packageOnly !== true)
    .map(([templateId]) => templateId);
  const packageOnlyIds = entries
    .filter(([, item]) => item.packageOnly === true)
    .map(([templateId]) => templateId);
  const uniqueCount = new Set(ids).size;
  const packageOnlyUniqueCount = new Set(packageOnlyIds).size;
  if (ids.length !== REVIEWED_BULK_AUGMENT_COUNT || uniqueCount !== REVIEWED_BULK_AUGMENT_COUNT ||
      packageOnlyIds.length !== REVIEWED_PACKAGE_ONLY_AUGMENT_COUNT ||
      packageOnlyUniqueCount !== REVIEWED_PACKAGE_ONLY_AUGMENT_COUNT) {
    throw new Error(
      `The reviewed augment catalog subset is invalid: expected exactly ${REVIEWED_BULK_AUGMENT_COUNT} unique confirmed templates and ${REVIEWED_PACKAGE_ONLY_AUGMENT_COUNT} unique package-only templates.`
    );
  }
  return ids;
}

function buildReviewedBulkAugmentGrant(playerId, catalog) {
  const templateIds = reviewedBulkAugmentIds(catalog);
  const commands = templateIds.map((templateId) => ({
    ServerCommand: 'AddItemToInventory',
    PlayerId: playerId,
    ItemName: templateId,
    Quantity: 1,
    Durability: 1,
  }));
  return { commands, templateIds };
}

function buildReviewedBulkTrainingAction(actionId, playerId, catalog) {
  switch (actionId) {
    case 'award-all-xp': {
      const commands = ['Combat', 'Exploration', 'Science'].map((category) => ({
        ServerCommand: 'AwardXP',
        PlayerId: playerId,
        Category: category,
        Experience: 10000,
      }));
      return { commands, description: 'Add 10,000 XP to all three categories' };
    }
    case 'unlock-all-trainer-skills': {
      const commands = reviewedBulkModuleIds(
        catalog,
        'Skills.Key.',
        REVIEWED_BULK_MODULE_COUNTS.trainerSkills
      ).map((moduleId) => ({
        ServerCommand: 'SkillsSetModuleLevel',
        PlayerId: playerId,
        Module: moduleId,
        Level: 1,
      }));
      return { commands, description: 'Unlock all reviewed trainer skills and capstones' };
    }
    case 'unlock-all-abilities': {
      const commands = reviewedBulkModuleIds(
        catalog,
        'Skills.Ability.',
        REVIEWED_BULK_MODULE_COUNTS.abilities,
        EXCLUDED_BULK_ABILITY_MODULES
      ).map((moduleId) => ({
        ServerCommand: 'SkillsSetModuleLevel',
        PlayerId: playerId,
        Module: moduleId,
        Level: 1,
      }));
      return { commands, description: 'Unlock all reviewed active abilities' };
    }
    default:
      throw new Error('Select one of the reviewed bulk training actions.');
  }
}

async function publishServerCommandBatch(vmIp, commands) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new Error('The reviewed bulk action did not produce any commands.');
  }

  const pod = await getMqPod(vmIp);
  const encodedMessages = commands.map((inner) => {
    const outer = {
      Version: 2,
      AuthToken: SERVER_COMMAND_AUTH_TOKEN,
      MessageContent: JSON.stringify(inner),
    };
    return Buffer.from(JSON.stringify(outer)).toString('base64');
  });
  const payloadList = `[${encodedMessages.map((value) => `<<"${value}">>`).join(',')}]`;
  const erl = [
    `Payloads = ${payloadList},`,
    'XName = rabbit_misc:r(<<"/">>, exchange, <<"heartbeats">>),',
    'X = rabbit_exchange:lookup_or_die(XName),',
    'Publish = fun Loop([], Count) -> Count;',
    'Loop([OuterB64 | Rest], Count) ->',
    'Outer = base64:decode(OuterB64),',
    'MsgId = list_to_binary("manager-bulk-" ++ integer_to_list(erlang:system_time(microsecond)) ++ "-" ++ integer_to_list(erlang:unique_integer([monotonic, positive]))),',
    'P = {list_to_atom("P_basic"), <<"Content">>, undefined, [], undefined, undefined, undefined, undefined, undefined, MsgId, undefined, undefined, <<"fls">>, <<"fls_backend">>, undefined},',
    'Content = rabbit_basic:build_content(P, Outer),',
    '{ok, Msg} = rabbit_basic:message(XName, <<"notifications">>, Content),',
    'Result = rabbit_queue_type:publish_at_most_once(X, Msg),',
    'NextCount = case Result of ok -> Count + 1; {ok, enqueued} -> Count + 1; Other -> erlang:error({publish_rejected, Other}) end,',
    `case Rest of [] -> ok; _ -> timer:sleep(${BULK_TRAINING_MESSAGE_DELAY_MS}) end,`,
    'Loop(Rest, NextCount)',
    'end,',
    'Accepted = Publish(Payloads, 0),',
    `Expected = ${commands.length},`,
    'true = (Accepted =:= Expected),',
    'io:format("bulk_publish_ok=~B~n", [Accepted]),',
    '{ok, Accepted}.',
  ].join(' ');
  const runner = 'set -eu; export PATH=/opt/rabbitmq/sbin:/opt/erlang/lib/erlang/bin:/bin:/usr/bin:/usr/local/bin:$PATH; expr=$(cat); /opt/rabbitmq/sbin/rabbitmqctl eval "$expr"';
  const runnerB64 = Buffer.from(runner).toString('base64');
  const command =
    `sudo kubectl exec -i -n ${pod.ns} ${pod.name} -- ` +
    `sh -lc "$(echo ${runnerB64} | base64 -d)" 2>&1`;

  let output;
  try {
    output = await ssh.run(vmIp, command, null, { stdin: erl, timeout: 60000 });
  } catch (error) {
    const ambiguous = new Error(
      'The bulk action did not return a complete broker receipt. Some commands may have been queued; no automatic retry was attempted.'
    );
    ambiguous.cause = error;
    throw ambiguous;
  }

  const markers = String(output || '').split(/\r?\n/).map((line) => line.trim())
    .filter((line) => /^bulk_publish_ok=\d+$/.test(line));
  const accepted = markers.length === 1 ? Number(markers[0].split('=')[1]) : NaN;
  if (accepted !== commands.length) {
    throw new Error(
      'The bulk action did not return an exact broker receipt. Some commands may have been queued; no automatic retry was attempted.'
    );
  }
  return { queuedCount: accepted, commandCount: commands.length };
}

function parsePawnId(value) {
  if (typeof value === 'string' && !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function offlinePresencePredicateSql(playerAlias) {
  return `(` +
    `lower(${playerAlias}.online_status::text) = 'offline' OR ` +
    `${playerAlias}.server_id IS NULL OR ` +
    `NOT EXISTS (SELECT 1 FROM active_server_ids asi ` +
    `WHERE asi.server_id = ${playerAlias}.server_id)` +
    `)`;
}

async function requireStoppedOfflineCharacter(vmIp, pawnId) {
  const status = await ssh.run(
    vmIp,
    '/home/dune/.dune/bin/battlegroup status',
    null,
    { timeout: 15000 }
  );
  const sections = status.split(/Game Servers/i);
  const battlegroupSuspended =
    /^\s*of\s+\d+\s+Ready\s+0\/0\s+Suspended\s*$/mi.test(sections[0] || '');
  const gameServerLines = (sections[1] || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const separatorIndex = gameServerLines.findIndex((line) => /^-+(?:\s+-+)+$/.test(line));
  const gameServerRows = separatorIndex >= 0
    ? gameServerLines.slice(separatorIndex + 1).filter((line) => !/No resources found/i.test(line))
    : [];
  const gameServersEmpty = separatorIndex >= 0 && gameServerRows.length === 0;
  if (sections.length < 2 || !battlegroupSuspended || !gameServersEmpty) {
    throw new Error('Battlegroup is not confirmed fully stopped; character changes were refused.');
  }

  const raw = await runPsql(vmIp,
    `SELECT COALESCE(json_agg(json_build_object(` +
    `'pawnId', ps.player_pawn_id, ` +
    `'controllerId', ps.player_controller_id, ` +
    `'onlineStatus', ps.online_status::text, ` +
    `'serverId', ps.server_id, ` +
    `'activeServer', EXISTS (SELECT 1 FROM active_server_ids asi ` +
    `WHERE asi.server_id = ps.server_id), ` +
    `'effectivelyOffline', ${offlinePresencePredicateSql('ps')}` +
    `)), '[]'::json)::text FROM player_state ps WHERE ps.player_pawn_id = ${pawnId}`
  );
  const line = raw.trim().split(/\r?\n/).find((value) => value.trim().startsWith('['));
  const players = line ? JSON.parse(line) : [];
  if (!Array.isArray(players) || players.length === 0) {
    throw new Error(`Character pawn ${pawnId} was not found.`);
  }
  if (players.length !== 1) {
    throw new Error(`Character pawn ${pawnId} has ambiguous player-state rows; character changes were refused.`);
  }
  const player = players[0];
  if (player.effectivelyOffline !== true) {
    const rawStatus = String(player.onlineStatus || 'Unknown');
    throw new Error(
      `The character must be fully logged out because it still has an active game-server session ` +
      `(database status: ${rawStatus}).`
    );
  }
  const controllerId = Number.parseInt(player.controllerId, 10);
  if (!Number.isSafeInteger(controllerId) || controllerId <= 0) {
    throw new Error(`Character pawn ${pawnId} has no valid player controller.`);
  }
  player.controllerId = controllerId;
  return player;
}

function offlineCharacterGuardSql(pawnId) {
  return `DO $character_guard$ ` +
    `DECLARE selected_player record; ` +
    `BEGIN ` +
    `BEGIN ` +
    `SELECT ps.* INTO STRICT selected_player FROM player_state ps ` +
    `WHERE ps.player_pawn_id = ${pawnId} FOR UPDATE; ` +
    `EXCEPTION ` +
    `WHEN no_data_found THEN RAISE EXCEPTION 'Character pawn ${pawnId} was not found'; ` +
    `WHEN too_many_rows THEN RAISE EXCEPTION ` +
    `'Character pawn ${pawnId} has ambiguous player-state rows; character changes were refused'; ` +
    `END; ` +
    `IF ${offlinePresencePredicateSql('selected_player')} IS DISTINCT FROM TRUE THEN ` +
    `RAISE EXCEPTION ` +
    `'Character pawn ${pawnId} must be fully logged out because it still has an active game-server session (database status: %)', ` +
    `selected_player.online_status::text; ` +
    `END IF; ` +
    `END $character_guard$; `;
}

async function backupBeforeCharacterMutation(vmIp) {
  log('Creating safety backup before character change...\n');
  const output = await ssh.run(
    vmIp,
    '/home/dune/.dune/bin/battlegroup backup',
    log,
    { timeout: 600000 }
  );
  const match = output.match(/Backup file[^:]*:\s*(\S+)/i);
  if (!match) throw new Error('Database backup did not return a verified backup path; character change refused.');
  log('Safety backup complete.\n');
  return match[1];
}

async function requireOwnedEligibleAugmentItem(vmIp, pawnId, itemId) {
  const raw = await runPsql(vmIp,
    `SELECT json_build_object(` +
    `'ownerId', inv.actor_id, 'templateId', i.template_id, ` +
    `'eligible', (COALESCE(i.template_id ILIKE '%Augment%', false) AND CASE ` +
    `WHEN jsonb_typeof(i.stats #> '{FAugmentItemStats,1,StatRolls}') = 'array' ` +
    `THEN jsonb_array_length(i.stats #> '{FAugmentItemStats,1,StatRolls}') > 0 ` +
    `ELSE false END)` +
    `)::text FROM items i JOIN inventories inv ON inv.id = i.inventory_id ` +
    `WHERE i.id = ${itemId}`
  );
  const line = raw.trim().split(/\r?\n/).find((value) => value.trim().startsWith('{'));
  if (!line) throw new Error(`Item ${itemId} was not found.`);
  const item = JSON.parse(line);
  if (Number(item.ownerId) !== pawnId) {
    throw new Error(`Item ${itemId} is not owned by character ${pawnId}.`);
  }
  if (!item.eligible) {
    throw new Error(`Item ${itemId} is not a supported standalone augment with a nonempty roll array.`);
  }
  return item;
}

async function requireCharacterBackpackCapacity(vmIp, pawnId) {
  const raw = await runPsql(vmIp,
    `SET search_path TO dune, public; ` +
    `WITH backpacks AS (` +
    `SELECT id, max_item_count FROM inventories ` +
    `WHERE actor_id = ${pawnId} AND inventory_type = 0` +
    `), selected AS (` +
    `SELECT min(id) AS id, min(max_item_count) AS max_item_count ` +
    `FROM backpacks HAVING count(*) = 1` +
    `), item_state AS (` +
    `SELECT count(i.id)::integer AS item_count, ` +
    `count(DISTINCT i.position_index)::integer AS distinct_positions, ` +
    `COALESCE(bool_and(i.position_index >= 0 AND i.position_index < selected.max_item_count), true) AS positions_valid ` +
    `FROM selected LEFT JOIN items i ON i.inventory_id = selected.id ` +
    `GROUP BY selected.max_item_count` +
    `) SELECT json_build_object(` +
    `'backpackCount', (SELECT count(*) FROM backpacks), ` +
    `'backpackId', (SELECT id FROM selected), ` +
    `'capacity', (SELECT max_item_count FROM selected), ` +
    `'itemCount', COALESCE((SELECT item_count FROM item_state), 0), ` +
    `'distinctPositions', COALESCE((SELECT distinct_positions FROM item_state), 0), ` +
    `'positionsValid', COALESCE((SELECT positions_valid FROM item_state), true)` +
    `)::text`
  );
  const line = raw.trim().split(/\r?\n/).find((value) => value.trim().startsWith('{'));
  if (!line) throw new Error('Backpack capacity preflight did not return a result.');
  const state = JSON.parse(line);
  const backpackCount = Number(state.backpackCount);
  if (backpackCount === 0) {
    throw new Error(`Backpack inventory was not found for character ${pawnId}.`);
  }
  if (backpackCount !== 1 || !Number.isSafeInteger(Number(state.backpackId))) {
    throw new Error(`Multiple Backpack inventories were found for character ${pawnId}; offline creation was refused.`);
  }
  const capacity = Number(state.capacity);
  const itemCount = Number(state.itemCount);
  const distinctPositions = Number(state.distinctPositions);
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new Error('The selected character has an invalid Backpack capacity.');
  }
  if (itemCount !== distinctPositions || state.positionsValid !== true) {
    throw new Error('The Backpack has duplicate or out-of-range positions; offline creation was refused.');
  }
  if (itemCount >= capacity) {
    throw new Error('The selected character\'s Backpack is full.');
  }
  return { backpackId: Number(state.backpackId), capacity, itemCount };
}

app.get('/api/online-actions/catalog', (_req, res) => {
  try {
    const catalog = readOnlineActionCatalog();
    const confirmedAugmentIds = reviewedBulkAugmentIds(catalog);
    res.json({
      skillModules: catalog.skillModules,
      bulkTrainingActions: REVIEWED_BULK_TRAINING_ACTIONS,
      limits: ONLINE_ACTION_LIMITS,
      itemTemplateCount: Object.keys(catalog.itemTemplates).length,
      confirmedAugmentCount: confirmedAugmentIds.length,
      excludedPackageOnlyAugmentCount: REVIEWED_PACKAGE_ONLY_AUGMENT_COUNT,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/characters/:id/online-actions', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const pawnId = parsePawnId(req.params.id);
  if (!pawnId) return res.status(400).json({ error: 'Invalid character id' });
  if (onlineActionLocks.has(pawnId)) {
    return res.status(409).json({ error: 'Another online action for this character is still being sent.' });
  }

  onlineActionLocks.add(pawnId);
  try {
    const body = req.body || {};
    const action = String(body.action || '').trim();

    if (action === 'grant-solari') {
      const amount = boundedInteger(body.amount, 'Solari amount', ONLINE_ACTION_LIMITS.solari.min, ONLINE_ACTION_LIMITS.solari.max);
      const target = await requireOnlineCommandTarget(ip, pawnId);
      const publish = await publishServerCommand(ip, {
        ServerCommand: 'AddItemToInventory',
        PlayerId: target.flsId,
        ItemName: 'SolarisCoin',
        Quantity: amount,
        Durability: 1,
      });
      log(`${amount} carried Solari queued for online character ${pawnId}.\n`);
      return res.status(202).json({
        success: true,
        action,
        amount,
        queued: publish.queued,
        brokerAccepted: publish.queued,
        command: publish.command,
        delivery: 'game-message-broker',
        message: `${amount.toLocaleString()} carried Solari was accepted by the game message broker. Check the character's inventory in-game to confirm it was applied.`,
      });
    }

    const target = await requireOnlineCommandTarget(ip, pawnId);
    const catalog = readOnlineActionCatalog();
    let inner;
    let description;

    switch (action) {
      case 'award-xp': {
        const categories = new Set(['Combat', 'Exploration', 'Science']);
        const category = String(body.category || '');
        if (!categories.has(category)) throw new Error('XP category must be Combat, Exploration, or Science.');
        const amount = boundedInteger(body.amount, 'XP amount', ONLINE_ACTION_LIMITS.xp.min, ONLINE_ACTION_LIMITS.xp.max);
        inner = { ServerCommand: 'AwardXP', PlayerId: target.flsId, Category: category, Experience: amount };
        description = `Award ${amount.toLocaleString()} ${category} XP`;
        break;
      }
      case 'set-skill-points': {
        const points = boundedInteger(body.points, 'Skill points', ONLINE_ACTION_LIMITS.skillPoints.min, ONLINE_ACTION_LIMITS.skillPoints.max);
        inner = { ServerCommand: 'SkillsSetUnspentSkillPoints', PlayerId: target.flsId, SkillPoints: points };
        description = `Set unspent skill points to ${points.toLocaleString()}`;
        break;
      }
      case 'set-skill-module': {
        const moduleId = String(body.moduleId || '').trim();
        const module = catalog.skillModules.find((entry) => entry.id === moduleId);
        if (!module) throw new Error('Select a skill module from the reviewed catalog.');
        const level = boundedInteger(body.level, 'Module level', 0, Number(module.maxLevel));
        inner = { ServerCommand: 'SkillsSetModuleLevel', PlayerId: target.flsId, Module: module.id, Level: level };
        description = `Set ${module.name} to level ${level}`;
        break;
      }
      case 'give-item': {
        const templateId = String(body.templateId || '').trim();
        if (!Object.prototype.hasOwnProperty.call(catalog.itemTemplates, templateId)) {
          throw new Error('Select an item from the reviewed item catalog.');
        }
        const catalogItem = catalog.itemTemplates[templateId];
        if (catalogItem.packageOnly === true && body.confirmPackageOnly !== true) {
          throw new Error('This package-only augment requires explicit experimental confirmation.');
        }
        const count = boundedInteger(body.count, 'Item count', ONLINE_ACTION_LIMITS.itemCount.min, ONLINE_ACTION_LIMITS.itemCount.max);
        if (catalogItem.category === 'Augments' && count !== 1) {
          throw new Error('Reviewed augment templates can only be granted one at a time.');
        }
        const durability = boundedNumber(body.durability, 'Durability', ONLINE_ACTION_LIMITS.itemDurability.min, ONLINE_ACTION_LIMITS.itemDurability.max);
        inner = { ServerCommand: 'AddItemToInventory', PlayerId: target.flsId, ItemName: templateId, Quantity: count, Durability: durability };
        description = `Give ${count.toLocaleString()} × ${catalog.itemTemplates[templateId].name || templateId}`;
        break;
      }
      case 'grant-all-confirmed-augments': {
        const batch = buildReviewedBulkAugmentGrant(target.flsId, catalog);
        const publish = await publishServerCommandBatch(ip, batch.commands);
        log(`${publish.queuedCount} confirmed augment grants queued for online character ${pawnId}.\n`);
        return res.status(202).json({
          success: true,
          action,
          brokerAccepted: true,
          queued: publish.queuedCount,
          queuedCount: publish.queuedCount,
          augmentCount: batch.templateIds.length,
          excludedPackageOnlyCount: REVIEWED_PACKAGE_ONLY_AUGMENT_COUNT,
          message: `${publish.queuedCount} individual confirmed augment grants were accepted by the game message broker. They were queued, not verified as applied; check the character's inventory or nearby ground in-game. The ${REVIEWED_PACKAGE_ONLY_AUGMENT_COUNT} package-only experimental candidates were not included.`,
        });
      }
      case 'run-training-batch': {
        const bulkActionId = String(body.bulkActionId || '').trim();
        const batch = buildReviewedBulkTrainingAction(bulkActionId, target.flsId, catalog);
        const publish = await publishServerCommandBatch(ip, batch.commands);
        log(`${batch.description}: ${publish.queuedCount} native commands queued for online character ${pawnId}.\n`);
        return res.status(202).json({
          success: true,
          action,
          bulkActionId,
          brokerAccepted: true,
          queued: publish.queuedCount,
          queuedCount: publish.queuedCount,
          message: `${batch.description}: ${publish.queuedCount} commands were accepted by the game message broker. Check in-game to confirm they were applied.`,
        });
      }
      default:
        return res.status(400).json({ error: 'Unsupported online action' });
    }

    const publish = await publishServerCommand(ip, inner);
    log(`${description} queued for online character ${pawnId}.\n`);
    return res.status(202).json({
      success: true,
      action,
      brokerAccepted: true,
      queued: publish.queued,
      command: publish.command,
      message: `${description} was accepted by the game message broker. This confirms delivery to the queue, not that the game client has applied it yet.`,
    });
  } catch (e) {
    const statusCode = e.statusCode || (/must|select|required|between|unsupported|whole number/i.test(e.message) ? 400 : 500);
    res.status(statusCode).json({ error: e.message });
  } finally {
    onlineActionLocks.delete(pawnId);
  }
});

app.get('/api/characters', async (_req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    const raw = await runPsql(ip,
      "SELECT json_agg(row_to_json(t)) FROM (" +
      "SELECT eps.player_pawn_id as id, decrypt_user_data(eps.encrypted_character_name) as name " +
      "FROM encrypted_player_state eps " +
      "WHERE eps.player_pawn_id IS NOT NULL " +
      "ORDER BY eps.player_pawn_id) t"
    );
    res.json({ characters: JSON.parse(raw.trim()) || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/characters/:id', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parsePawnId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid ID' });

  try {
    const propsRaw = await runPsql(ip, `SELECT properties::text FROM actors WHERE id = ${id}`);
    const gasRaw = await runPsql(ip, `SELECT gas_attributes::text FROM actors WHERE id = ${id}`);

    const invRaw = await runPsql(ip,
      `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (` +
      `SELECT id, inventory_type, max_item_count FROM inventories WHERE actor_id = ${id} AND inventory_type IS NOT NULL ORDER BY id) t`
    );

    const itemsRaw = await runPsql(ip,
      `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (` +
      `SELECT i.id, i.inventory_id, i.template_id, i.stack_size, i.position_index, ` +
      `i.quality_level, inv.inventory_type, ` +
      `(COALESCE(i.template_id ILIKE '%Augment%', false) AND CASE ` +
      `WHEN jsonb_typeof(i.stats #> '{FAugmentItemStats,1,StatRolls}') = 'array' ` +
      `THEN jsonb_array_length(i.stats #> '{FAugmentItemStats,1,StatRolls}') > 0 ` +
      `ELSE false END) AS augment_eligible, ` +
      `(CASE WHEN i.template_id ILIKE '%Augment%' AND ` +
      `jsonb_typeof(i.stats #> '{FAugmentItemStats,1,StatRolls}') = 'array' ` +
      `THEN (SELECT COALESCE(sum(CASE WHEN jsonb_typeof(roll.value) = 'number' ` +
      `THEN CASE WHEN roll.value::numeric > 0 THEN 1 ELSE 0 END ELSE 0 END), 0)::integer ` +
      `FROM jsonb_array_elements(i.stats #> '{FAugmentItemStats,1,StatRolls}') roll(value)) ` +
      `ELSE 0 END) ` +
      `AS augment_roll_count ` +
      `FROM items i JOIN inventories inv ON i.inventory_id = inv.id ` +
      `WHERE inv.actor_id = ${id} ORDER BY inv.inventory_type, i.position_index) t`
    );

    const stateRaw = await runPsql(ip,
      `SELECT json_build_object(` +
      `'onlineStatus', ps.online_status::text, ` +
      `'serverId', ps.server_id, ` +
      `'controllerId', ps.player_controller_id` +
      `)::text FROM player_state ps WHERE ps.player_pawn_id = ${id} LIMIT 1`
    );
    const stateLine = stateRaw.trim().split(/\r?\n/).find((value) => value.trim().startsWith('{'));
    const playerState = stateLine ? JSON.parse(stateLine) : { onlineStatus: 'Offline', serverId: null, controllerId: null };

    res.json({
      actorId: id,
      properties: JSON.parse(propsRaw.trim() || '{}'),
      gasAttributes: JSON.parse(gasRaw.trim() || '{}'),
      inventories: JSON.parse(invRaw.trim()) || [],
      items: JSON.parse(itemsRaw.trim()) || [],
      playerState,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/characters/:id/stats', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);
  const { updates } = req.body;
  if (!updates || !updates.length) return res.status(400).json({ error: 'No updates' });

  try {
    const propUpdates = updates.filter(u => u.field === 'properties');
    const gasUpdates = updates.filter(u => u.field === 'gas_attributes');

    if (propUpdates.length) {
      let expr = 'properties';
      for (const u of propUpdates) {
        const pathStr = '{' + u.path.join(',') + '}';
        expr = `jsonb_set(${expr}, '${pathStr}', '${JSON.stringify(u.value)}'::jsonb)`;
      }
      await runPsql(ip, `UPDATE actors SET properties = ${expr} WHERE id = ${id}`);
    }

    if (gasUpdates.length) {
      let expr = 'gas_attributes';
      for (const u of gasUpdates) {
        const pathStr = '{' + u.path.join(',') + '}';
        expr = `jsonb_set(${expr}, '${pathStr}', '${JSON.stringify(u.value)}'::jsonb)`;
      }
      await runPsql(ip, `UPDATE actors SET gas_attributes = ${expr} WHERE id = ${id}`);
    }

    log(`Character ${id} stats updated.\n`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create one reviewed standalone augment directly in the selected character's
// Backpack. This guarded path is intentionally separate from generic item add.
app.post('/api/characters/:id/inventory/add-augment', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parsePawnId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid character id' });

  const body = req.body;
  if (!body || Array.isArray(body) || typeof body !== 'object') {
    return res.status(400).json({ error: 'A templateId is required.' });
  }
  const bodyKeys = Object.keys(body);
  if (bodyKeys.length !== 1 || bodyKeys[0] !== 'templateId') {
    return res.status(400).json({ error: 'Only templateId is accepted for offline augment creation.' });
  }
  const templateId = String(body.templateId || '').trim();
  if (!Object.prototype.hasOwnProperty.call(REVIEWED_OFFLINE_AUGMENTS, templateId)) {
    return res.status(400).json({ error: 'Select one of the three reviewed offline augment templates.' });
  }
  const reviewedAugment = REVIEWED_OFFLINE_AUGMENTS[templateId];

  const statsJson =
    `{"FAugmentItemStats":[[],{"StatRolls":[${reviewedAugment.seed}]}],` +
    `"FItemStackAndDurabilityStats":[[],{"MaxDurability":-1.1,"CurrentDurability":-1.1,"DecayedMaxDurability":-1.1}]}`;

  try {
    await requireStoppedOfflineCharacter(ip, id);
    await requireCharacterBackpackCapacity(ip, id);
    const backup = await backupBeforeCharacterMutation(ip);
    await requireStoppedOfflineCharacter(ip, id);

    const raw = await runPsql(ip,
      `BEGIN; ` +
      `SET LOCAL search_path TO dune, public; ` +
      offlineCharacterGuardSql(id) +
      `CREATE TEMP TABLE offline_augment_backpack (` +
      `inventory_id bigint PRIMARY KEY, max_item_count integer NOT NULL, position_index integer` +
      `) ON COMMIT DROP; ` +
      `INSERT INTO offline_augment_backpack (inventory_id, max_item_count) ` +
      `SELECT inv.id, inv.max_item_count FROM inventories inv ` +
      `WHERE inv.actor_id = ${id} AND inv.inventory_type = 0 FOR UPDATE OF inv; ` +
      `DO $offline_augment_backpack_guard$ ` +
      `DECLARE item_count integer; distinct_positions integer; invalid_positions integer; backpack_capacity integer; ` +
      `BEGIN ` +
      `IF (SELECT count(*) FROM offline_augment_backpack) <> 1 THEN ` +
      `RAISE EXCEPTION 'Expected exactly one Backpack inventory for character ${id}'; END IF; ` +
      `SELECT max_item_count INTO backpack_capacity FROM offline_augment_backpack; ` +
      `IF backpack_capacity IS NULL OR backpack_capacity <= 0 THEN ` +
      `RAISE EXCEPTION 'The selected character has an invalid Backpack capacity'; END IF; ` +
      `PERFORM i.id FROM items i JOIN offline_augment_backpack backpack ` +
      `ON backpack.inventory_id = i.inventory_id ORDER BY i.id FOR UPDATE OF i; ` +
      `SELECT count(*)::integer, count(DISTINCT i.position_index)::integer, ` +
      `count(*) FILTER (WHERE i.position_index < 0 OR i.position_index >= backpack.max_item_count)::integer ` +
      `INTO item_count, distinct_positions, invalid_positions ` +
      `FROM items i JOIN offline_augment_backpack backpack ON backpack.inventory_id = i.inventory_id; ` +
      `IF item_count <> distinct_positions OR invalid_positions <> 0 THEN ` +
      `RAISE EXCEPTION 'The Backpack has duplicate or out-of-range positions'; END IF; ` +
      `IF item_count >= backpack_capacity THEN RAISE EXCEPTION 'The selected character''s Backpack is full'; END IF; ` +
      `END $offline_augment_backpack_guard$; ` +
      `UPDATE offline_augment_backpack backpack SET position_index = (` +
      `SELECT slot FROM generate_series(0, backpack.max_item_count - 1) AS free_slots(slot) ` +
      `WHERE NOT EXISTS (SELECT 1 FROM items i WHERE i.inventory_id = backpack.inventory_id ` +
      `AND i.position_index = free_slots.slot) ORDER BY slot LIMIT 1` +
      `); ` +
      `DO $offline_augment_slot_guard$ BEGIN ` +
      `IF (SELECT position_index FROM offline_augment_backpack) IS NULL THEN ` +
      `RAISE EXCEPTION 'No free Backpack position was found'; END IF; ` +
      `END $offline_augment_slot_guard$; ` +
      `CREATE TEMP TABLE offline_augment_inserted (` +
      `item_id bigint PRIMARY KEY, inventory_id bigint NOT NULL, position_index integer NOT NULL, ` +
      `acquisition_time bigint NOT NULL` +
      `) ON COMMIT DROP; ` +
      `WITH inserted AS (` +
      `INSERT INTO items (` +
      `inventory_id, template_id, stack_size, position_index, stats, is_new, acquisition_time, quality_level, volume_override` +
      `) SELECT backpack.inventory_id, '${templateId}', 1, backpack.position_index, '${statsJson}'::jsonb, ` +
      `true, extract(epoch FROM clock_timestamp())::bigint, 1, NULL ` +
      `FROM offline_augment_backpack backpack ` +
      `RETURNING id, inventory_id, position_index, acquisition_time` +
      `) INSERT INTO offline_augment_inserted (item_id, inventory_id, position_index, acquisition_time) ` +
      `SELECT id, inventory_id, position_index, acquisition_time FROM inserted; ` +
      `DO $offline_augment_verify$ BEGIN ` +
      `IF (SELECT count(*) FROM offline_augment_inserted) <> 1 THEN ` +
      `RAISE EXCEPTION 'Offline augment insert row-count verification failed'; END IF; ` +
      `IF EXISTS (` +
      `SELECT 1 FROM offline_augment_inserted created ` +
      `JOIN offline_augment_backpack backpack ON backpack.inventory_id = created.inventory_id ` +
      `LEFT JOIN items i ON i.id = created.item_id ` +
      `LEFT JOIN inventories inv ON inv.id = i.inventory_id ` +
      `WHERE i.id IS NULL OR inv.id IS NULL OR inv.actor_id IS DISTINCT FROM ${id} ` +
      `OR inv.inventory_type IS DISTINCT FROM 0 ` +
      `OR i.inventory_id IS DISTINCT FROM backpack.inventory_id ` +
      `OR i.position_index IS DISTINCT FROM backpack.position_index ` +
      `OR i.position_index IS DISTINCT FROM created.position_index ` +
      `OR i.template_id IS DISTINCT FROM '${templateId}' ` +
      `OR i.stack_size IS DISTINCT FROM 1 OR i.is_new IS DISTINCT FROM true ` +
      `OR i.acquisition_time IS DISTINCT FROM created.acquisition_time ` +
      `OR i.quality_level IS DISTINCT FROM 1 OR i.volume_override IS NOT NULL ` +
      `OR i.stats IS DISTINCT FROM '${statsJson}'::jsonb` +
      `) THEN RAISE EXCEPTION 'Offline augment readback verification failed'; END IF; ` +
      `END $offline_augment_verify$; ` +
      `SELECT json_build_object(` +
      `'itemId', created.item_id, 'inventoryId', created.inventory_id, ` +
      `'positionIndex', created.position_index, 'acquisitionTime', created.acquisition_time, ` +
      `'templateId', '${templateId}', 'qualityLevel', 1, 'verified', true` +
      `)::text FROM offline_augment_inserted created; ` +
      `COMMIT;`,
      { timeout: 120000 }
    );

    const line = raw.trim().split(/\r?\n/).find((value) => value.trim().startsWith('{'));
    if (!line) throw new Error('Offline augment creation committed but verified readback was unavailable.');
    const result = JSON.parse(line);
    if (!result.verified || result.templateId !== templateId || Number(result.qualityLevel) !== 1 ||
        !Number.isSafeInteger(Number(result.itemId)) || !Number.isSafeInteger(Number(result.positionIndex))) {
      throw new Error('Offline augment readback did not match the requested template.');
    }

    log(`Created one verified ${reviewedAugment.name} in character ${id}'s Backpack.\n`);
    res.json({
      success: true,
      ...result,
      backup,
      experimental: reviewedAugment.installedDerived,
    });
  } catch (e) {
    const message = e.message || 'Offline augment creation failed';
    const statusCode = /not confirmed fully stopped|fully logged out|must be Offline|Backpack is full|No free Backpack|Multiple Backpack|Expected exactly one Backpack|duplicate or out-of-range/i.test(message)
      ? 409
      : (/not found/i.test(message) ? 404 : (/invalid|Select one|Only templateId|required/i.test(message) ? 400 : 500));
    res.status(statusCode).json({ error: message });
  }
});

app.post('/api/characters/:id/inventory/add', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const actorId = parseInt(req.params.id);
  const { templateId, stackSize, inventoryId, isEquipment } = req.body;

  if (!templateId || !stackSize || !inventoryId) {
    return res.status(400).json({ error: 'templateId, stackSize, and inventoryId required' });
  }

  const submittedTemplateId = String(templateId).trim();
  let catalogItem;
  try {
    catalogItem = readOnlineActionCatalog().itemTemplates[submittedTemplateId];
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
  if (catalogItem?.category === 'Augments' || /augment/i.test(submittedTemplateId)) {
    return res.status(400).json({
      error: 'Augments must use the dedicated reviewed online grant or guarded offline creation action.',
    });
  }

  const safeId = submittedTemplateId.replace(/'/g, "''");
  const stats = isEquipment
    ? '{"FCustomizationStats": [[], {}], "FItemStackAndDurabilityStats": [[], {}]}'
    : '{"FItemStackAndDurabilityStats": [[], {"DecayedMaxDurability": 0.0}]}';

  try {
    const posRaw = await runPsql(ip,
      `SELECT COALESCE(MAX(position_index) + 1, 0) FROM items WHERE inventory_id = ${inventoryId}`
    );
    const nextPos = parseInt(posRaw.trim()) || 0;

    await runPsql(ip,
      `INSERT INTO items (inventory_id, template_id, stack_size, position_index, stats) ` +
      `VALUES (${inventoryId}, '${safeId}', ${parseInt(stackSize)}, ${nextPos}, '${stats}'::jsonb)`
    );

    log(`Added ${stackSize}x ${templateId} to inventory.\n`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Max one persisted augment in the selected character's owned inventories.
// The row and its owning inventory are locked and revalidated inside the write transaction.
app.post('/api/characters/:id/inventory/:itemId/augment/max', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parsePawnId(req.params.id);
  const itemId = parsePawnId(req.params.itemId);
  if (!id) return res.status(400).json({ error: 'Invalid character id' });
  if (!itemId) return res.status(400).json({ error: 'Invalid item id' });

  try {
    await requireStoppedOfflineCharacter(ip, id);
    await requireOwnedEligibleAugmentItem(ip, id, itemId);
    const backup = await backupBeforeCharacterMutation(ip);
    await requireStoppedOfflineCharacter(ip, id);

    const raw = await runPsql(ip,
      `BEGIN; ` +
      `SET LOCAL search_path TO dune, public; ` +
      offlineCharacterGuardSql(id) +
      `DO $augment_item_guard$ ` +
      `DECLARE owner_id bigint; item_template text; item_stats jsonb; ` +
      `BEGIN ` +
      `SELECT inv.actor_id, i.template_id, i.stats ` +
      `INTO owner_id, item_template, item_stats ` +
      `FROM items i JOIN inventories inv ON inv.id = i.inventory_id ` +
      `WHERE i.id = ${itemId} FOR UPDATE OF i, inv; ` +
      `IF NOT FOUND THEN RAISE EXCEPTION 'Item ${itemId} was not found'; END IF; ` +
      `IF owner_id IS DISTINCT FROM ${id} THEN ` +
      `RAISE EXCEPTION 'Item ${itemId} is not owned by character ${id}'; END IF; ` +
      `IF (item_template ILIKE '%Augment%') IS NOT TRUE THEN ` +
      `RAISE EXCEPTION 'Item ${itemId} is not a supported augment'; END IF; ` +
      `IF (CASE WHEN jsonb_typeof(item_stats #> '{FAugmentItemStats,1,StatRolls}') = 'array' ` +
      `THEN jsonb_array_length(item_stats #> '{FAugmentItemStats,1,StatRolls}') > 0 ` +
      `ELSE false END) IS NOT TRUE THEN ` +
      `RAISE EXCEPTION 'Item ${itemId} has no supported augment roll array'; END IF; ` +
      `END $augment_item_guard$; ` +
      `CREATE TEMP TABLE augment_item_target (` +
      `item_id bigint PRIMARY KEY, inventory_id bigint NOT NULL, expected_rolls jsonb NOT NULL, ` +
      `numeric_rolls integer NOT NULL, changed_rolls integer NOT NULL, grade_changed integer NOT NULL` +
      `) ON COMMIT DROP; ` +
      `INSERT INTO augment_item_target ` +
      `(item_id, inventory_id, expected_rolls, numeric_rolls, changed_rolls, grade_changed) ` +
      `SELECT i.id, i.inventory_id, ` +
      `(SELECT jsonb_agg(CASE ` +
      `WHEN jsonb_typeof(roll.value) <> 'number' THEN roll.value ` +
      `WHEN roll.value::numeric <= 0 THEN roll.value ` +
      `ELSE to_jsonb(1.003398::numeric) END ORDER BY roll.ordinality) ` +
      `FROM jsonb_array_elements(i.stats #> '{FAugmentItemStats,1,StatRolls}') ` +
      `WITH ORDINALITY AS roll(value, ordinality)), ` +
      `(SELECT COALESCE(sum(CASE WHEN jsonb_typeof(roll.value) = 'number' ` +
      `THEN CASE WHEN roll.value::numeric > 0 THEN 1 ELSE 0 END ELSE 0 END), 0)::integer ` +
      `FROM jsonb_array_elements(i.stats #> '{FAugmentItemStats,1,StatRolls}') roll(value)), ` +
      `(SELECT COALESCE(sum(CASE WHEN jsonb_typeof(roll.value) = 'number' ` +
      `THEN CASE WHEN roll.value::numeric > 0 AND roll.value::numeric <> 1.003398::numeric ` +
      `THEN 1 ELSE 0 END ELSE 0 END), 0)::integer ` +
      `FROM jsonb_array_elements(i.stats #> '{FAugmentItemStats,1,StatRolls}') roll(value)), ` +
      `CASE WHEN i.quality_level IS DISTINCT FROM 5 THEN 1 ELSE 0 END ` +
      `FROM items i JOIN inventories inv ON inv.id = i.inventory_id ` +
      `WHERE i.id = ${itemId} AND inv.actor_id = ${id} ` +
      `AND i.template_id ILIKE '%Augment%' ` +
      `AND CASE WHEN jsonb_typeof(i.stats #> '{FAugmentItemStats,1,StatRolls}') = 'array' ` +
      `THEN jsonb_array_length(i.stats #> '{FAugmentItemStats,1,StatRolls}') > 0 ELSE false END; ` +
      `CREATE TEMP TABLE augment_item_updated (item_id bigint PRIMARY KEY) ON COMMIT DROP; ` +
      `WITH updated AS (` +
      `UPDATE items i SET ` +
      `stats = jsonb_set(i.stats, '{FAugmentItemStats,1,StatRolls}', target.expected_rolls, false), ` +
      `quality_level = 5 ` +
      `FROM augment_item_target target ` +
      `WHERE i.id = target.item_id AND i.inventory_id = target.inventory_id RETURNING i.id` +
      `) INSERT INTO augment_item_updated (item_id) SELECT id FROM updated; ` +
      `DO $augment_item_verify$ BEGIN ` +
      `IF (SELECT count(*) FROM augment_item_target) <> 1 ` +
      `OR (SELECT count(*) FROM augment_item_updated) <> 1 THEN ` +
      `RAISE EXCEPTION 'Single augment row-count verification failed'; END IF; ` +
      `IF EXISTS (` +
      `SELECT 1 FROM augment_item_target target ` +
      `LEFT JOIN items i ON i.id = target.item_id ` +
      `LEFT JOIN inventories inv ON inv.id = i.inventory_id ` +
      `WHERE i.id IS NULL OR inv.id IS NULL OR inv.actor_id IS DISTINCT FROM ${id} ` +
      `OR i.inventory_id IS DISTINCT FROM target.inventory_id ` +
      `OR (i.template_id ILIKE '%Augment%') IS NOT TRUE ` +
      `OR i.quality_level IS DISTINCT FROM 5 ` +
      `OR i.stats #> '{FAugmentItemStats,1,StatRolls}' IS DISTINCT FROM target.expected_rolls` +
      `) THEN RAISE EXCEPTION 'Single augment readback verification failed'; END IF; ` +
      `END $augment_item_verify$; ` +
      `SELECT json_build_object(` +
      `'itemId', (SELECT item_id FROM augment_item_target), ` +
      `'updatedItems', (SELECT count(*) FROM augment_item_updated), ` +
      `'numericAttributes', (SELECT numeric_rolls FROM augment_item_target), ` +
      `'changedAttributes', (SELECT changed_rolls FROM augment_item_target), ` +
      `'gradeChanges', (SELECT grade_changed FROM augment_item_target), ` +
      `'qualityLevel', 5, 'maxValue', 1.003398, 'verified', true` +
      `)::text; ` +
      `COMMIT;`,
      { timeout: 120000 }
    );

    const line = raw.trim().split(/\r?\n/).find((value) => value.trim().startsWith('{'));
    if (!line) throw new Error('Augment update committed but verified readback was unavailable.');
    const result = JSON.parse(line);
    if (!result.verified || Number(result.itemId) !== itemId || Number(result.updatedItems) !== 1 ||
        Number(result.qualityLevel) !== 5) {
      throw new Error('Augment readback did not match the selected item.');
    }

    log(`Verified maximum augment attributes and Grade 5 for item ${itemId} owned by character ${id}.\n`);
    res.json({ success: true, ...result, backup });
  } catch (e) {
    const message = e.message || 'Augment item update failed';
    const statusCode = /not confirmed fully stopped|fully logged out|must be Offline/i.test(message)
      ? 409
      : (/not found|not owned/i.test(message) ? 404 : (/not a supported.*augment|no supported augment/i.test(message) ? 400 : 500));
    res.status(statusCode).json({ error: message });
  }
});

// Max every confirmed positive numeric roll and set Grade 5 for supported augments
// in this character's owned inventories. Sentinels and non-numeric entries are preserved.
app.post('/api/characters/:id/augments/max-attributes', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parsePawnId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid character id' });

  try {
    await requireStoppedOfflineCharacter(ip, id);
    const backup = await backupBeforeCharacterMutation(ip);
    await requireStoppedOfflineCharacter(ip, id);

    const raw = await runPsql(ip,
      `BEGIN; ` +
      `SET LOCAL search_path TO dune, public; ` +
      offlineCharacterGuardSql(id) +
      `CREATE TEMP TABLE augment_attribute_targets (` +
      `item_id bigint PRIMARY KEY, expected_rolls jsonb NOT NULL, ` +
      `numeric_rolls integer NOT NULL, changed_rolls integer NOT NULL, ` +
      `grade_changed integer NOT NULL` +
      `) ON COMMIT DROP; ` +
      `INSERT INTO augment_attribute_targets ` +
      `(item_id, expected_rolls, numeric_rolls, changed_rolls, grade_changed) ` +
      `SELECT i.id, ` +
      `(SELECT jsonb_agg(CASE ` +
      `WHEN jsonb_typeof(roll.value) <> 'number' THEN roll.value ` +
      `WHEN roll.value::numeric <= 0 THEN roll.value ` +
      `ELSE to_jsonb(1.003398::numeric) END ORDER BY roll.ordinality) ` +
      `FROM jsonb_array_elements(i.stats #> '{FAugmentItemStats,1,StatRolls}') ` +
      `WITH ORDINALITY AS roll(value, ordinality)), ` +
      `(SELECT COALESCE(sum(CASE WHEN jsonb_typeof(roll.value) = 'number' ` +
      `THEN CASE WHEN roll.value::numeric > 0 THEN 1 ELSE 0 END ELSE 0 END), 0)::integer ` +
      `FROM jsonb_array_elements(i.stats #> '{FAugmentItemStats,1,StatRolls}') roll(value)), ` +
      `(SELECT COALESCE(sum(CASE WHEN jsonb_typeof(roll.value) = 'number' ` +
      `THEN CASE WHEN roll.value::numeric > 0 AND roll.value::numeric <> 1.003398::numeric ` +
      `THEN 1 ELSE 0 END ELSE 0 END), 0)::integer ` +
      `FROM jsonb_array_elements(i.stats #> '{FAugmentItemStats,1,StatRolls}') roll(value)), ` +
      `CASE WHEN i.quality_level IS DISTINCT FROM 5 THEN 1 ELSE 0 END ` +
      `FROM items i JOIN inventories inv ON inv.id = i.inventory_id ` +
      `WHERE inv.actor_id = ${id} ` +
      `AND i.template_id ILIKE '%Augment%' ` +
      `AND CASE WHEN jsonb_typeof(i.stats #> '{FAugmentItemStats,1,StatRolls}') = 'array' ` +
      `THEN jsonb_array_length(i.stats #> '{FAugmentItemStats,1,StatRolls}') > 0 ELSE false END ` +
      `FOR UPDATE OF i, inv; ` +
      `CREATE TEMP TABLE augment_attribute_updated (` +
      `item_id bigint PRIMARY KEY` +
      `) ON COMMIT DROP; ` +
      `WITH updated AS (` +
      `UPDATE items i SET ` +
      `stats = jsonb_set(i.stats, '{FAugmentItemStats,1,StatRolls}', target.expected_rolls, false), ` +
      `quality_level = 5 ` +
      `FROM augment_attribute_targets target WHERE i.id = target.item_id RETURNING i.id` +
      `) INSERT INTO augment_attribute_updated (item_id) SELECT id FROM updated; ` +
      `DO $augment_verify$ BEGIN ` +
      `IF (SELECT count(*) FROM augment_attribute_updated) <> ` +
      `(SELECT count(*) FROM augment_attribute_targets) THEN ` +
      `RAISE EXCEPTION 'Augment row-count verification failed'; END IF; ` +
      `IF EXISTS (` +
      `SELECT 1 FROM augment_attribute_targets target ` +
      `LEFT JOIN items i ON i.id = target.item_id ` +
      `LEFT JOIN inventories inv ON inv.id = i.inventory_id ` +
      `WHERE i.id IS NULL OR inv.actor_id IS DISTINCT FROM ${id} ` +
      `OR (i.template_id ILIKE '%Augment%') IS NOT TRUE ` +
      `OR i.quality_level IS DISTINCT FROM 5 ` +
      `OR i.stats #> '{FAugmentItemStats,1,StatRolls}' IS DISTINCT FROM target.expected_rolls` +
      `) THEN RAISE EXCEPTION 'Augment attribute readback verification failed'; END IF; ` +
      `END $augment_verify$; ` +
      `SELECT json_build_object(` +
      `'eligibleItems', (SELECT count(*) FROM augment_attribute_targets), ` +
      `'updatedItems', (SELECT count(*) FROM augment_attribute_updated), ` +
      `'numericAttributes', (SELECT COALESCE(sum(numeric_rolls), 0) FROM augment_attribute_targets), ` +
      `'changedAttributes', (SELECT COALESCE(sum(changed_rolls), 0) FROM augment_attribute_targets), ` +
      `'gradeChanges', (SELECT COALESCE(sum(grade_changed), 0) FROM augment_attribute_targets), ` +
      `'qualityLevel', 5, 'maxValue', 1.003398, 'verified', true` +
      `)::text; ` +
      `COMMIT;`,
      { timeout: 120000 }
    );

    const line = raw.trim().split(/\r?\n/).find((value) => value.trim().startsWith('{'));
    if (!line) throw new Error('Augment update committed but verified readback was unavailable.');
    const result = JSON.parse(line);
    if (!result.verified || Number(result.updatedItems) !== Number(result.eligibleItems)) {
      throw new Error('Augment attribute readback did not match the targeted item count.');
    }

    log(`Verified maximum augment attributes and Grade 5 for ${result.updatedItems} item(s) owned by character ${id}.\n`);
    res.json({ success: true, ...result, backup });
  } catch (e) {
    const message = e.message || 'Augment attribute update failed';
    const statusCode = /not confirmed fully stopped|fully logged out|must be Offline/i.test(message)
      ? 409
      : (/not found/i.test(message) ? 404 : 500);
    res.status(statusCode).json({ error: message });
  }
});

// Unlock all tech tree recipes
app.post('/api/characters/:id/tech/unlock-all', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parsePawnId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid character id' });

  try {
    await requireStoppedOfflineCharacter(ip, id);
    const backup = await backupBeforeCharacterMutation(ip);
    await requireStoppedOfflineCharacter(ip, id);
    const raw = await runPsql(ip,
      `BEGIN; ` +
      `SET LOCAL search_path TO dune, public; ` +
      offlineCharacterGuardSql(id) +
      `DO $tech_unlock$ ` +
      `DECLARE actor_props jsonb; tech_entries jsonb; recipe_entries jsonb; ` +
      `tech_entry jsonb; item_key text; recipe_id text; ` +
      `BEGIN ` +
      `SELECT properties INTO actor_props FROM actors WHERE id = ${id} FOR UPDATE; ` +
      `IF actor_props IS NULL THEN RAISE EXCEPTION 'Character actor ${id} was not found'; END IF; ` +
      `SELECT COALESCE(jsonb_agg(` +
      `jsonb_set(jsonb_set(entry, '{UnlockedState}', '"Purchased"'::jsonb), ` +
      `'{bIsNewEntry}', 'false'::jsonb)), '[]'::jsonb) INTO tech_entries ` +
      `FROM jsonb_array_elements(COALESCE(actor_props #> ` +
      `'{TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData}', '[]'::jsonb)) entry; ` +
      `recipe_entries := COALESCE(actor_props #> ` +
      `'{CraftingRecipesLibraryActorComponent,m_KnownItemRecipes}', '[]'::jsonb); ` +
      `FOR tech_entry IN SELECT value FROM jsonb_array_elements(tech_entries) LOOP ` +
      `item_key := tech_entry->>'ItemKey'; recipe_id := NULL; ` +
      `IF left(item_key, 4) = 'RCP_' THEN recipe_id := substring(item_key from 5); ` +
      `ELSIF left(item_key, 4) = 'BLD_' THEN recipe_id := substring(item_key from 5); ` +
      `IF right(recipe_id, 7) <> '_Patent' THEN recipe_id := recipe_id || '_Patent'; END IF; END IF; ` +
      `IF recipe_id IS NOT NULL ` +
      `AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(recipe_entries) r ` +
      `WHERE r->'BaseRecipeId'->>'Name' = recipe_id) ` +
      `AND EXISTS (SELECT 1 FROM actors candidate CROSS JOIN LATERAL ` +
      `jsonb_array_elements(COALESCE(candidate.properties #> ` +
      `'{CraftingRecipesLibraryActorComponent,m_KnownItemRecipes}', '[]'::jsonb)) observed ` +
      `WHERE observed->'BaseRecipeId'->>'Name' = recipe_id) THEN ` +
      `recipe_entries := recipe_entries || jsonb_build_array(jsonb_build_object(` +
      `'m_Source', 'SchematicPickup', 'm_bIsNew', true, ` +
      `'BaseRecipeId', jsonb_build_object('Name', recipe_id), ` +
      `'m_QualityLevel', 0, 'm_NumberOfRecipeUses', 0, 'm_bIsLimitedUseRecipe', false)); ` +
      `END IF; END LOOP; ` +
      `actor_props := jsonb_set(jsonb_set(jsonb_set(actor_props, ` +
      `'{TechKnowledgePlayerComponent,m_TechKnowledgePoints}', '2779'::jsonb, true), ` +
      `'{TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData}', tech_entries, true), ` +
      `'{CraftingRecipesLibraryActorComponent,m_KnownItemRecipes}', recipe_entries, true); ` +
      `UPDATE actors SET properties = actor_props WHERE id = ${id}; ` +
      `IF NOT FOUND THEN RAISE EXCEPTION 'Character actor ${id} changed concurrently'; END IF; ` +
      `IF EXISTS (SELECT 1 FROM jsonb_array_elements(tech_entries) e ` +
      `WHERE e->>'UnlockedState' <> 'Purchased') THEN ` +
      `RAISE EXCEPTION 'Tech unlock verification failed'; END IF; ` +
      `END $tech_unlock$; ` +
      `COMMIT; ` +
      `SELECT json_build_object(` +
      `'total', jsonb_array_length(properties #> ` +
      `'{TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData}'), ` +
      `'knownRecipes', jsonb_array_length(properties #> ` +
      `'{CraftingRecipesLibraryActorComponent,m_KnownItemRecipes}')` +
      `)::text FROM actors WHERE id = ${id};`,
      { timeout: 120000 }
    );
    const summaryLine = raw.trim().split(/\r?\n/).reverse().find((line) => line.trim().startsWith('{'));
    if (!summaryLine) throw new Error('Tech unlock completed without a verification summary.');
    const summary = JSON.parse(summaryLine);
    log(`All ${summary.total} game-created tech entries unlocked for character ${id}; ${summary.knownRecipes} known recipes verified.\n`);
    res.json({
      success: true,
      total: summary.total,
      knownRecipes: summary.knownRecipes,
      added: 0,
      safeMode: true,
      backup,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Lock all tech tree recipes (reset)
app.post('/api/characters/:id/tech/lock-all', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parsePawnId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid character id' });

  try {
    await requireStoppedOfflineCharacter(ip, id);
    const backup = await backupBeforeCharacterMutation(ip);
    await requireStoppedOfflineCharacter(ip, id);
    await runPsql(ip,
      `BEGIN; SET LOCAL search_path TO dune, public; ` +
      offlineCharacterGuardSql(id) +
      `SELECT id FROM actors WHERE id = ${id} FOR UPDATE; ` +
      `UPDATE actors SET properties = jsonb_set(` +
      `properties, '{TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData}', ` +
      `(SELECT jsonb_agg(jsonb_set(elem, '{UnlockedState}', '"NotPurchased"')) ` +
      `FROM jsonb_array_elements(properties->'TechKnowledgePlayerComponent'->'m_TechKnowledge'->'m_TechKnowledgeData') as elem)` +
      `) WHERE id = ${id}; ` +
      `DO $verify$ BEGIN IF EXISTS (` +
      `SELECT 1 FROM actors a CROSS JOIN LATERAL jsonb_array_elements(` +
      `a.properties #> '{TechKnowledgePlayerComponent,m_TechKnowledge,m_TechKnowledgeData}') e ` +
      `WHERE a.id = ${id} AND e->>'UnlockedState' <> 'NotPurchased') THEN ` +
      `RAISE EXCEPTION 'Tech lock verification failed'; END IF; END $verify$; COMMIT;`
    );
    log(`All tech tree recipes locked for character ${id}.\n`);
    res.json({ success: true, backup });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get cosmetics list
app.get('/api/characters/:id/cosmetics', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);

  try {
    const raw = await runPsql(ip,
      `SELECT COALESCE(json_agg(elem->>'m_CustomizationId' ORDER BY elem->>'m_CustomizationId'), '[]') ` +
      `FROM (SELECT jsonb_array_elements(properties->'CustomizationLibraryActorComponent'` +
      `->'m_UnlockedCustomizationSerializableList'->'m_UnlockedCustomizationIds') as elem ` +
      `FROM actors WHERE id = ${id}) sub`
    );
    res.json({ cosmetics: JSON.parse(raw.trim()) || [] });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Add cosmetic
app.post('/api/characters/:id/cosmetics/add', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parsePawnId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid character id' });
  const { cosmeticId } = req.body;
  if (!cosmeticId) return res.status(400).json({ error: 'cosmeticId required' });

  const safe = String(cosmeticId);
  if (!loadCosmeticCatalogIds().includes(safe)) {
    return res.status(400).json({ error: 'Cosmetic ID is not in the reviewed persisted-data catalog.' });
  }
  try {
    await requireStoppedOfflineCharacter(ip, id);
    const backup = await backupBeforeCharacterMutation(ip);
    await requireStoppedOfflineCharacter(ip, id);
    await runPsql(ip,
      `BEGIN; SET LOCAL search_path TO dune, public; ` +
      offlineCharacterGuardSql(id) +
      `SELECT id FROM actors WHERE id = ${id} FOR UPDATE; ` +
      `UPDATE actors SET properties = jsonb_set(properties, ` +
      `'{CustomizationLibraryActorComponent,m_UnlockedCustomizationSerializableList,m_UnlockedCustomizationIds}', ` +
      `(properties->'CustomizationLibraryActorComponent'->'m_UnlockedCustomizationSerializableList'->'m_UnlockedCustomizationIds') ` +
      `|| '[{"m_CustomizationId": "${safe.replace(/'/g, "''")}"}]'::jsonb` +
      `) WHERE id = ${id} AND NOT EXISTS (` +
      `SELECT 1 FROM jsonb_array_elements(properties->'CustomizationLibraryActorComponent'` +
      `->'m_UnlockedCustomizationSerializableList'->'m_UnlockedCustomizationIds') elem ` +
      `WHERE elem->>'m_CustomizationId' = '${safe.replace(/'/g, "''")}'); ` +
      `DO $verify$ BEGIN IF NOT EXISTS (` +
      `SELECT 1 FROM actors a CROSS JOIN LATERAL jsonb_array_elements(` +
      `a.properties #> '{CustomizationLibraryActorComponent,m_UnlockedCustomizationSerializableList,m_UnlockedCustomizationIds}') e ` +
      `WHERE a.id = ${id} AND e->>'m_CustomizationId' = '${safe.replace(/'/g, "''")}') THEN ` +
      `RAISE EXCEPTION 'Cosmetic add verification failed'; END IF; END $verify$; COMMIT;`
    );
    log(`Cosmetic "${safe}" added to character ${id}.\n`);
    res.json({ success: true, backup });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Remove cosmetic
app.post('/api/characters/:id/cosmetics/remove', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parsePawnId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid character id' });
  const { cosmeticId } = req.body;
  if (!cosmeticId) return res.status(400).json({ error: 'cosmeticId required' });

  const safe = String(cosmeticId);
  if (!loadCosmeticCatalogIds().includes(safe)) {
    return res.status(400).json({ error: 'Cosmetic ID is not in the reviewed persisted-data catalog.' });
  }
  try {
    await requireStoppedOfflineCharacter(ip, id);
    const backup = await backupBeforeCharacterMutation(ip);
    await requireStoppedOfflineCharacter(ip, id);
    await runPsql(ip,
      `BEGIN; SET LOCAL search_path TO dune, public; ` +
      offlineCharacterGuardSql(id) +
      `SELECT id FROM actors WHERE id = ${id} FOR UPDATE; ` +
      `UPDATE actors SET properties = jsonb_set(properties, ` +
      `'{CustomizationLibraryActorComponent,m_UnlockedCustomizationSerializableList,m_UnlockedCustomizationIds}', ` +
      `(SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb) FROM jsonb_array_elements(` +
      `properties->'CustomizationLibraryActorComponent'->'m_UnlockedCustomizationSerializableList'->'m_UnlockedCustomizationIds'` +
      `) as elem WHERE elem->>'m_CustomizationId' != '${safe.replace(/'/g, "''")}')` +
      `) WHERE id = ${id}; ` +
      `DO $verify$ BEGIN IF EXISTS (` +
      `SELECT 1 FROM actors a CROSS JOIN LATERAL jsonb_array_elements(` +
      `a.properties #> '{CustomizationLibraryActorComponent,m_UnlockedCustomizationSerializableList,m_UnlockedCustomizationIds}') e ` +
      `WHERE a.id = ${id} AND e->>'m_CustomizationId' = '${safe.replace(/'/g, "''")}') THEN ` +
      `RAISE EXCEPTION 'Cosmetic remove verification failed'; END IF; END $verify$; COMMIT;`
    );
    log(`Cosmetic "${safe}" removed from character ${id}.\n`);
    res.json({ success: true, backup });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

function loadCosmeticCatalogIds() {
  const catalogPath = path.join(__dirname, 'public', 'data', 'cosmetic-catalog.json');
  const data = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  return Object.entries(data.cosmetics || {})
    .filter(([id, info]) => info.unlock !== 'inventory' && !id.startsWith('Swatch_'))
    .map(([id]) => id)
    .sort();
}

// Unlock all cosmetics from catalog (merge with existing)
app.post('/api/characters/:id/cosmetics/unlock-all', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parsePawnId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid character id' });

  try {
    await requireStoppedOfflineCharacter(ip, id);
    const backup = await backupBeforeCharacterMutation(ip);
    await requireStoppedOfflineCharacter(ip, id);
    const catalogIds = loadCosmeticCatalogIds();
    const catalogPayload = JSON.stringify(catalogIds.map((cid) => ({ m_CustomizationId: cid })))
      .replace(/'/g, "''");
    const raw = await runPsql(ip,
      `BEGIN; SET LOCAL search_path TO dune, public; ` +
      offlineCharacterGuardSql(id) +
      `DO $cosmetic_unlock$ ` +
      `DECLARE actor_props jsonb; current_entries jsonb; catalog_entries jsonb; candidate jsonb; ` +
      `BEGIN SELECT properties INTO actor_props FROM actors WHERE id = ${id} FOR UPDATE; ` +
      `IF actor_props IS NULL THEN RAISE EXCEPTION 'Character actor ${id} was not found'; END IF; ` +
      `current_entries := COALESCE(actor_props #> ` +
      `'{CustomizationLibraryActorComponent,m_UnlockedCustomizationSerializableList,m_UnlockedCustomizationIds}', '[]'::jsonb); ` +
      `catalog_entries := '${catalogPayload}'::jsonb; ` +
      `FOR candidate IN SELECT value FROM jsonb_array_elements(catalog_entries) LOOP ` +
      `IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(current_entries) e ` +
      `WHERE e->>'m_CustomizationId' = candidate->>'m_CustomizationId') THEN ` +
      `current_entries := current_entries || jsonb_build_array(candidate); END IF; END LOOP; ` +
      `actor_props := jsonb_set(actor_props, ` +
      `'{CustomizationLibraryActorComponent,m_UnlockedCustomizationSerializableList,m_UnlockedCustomizationIds}', ` +
      `current_entries, true); UPDATE actors SET properties = actor_props WHERE id = ${id}; ` +
      `IF NOT FOUND THEN RAISE EXCEPTION 'Character actor ${id} changed concurrently'; END IF; ` +
      `IF EXISTS (SELECT 1 FROM jsonb_array_elements(catalog_entries) c WHERE NOT EXISTS (` +
      `SELECT 1 FROM jsonb_array_elements(current_entries) e ` +
      `WHERE e->>'m_CustomizationId' = c->>'m_CustomizationId')) THEN ` +
      `RAISE EXCEPTION 'Cosmetic bulk verification failed'; END IF; END $cosmetic_unlock$; ` +
      `COMMIT; SELECT json_build_object('total', jsonb_array_length(properties #> ` +
      `'{CustomizationLibraryActorComponent,m_UnlockedCustomizationSerializableList,m_UnlockedCustomizationIds}'))::text ` +
      `FROM actors WHERE id = ${id};`,
      { timeout: 120000 }
    );
    const summaryLine = raw.trim().split(/\r?\n/).reverse().find((line) => line.trim().startsWith('{'));
    if (!summaryLine) throw new Error('Cosmetic unlock completed without a verification summary.');
    const summary = JSON.parse(summaryLine);
    log(`All ${summary.total} reviewed cosmetics unlocked for character ${id}.\n`);
    res.json({ success: true, total: summary.total, backup });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get specialization data
app.get('/api/characters/:id/specializations', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);

  try {
    const pawnRow = await runPsql(ip,
      `SELECT player_controller_id FROM encrypted_player_state WHERE player_pawn_id = ${id}`
    );
    const controllerId = parseInt(pawnRow.trim());

    const tracksRaw = await runPsql(ip,
      `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (` +
      `SELECT track_type, xp_amount, level FROM specialization_tracks WHERE player_id = ${controllerId} ORDER BY track_type) t`
    );

    const keystonesRaw = await runPsql(ip,
      `SELECT COALESCE(json_agg(km.name ORDER BY km.id), '[]') FROM purchased_specialization_keystones pk ` +
      `JOIN specialization_keystones_map km ON pk.keystone_id = km.id WHERE pk.player_id = ${controllerId}`
    );

    const allKeystonesRaw = await runPsql(ip,
      `SELECT COALESCE(json_agg(row_to_json(t) ORDER BY t.id), '[]') FROM (SELECT id, name FROM specialization_keystones_map ORDER BY id) t`
    );

    res.json({
      controllerId,
      tracks: JSON.parse(tracksRaw.trim()) || [],
      purchasedKeystones: JSON.parse(keystonesRaw.trim()) || [],
      allKeystones: JSON.parse(allKeystonesRaw.trim()) || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Set specialization track
app.post('/api/characters/:id/specializations/track', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parsePawnId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid character id' });
  const { trackType, xp, level } = req.body;

  const validTracks = ['Combat', 'Crafting', 'Gathering', 'Exploration', 'Sabotage'];
  if (!validTracks.includes(trackType)) return res.status(400).json({ error: 'Invalid track type' });
  const parsedXp = Number.parseInt(xp, 10);
  const parsedLevel = Number.parseFloat(level);
  if (!Number.isInteger(parsedXp) || parsedXp < 0 || parsedXp > 44182 ||
      !Number.isFinite(parsedLevel) || parsedLevel < 0 || parsedLevel > 100) {
    return res.status(400).json({ error: 'XP must be 0-44182 and level must be 0-100.' });
  }

  try {
    await requireStoppedOfflineCharacter(ip, id);
    const backup = await backupBeforeCharacterMutation(ip);
    const player = await requireStoppedOfflineCharacter(ip, id);
    const controllerId = Number.parseInt(player.controllerId, 10);

    await runPsql(ip,
      `BEGIN; SET LOCAL search_path TO dune, public; ` +
      offlineCharacterGuardSql(id) +
      `SELECT set_specialization_xp_and_level(` +
      `${controllerId}, '${trackType}'::specializationtracktype, ${parsedXp}, ${parsedLevel}); ` +
      `DO $verify$ BEGIN IF NOT EXISTS (` +
      `SELECT 1 FROM specialization_tracks WHERE player_id = ${controllerId} ` +
      `AND track_type::text = '${trackType}' AND xp_amount = ${parsedXp} AND level = ${parsedLevel}) THEN ` +
      `RAISE EXCEPTION 'Specialization track verification failed'; END IF; END $verify$; COMMIT;`
    );
    log(`Specialization ${trackType} set to level ${level} for character ${id} (controller ${controllerId}).\n`);
    res.json({ success: true, backup });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Unlock all keystones for a track
app.post('/api/characters/:id/specializations/unlock-keystones', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parsePawnId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid character id' });
  const { trackPrefix } = req.body;

  const validPrefixes = ['Combat_', 'Crafting_', 'Exploration_', 'Gathering_', 'Sabotage_'];
  if (!validPrefixes.some(p => trackPrefix === p)) return res.status(400).json({ error: 'Invalid track prefix' });

  try {
    await requireStoppedOfflineCharacter(ip, id);
    const backup = await backupBeforeCharacterMutation(ip);
    const player = await requireStoppedOfflineCharacter(ip, id);
    const controllerId = Number.parseInt(player.controllerId, 10);

    await runPsql(ip,
      `BEGIN; SET LOCAL search_path TO dune, public; ` +
      offlineCharacterGuardSql(id) +
      `INSERT INTO purchased_specialization_keystones (player_id, keystone_id) ` +
      `SELECT ${controllerId}, id FROM specialization_keystones_map WHERE name LIKE '${trackPrefix}%' ` +
      `ON CONFLICT DO NOTHING; ` +
      `DO $verify$ BEGIN IF (` +
      `SELECT count(*) FROM purchased_specialization_keystones pk JOIN specialization_keystones_map km ` +
      `ON km.id = pk.keystone_id WHERE pk.player_id = ${controllerId} AND km.name LIKE '${trackPrefix}%') ` +
      `<> (SELECT count(*) FROM specialization_keystones_map WHERE name LIKE '${trackPrefix}%') THEN ` +
      `RAISE EXCEPTION 'Keystone verification failed'; END IF; END $verify$; COMMIT;`
    );
    log(`All ${trackPrefix.replace('_', '')} keystones unlocked for character ${id} (controller ${controllerId}).\n`);
    res.json({ success: true, backup });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Max every specialization and grant every keystone using the controller row.
app.post('/api/characters/:id/specializations/max-all', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parsePawnId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid character id' });

  try {
    await requireStoppedOfflineCharacter(ip, id);
    const backup = await backupBeforeCharacterMutation(ip);
    const player = await requireStoppedOfflineCharacter(ip, id);
    const controllerId = Number.parseInt(player.controllerId, 10);
    const tracks = ['Combat', 'Crafting', 'Gathering', 'Exploration', 'Sabotage'];
    const calls = tracks.map((track) =>
      `SELECT set_specialization_xp_and_level(${controllerId}, '${track}'::specializationtracktype, 44182, 100);`
    ).join(' ');
    const pawnCleanup = id === controllerId ? '' :
      `DELETE FROM specialization_tracks WHERE player_id = ${id}; ` +
      `DELETE FROM purchased_specialization_keystones WHERE player_id = ${id}; `;
    const pawnCleanupVerification = id === controllerId ? '' :
      `IF EXISTS (SELECT 1 FROM specialization_tracks WHERE player_id = ${id}) ` +
      `OR EXISTS (SELECT 1 FROM purchased_specialization_keystones WHERE player_id = ${id}) THEN ` +
      `RAISE EXCEPTION 'Pawn-id specialization cleanup failed'; END IF; `;

    await runPsql(ip,
      `BEGIN; ` +
      `SET LOCAL search_path TO dune, public; ` +
      offlineCharacterGuardSql(id) +
      pawnCleanup +
      calls + ' ' +
      `INSERT INTO purchased_specialization_keystones (player_id, keystone_id) ` +
      `SELECT ${controllerId}, id FROM specialization_keystones_map ON CONFLICT DO NOTHING; ` +
      `DO $verify$ BEGIN ` +
      `IF (SELECT count(*) FROM specialization_tracks WHERE player_id = ${controllerId} ` +
      `AND xp_amount = 44182 AND level = 100) <> 5 THEN ` +
      `RAISE EXCEPTION 'Specialization max verification failed'; END IF; ` +
      `IF (SELECT count(*) FROM purchased_specialization_keystones WHERE player_id = ${controllerId}) ` +
      `<> (SELECT count(*) FROM specialization_keystones_map) THEN ` +
      `RAISE EXCEPTION 'All-keystone verification failed'; END IF; ` +
      pawnCleanupVerification +
      `END $verify$; ` +
      `COMMIT;`,
      { timeout: 120000 }
    );

    log(`All specializations maxed and all keystones unlocked for character ${id} (controller ${controllerId}).\n`);
    res.json({ success: true, controllerId, xp: 44182, level: 100, keystones: 'all', backup });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get currency and faction data
app.get('/api/characters/:id/economy', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);

  try {
    const pawnRow = await runPsql(ip,
      `SELECT player_controller_id FROM encrypted_player_state WHERE player_pawn_id = ${id}`
    );
    const controllerId = parseInt(pawnRow.trim());

    const currencyRaw = await runPsql(ip,
      `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (` +
      `SELECT currency_id, balance FROM player_virtual_currency_balances WHERE player_controller_id = ${controllerId} ORDER BY currency_id) t`
    );

    const factionRepRaw = await runPsql(ip,
      `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (` +
      `SELECT fr.faction_id, f.name as faction_name, fr.reputation_amount ` +
      `FROM player_faction_reputation fr JOIN factions f ON fr.faction_id = f.id ` +
      `WHERE fr.actor_id = ${id} ORDER BY fr.faction_id) t`
    );

    const factionsRaw = await runPsql(ip,
      `SELECT COALESCE(json_agg(row_to_json(t)), '[]') FROM (SELECT id, name FROM factions ORDER BY id) t`
    );

    res.json({
      controllerId,
      currency: JSON.parse(currencyRaw.trim()) || [],
      factionRep: JSON.parse(factionRepRaw.trim()) || [],
      factions: JSON.parse(factionsRaw.trim()) || [],
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Set currency
app.post('/api/characters/:id/economy/currency', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parsePawnId(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid character id' });

  const rawCurrencyId = req.body && req.body.currencyId;
  const rawBalance = req.body && req.body.balance;
  if (rawCurrencyId === '' || rawCurrencyId == null || rawBalance === '' || rawBalance == null) {
    return res.status(400).json({ error: 'currencyId and balance are required' });
  }

  let currencyId;
  let balance;
  try {
    currencyId = boundedInteger(rawCurrencyId, 'Currency ID', 0, 1);
    if (currencyId !== 0 && currencyId !== 1) throw new Error('Currency ID must be 0 or 1.');
    balance = boundedInteger(rawBalance, 'Balance', 0, MAX_CURRENCY_BALANCE);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    await requireStoppedOfflineCharacter(ip, id);
    const backup = await backupBeforeCharacterMutation(ip);
    const player = await requireStoppedOfflineCharacter(ip, id);
    const controllerId = player.controllerId;

    const raw = await runPsql(ip,
      `BEGIN; ` +
      `SET LOCAL search_path TO dune, public; ` +
      offlineCharacterGuardSql(id) +
      `DO $currency_guard$ BEGIN ` +
      `IF NOT EXISTS (SELECT 1 FROM player_state WHERE player_pawn_id = ${id} ` +
      `AND player_controller_id = ${controllerId}) THEN ` +
      `RAISE EXCEPTION 'Player controller changed during currency update'; END IF; ` +
      `END $currency_guard$; ` +
      `SELECT balance FROM player_virtual_currency_balances ` +
      `WHERE player_controller_id = ${controllerId} AND currency_id = ${currencyId} FOR UPDATE; ` +
      `INSERT INTO player_virtual_currency_balances (player_controller_id, currency_id, balance) ` +
      `VALUES (${controllerId}, ${currencyId}, ${balance}) ` +
      `ON CONFLICT (player_controller_id, currency_id) DO UPDATE SET balance = EXCLUDED.balance; ` +
      `DO $currency_verify$ BEGIN ` +
      `IF NOT EXISTS (SELECT 1 FROM player_virtual_currency_balances ` +
      `WHERE player_controller_id = ${controllerId} AND currency_id = ${currencyId} ` +
      `AND balance = ${balance}) THEN RAISE EXCEPTION 'Currency balance verification failed'; END IF; ` +
      `END $currency_verify$; ` +
      `SELECT json_build_object('currencyId', currency_id, 'balance', balance)::text ` +
      `FROM player_virtual_currency_balances WHERE player_controller_id = ${controllerId} ` +
      `AND currency_id = ${currencyId}; ` +
      `COMMIT;`
    );
    const line = raw.trim().split(/\r?\n/).find((value) => value.trim().startsWith('{'));
    if (!line) throw new Error('Currency update committed but verified readback was unavailable.');
    const verified = JSON.parse(line);
    if (Number(verified.currencyId) !== currencyId || Number(verified.balance) !== balance) {
      throw new Error('Currency readback did not match the requested balance.');
    }

    log(`Currency ${currencyId} set to ${balance} for character ${id} (controller ${controllerId}).\n`);
    res.json({ success: true, currencyId, balance, controllerId, backup });
  } catch (e) {
    const message = e.message || 'Currency update failed';
    const statusCode = /not confirmed fully stopped|fully logged out|must be Offline/i.test(message)
      ? 409
      : (/not found/i.test(message) ? 404 : 500);
    res.status(statusCode).json({ error: message });
  }
});

// Set faction reputation
app.post('/api/characters/:id/economy/reputation', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const id = parseInt(req.params.id);
  const { factionId, amount } = req.body;

  try {
    await runPsql(ip,
      `INSERT INTO player_faction_reputation (actor_id, faction_id, reputation_amount) ` +
      `VALUES (${id}, ${parseInt(factionId)}, ${parseInt(amount)}) ` +
      `ON CONFLICT (actor_id, faction_id) DO UPDATE SET reputation_amount = EXCLUDED.reputation_amount`
    );
    log(`Faction ${factionId} reputation set to ${amount} for character ${id}.\n`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/characters/:id/inventory/:itemId', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const itemId = parseInt(req.params.itemId);

  try {
    await runPsql(ip, `DELETE FROM items WHERE id = ${itemId}`);
    log(`Removed item ${itemId}.\n`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Server Visibility (LAN / Public)
// ---------------------------------------------------------------------------

app.get('/api/server-visibility', async (_req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    const advertisedIp = await readSettingsConfIp(ip);
    const directorPort = await getDirectorPort(ip);

    // Detect public IP — try VM first, fall back to Windows host
    let publicIp = null;
    for (const method of [
      () => ssh.run(ip, 'curl -s --max-time 5 https://api.ipify.org 2>/dev/null', null, { timeout: 10000 }),
      () => ssh.run(ip, "wget -qO- --timeout=5 'https://api.ipify.org' 2>/dev/null", null, { timeout: 10000 }),
      () => ps.run("(Invoke-WebRequest -Uri 'https://api.ipify.org' -UseBasicParsing -TimeoutSec 5).Content"),
    ]) {
      try {
        const out = await method();
        if (out && /^\d+\.\d+\.\d+\.\d+$/.test(out.trim())) { publicIp = out.trim(); break; }
      } catch { /* try next */ }
    }

    const isWan = advertisedIp && advertisedIp !== ip;

    res.json({
      advertisedIp,
      vmIp: ip,
      publicIp,
      directorPort,
      isWan,
      portForward: {
        targetIp: ip,
        ...PORT_FORWARD_INFO,
        directorTcp: directorPort,
      },
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


app.post('/api/server-visibility', async (req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });
  const { advertisedIp } = req.body;
  if (!advertisedIp) return res.status(400).json({ error: 'advertisedIp required' });

  try {
    await writeSettingsConfIp(ip, advertisedIp.trim());
    visibilityManuallySet = true;
    const isWan = advertisedIp.trim() !== ip;
    log(`Server visibility IP set to ${advertisedIp}.\n`);
    if (isWan) {
      log(`WAN: forward TCP ${PORT_FORWARD_INFO.rmqTcp}, Director NodePort, and UDP ${PORT_FORWARD_INFO.gameUdpStart}-${PORT_FORWARD_INFO.gameUdpEnd} to VM ${ip}, then stop and start the battlegroup.\n`);
    } else {
      log('LAN mode: players on your local network can join. Stop and start the battlegroup to apply.\n');
    }
    log('Self-hosted worlds appear in-game under Servers → Experimental (not Official or Private).\n');
    res.json({
      success: true,
      isWan,
      requiresBattlegroupRestart: true,
      message: 'Stop the battlegroup completely, then start it again for the gateway to register the new address with Funcom.',
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------------------------------------------------------------------------
// Experimental: Multi-Sietch Management
// ---------------------------------------------------------------------------

async function getBattlegroupJson(ip) {
  const ns = await ssh.run(ip,
    "sudo kubectl get battlegroups -A --no-headers -o custom-columns=':metadata.namespace' 2>/dev/null | head -1",
    null, { timeout: 15000 });
  const name = await ssh.run(ip,
    "sudo kubectl get battlegroups -A --no-headers -o custom-columns=':metadata.name' 2>/dev/null | head -1",
    null, { timeout: 15000 });
  if (!ns || !name) throw new Error('Battlegroup not found');
  const raw = await ssh.run(ip,
    `sudo kubectl get battlegroups -n ${ns.trim()} ${name.trim()} -o json 2>/dev/null`,
    null, { timeout: 30000 });
  return { ns: ns.trim(), name: name.trim(), bg: JSON.parse(raw) };
}

app.get('/api/sietches', async (_req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    const { bg } = await getBattlegroupJson(ip);
    const sets = bg.spec.serverGroup.template.spec.sets;
    const worldPartitions = bg.spec.database.template.spec.deployment.spec.worldPartitions;

    const survivalSets = sets
      .map((s, i) => ({ index: i, map: s.map, partitions: s.partitions, replicas: s.replicas, memory: s.resources?.limits?.memory || '?', dedicatedScaling: s.dedicatedScaling }))
      .filter(s => s.map === 'Survival_1' && !s.dedicatedScaling);

    const maxPartitionId = Math.max(...worldPartitions.flatMap(w => w.partitions.map(p => p.id)));

    res.json({
      sietches: survivalSets,
      sietchCount: survivalSets.length,
      maxPartitionId,
      totalSets: sets.length,
      totalWorldPartitions: worldPartitions.length,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sietches/add', async (_req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    const { ns, name, bg } = await getBattlegroupJson(ip);
    const sets = bg.spec.serverGroup.template.spec.sets;
    const worldPartitions = bg.spec.database.template.spec.deployment.spec.worldPartitions;
    const grid = (bg.metadata.annotations.grid || '').split(',');

    const survivalSets = sets.filter(s => s.map === 'Survival_1' && !s.dedicatedScaling);
    const currentCount = survivalSets.length;
    const maxPartitionId = Math.max(...worldPartitions.flatMap(w => w.partitions.map(p => p.id)));
    const newPartitionId = maxPartitionId + 1;
    const newSietchNum = currentCount + 1;

    log(`Adding sietch ${newSietchNum} (partition ${newPartitionId})...\n`);

    // Clone the first Survival_1 set as template
    const template = JSON.parse(JSON.stringify(sets.find(s => s.map === 'Survival_1' && !s.dedicatedScaling)));
    template.partitions = [newPartitionId];

    // Build patches
    const patches = [
      { op: 'add', path: '/spec/serverGroup/template/spec/sets/-', value: template },
      { op: 'add', path: '/spec/database/template/spec/deployment/spec/worldPartitions/-', value: {
        map: 'Survival_1',
        partitions: [{ dimension: 0, disable: false, id: newPartitionId, maxX: 1, maxY: 1, minX: 0, minY: 0 }]
      }},
      { op: 'replace', path: '/metadata/annotations/grid', value: [...grid, '1x1'].join(',') },
    ];

    const patchJson = JSON.stringify(patches);
    const b64 = Buffer.from(patchJson).toString('base64');

    await ssh.run(ip,
      `echo '${b64}' | base64 -d | sudo kubectl patch battlegroup ${name} -n ${ns} --type=json -p "$(echo '${b64}' | base64 -d)" 2>&1`,
      log, { timeout: 30000 });

    log(`\nSietch ${newSietchNum} added (partition ${newPartitionId}). Restart the battlegroup to apply.\n`);
    res.json({ success: true, sietchNumber: newSietchNum, partitionId: newPartitionId });
  } catch (e) {
    log(`Error adding sietch: ${e.message}\n`);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sietches/remove', async (_req, res) => {
  const ip = await getVmIp();
  if (!ip) return res.status(400).json({ error: 'VM not running' });

  try {
    const { ns, name, bg } = await getBattlegroupJson(ip);
    const sets = bg.spec.serverGroup.template.spec.sets;
    const worldPartitions = bg.spec.database.template.spec.deployment.spec.worldPartitions;
    const grid = (bg.metadata.annotations.grid || '').split(',');

    // Find all Survival_1 sets (non-dedicatedScaling)
    const survivalIndices = sets
      .map((s, i) => ({ ...s, _idx: i }))
      .filter(s => s.map === 'Survival_1' && !s.dedicatedScaling);

    if (survivalIndices.length <= 1) {
      return res.status(400).json({ error: 'Cannot remove the last sietch' });
    }

    const lastSurvival = survivalIndices[survivalIndices.length - 1];
    const lastPartitionId = lastSurvival.partitions[0];

    // Find matching worldPartition entry
    const wpIdx = worldPartitions.findIndex(w =>
      w.map === 'Survival_1' && w.partitions.some(p => p.id === lastPartitionId));

    log(`Removing sietch ${survivalIndices.length} (partition ${lastPartitionId})...\n`);

    // Build patches (remove in reverse index order to avoid shifting)
    const patches = [];
    patches.push({ op: 'remove', path: `/spec/serverGroup/template/spec/sets/${lastSurvival._idx}` });
    if (wpIdx >= 0) {
      patches.push({ op: 'remove', path: `/spec/database/template/spec/deployment/spec/worldPartitions/${wpIdx}` });
    }
    if (grid.length > 1) {
      patches.push({ op: 'replace', path: '/metadata/annotations/grid', value: grid.slice(0, -1).join(',') });
    }

    // Sort patches so higher indices are removed first
    patches.sort((a, b) => (b.path > a.path ? 1 : -1));

    const patchJson = JSON.stringify(patches);
    const b64 = Buffer.from(patchJson).toString('base64');

    await ssh.run(ip,
      `echo '${b64}' | base64 -d | sudo kubectl patch battlegroup ${name} -n ${ns} --type=json -p "$(echo '${b64}' | base64 -d)" 2>&1`,
      log, { timeout: 30000 });

    log(`\nSietch removed. Restart the battlegroup to apply.\n`);
    res.json({ success: true, removedPartition: lastPartitionId, remainingSietches: survivalIndices.length - 1 });
  } catch (e) {
    log(`Error removing sietch: ${e.message}\n`);
    res.status(500).json({ error: e.message });
  }
});

// --- Static UI (after all API routes) ---
app.use('/api', (_req, res) => {
  res.status(404).json({
    error: 'API endpoint not found. Stop and restart the Server Manager (start_as_admin.bat) to load updates.',
  });
});

app.use(express.static(path.join(__dirname, 'public')));

// --- SPA fallback ---
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  console.log(`Dune Server Manager running at http://${HOST}:${PORT}`);
});
