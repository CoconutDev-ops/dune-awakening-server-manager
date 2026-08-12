(() => {
  // -----------------------------------------------------------------------
  // DOM refs
  // -----------------------------------------------------------------------
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  const vmChip        = $('#vm-chip');
  const bgChip        = $('#bg-chip');
  const vmBadge       = $('#vm-badge');
  const bgBadge       = $('#bg-badge');
  const vmState       = $('#vm-state');
  const vmIp          = $('#vm-ip');
  const vmMemory      = $('#vm-memory');
  const vmUptime      = $('#vm-uptime');
  const bgStatusText  = $('#bg-status-text');
  const consoleOut    = $('#console-output');
  const consoleToggle = $('#console-toggle');
  const consoleWrap   = $('#console-wrapper');
  const consoleBadge  = $('#console-badge');
  const overlay       = $('#overlay');
  const overlayText   = $('#overlay-text');
  const operationConsoleOut = $('#operation-console-output');
  const operationConsoleScroll = $('#operation-console-scroll');
  const linkFB        = $('#link-filebrowser');
  const linkDir       = $('#link-director');
  const monFB         = $('#mon-filebrowser');
  const monDir        = $('#mon-director');

  // -----------------------------------------------------------------------
  // State
  // -----------------------------------------------------------------------
  let status = null;
  let busy = false;

  // -----------------------------------------------------------------------
  // Tabs
  // -----------------------------------------------------------------------
  const SETUP_DISMISSED_KEY = 'duneServerManager.setupDismissed';
  const setupNavTab = $('#setup-nav-tab');
  const setupNavLabel = $('#setup-nav-label');
  const showSetupButton = $('#btn-show-setup');
  const charactersNavTab = $('#characters-nav-tab');
  const characterSubnav = $('#character-subnav');
  const characterViewButtons = $$('.character-subnav-item');

  // Keep the data-heavy tools in dedicated workspaces without changing any
  // action IDs or event targets used by the character editor below.
  $('#character-inventory-mount').append(
    $('#character-inventory-card'),
    $('#character-augment-card')
  );
  $('#character-cheats-mount').append($('#character-cheats-card'));

  function switchCharacterView(view) {
    if (!view || !charData) return;

    $$('[data-character-view-panel]').forEach((panel) => {
      const active = panel.dataset.characterViewPanel === view;
      panel.hidden = !active;
      panel.classList.toggle('active', active);
    });

    characterViewButtons.forEach((button) => {
      const active = button.dataset.characterView === view;
      const isOfflineParent = button.classList.contains('character-subnav-parent');
      button.classList.toggle('active', active || (isOfflineParent && view.startsWith('offline-')));
      if (active && !isOfflineParent) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });

    const content = $('.content');
    if (content) content.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function setCharacterWorkspaceAvailable(available) {
    characterViewButtons.forEach((button) => { button.disabled = !available; });
  }

  characterViewButtons.forEach((button) => {
    button.addEventListener('click', () => switchCharacterView(button.dataset.characterView));
  });

  function setupIsDismissed() {
    try {
      return localStorage.getItem(SETUP_DISMISSED_KEY) === 'true';
    } catch {
      return false;
    }
  }

  function setSetupDismissed(dismissed) {
    try {
      if (dismissed) localStorage.setItem(SETUP_DISMISSED_KEY, 'true');
      else localStorage.removeItem(SETUP_DISMISSED_KEY);
    } catch { /* Keep the control usable when storage is unavailable. */ }

    setupNavTab.hidden = dismissed;
    setupNavLabel.hidden = dismissed;
    showSetupButton.hidden = !dismissed;
  }

  setSetupDismissed(setupIsDismissed());

  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.tab').forEach((t) => t.classList.remove('active'));
      $$('.panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');
      const charactersActive = tab.dataset.tab === 'characters';
      characterSubnav.hidden = !charactersActive;
      charactersNavTab.setAttribute('aria-expanded', String(charactersActive));
    });
  });

  $('#btn-dismiss-setup').addEventListener('click', () => {
    setSetupDismissed(true);
    document.querySelector('.tab[data-tab="dashboard"]').click();
  });

  showSetupButton.addEventListener('click', () => {
    setSetupDismissed(false);
    setupNavTab.click();
  });

  // -----------------------------------------------------------------------
  // Console
  // -----------------------------------------------------------------------
  consoleWrap.classList.add('collapsed');

  consoleToggle.addEventListener('click', () => {
    consoleWrap.classList.toggle('collapsed');
    consoleBadge.hidden = true;
  });

  function appendConsole(text) {
    consoleOut.textContent += text;
    consoleOut.parentElement.scrollTop = consoleOut.parentElement.scrollHeight;

    // The full-screen operation console follows the same output stream as the
    // persistent console, but only retains output from the current operation.
    if (!overlay.hidden) {
      if (!operationHasOutput) {
        operationConsoleOut.textContent = '';
        operationHasOutput = true;
      }
      operationConsoleOut.textContent += text;
      operationConsoleScroll.scrollTop = operationConsoleScroll.scrollHeight;
    }

    if (consoleWrap.classList.contains('collapsed')) {
      consoleBadge.hidden = false;
    }
  }

  function expandConsole() {
    consoleWrap.classList.remove('collapsed');
    consoleBadge.hidden = true;
  }

  // -----------------------------------------------------------------------
  // Setup log pipe (defined early so WS handler can call it)
  // -----------------------------------------------------------------------
  let wizStep = 1;
  function pipeToSetupLog(text) {
    if (wizStep === 3) {
      const el = $('#setup-log');
      if (el) { el.textContent += text; el.scrollTop = el.scrollHeight; }
    } else if (wizStep === 6) {
      const el = $('#bootstrap-log');
      if (el) { el.textContent += text; el.scrollTop = el.scrollHeight; }
    }
  }

  // -----------------------------------------------------------------------
  // WebSocket
  // -----------------------------------------------------------------------
  let ws;

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'output') {
          appendConsole(msg.data);
          pipeToSetupLog(msg.data);
        }
      } catch { /* ignore */ }
    };
    ws.onclose = () => setTimeout(connectWs, 3000);
  }
  connectWs();

  // -----------------------------------------------------------------------
  // API helpers
  // -----------------------------------------------------------------------
  async function api(method, path, body) {
    const opts = { method, headers: { 'Content-Type': 'application/json' } };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`/api/${path}`, opts);
    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(
        res.ok
          ? 'Invalid JSON from server'
          : `Server error (${res.status}): ${text.startsWith('<!') ? 'endpoint missing or manager needs restart' : text.slice(0, 120)}`
      );
    }
    if (!res.ok) {
      const err = new Error(data.error || data.message || `Request failed (${res.status})`);
      err.status = res.status;
      err.code = data.code;
      err.startFailed = data.startFailed;
      err.attemptedGB = data.attemptedGB;
      throw err;
    }
    return data;
  }

  const operationLockTargets = [$('.topbar'), $('.tabs'), $('.content'), consoleWrap];
  let operationPreviousFocus = null;
  let operationDepth = 0;
  let operationHasOutput = false;

  function showOverlay(text) {
    operationDepth += 1;
    if (operationDepth > 1) return;

    overlayText.textContent = text;
    operationHasOutput = false;
    operationConsoleOut.textContent = 'Waiting for server output...\n';
    operationConsoleScroll.scrollTop = 0;
    operationPreviousFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    operationLockTargets.forEach((element) => { element.inert = true; });
    document.body.classList.add('operation-active');
    overlay.hidden = false;
    busy = true;
    requestAnimationFrame(() => overlay.focus({ preventScroll: true }));
  }

  function hideOverlay() {
    if (operationDepth === 0) return;
    operationDepth -= 1;
    if (operationDepth > 0) return;

    overlay.hidden = true;
    document.body.classList.remove('operation-active');
    operationLockTargets.forEach((element) => { element.inert = false; });
    busy = false;
    if (operationPreviousFocus && operationPreviousFocus.isConnected) {
      operationPreviousFocus.focus({ preventScroll: true });
    }
    operationPreviousFocus = null;
  }

  async function runAction(path, label, body) {
    if (busy) return;
    showOverlay(label + '...');
    appendConsole(`\n> ${label}\n`);
    try {
      await api('POST', path, body);
    } catch (e) {
      appendConsole(`Error: ${e.message}\n`);
      expandConsole();
      alert(`${label} failed: ${e.message}`);
    }
    hideOverlay();
    refreshStatus();
  }

  async function startVmAction(memoryGB) {
    if (busy) return;
    const vmRetryPanel = $('#vm-start-retry');
    if (vmRetryPanel) vmRetryPanel.hidden = true;

    showOverlay('Starting VM...');
    appendConsole('\n> Starting VM\n');
    expandConsole();

    try {
      const body = memoryGB ? { memoryGB } : undefined;
      const result = await api('POST', 'vm/start', body);
      if (result.memoryGB) {
        appendConsole(`VM started with ${result.memoryGB} GB RAM.\n`);
      }
    } catch (e) {
      appendConsole(`Error: ${e.message}\n`);
      expandConsole();
      alert('Failed to start VM: ' + e.message);
      if (e.startFailed || e.status === 507) {
        if (vmRetryPanel) vmRetryPanel.hidden = false;
      }
    }

    hideOverlay();
    refreshStatus();
  }

  // -----------------------------------------------------------------------
  // Status refresh
  // -----------------------------------------------------------------------
  function applyStatus(s) {
    status = s;
    const vm = s.vm || {};
    const bg = s.battlegroup;
    const links = s.links || {};

    // VM card
    const running = vm.exists && vm.state === 'Running';
    const stopped = vm.exists && vm.state !== 'Running';
    const missing = !vm.exists;

    vmState.textContent  = vm.exists ? vm.state : 'Not Found';
    vmIp.textContent     = vm.ip || '—';
    if (running && vm.memoryMB) {
      vmMemory.textContent = `${Math.round(vm.memoryMB)} MB`;
    } else if (vm.startupMemoryMB) {
      vmMemory.textContent = `${Math.round(vm.startupMemoryMB / 1024)} GB configured`;
    } else {
      vmMemory.textContent = '—';
    }
    vmUptime.textContent = vm.uptime || '—';

    vmBadge.textContent = running ? 'Running' : stopped ? vm.state : 'Not Found';
    vmBadge.className   = `badge ${running ? 'running' : stopped ? 'stopped' : ''}`;

    vmChip.className  = `status-chip ${running ? 'running' : stopped ? 'stopped' : 'unknown'}`;
    $('#vm-chip-state').textContent = running ? vm.ip || 'Running' : vm.exists ? vm.state : '—';

    $('#btn-vm-start').disabled = busy || running || missing;
    $('#btn-vm-stop').disabled  = busy || !running;

    // Battlegroup card
    const bgUp = bg && bg.running;
    bgBadge.textContent = !running ? 'VM Off' : bgUp ? 'Active' : 'Inactive';
    bgBadge.className   = `badge ${!running ? '' : bgUp ? 'running' : 'stopped'}`;
    bgChip.className    = `status-chip ${!running ? 'unknown' : bgUp ? 'running' : 'stopped'}`;
    $('#bg-chip-state').textContent = !running ? '—' : bgUp ? 'Active' : 'Inactive';
    bgStatusText.textContent = bg ? bg.output || 'No details' : 'VM not running';

    const bgBtns = ['btn-bg-start', 'btn-bg-restart', 'btn-bg-stop', 'btn-bg-update'];
    bgBtns.forEach((id) => { $(`#${id}`).disabled = busy || !running; });

    // All data-action buttons
    $$('[data-action]').forEach((btn) => { btn.disabled = busy || !running; });

    // Links
    function setLink(el, url) {
      if (url) {
        el.href = url;
        el.classList.remove('disabled');
        el.removeAttribute('data-nolink');
      } else {
        el.removeAttribute('href');
        el.classList.add('disabled');
        el.setAttribute('data-nolink', '1');
      }
    }
    setLink(linkFB, links.fileBrowser);
    setLink(linkDir, links.director);
    setLink(monFB, links.fileBrowser);
    setLink(monDir, links.director);

    // Settings buttons
    $('#btn-rotate-key').disabled = busy || !running;

    // Config warning banner
    const cw = $('#config-warning');
    if (cw) {
      if (bgUp) {
        cw.classList.remove('ok');
        cw.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg><span><strong>Battlegroup is running.</strong> Stop it before editing. Changes apply on next start.</span>';
      } else {
        cw.classList.add('ok');
        cw.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M8 12l2.5 2.5L16 9"/></svg><span><strong>Battlegroup is offline.</strong> Safe to edit. Changes will apply on next start.</span>';
      }
    }

    const repairPanel = $('#repair-bootstrap-panel');
    if (repairPanel) {
      const needsRepair = running && bg && bg.needsBootstrap;
      repairPanel.hidden = !needsRepair;
      $('#btn-repair-bootstrap').disabled = busy || !needsRepair;
    }

    const sshPanel = $('#ssh-key-warning');
    if (sshPanel) {
      const sshMissing = running && s.ssh && !s.ssh.keyPresent;
      const sshAuthFailed = running && bg && bg.output &&
        /Identity file .* not accessible|Permission denied \(publickey/i.test(bg.output);
      sshPanel.hidden = !(sshMissing || sshAuthFailed);
      if (sshMissing || sshAuthFailed) {
        const hint = $('#ssh-key-hint');
        if (hint) {
          hint.textContent = sshMissing
            ? `Expected key at ${s.ssh && s.ssh.keyPath ? s.ssh.keyPath : 'LOCALAPPDATA\\DuneAwakeningServer\\sshKey'}`
            : 'SSH cannot read the key (common when running from WSL after reboot). Restart the manager or use Settings → Rotate SSH Key.';
        }
      }
    }

    const vmRetryPanel = $('#vm-start-retry');
    if (vmRetryPanel && running) vmRetryPanel.hidden = true;
  }

  async function refreshStatus() {
    try {
      const s = await api('GET', 'status');
      applyStatus(s);
    } catch { /* silent */ }
  }

  refreshStatus();
  setInterval(refreshStatus, 3000);

  // -----------------------------------------------------------------------
  // Setup Wizard
  // -----------------------------------------------------------------------
  let wizData = {};

  const wizNext = $('#wiz-next');
  const wizBack = $('#wiz-back');
  const wizBadge = $('#setup-step-badge');
  const wizFill = $('#wizard-progress-fill');

  function showWizStep(n) {
    wizStep = n;
    $$('.wizard-step').forEach((s) => s.classList.remove('active'));
    const el = $(`#wiz-step-${n}`);
    if (el) el.classList.add('active');
    wizBadge.textContent = n <= 6 ? `Step ${n} of 6` : 'Complete';
    wizFill.style.width = `${Math.min((n / 6) * 100, 100)}%`;
    wizBack.hidden = n <= 1 || n >= 7;
    wizNext.hidden = n >= 7;
    wizNext.textContent = n === 6 ? 'Finish Setup' : 'Next';
    if (n === 7) {
      wizNext.hidden = true;
      wizBack.hidden = true;
    }
    if (n === 5) updateSetupPortForwardPanel();
  }

  // Retry start with different memory
  $('#btn-retry-start').addEventListener('click', async () => {
    const memGB = parseInt($('#retry-memory').value, 10);
    const logEl = $('#setup-log');
    const spinner = $('#setup-spinner');
    const retryPanel = $('#retry-start');

    spinner.hidden = false;
    retryPanel.hidden = true;
    $('#btn-retry-start').disabled = true;

    try {
      const result = await api('POST', 'setup/retry-start', { memoryGB: memGB });
      if (result.success) {
        wizData.ip = result.ip;
        wizData.memoryGB = memGB;
        logEl.textContent += `\nVM ready at ${result.ip}\n`;
        spinner.hidden = true;
        wizNext.disabled = false;
        if (memGB < 20) $('#setup-swap').checked = true;
      } else {
        throw new Error(result.error || 'Start failed');
      }
    } catch (e) {
      logEl.textContent += `\nError: ${e.message}\n`;
      spinner.hidden = true;
      retryPanel.hidden = false;
      $('#btn-retry-start').disabled = false;
    }
  });

  // Preflight
  let preflightPassed = false;
  let preflightData = null;

  function applyPreflightResults(data) {
    preflightData = data;

    function mark(id, ok) {
      const el = $(id);
      el.classList.toggle('pass', ok);
      el.classList.toggle('fail', !ok);
      el.querySelector('.pf-icon').textContent = ok ? '\u2705' : '\u274C';
    }
    mark('#pf-hyperv', data.hyperv);
    mark('#pf-vmcx', data.vmcxFound);
    mark('#pf-drives', data.drives && data.drives.length > 0);

    preflightPassed = data.hyperv && data.vmcxFound && data.drives && data.drives.length > 0;

    const resetPanel = $('#setup-reset-panel');
    const resetDesc = $('#setup-reset-desc');
    if (resetPanel) {
      if (data.vmExists) {
        resetPanel.hidden = false;
        if (resetDesc) {
          resetDesc.textContent = data.vmState
            ? `VM "dune-awakening" exists (${data.vmState}). Delete everything below to run setup again from scratch.`
            : 'VM "dune-awakening" exists. Delete everything below to run setup again from scratch.';
        }
      } else {
        resetPanel.hidden = true;
      }
    }

    if (preflightPassed) {
      const sel = $('#setup-drive');
      sel.innerHTML = '';
      data.drives.forEach((d) => {
        const opt = document.createElement('option');
        opt.value = d.name;
        opt.textContent = `${d.name}: — ${d.freeGB} GB free`;
        sel.appendChild(opt);
      });

      if (data.nics && data.nics.length > 0) {
        const nicSel = $('#setup-nic');
        nicSel.innerHTML = '';
        data.nics.forEach((n) => {
          const opt = document.createElement('option');
          opt.value = n.name;
          opt.textContent = `${n.name} (${n.desc})`;
          nicSel.appendChild(opt);
        });
      }
    }
  }

  async function runPreflight() {
    $('#btn-preflight').disabled = true;
    $('#btn-preflight').textContent = 'Checking...';
    try {
      applyPreflightResults(await api('GET', 'setup/preflight'));
    } catch (e) {
      appendConsole(`Preflight error: ${e.message}\n`);
    }
    $('#btn-preflight').disabled = false;
    $('#btn-preflight').textContent = 'Run Checks';
  }

  $('#btn-preflight').addEventListener('click', runPreflight);

  document.querySelector('.tab[data-tab="setup"]')?.addEventListener('click', () => {
    if (!preflightData) runPreflight();
  });

  $('#btn-setup-reset').addEventListener('click', async () => {
    if (busy) return;

    const msg =
      'This permanently deletes your Dune VM, all battlegroup/world data inside it, ' +
      'install folders, and SSH keys.\n\n' +
      'Export a database backup first if you need to keep your world.\n\n' +
      'Type DELETE to confirm.';
    const typed = prompt(msg);
    if (typed !== 'DELETE') {
      if (typed !== null) alert('Reset cancelled — you must type DELETE exactly.');
      return;
    }

    busy = true;
    showOverlay('Deleting existing installation...');
    try {
      const res = await api('POST', 'setup/reset');
      if (!res.success) throw new Error(res.error || 'Reset failed');

      wizData = {};
      preflightPassed = false;
      showWizStep(1);
      $('#setup-log').textContent = '';
      $('#bootstrap-log').textContent = '';
      appendConsole('Installation reset complete. Run pre-flight checks to begin a fresh setup.\n');
      cachedVmStatus = null;
      await runPreflight();
      refreshStatus();
    } catch (e) {
      alert('Reset failed: ' + e.message);
      appendConsole(`Reset error: ${e.message}\n`);
    }
    hideOverlay();
    busy = false;
  });

  // Show/hide NIC field based on network mode
  document.addEventListener('change', (e) => {
    if (e.target.id === 'setup-network') {
      $('#nic-field').style.display = e.target.value === 'external' ? '' : 'none';
    }
    if (e.target.id === 'setup-ip-mode') {
      $('#static-fields').style.display = e.target.value === 'static' ? '' : 'none';
    }
    if (e.target.name === 'playerIpChoice') {
      $('#setup-player-ip-manual').style.display = e.target.value === 'manual' ? '' : 'none';
      updateSetupPortForwardPanel();
    }
  });

  // Next / Back
  wizBack.addEventListener('click', () => {
    if (wizStep > 1) showWizStep(wizStep - 1);
  });

  wizNext.addEventListener('click', async () => {
    if (busy) return;

    // Validate and execute per step
    if (wizStep === 1) {
      if (!preflightPassed) {
        alert('Pre-flight checks must pass before continuing. Click "Run Checks".');
        return;
      }
      if (preflightData && preflightData.vmExists) {
        if (!confirm(
          'A VM already exists. Continuing will replace it during import, but SSH keys may be stale.\n\n' +
          'For a clean reinstall, use "Delete & Start Fresh" on step 1 instead.\n\nContinue anyway?'
        )) return;
      }
      showWizStep(2);

    } else if (wizStep === 2) {
      const token = $('#setup-token').value.trim();
      if (!token) { alert('Server token is required. Get one from account.duneawakening.com'); return; }
      wizData.token = token;
      wizData.drive = $('#setup-drive').value;
      wizData.memoryGB = parseInt($('#setup-memory').value, 10);
      wizData.networkMode = $('#setup-network').value;
      wizData.nicName = wizData.networkMode === 'external' ? $('#setup-nic').value : null;
      if (wizData.memoryGB < 20) {
        $('#setup-swap').checked = true;
      }
      showWizStep(3);

      // Auto-run import
      const logEl = $('#setup-log');
      const spinner = $('#setup-spinner');
      const retryPanel = $('#retry-start');
      logEl.textContent = '';
      spinner.hidden = false;
      retryPanel.hidden = true;
      wizNext.disabled = true;

      try {
        const result = await api('POST', 'setup/import', {
          drive: wizData.drive,
          memoryGB: wizData.memoryGB,
          networkMode: wizData.networkMode,
          nicName: wizData.nicName,
        });
        if (result.success) {
          wizData.ip = result.ip;
          logEl.textContent += `\nVM ready at ${result.ip}\n`;
          spinner.hidden = true;
          wizNext.disabled = false;
        } else if (result.imported && result.startFailed) {
          spinner.hidden = true;
          retryPanel.hidden = false;
        } else {
          throw new Error(result.error || 'Import failed');
        }
      } catch (e) {
        logEl.textContent += `\nError: ${e.message}\n`;
        spinner.hidden = true;
        wizNext.disabled = false;
      }

    } else if (wizStep === 3) {
      if (!wizData.ip) { alert('VM must be running before continuing. If the start failed, use Retry Start below.'); return; }
      showWizStep(4);

    } else if (wizStep === 4) {
      const curPw = $('#setup-curpw').value || 'dune';
      const pw = $('#setup-pw').value;
      const pw2 = $('#setup-pw2').value;
      if (!pw) { alert('New password required.'); return; }
      if (pw !== pw2) { alert('Passwords do not match.'); return; }

      showOverlay('Installing SSH key and changing password...');
      try {
        const res = await api('POST', 'setup/security', {
          ip: wizData.ip,
          currentPassword: curPw,
          newPassword: pw,
        });
        if (!res.success) throw new Error(res.error || 'Security setup failed');
        appendConsole('SSH key installed and password changed.\n');
      } catch (e) {
        appendConsole(`Security setup error: ${e.message}\n`);
        hideOverlay();
        alert('Failed: ' + e.message + '. Check the console for details.');
        return;
      }
      hideOverlay();
      showWizStep(5);

      // Detect IPs
      try {
        const ips = await api('POST', 'setup/detect-ip', { ip: wizData.ip });
        wizData.publicIp = ips.publicIp;
        wizData.privateIp = ips.privateIp;
        $('#opt-public').textContent = ips.publicIp
          ? `Public IP: ${ips.publicIp} (requires port forwarding)`
          : 'Public IP: not detected';
        $('#opt-private').textContent = `Private IP: ${ips.privateIp} (LAN only)`;
        if (!ips.publicIp) {
          document.querySelector('input[name="playerIpChoice"][value="private"]').checked = true;
        }
        updateSetupPortForwardPanel();
      } catch { /* ignore */ }

    } else if (wizStep === 5) {
      const ipMode = $('#setup-ip-mode').value;
      const choice = document.querySelector('input[name="playerIpChoice"]:checked').value;
      let playerIp;
      if (choice === 'public') playerIp = wizData.publicIp;
      else if (choice === 'private') playerIp = wizData.privateIp || wizData.ip;
      else playerIp = $('#setup-player-ip-manual').value;

      if (!playerIp) { alert('Please enter a player-facing IP.'); return; }

      showOverlay('Configuring network...');
      try {
        const body = { ip: wizData.ip, mode: ipMode, playerIp, token: wizData.token };
        if (ipMode === 'static') {
          body.staticIp = $('#setup-static-ip').value;
          body.staticGw = $('#setup-static-gw').value;
        }
        const res = await api('POST', 'setup/network', body);
        if (res.vmIp) wizData.ip = res.vmIp;
      } catch (e) {
        appendConsole(`Network config error: ${e.message}\n`);
      }
      hideOverlay();
      showWizStep(6);

    } else if (wizStep === 6) {
      const logEl = $('#bootstrap-log');
      const spinner = $('#bootstrap-spinner');
      logEl.textContent = '';
      spinner.hidden = false;
      wizNext.disabled = true;

      try {
        const worldName = $('#setup-world-name').value.trim();
        if (!worldName) { alert('World name is required.'); spinner.hidden = true; wizNext.disabled = false; return; }
        const res = await api('POST', 'setup/bootstrap', {
          ip: wizData.ip,
          enableSwap: $('#setup-swap').checked,
          token: wizData.token,
          worldName,
          region: $('#setup-region').value,
        });
        if (res.success) {
          logEl.textContent += '\nSetup complete!\n';
        } else {
          logEl.textContent += `\nError: ${res.error}\n`;
        }
      } catch (e) {
        logEl.textContent += `\nError: ${e.message}\n`;
      }
      spinner.hidden = true;
      showWizStep(7);
      // Replace nav with a "Go to Dashboard" button
      wizNext.hidden = false;
      wizNext.disabled = false;
      wizNext.textContent = 'Go to Dashboard';
      wizNext.onclick = () => {
        document.querySelector('.tab[data-tab="dashboard"]').click();
      };
      wizBack.hidden = true;
      cachedVmStatus = null;
      refreshStatus();
    }
  });

  // Block clicks on disabled links
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-nolink]');
    if (a) e.preventDefault();
  });

  // -----------------------------------------------------------------------
  // Button bindings — Dashboard
  // -----------------------------------------------------------------------
  $('#btn-vm-start').addEventListener('click', () => startVmAction());
  $('#btn-dashboard-retry-start').addEventListener('click', () => {
    const memGB = parseInt($('#dashboard-retry-memory').value, 10);
    startVmAction(memGB);
  });
  $('#btn-vm-stop').addEventListener('click', () => {
    if (!confirm('Stop the VM? All running servers will go down.')) return;
    runAction('vm/stop', 'Stopping VM');
  });

  $('#btn-bg-start').addEventListener('click',   () => runAction('bg/start', 'Starting battlegroup'));
  $('#btn-bg-restart').addEventListener('click',  () => runAction('bg/restart', 'Restarting battlegroup'));
  $('#btn-bg-stop').addEventListener('click',     () => {
    if (!confirm('Stop the battlegroup?')) return;
    runAction('bg/stop', 'Stopping battlegroup');
  });
  $('#btn-bg-update').addEventListener('click',   () => runAction('bg/update', 'Checking for updates'));

  $('#btn-repair-bootstrap').addEventListener('click', async () => {
    const token = $('#repair-token').value.trim();
    const worldName = $('#repair-world-name').value.trim();
    if (!token) { alert('Server token is required.'); return; }
    if (!worldName) { alert('World name is required.'); return; }
    if (!confirm('Repair will delete the empty battlegroup namespace and re-run setup. Continue?')) return;

    const logEl = $('#repair-log');
    const spinner = $('#repair-spinner');
    logEl.textContent = '';
    spinner.hidden = false;
    $('#btn-repair-bootstrap').disabled = true;
    showOverlay('Repairing battlegroup setup...');

    try {
      const res = await api('POST', 'setup/repair', {
        token,
        worldName,
        region: $('#repair-region').value,
        enableSwap: $('#repair-swap').checked,
      });
      if (res.success) {
        logEl.textContent += '\nRepair complete. Refreshing status...\n';
        await refreshStatus();
      } else {
        logEl.textContent += `\nError: ${res.error}\n`;
      }
    } catch (e) {
      logEl.textContent += `\nError: ${e.message}\n`;
    }
    spinner.hidden = true;
    $('#btn-repair-bootstrap').disabled = false;
    hideOverlay();
  });

  // data-action buttons (battlegroup tab, monitoring, database)
  $$('[data-action]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const action = btn.dataset.action;
      const label = btn.textContent.trim();
      runAction(action, label);
    });
  });

  // -----------------------------------------------------------------------
  // Settings
  // -----------------------------------------------------------------------
  $('#form-password').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pw  = $('#pw-new').value;
    const pw2 = $('#pw-confirm').value;
    if (pw !== pw2) { alert('Passwords do not match.'); return; }
    if (!pw) { alert('Password cannot be empty.'); return; }
    showOverlay('Changing password...');
    appendConsole('\n> Changing VM password\n');
    try {
      const res = await api('POST', 'vm/password', { password: pw });
      if (res.success) {
        appendConsole('Password changed successfully.\n');
        $('#pw-new').value = '';
        $('#pw-confirm').value = '';
      } else {
        appendConsole(`Failed: ${res.error}\n`);
      }
    } catch (e) {
      appendConsole(`Error: ${e.message}\n`);
    }
    hideOverlay();
  });

  $('#btn-rotate-key').addEventListener('click', () => {
    if (!confirm('Generate a new SSH key? The old key will be replaced.')) return;
    runAction('vm/rotate-key', 'Rotating SSH key');
  });

  // -----------------------------------------------------------------------
  // Game Config
  // -----------------------------------------------------------------------
  let configOriginal = {};

  async function loadConfig() {
    const loading = $('#config-loading');
    const panels = $('#config-panels');
    loading.style.display = '';
    panels.style.display = 'none';

    try {
      const data = await api('GET', 'config');
      if (data.error) throw new Error(data.error);

      configOriginal = { game: { ...data.game }, engine: { ...data.engine } };

      $$('.cfg').forEach((el) => {
        const file = el.dataset.file;
        const key = el.dataset.key;
        const values = file === 'game' ? data.game : data.engine;

        if (key in values) {
          let val = values[key];
          // Strip surrounding quotes for string values
          if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
          el.value = val;
        }
        el.classList.remove('cfg-dirty');
      });

      loading.style.display = 'none';
      panels.style.display = '';
    } catch (e) {
      loading.querySelector('.card-body').textContent = 'Failed to load config: ' + e.message;
    }
  }

  // Mark dirty on change
  document.addEventListener('input', (e) => {
    if (e.target.classList.contains('cfg')) e.target.classList.add('cfg-dirty');
  });
  document.addEventListener('change', (e) => {
    if (e.target.classList.contains('cfg')) e.target.classList.add('cfg-dirty');
  });

  // Load when tab opens
  const configTabBtn = document.querySelector('.tab[data-tab="gameconfig"]');
  configTabBtn.addEventListener('click', () => {
    if ($('#config-panels').style.display === 'none') loadConfig();
  });

  // Reload
  $('#btn-config-reload').addEventListener('click', loadConfig);

  // Save
  $('#btn-config-save').addEventListener('click', async () => {
    const changes = { game: {}, engine: {} };
    let count = 0;

    $$('.cfg.cfg-dirty').forEach((el) => {
      const file = el.dataset.file;
      const key = el.dataset.key;
      changes[file][key] = el.value;
      count++;
    });

    if (count === 0) { alert('No changes to save.'); return; }

    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup before saving config changes.');
      return;
    }

    showOverlay(`Saving ${count} setting(s)...`);
    try {
      const res = await api('POST', 'config', changes);
      if (res.success) {
        appendConsole(`Saved ${count} config change(s). Settings deployed — stop & start the battlegroup to apply.\n`);
        $$('.cfg.cfg-dirty').forEach((el) => el.classList.remove('cfg-dirty'));
      } else {
        throw new Error(res.error);
      }
    } catch (e) {
      appendConsole(`Config save error: ${e.message}\n`);
      alert('Save failed: ' + e.message);
    }
    hideOverlay();
  });

  // -----------------------------------------------------------------------
  // Server Visibility
  // -----------------------------------------------------------------------
  let visibilityData = null;

  function buildPortForwardHtml(vmIp, directorPort, opts = {}) {
    const director = directorPort || 'see Dashboard';
    const target = vmIp || 'your VM IP';
    return (
      '<strong>Router port forwarding required (WAN)</strong>' +
      '<p class="pf-target">Forward these ports to your <strong>VM</strong> at <code>' + target + '</code> — not your Windows PC.</p>' +
      '<table><thead><tr><th>Port</th><th>Protocol</th><th>Purpose</th></tr></thead><tbody>' +
      '<tr><td><strong>31982</strong></td><td>TCP</td><td>Queue / matchmaking (required for server finder)</td></tr>' +
      '<tr><td><strong>' + director + '</strong></td><td>TCP</td><td>Director (matchmaking)</td></tr>' +
      '<tr><td><strong>7777–7810</strong></td><td>UDP</td><td>Game server traffic</td></tr>' +
      '</tbody></table>' +
      (opts.setupHint
        ? '<p>Finish setup, then configure these forwards on your router before sharing the server publicly.</p>'
        : '<p>After applying a public IP, <strong>stop the battlegroup completely</strong>, then start it again so Funcom registers the correct join address.</p>')
    );
  }

  function isWanVisibilityChoice(selectedValue, vmIp, publicIp) {
    if (!selectedValue || selectedValue === 'custom') return true;
    if (publicIp && selectedValue === publicIp) return true;
    return vmIp && selectedValue !== vmIp;
  }

  function updateVisibilityPortForwardPanel() {
    const panel = $('#visibility-port-forward');
    if (!panel || !visibilityData) return;

    const selected = document.querySelector('input[name="visibility"]:checked');
    let selectedValue = selected ? selected.value : '';
    if (selectedValue === 'custom') {
      selectedValue = $('#visibility-custom-ip').value.trim() || 'custom';
    }

    const show = isWanVisibilityChoice(selectedValue, visibilityData.vmIp, visibilityData.publicIp);
    panel.innerHTML = buildPortForwardHtml(
      visibilityData.vmIp,
      visibilityData.directorPort,
    );
    panel.hidden = !show;
    panel.style.display = show ? '' : 'none';
  }

  function updateSetupPortForwardPanel() {
    const panel = $('#setup-port-forward');
    if (!panel) return;

    const choice = document.querySelector('input[name="playerIpChoice"]:checked');
    const isPublic = choice && (choice.value === 'public' || choice.value === 'manual');
    if (!isPublic) {
      panel.hidden = true;
      panel.style.display = 'none';
      return;
    }

    panel.innerHTML = buildPortForwardHtml(wizData.ip || 'VM IP', null, { setupHint: true });
    panel.hidden = false;
    panel.style.display = '';
  }

  async function loadVisibility() {
    const loading = $('#visibility-loading');
    const controls = $('#visibility-controls');
    loading.style.display = '';
    controls.style.display = 'none';

    try {
      visibilityData = await api('GET', 'server-visibility');
      if (visibilityData.error) throw new Error(visibilityData.error);

      const radios = $('#visibility-radios');
      radios.innerHTML = '';

      const options = [];
      if (visibilityData.publicIp) {
        options.push({
          value: visibilityData.publicIp,
          label: `Public (WAN) — ${visibilityData.publicIp}`,
          hint: 'Internet players — port forwarding required',
        });
      }
      options.push({
        value: visibilityData.vmIp,
        label: `LAN — ${visibilityData.vmIp}`,
        hint: 'Only players on your local network',
      });
      options.push({ value: 'custom', label: 'Custom IP', hint: 'Enter manually' });

      const current = visibilityData.advertisedIp || visibilityData.vmIp;
      let matchedCustom = true;

      options.forEach((opt) => {
        const id = 'vis-' + opt.value.replace(/\./g, '-');
        const isSelected = opt.value !== 'custom' && current === opt.value;
        if (isSelected) matchedCustom = false;
        const div = document.createElement('label');
        div.className = 'radio-option' + (isSelected ? ' selected' : '');
        div.innerHTML =
          `<input type="radio" name="visibility" value="${opt.value}" id="${id}" ${isSelected ? 'checked' : ''}>` +
          `<span class="radio-label">${opt.label}</span>` +
          `<span class="radio-hint">${opt.hint}</span>`;
        radios.appendChild(div);
      });

      if (matchedCustom && current) {
        const customRadio = radios.querySelector('input[value="custom"]');
        if (customRadio) {
          customRadio.checked = true;
          customRadio.closest('.radio-option').classList.add('selected');
          $('#visibility-custom-ip').value = current;
          $('#visibility-custom-row').style.display = '';
        }
      }

      radios.querySelectorAll('input[type="radio"]').forEach((r) => {
        r.addEventListener('change', () => {
          radios.querySelectorAll('.radio-option').forEach((o) => o.classList.remove('selected'));
          r.closest('.radio-option').classList.add('selected');
          $('#visibility-custom-row').style.display = r.value === 'custom' ? '' : 'none';
          updateVisibilityPortForwardPanel();
        });
      });

      const customIpInput = $('#visibility-custom-ip');
      if (customIpInput) {
        customIpInput.addEventListener('input', updateVisibilityPortForwardPanel);
      }

      $('#visibility-current').textContent = `Currently advertising: ${current}`;
      updateVisibilityPortForwardPanel();

      loading.style.display = 'none';
      controls.style.display = '';
    } catch (e) {
      loading.textContent = 'Failed to load visibility: ' + e.message;
    }
  }

  $('#btn-visibility-save').addEventListener('click', async () => {
    const selected = document.querySelector('input[name="visibility"]:checked');
    if (!selected) { alert('Select an option.'); return; }

    let ip = selected.value;
    if (ip === 'custom') {
      ip = $('#visibility-custom-ip').value.trim();
      if (!ip) { alert('Enter a custom IP address.'); return; }
    }

    showOverlay('Setting server visibility...');
    try {
      const res = await api('POST', 'server-visibility', { advertisedIp: ip });
      appendConsole(`Server visibility set to ${ip}.\n`);
      if (res.message) appendConsole(res.message + '\n');
      appendConsole('Self-hosted servers appear in-game under Servers → Experimental.\n');
      await loadVisibility();
    } catch (e) { alert('Failed: ' + e.message); }
    hideOverlay();
  });

  // Load visibility when Game Config tab opens
  const origConfigLoad = loadConfig;
  loadConfig = async function() {
    await origConfigLoad();
    loadVisibility();
  };

  // -----------------------------------------------------------------------
  // Character Editor
  // -----------------------------------------------------------------------
  const INVENTORY_LABELS = {
    0: 'Backpack', 1: 'Recipes', 12: 'Emotes', 14: 'Social',
    15: 'Hotbar', 20: 'Quick-use', 25: 'Slot-25', 27: 'Equipped',
    29: 'Slot-29', 30: 'Storage', 31: 'Slot-31', 32: 'Slot-32', 33: 'Slot-33',
  };
  const WRITABLE_INV_TYPES = [0, 15, 20, 27];
  const STACK_LIMITS = {
    'Resources': 100, 'Ammo': 100, 'Consumables': 20, 'Fuel': 5,
    'Weapons - Melee': 1, 'Weapons - Ranged': 1,
    'Garments': 1, 'Garments - Head': 1, 'Garments - Chest': 1,
    'Garments - Hands': 1, 'Garments - Legs': 1, 'Garments - Feet': 1,
    'Tools': 1, 'Vehicle Modules': 1, 'Building': 1, 'Contract Items': 1, 'Misc': 1,
  };

  let itemCatalog = null;
  let catalogArr = [];
  let charData = null;
  let onlineActionCatalog = null;

  async function loadItemCatalog() {
    if (itemCatalog) return;
    try {
      const [itemResp, augmentResp] = await Promise.all([
        fetch('/data/item-catalog.json'),
        fetch('/data/augment-catalog.json'),
      ]);
      if (!itemResp.ok || !augmentResp.ok) throw new Error('A reviewed item catalog could not be loaded.');
      const [data, augmentData] = await Promise.all([itemResp.json(), augmentResp.json()]);
      itemCatalog = { ...(data.items || {}), ...(augmentData.items || {}) };
      catalogArr = Object.entries(itemCatalog).map(([tid, info]) => ({
        tid,
        name: info.name,
        category: info.category,
        effect: info.effect || '',
        offlineCreatable: info.offlineCreatable === true,
        offlineExperimental: info.offlineExperimental === true,
        packageOnly: info.packageOnly === true,
      }));
      catalogArr.sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      appendConsole('Failed to load item catalog: ' + e.message + '\n');
    }
  }

  async function loadOnlineActionCatalog() {
    if (onlineActionCatalog) return;
    try {
      onlineActionCatalog = await api('GET', 'online-actions/catalog');

      const moduleSelect = $('#online-skill-module');
      moduleSelect.innerHTML = '<option value="">— Select a skill or ability —</option>';
      const byCategory = new Map();
      (onlineActionCatalog.skillModules || []).forEach(module => {
        const category = module.category || 'Other';
        if (!byCategory.has(category)) byCategory.set(category, []);
        byCategory.get(category).push(module);
      });
      [...byCategory.keys()].sort().forEach(category => {
        const group = document.createElement('optgroup');
        group.label = category;
        byCategory.get(category).sort((a, b) => a.name.localeCompare(b.name)).forEach(module => {
          const option = document.createElement('option');
          option.value = module.id;
          option.textContent = `${module.name} (max ${module.maxLevel})`;
          option.dataset.maxLevel = module.maxLevel;
          group.appendChild(option);
        });
        moduleSelect.appendChild(group);
      });

      const bulkActionSelect = $('#online-bulk-training-action');
      bulkActionSelect.innerHTML = '<option value="">— Select a reviewed bulk action —</option>';
      (onlineActionCatalog.bulkTrainingActions || []).forEach(action => {
        const option = document.createElement('option');
        option.value = action.id;
        option.textContent = action.name;
        bulkActionSelect.appendChild(option);
      });

      const augmentBulkButton = $('#btn-online-grant-all-augments');
      if (augmentBulkButton && Number.isSafeInteger(onlineActionCatalog.confirmedAugmentCount)) {
        augmentBulkButton.textContent = `Give 1 of Every Confirmed Augment (${onlineActionCatalog.confirmedAugmentCount})`;
      }
    } catch (e) {
      appendConsole('Failed to load online action catalog: ' + e.message + '\n');
    }
  }

  function populateOnlineItemCatalog() {
    const list = $('#online-item-templates');
    if (!list || !catalogArr.length || list.children.length) return;
    const fragment = document.createDocumentFragment();
    catalogArr.forEach(item => {
      const option = document.createElement('option');
      option.value = item.tid;
      option.label = `${item.name} — ${item.category}`;
      fragment.appendChild(option);
    });
    list.appendChild(fragment);
  }

  function syncOnlineItemQuantityLimit() {
    const templateId = ($('#online-item-template').value || '').trim();
    const countInput = $('#online-item-count');
    const isAugment = itemCatalog?.[templateId]?.category === 'Augments';
    const genericMaximum = onlineActionCatalog?.limits?.itemCount?.max || 1000;
    countInput.max = isAugment ? '1' : String(genericMaximum);
    if (isAugment) countInput.value = '1';
  }

  function updateOnlineCharacterStatus() {
    const badge = $('#online-character-status');
    if (!badge) return;
    const state = String(charData?.playerState?.onlineStatus || 'Offline');
    const online = state.toLowerCase() === 'online' && charData?.playerState?.serverId;
    badge.textContent = online ? 'Online — live actions ready' : `${state} — live actions unavailable`;
    badge.classList.toggle('online-ready', Boolean(online));
  }

  let cosmeticCatalog = null;
  let cosmeticArr = [];
  let unlockedCosmetics = new Set();

  async function loadCosmeticCatalog() {
    if (cosmeticCatalog) return;
    try {
      const resp = await fetch('/data/cosmetic-catalog.json');
      const data = await resp.json();
      cosmeticCatalog = data.cosmetics;
      cosmeticArr = Object.entries(cosmeticCatalog).map(([id, info]) => ({
        id, name: info.name, category: info.category, unlock: info.unlock || 'customization',
      }));
      cosmeticArr.sort((a, b) => a.name.localeCompare(b.name));
      const hint = $('#cosmetic-results-hint');
      if (hint && data._meta?.unlockable) {
        hint.textContent = `Type at least 2 characters to search across ${data._meta.unlockable} reviewed persisted cosmetic IDs, or pick a category filter.`;
      }
    } catch (e) {
      appendConsole('Failed to load cosmetic catalog: ' + e.message + '\n');
    }
  }

  function catalogName(tid) {
    if (!itemCatalog) return tid;
    const info = itemCatalog[tid];
    return info ? info.name : tid;
  }

  function catalogCategory(tid) {
    if (!itemCatalog) return 'Misc';
    const info = itemCatalog[tid];
    return info ? info.category : 'Misc';
  }

  function isEquipmentCategory(cat) {
    return /Weapon|Garment|Tool/i.test(cat);
  }

  async function loadCharacterList() {
    const sel = $('#char-select');
    sel.innerHTML = '<option value="">Loading...</option>';
    try {
      const data = await api('GET', 'characters');
      sel.innerHTML = '<option value="">— Choose a character —</option>';
      (data.characters || []).forEach(c => {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = `${c.name} (ID: ${c.id})`;
        sel.appendChild(opt);
      });
    } catch (e) {
      sel.innerHTML = '<option value="">Error loading characters</option>';
    }
  }

  function readStat(data, field, pathStr) {
    const parts = pathStr.split('.');
    let obj = field === 'properties' ? data.properties : data.gasAttributes;
    for (const p of parts) {
      if (!obj || typeof obj !== 'object') return '';
      obj = obj[p];
    }
    if (obj && typeof obj === 'object' && 'BaseValue' in obj) return obj.BaseValue;
    return obj != null ? obj : '';
  }

  function renderInventory() {
    if (!charData) return;
    const tbody = $('#inv-tbody');
    const items = charData.items || [];
    tbody.innerHTML = '';

    const nonEmoteItems = items.filter(i =>
      !i.template_id.startsWith('Emote_') && !i.template_id.startsWith('Social_')
    );

    nonEmoteItems.forEach(item => {
      const tr = document.createElement('tr');
      const name = catalogName(item.template_id);
      const loc = INVENTORY_LABELS[item.inventory_type] || `Type ${item.inventory_type}`;
      const grade = item.quality_level == null ? '-' : item.quality_level;
      const augmentAction = item.augment_eligible
        ? `<button class="btn-augment-max" data-item-id="${item.id}" ` +
          `title="Max ${item.augment_roll_count} positive numeric roll(s) and set Grade 5">Max + Grade 5</button>`
        : '';
      tr.innerHTML = `
        <td class="item-name">${name}</td>
        <td class="item-tid">${item.template_id}</td>
        <td>${item.stack_size}</td>
        <td>${grade}</td>
        <td>${loc}</td>
        <td><div class="inventory-actions">${augmentAction}<button class="btn-remove" data-item-id="${item.id}">Remove</button></div></td>
      `;
      tbody.appendChild(tr);
    });

    $('#inv-count').textContent = `${nonEmoteItems.length} items`;
  }

  async function loadCharacter(actorId) {
    showOverlay('Loading character...');
    try {
      charData = await api('GET', `characters/${actorId}`);
      $('#char-editor').style.display = '';
      setCharacterWorkspaceAvailable(true);
      switchCharacterView('online');

      const selectedCharacter = $('#char-select').selectedOptions[0];
      $('#character-selection-title').textContent = selectedCharacter?.value
        ? selectedCharacter.textContent
        : `Character ${actorId}`;

      $$('.char-stat').forEach(el => {
        const field = el.dataset.field;
        const pathStr = el.dataset.path;
        el.value = readStat(charData, field, pathStr);
      });

      charData.writableInvs = charData.inventories
        .filter(inv => WRITABLE_INV_TYPES.includes(inv.inventory_type))
        .map(inv => ({
          id: inv.id,
          type: inv.inventory_type,
          label: INVENTORY_LABELS[inv.inventory_type] || `Type ${inv.inventory_type}`,
        }));

      renderInventory();
      updateOnlineCharacterStatus();
    } catch (e) {
      alert('Failed to load character: ' + e.message);
    }
    hideOverlay();
  }

  // Character tab — load list on first open
  let charTabLoaded = false;
  document.querySelector('.tab[data-tab="characters"]').addEventListener('click', async () => {
    await Promise.all([loadItemCatalog(), loadCosmeticCatalog(), loadOnlineActionCatalog()]);
    populateOnlineItemCatalog();
    if (!charTabLoaded) {
      charTabLoaded = true;
      loadCharacterList();
    }
  });

  $('#btn-char-refresh').addEventListener('click', () => loadCharacterList());
  $('#btn-char-load').addEventListener('click', () => {
    const id = $('#char-select').value;
    if (!id) { alert('Select a character first.'); return; }
    loadCharacter(parseInt(id));
  });

  // Save stats
  $('#btn-stats-save').addEventListener('click', async () => {
    if (!charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup before editing characters.');
      return;
    }

    const updates = [];
    $$('.char-stat').forEach(el => {
      const field = el.dataset.field;
      const pathStr = el.dataset.path;
      const parts = pathStr.split('.');
      const val = parseFloat(el.value);
      if (isNaN(val)) return;

      if (field === 'gas_attributes' && parts.length === 2) {
        updates.push({ field, path: [parts[0], parts[1], 'BaseValue'], value: val });
        updates.push({ field, path: [parts[0], parts[1], 'CurrentValue'], value: val });
      } else if (field === 'properties' && pathStr === 'DamageableActorComponent.m_TotalMaxHealth') {
        updates.push({ field, path: parts, value: val });
        updates.push({ field, path: ['DamageableActorComponent', 'm_CurrentMaxHealth'], value: val });
      } else {
        updates.push({ field, path: parts, value: val });
      }
    });

    if (!updates.length) { alert('No changes to save.'); return; }

    showOverlay('Saving stats...');
    try {
      const res = await api('POST', `characters/${charData.actorId}/stats`, { updates });
      if (res.success) {
        appendConsole(`Stats saved for character ${charData.actorId}.\n`);
        alert('Stats saved. Restart the battlegroup for changes to take effect.');
      } else {
        throw new Error(res.error);
      }
    } catch (e) {
      alert('Save failed: ' + e.message);
    }
    hideOverlay();
  });

  // Remove item
  $('#inv-tbody').addEventListener('click', async (e) => {
    const augmentBtn = e.target.closest('.btn-augment-max');
    if (augmentBtn && charData) {
      if (status && status.battlegroup && status.battlegroup.running) {
        alert('Stop the battlegroup before changing augment attributes.');
        return;
      }
      const itemId = Number(augmentBtn.dataset.itemId);
      const item = (charData.items || []).find((candidate) => candidate.id === itemId);
      if (!item || !item.augment_eligible) {
        alert('This item is not a supported standalone augment. Refresh the character and try again.');
        return;
      }
      if (!confirm(
        `Max ${item.augment_roll_count} positive numeric roll(s) on ${catalogName(item.template_id)} and set it to Grade 5?\n\n` +
        'The character must be logged out. A safety backup will be created first.'
      )) return;

      augmentBtn.disabled = true;
      augmentBtn.textContent = 'Working...';
      showOverlay('Maximizing augment and setting Grade 5...');
      try {
        const response = await api(
          'POST',
          `characters/${charData.actorId}/inventory/${itemId}/augment/max`,
          {}
        );
        $('#augment-max-result').textContent =
          `Verified item ${response.itemId}: ${response.numericAttributes} positive numeric roll(s), ` +
          `${response.changedAttributes} roll value(s) changed, Grade 5` +
          `${response.gradeChanges ? ' applied' : ' already set'}. Backup: ${response.backup}`;
        appendConsole(
          `Augment item ${response.itemId} verified at maximum rolls and Grade 5. ` +
          `Backup: ${response.backup}.\n`
        );
        await loadCharacter(charData.actorId);
      } catch (error) {
        $('#augment-max-result').textContent = 'No augment changes were committed: ' + error.message;
        alert('Augment update failed: ' + error.message);
      } finally {
        if (augmentBtn.isConnected) {
          augmentBtn.disabled = false;
          augmentBtn.textContent = 'Max + Grade 5';
        }
        hideOverlay();
      }
      return;
    }

    const btn = e.target.closest('.btn-remove');
    if (!btn || !charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup before editing inventory.');
      return;
    }

    const itemId = btn.dataset.itemId;
    if (!confirm('Remove this item?')) return;

    try {
      await api('DELETE', `characters/${charData.actorId}/inventory/${itemId}`);
      charData.items = charData.items.filter(i => i.id !== parseInt(itemId));
      renderInventory();
    } catch (e) {
      alert('Remove failed: ' + e.message);
    }
  });

  // Item search
  let searchTimeout;
  function runItemSearch() {
    const query = ($('#item-search').value || '').trim().toLowerCase();
    const catFilter = $('#item-cat-filter').value;
    const resultsWrap = $('#item-results');
    const tbody = $('#item-results-body');
    const hint = $('#item-results-hint');

    if (query.length < 2 && !catFilter) {
      resultsWrap.style.display = 'none';
      hint.style.display = '';
      return;
    }

    let results = catalogArr;
    if (query.length >= 2) {
      results = results.filter(i =>
        i.name.toLowerCase().includes(query) || i.tid.toLowerCase().includes(query));
    }
    if (catFilter) {
      if (catFilter === 'Garments') {
        results = results.filter(i => i.category.startsWith('Garments'));
      } else {
        results = results.filter(i => i.category === catFilter);
      }
    }

    results = results.slice(0, 50);

    tbody.innerHTML = '';
    if (!results.length) {
      tbody.innerHTML = '<tr><td colspan="5" style="color:var(--text-dim);text-align:center;padding:1rem">No items found</td></tr>';
    } else {
      const invOptions = (charData && charData.writableInvs || [])
        .map(inv => `<option value="${inv.id}">${inv.label}</option>`)
        .join('');
      const defaultInvOption = invOptions || '<option value="">No character loaded</option>';

      results.forEach(item => {
        const cat = item.category;
        const maxStack = STACK_LIMITS[cat] || 100;
        const isEq = isEquipmentCategory(cat);
        const isAugment = cat === 'Augments';
        const canCreateOffline = isAugment && item.offlineCreatable;
        const tr = document.createElement('tr');
        if (isAugment) tr.classList.add('offline-augment-row');
        tr.innerHTML = `
          <td class="item-name">${item.name}<br><span class="item-tid">${item.tid}</span>${item.effect ? `<br><span class="item-effect">${item.effect}</span>` : ''}</td>
          <td style="font-size:.72rem;color:var(--text-dim)">${cat}</td>
          <td>${isAugment ? '<span class="fixed-value">1 fixed</span>' : `<input type="number" value="1" min="1" max="${maxStack}" class="add-qty" data-max="${maxStack}">`}</td>
          <td>${canCreateOffline ? '<span class="fixed-value">Backpack (automatic)</span>' : isAugment ? '<span class="fixed-value">Native online grant</span>' : `<select class="add-inv">${defaultInvOption}</select>`}</td>
          <td>${canCreateOffline
            ? `<button class="btn-create-augment" data-tid="${item.tid}" data-experimental="${item.offlineExperimental ? 1 : 0}">Create Offline</button>`
            : isAugment
              ? '<span class="fixed-value">Online only</span>'
            : `<button class="btn-add" data-tid="${item.tid}" data-eq="${isEq ? 1 : 0}">Add</button>`}</td>
        `;
        tbody.appendChild(tr);
      });
    }

    resultsWrap.style.display = '';
    hint.style.display = 'none';
  }

  $('#item-search').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(runItemSearch, 200);
  });
  $('#item-cat-filter').addEventListener('change', runItemSearch);

  // Add item
  $('#item-results-body').addEventListener('click', async (e) => {
    const augmentBtn = e.target.closest('.btn-create-augment');
    if (augmentBtn && charData) {
      if (status && status.battlegroup && status.battlegroup.running) {
        alert('Stop the battlegroup before creating an augment offline.');
        return;
      }
      const tid = augmentBtn.dataset.tid;
      const item = catalogArr.find(candidate => candidate.tid === tid && candidate.category === 'Augments');
      if (!item) {
        alert('Select one of the reviewed augments.');
        return;
      }
      const experimentalNotice = augmentBtn.dataset.experimental === '1'
        ? '\n\nThis template shape was reconstructed from an installed augment and remains experimental. Verify it in-game.'
        : '';
      if (!confirm(
        `Create one ${item.name} in this character's Backpack?\n\n` +
        'The battlegroup must be fully stopped and the character logged out. A safety backup will be created first. ' +
        'The native Online Actions grant remains the preferred, game-proven method.' +
        experimentalNotice
      )) return;

      augmentBtn.disabled = true;
      augmentBtn.textContent = 'Creating...';
      showOverlay('Creating reviewed augment in the Backpack...');
      try {
        const response = await api('POST', `characters/${charData.actorId}/inventory/add-augment`, {
          templateId: tid,
        });
        $('#augment-max-result').textContent =
          `Created ${item.name} as item ${response.itemId} in Backpack position ${response.positionIndex}, ` +
          `Grade ${response.qualityLevel}. Backup: ${response.backup}. ` +
          'You can now use Max + Grade 5 while the battlegroup remains stopped and the character stays logged out.';
        appendConsole(
          `Verified offline creation of ${item.name} as item ${response.itemId}. Backup: ${response.backup}.\n`
        );
        await loadCharacter(charData.actorId);
        runItemSearch();
      } catch (error) {
        alert('Offline augment creation failed: ' + error.message);
      } finally {
        if (augmentBtn.isConnected) {
          augmentBtn.disabled = false;
          augmentBtn.textContent = 'Create Offline';
        }
        hideOverlay();
      }
      return;
    }

    const btn = e.target.closest('.btn-add');
    if (!btn || !charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup before editing inventory.');
      return;
    }

    const row = btn.closest('tr');
    const qty = parseInt(row.querySelector('.add-qty').value);
    const invId = parseInt(row.querySelector('.add-inv').value);
    const tid = btn.dataset.tid;
    const isEq = btn.dataset.eq === '1';
    const maxStack = parseInt(row.querySelector('.add-qty').dataset.max);

    if (!invId) { alert('Load a character first.'); return; }
    if (isNaN(qty) || qty < 1) { alert('Invalid quantity.'); return; }
    if (qty > maxStack) {
      if (!confirm(`Warning: ${qty} exceeds the estimated max stack of ${maxStack} for this item type. This may cause issues. Continue?`)) return;
    }

    btn.disabled = true;
    btn.textContent = '...';
    try {
      const res = await api('POST', `characters/${charData.actorId}/inventory/add`, {
        templateId: tid, stackSize: qty, inventoryId: invId, isEquipment: isEq,
      });
      if (res.success) {
        appendConsole(`Added ${qty}x ${catalogName(tid)} to inventory.\n`);
        await loadCharacter(charData.actorId);
        runItemSearch();
      } else {
        throw new Error(res.error);
      }
    } catch (e) {
      alert('Add failed: ' + e.message);
    }
    btn.disabled = false;
    btn.textContent = 'Add';
  });

  // Max all supported standalone augment rolls for the selected offline character and set Grade 5.
  $('#btn-augment-max-all').addEventListener('click', async () => {
    if (!charData) { alert('Load a character first.'); return; }
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup before changing augment attributes.');
      return;
    }

    const confirmed = confirm(
      'Max every supported standalone augment in this character\'s owned inventories and set each one to Grade 5? ' +
      'Non-positive sentinel values will be preserved. Already-installed augments are not included.\n\n' +
      'The character must be logged out. A safety backup will be created before the change.'
    );
    if (!confirmed) return;

    const button = $('#btn-augment-max-all');
    const result = $('#augment-max-result');
    button.disabled = true;
    result.textContent = 'Creating a backup and checking augment attributes...';
    showOverlay('Maximizing supported augments and setting Grade 5...');
    try {
      const response = await api('POST', `characters/${charData.actorId}/augments/max-attributes`, {});
      result.textContent = response.eligibleItems
        ? `Verified ${response.numericAttributes} positive numeric rolls across ${response.updatedItems} supported standalone augment item(s); ` +
          `${response.changedAttributes} roll value(s) changed and ${response.gradeChanges} item grade(s) changed to 5. Backup: ${response.backup}`
        : `No supported standalone augment items were found in this character's owned inventories. Backup: ${response.backup}`;
      appendConsole(
        `Augment attributes verified for character ${charData.actorId}: ` +
        `${response.updatedItems} item(s), ${response.changedAttributes} roll value(s) changed, ` +
        `${response.gradeChanges} grade(s) changed to 5. ` +
        `Backup: ${response.backup}.\n`
      );
      await loadCharacter(charData.actorId);
    } catch (e) {
      result.textContent = 'No augment changes were committed: ' + e.message;
      alert('Augment update failed: ' + e.message);
    } finally {
      button.disabled = false;
      hideOverlay();
    }
  });

  // -----------------------------------------------------------------------
  // Cosmetics
  // -----------------------------------------------------------------------
  function cosmeticLabel(id) {
    if (cosmeticCatalog && cosmeticCatalog[id]) return cosmeticCatalog[id].name;
    return id.replace(/^MTX_/, '').replace(/_MeshVariant$/, '').replace(/_/g, ' ');
  }

  function cosmeticCategory(id) {
    if (cosmeticCatalog && cosmeticCatalog[id]) return cosmeticCatalog[id].category;
    return 'Other';
  }

  async function addCosmetic(cosmeticId) {
    if (!charData) { alert('Load a character first.'); return false; }
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return false;
    }
    if (unlockedCosmetics.has(cosmeticId)) return true;

    showOverlay('Adding cosmetic...');
    try {
      const res = await api('POST', `characters/${charData.actorId}/cosmetics/add`, { cosmeticId });
      appendConsole(`Cosmetic "${cosmeticLabel(cosmeticId)}" added. Backup: ${res.backup}.\n`);
      unlockedCosmetics.add(cosmeticId);
      updateCosmeticCount();
      runCosmeticSearch();
      return true;
    } catch (e) {
      alert('Failed: ' + e.message);
      return false;
    } finally {
      hideOverlay();
    }
  }

  async function removeCosmetic(cosmeticId, { confirmRemove = true } = {}) {
    if (!charData) { alert('Load a character first.'); return false; }
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return false;
    }
    if (!unlockedCosmetics.has(cosmeticId)) return true;
    if (confirmRemove && !confirm(`Remove cosmetic "${cosmeticLabel(cosmeticId)}"?`)) return false;

    showOverlay('Removing cosmetic...');
    try {
      const res = await api('POST', `characters/${charData.actorId}/cosmetics/remove`, { cosmeticId });
      appendConsole(`Cosmetic "${cosmeticLabel(cosmeticId)}" removed. Backup: ${res.backup}.\n`);
      unlockedCosmetics.delete(cosmeticId);
      updateCosmeticCount();
      runCosmeticSearch();
      return true;
    } catch (e) {
      alert('Failed: ' + e.message);
      return false;
    } finally {
      hideOverlay();
    }
  }

  function updateCosmeticCount() {
    $('#cosmetic-count').textContent = `${unlockedCosmetics.size} unlocked`;
  }

  let cosmeticSearchTimeout;
  function runCosmeticSearch() {
    const query = ($('#cosmetic-search').value || '').trim().toLowerCase();
    const catFilter = $('#cosmetic-cat-filter').value;
    const resultsWrap = $('#cosmetic-results');
    const tbody = $('#cosmetic-results-body');
    const hint = $('#cosmetic-results-hint');

    if (query.length < 2 && !catFilter) {
      resultsWrap.style.display = 'none';
      hint.style.display = '';
      return;
    }

    let results = cosmeticArr;
    if (query.length >= 2) {
      results = results.filter(c =>
        c.name.toLowerCase().includes(query) || c.id.toLowerCase().includes(query));
    }
    if (catFilter) {
      results = results.filter(c => c.category === catFilter);
    }

    results = results.slice(0, 100);

    tbody.innerHTML = '';
    if (!results.length) {
      tbody.innerHTML = '<tr><td colspan="3" style="color:var(--text-dim);text-align:center;padding:1rem">No cosmetics found</td></tr>';
    } else {
      results.forEach(c => {
        const owned = unlockedCosmetics.has(c.id);
        const invOnly = c.unlock === 'inventory';
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td class="item-name">${c.name}${invOnly ? ' <span style="color:var(--amber,#c9a227);font-size:.72rem">(inventory item)</span>' : ''}<br><span class="item-tid">${c.id}</span></td>
          <td style="font-size:.72rem;color:var(--text-dim)">${c.category}</td>
          <td><button class="btn btn-sm cosmetic-toggle ${owned ? 'btn-remove' : 'btn-green'}" data-cosmetic="${c.id}" data-owned="${owned ? '1' : '0'}" ${invOnly ? 'title="Swatch tokens usually need to be added via Inventory, not cosmetics"' : ''}>${owned ? 'Remove' : 'Add'}</button></td>
        `;
        tbody.appendChild(tr);
      });
    }

    resultsWrap.style.display = '';
    hint.style.display = 'none';
  }

  $('#cosmetic-search').addEventListener('input', () => {
    clearTimeout(cosmeticSearchTimeout);
    cosmeticSearchTimeout = setTimeout(runCosmeticSearch, 200);
  });
  $('#cosmetic-cat-filter').addEventListener('change', runCosmeticSearch);

  $('#cosmetic-results-body').addEventListener('click', async (e) => {
    const btn = e.target.closest('.cosmetic-toggle');
    if (!btn) return;

    const cosmeticId = btn.dataset.cosmetic;
    const owned = btn.dataset.owned === '1';
    btn.disabled = true;
    btn.textContent = '...';

    const ok = owned
      ? await removeCosmetic(cosmeticId)
      : await addCosmetic(cosmeticId);

    if (!ok) {
      btn.disabled = false;
      btn.textContent = owned ? 'Remove' : 'Add';
    }
  });

  async function loadCosmetics() {
    if (!charData) return;
    try {
      const data = await api('GET', `characters/${charData.actorId}/cosmetics`);
      unlockedCosmetics = new Set(data.cosmetics || []);
      updateCosmeticCount();
    } catch (e) {
      appendConsole('Failed to load cosmetics: ' + e.message + '\n');
    }
  }

  $('#btn-cosmetic-add').addEventListener('click', async () => {
    const input = $('#cosmetic-add-input');
    const cosmeticId = input.value.trim();
    if (!cosmeticId) { alert('Enter a cosmetic ID.'); return; }
    const ok = await addCosmetic(cosmeticId);
    if (ok) input.value = '';
  });

  $('#btn-cosmetic-unlock-all').addEventListener('click', async () => {
    if (!charData) { alert('Load a character first.'); return; }
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return;
    }
    if (!confirm('Unlock all reviewed persisted cosmetics on this character? Existing entries are preserved and a database backup is created first.')) return;

    showOverlay('Unlocking all cosmetics...');
    try {
      const res = await api('POST', `characters/${charData.actorId}/cosmetics/unlock-all`);
      appendConsole(`Verified ${res.total} cosmetics. Backup: ${res.backup}.\n`);
      await loadCosmetics();
      runCosmeticSearch();
    } catch (e) {
      alert('Failed: ' + e.message + '\n\nStop and restart the Server Manager (start_as_admin.bat), then try again.');
    }
    hideOverlay();
  });

  // -----------------------------------------------------------------------
  // Tech Tree
  // -----------------------------------------------------------------------
  async function refreshTechCount() {
    if (!charData) return;
    try {
      const d = await api('GET', `characters/${charData.actorId}`);
      const tree = d.properties?.TechKnowledgePlayerComponent?.m_TechKnowledge?.m_TechKnowledgeData || [];
      const purchased = tree.filter(i => i.UnlockedState === 'Purchased').length;
      $('#tech-count').textContent = `${purchased} purchased / ${tree.length} valid entries`;
    } catch { /* silent */ }
  }

  $('#btn-tech-unlock-all').addEventListener('click', async () => {
    if (!charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return;
    }
    if (!confirm('Unlock every valid tech entry already created by the game for this character? A database backup will be created first.')) return;
    showOverlay('Unlocking all recipes...');
    try {
      const res = await api('POST', `characters/${charData.actorId}/tech/unlock-all`);
      appendConsole(`Tech tree: ${res.total} valid entries unlocked; no guessed nodes injected. Backup: ${res.backup}.\n`);
      await refreshTechCount();
    } catch (e) { alert('Failed: ' + e.message); }
    hideOverlay();
  });

  $('#btn-tech-lock-all').addEventListener('click', async () => {
    if (!charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return;
    }
    if (!confirm('Lock ALL tech tree recipes? This resets your entire tech tree.')) return;
    showOverlay('Locking all recipes...');
    try {
      await api('POST', `characters/${charData.actorId}/tech/lock-all`);
      appendConsole('All tech tree recipes locked.\n');
      await refreshTechCount();
    } catch (e) { alert('Failed: ' + e.message); }
    hideOverlay();
  });

  // -----------------------------------------------------------------------
  // Specializations
  // -----------------------------------------------------------------------
  const SPEC_TRACKS = [
    { type: 'Combat', label: 'Combat' },
    { type: 'Crafting', label: 'Crafting' },
    { type: 'Exploration', label: 'Exploration' },
    { type: 'Gathering', label: 'Gathering' },
    { type: 'Sabotage', label: 'Sabotage' },
  ];

  async function loadSpecializations() {
    if (!charData) return;
    try {
      const data = await api('GET', `characters/${charData.actorId}/specializations`);
      const grid = $('#spec-tracks-grid');
      grid.innerHTML = '';

      SPEC_TRACKS.forEach(spec => {
        const track = (data.tracks || []).find(t => t.track_type === spec.type);
        const xp = track ? track.xp_amount : 0;
        const lvl = track ? track.level : 0;

        const div = document.createElement('div');
        div.className = 'config-item';
        div.innerHTML = `
          <label>${spec.label} <span class="field-hint-inline">current: Lv${Math.floor(lvl)}, ${xp} XP</span></label>
          <div class="input-with-unit">
            <input type="number" class="select-input spec-level" data-track="${spec.type}" value="${Math.floor(lvl)}" min="0" max="100" step="1" placeholder="Level" style="width:70px" title="Level">
            <input type="number" class="select-input spec-xp" data-track="${spec.type}" value="${xp}" min="0" step="1000" placeholder="XP" style="width:100px" title="XP">
            <button class="btn btn-green btn-sm spec-save" data-track="${spec.type}">Set</button>
          </div>
        `;
        grid.appendChild(div);
      });
    } catch (e) {
      appendConsole('Failed to load specializations: ' + e.message + '\n');
    }
  }

  document.addEventListener('click', async (e) => {
    const saveBtn = e.target.closest('.spec-save');
    if (!saveBtn || !charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return;
    }

    const track = saveBtn.dataset.track;
    const row = saveBtn.closest('.config-item');
    const level = parseFloat(row.querySelector('.spec-level').value);
    const xp = parseInt(row.querySelector('.spec-xp').value);

    showOverlay(`Setting ${track}...`);
    try {
      const res = await api('POST', `characters/${charData.actorId}/specializations/track`, {
        trackType: track, xp, level,
      });
      appendConsole(`${track} set to level ${level}, ${xp} XP. Backup: ${res.backup}.\n`);
      await loadSpecializations();
    } catch (e) { alert('Failed: ' + e.message); }
    hideOverlay();
  });

  $('#online-skill-module').addEventListener('change', (e) => {
    const selected = e.target.selectedOptions[0];
    const maximum = parseInt(selected?.dataset.maxLevel || '1', 10);
    const level = $('#online-skill-level');
    level.max = maximum;
    if (parseInt(level.value, 10) > maximum) level.value = maximum;
  });

  $('#online-item-template').addEventListener('input', syncOnlineItemQuantityLimit);
  $('#online-item-template').addEventListener('change', syncOnlineItemQuantityLimit);

  $$('.online-action-btn').forEach(button => button.addEventListener('click', async () => {
    if (!charData) { alert('Load a character first.'); return; }
    const action = button.dataset.onlineAction;
    let body = { action };
    let confirmation = '';

    if (action === 'award-xp') {
      body.category = $('#online-xp-category').value;
      body.amount = Number($('#online-xp-amount').value);
      confirmation = `Add ${body.amount.toLocaleString()} ${body.category} XP to this online character?`;
    } else if (action === 'set-skill-points') {
      body.points = Number($('#online-skill-points').value);
      confirmation = `Set this character's unspent skill points to ${body.points.toLocaleString()}? This replaces the current unspent amount.`;
    } else if (action === 'set-skill-module') {
      body.moduleId = $('#online-skill-module').value;
      body.level = Number($('#online-skill-level').value);
      if (!body.moduleId) { alert('Select a skill or ability first.'); return; }
      const label = $('#online-skill-module').selectedOptions[0]?.textContent || body.moduleId;
      confirmation = `Set ${label} to level ${body.level}?`;
    } else if (action === 'give-item') {
      body.templateId = $('#online-item-template').value.trim();
      if (!itemCatalog || !Object.prototype.hasOwnProperty.call(itemCatalog, body.templateId)) {
        alert('Select an exact item from the reviewed catalog.'); return;
      }
      syncOnlineItemQuantityLimit();
      body.count = Number($('#online-item-count').value);
      body.durability = Number($('#online-item-durability').value);
      const packageOnly = itemCatalog[body.templateId].packageOnly === true;
      body.confirmPackageOnly = packageOnly;
      confirmation = `Give ${body.count.toLocaleString()} × ${catalogName(body.templateId)} to this online character? Items that do not fit may be handled by the game near the player.` +
        (packageOnly
          ? '\n\nEXPERIMENTAL PACKAGE-ONLY ID: it exists in the current 1.4 Systems.pak, but has not been observed as a persisted player item. The game may ignore it or create an unfinished item. Continue?'
          : '');
    } else if (action === 'grant-all-confirmed-augments') {
      const augmentCount = onlineActionCatalog?.confirmedAugmentCount || 105;
      const excludedCount = onlineActionCatalog?.excludedPackageOnlyAugmentCount || 22;
      confirmation = `Queue exactly one of each of the ${augmentCount} metadata-confirmed augments for this online character? Commands are paced about 300 ms apart and will take roughly ${Math.ceil(augmentCount * 0.3)} seconds.\n\nThe ${excludedCount} package-only experimental candidates are excluded. Make plenty of inventory space; overflow may be placed near the character. Broker acceptance only means queued, not applied.`;
    } else if (action === 'run-training-batch') {
      body.bulkActionId = $('#online-bulk-training-action').value;
      if (!body.bulkActionId) { alert('Select a reviewed bulk action first.'); return; }
      confirmation = `Run ${$('#online-bulk-training-action').selectedOptions[0].textContent} for this online character? Commands are sent about 300 ms apart and may take several seconds.`;
    } else if (action === 'grant-solari') {
      body.amount = Number($('#online-solari-amount').value);
      confirmation = `Give ${body.amount.toLocaleString()} carried Solari to this online character through the live game channel?`;
    }

    if (!confirm(confirmation)) return;
    const result = $('#online-action-result');
    result.className = 'online-action-result working';
    result.textContent = 'Sending action...';
    showOverlay('Sending online action...');
    button.disabled = true;
    try {
      const response = await api('POST', `characters/${charData.actorId}/online-actions`, body);
      result.className = 'online-action-result success';
      result.textContent = response.message;
      appendConsole(response.message + '\n');
    } catch (e) {
      result.className = 'online-action-result error';
      result.textContent = e.message;
      alert('Online action failed: ' + e.message);
    } finally {
      button.disabled = false;
      hideOverlay();
    }
  }));

  $('#btn-spec-max-all').addEventListener('click', async () => {
    if (!charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return;
    }
    if (!confirm('Max all five specialization tracks and unlock every keystone? A database backup will be created first.')) return;

    showOverlay('Maxing all specializations...');
    try {
      const res = await api('POST', `characters/${charData.actorId}/specializations/max-all`);
      appendConsole(`All tracks set to level ${res.level} / ${res.xp} XP and all keystones unlocked. Backup: ${res.backup}.\n`);
      await loadSpecializations();
    } catch (e) { alert('Failed: ' + e.message); }
    hideOverlay();
  });

  // Keystone unlock buttons
  $('#spec-keystone-btns').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-prefix]');
    if (!btn || !charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return;
    }

    const prefix = btn.dataset.prefix;
    const trackName = prefix.replace('_', '');
    if (!confirm(`Unlock ALL ${trackName} keystones (perks)?`)) return;

    showOverlay(`Unlocking ${trackName} keystones...`);
    try {
      const res = await api('POST', `characters/${charData.actorId}/specializations/unlock-keystones`, { trackPrefix: prefix });
      appendConsole(`All ${trackName} keystones unlocked. Backup: ${res.backup}.\n`);
    } catch (e) { alert('Failed: ' + e.message); }
    hideOverlay();
  });

  // -----------------------------------------------------------------------
  // Economy (Currency + Faction Rep)
  // -----------------------------------------------------------------------
  async function loadEconomy() {
    if (!charData) return;
    try {
      const data = await api('GET', `characters/${charData.actorId}/economy`);

      (data.currency || []).forEach(c => {
        const el = $(`#econ-currency-${c.currency_id}`);
        if (el) el.value = c.balance;
      });

      const grid = $('#faction-rep-grid');
      grid.innerHTML = '';
      (data.factions || []).forEach(f => {
        if (f.name === 'None') return;
        const rep = (data.factionRep || []).find(r => r.faction_id === f.id);
        const amount = rep ? rep.reputation_amount : 0;

        const div = document.createElement('div');
        div.className = 'config-item';
        div.innerHTML = `
          <label>${f.name} Reputation</label>
          <div class="input-with-unit">
            <input type="number" class="select-input faction-rep" data-faction="${f.id}" value="${amount}" min="0" step="500">
            <button class="btn btn-green btn-sm faction-rep-save" data-faction="${f.id}">Set</button>
          </div>
        `;
        grid.appendChild(div);
      });
    } catch (e) {
      appendConsole('Failed to load economy: ' + e.message + '\n');
    }
  }

  // Currency set buttons
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-currency]');
    if (!btn || btn.tagName !== 'BUTTON' || !charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return;
    }

    const cid = parseInt(btn.dataset.currency);
    const balance = parseInt($(`#econ-currency-${cid}`).value);
    if (isNaN(balance)) { alert('Enter a valid amount.'); return; }

    showOverlay('Setting currency...');
    try {
      const response = await api('POST', `characters/${charData.actorId}/economy/currency`, { currencyId: cid, balance });
      appendConsole(`Currency ${response.currencyId} verified at ${response.balance}. Backup: ${response.backup}.\n`);
    } catch (e) { alert('Failed: ' + e.message); }
    hideOverlay();
  });

  // Faction rep set buttons
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.faction-rep-save');
    if (!btn || !charData) return;
    if (status && status.battlegroup && status.battlegroup.running) {
      alert('Stop the battlegroup first.'); return;
    }

    const fid = parseInt(btn.dataset.faction);
    const row = btn.closest('.config-item');
    const amount = parseInt(row.querySelector('.faction-rep').value);
    if (isNaN(amount)) { alert('Enter a valid amount.'); return; }

    showOverlay('Setting reputation...');
    try {
      await api('POST', `characters/${charData.actorId}/economy/reputation`, { factionId: fid, amount });
      appendConsole(`Faction ${fid} reputation set to ${amount}.\n`);
    } catch (e) { alert('Failed: ' + e.message); }
    hideOverlay();
  });

  // -----------------------------------------------------------------------
  // Load all sections when a character is loaded
  // -----------------------------------------------------------------------
  const origLoadCharacter = loadCharacter;
  loadCharacter = async function(actorId) {
    await origLoadCharacter(actorId);
    if (charData) {
      refreshTechCount();
      loadSpecializations();
      loadEconomy();
      await loadCosmetics();
      runCosmeticSearch();
    }
  };

  // -----------------------------------------------------------------------
  // Experimental: Multi-Sietch
  // -----------------------------------------------------------------------
  let sietchLoaded = false;

  async function loadSietches() {
    const statusEl = $('#sietch-status');
    const controlsEl = $('#sietch-controls');

    try {
      const data = await api('GET', 'sietches');
      if (data.error) throw new Error(data.error);

      const count = data.sietchCount;
      const ramEst = (count * 12) + 6;

      statusEl.innerHTML =
        `<div style="display:flex;gap:2rem;align-items:center;flex-wrap:wrap">` +
        `<div><strong style="font-size:1.8rem;color:var(--accent)">${count}</strong> <span style="color:var(--text-dim)">sietch${count !== 1 ? 'es' : ''} configured</span></div>` +
        `<div style="font-size:.85rem;color:var(--text-dim)">Partitions: ${data.sietches.map(s => '#' + s.partitions[0]).join(', ')} &middot; Est. RAM: ~${ramEst} GB</div>` +
        `</div>`;

      $('#btn-remove-sietch').disabled = count <= 1;
      controlsEl.style.display = '';
      sietchLoaded = true;
    } catch (e) {
      statusEl.innerHTML = `<span style="color:var(--danger)">Failed to load sietch info: ${e.message}</span>`;
      controlsEl.style.display = 'none';
    }
  }

  $('#btn-add-sietch').addEventListener('click', async () => {
    const msg = 'Add a new sietch to the battlegroup?\n\n' +
      'This adds another Hagga Basin instance (~12 GB RAM).\n' +
      'You must restart the battlegroup after for it to take effect.\n\n' +
      'This feature is EXPERIMENTAL and has not been fully tested.';
    if (!confirm(msg)) return;

    showOverlay('Adding sietch...');
    try {
      const result = await api('POST', 'sietches/add');
      if (result.error) throw new Error(result.error);
      appendConsole(`Sietch ${result.sietchNumber} added (partition ${result.partitionId}). Restart the battlegroup to apply.\n`);
      await loadSietches();
    } catch (e) {
      alert('Failed to add sietch: ' + e.message);
    }
    hideOverlay();
  });

  $('#btn-remove-sietch').addEventListener('click', async () => {
    const msg = 'Remove the last added sietch?\n\n' +
      'WARNING: Player bases and progress in this sietch may become inaccessible.\n' +
      'Take a database backup first!\n\n' +
      'You must restart the battlegroup after for it to take effect.';
    if (!confirm(msg)) return;

    showOverlay('Removing sietch...');
    try {
      const result = await api('POST', 'sietches/remove');
      if (result.error) throw new Error(result.error);
      appendConsole(`Sietch removed (partition ${result.removedPartition}). ${result.remainingSietches} sietch${result.remainingSietches !== 1 ? 'es' : ''} remaining. Restart the battlegroup to apply.\n`);
      await loadSietches();
    } catch (e) {
      alert('Failed to remove sietch: ' + e.message);
    }
    hideOverlay();
  });

  document.querySelector('.tab[data-tab="experimental"]').addEventListener('click', () => {
    if (!sietchLoaded) loadSietches();
  });
})();
