/* ============================================================================
 * online.js — connect the IDE to the ESP32 PLC (the firmware's web server):
 * download / upload the program, CPU RUN/STOP, force I/O, and monitor the
 * diagrams live from the real GPIO and memory (TIA "go online").
 *
 * Only active when the IDE is SERVED by the PLC (http/https), so same-origin
 * fetch to /api/* works. Opened from a file, the IDE works offline (simulator).
 *
 * PLC API:  GET  /api/info  /api/state  /api/program  /api/pins  /api/netinfo
 *           POST /api/program  /api/force {key,value}  /api/unforce
 *                /api/run  /api/stop
 * ==========================================================================*/
(function (T) {
  'use strict';

  const O = {
    connected: false,
    monitoring: false,
    running: false,
    hasProgram: false,
    project: null,       // name of the program on the PLC
    rev: 0,              // bumps on every download
    forced: 0,           // number of forced I/O points
    mock: false,
    scan: 0,
    info: null,          // last /api/info
    _timer: null,
    _infoTimer: null,
    _index: null,
    _forcedMap: {},
  };
  T.online = O;

  O.available = function () { return /^https?:$/.test(location.protocol); };

  /* fetch wrapper: JSON in/out; a failed request rejects with the PLC's own
   * error message ({ok:false, error}) when it sent one */
  function api(path, opts) {
    opts = opts || {};
    if (opts.body && typeof opts.body !== 'string') opts.body = JSON.stringify(opts.body);
    opts.headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
    return fetch(path, opts).then((r) => {
      const ct = r.headers.get('content-type') || '';
      const body = ct.indexOf('json') >= 0 ? r.json().catch(() => null) : r.text();
      return body.then((b) => {
        if (!r.ok) throw new Error((b && b.error) || ('HTTP ' + r.status));
        return b;
      });
    });
  }
  O.api = api;

  function snap() {
    return { connected: O.connected, monitoring: O.monitoring, running: O.running, hasProgram: O.hasProgram,
      forced: O.forced, mock: O.mock, scan: O.scan, available: O.available() };
  }
  function emit() { T.bus.emit('online:state', snap()); }

  function applyInfo(info) {
    O.connected = true;
    O.info = info;
    O.running = !!info.running;
    O.hasProgram = !!info.hasProgram;
    O.project = info.project || null;
    O.rev = info.programRev || 0;
    O.forced = info.forced || 0;
    O.mock = !!info.mock;
  }
  function plcName(info) { return ((info && info.wifi && info.wifi.hostname) ? info.wifi.hostname + '.local' : location.host); }
  function cpuText() {
    return O.hasProgram ? 'CPU ' + (O.running ? 'RUN' : 'STOP') + ' · "' + (O.project || '?') + '"' : 'no program on the PLC';
  }

  /* ----------------------------------------------------------- connect */
  O.connect = function (quiet) {
    if (!O.available()) {
      if (!quiet) T.status('This IDE runs from a file. Open it from the PLC (http://esp32-plc.local or its IP) to go online.', 'warn');
      emit(); return Promise.resolve(false);
    }
    return api('/api/info').then((info) => {
      applyInfo(info);
      if (!quiet) T.status('Connected to ' + plcName(info) + ' — ' + cpuText(), 'ok');
      emit();
      startInfoPoll();
      return true;
    }).catch(() => {
      O.connected = false;
      if (!quiet) T.status('No PLC answering at ' + location.host, 'warn');
      emit(); return false;
    });
  };

  // light status poll while connected but not monitoring (CPU state, forces)
  function startInfoPoll() {
    if (O._infoTimer) return;
    O._infoTimer = setInterval(() => {
      if (!O.connected || O.monitoring) return;
      api('/api/info').then((i) => { applyInfo(i); emit(); }).catch(() => {});
    }, 4000);
  }

  /* At start-up (called by app.js): go online quietly when served by the PLC.
   * A browser with no saved project picks up the PLC's program automatically. */
  O.autoStart = function (hadSavedProject) {
    if (!O.available()) return;
    O.connect(true).then((ok) => {
      if (!ok) return;
      if (O.hasProgram && !hadSavedProject) {
        fetchProgram().then((p) => {
          T.app.adoptProject(p);
          T.storage.save();
          T.status('Loaded "' + (p.name || '?') + '" from the PLC (' + cpuText() + ')', 'ok');
        }).catch(() => T.status('Connected — ' + cpuText(), 'ok'));
      } else if (O.hasProgram && T.project && O.project && O.project !== T.project.name) {
        T.status('Connected — the PLC holds "' + O.project + '" (' + (O.running ? 'RUN' : 'STOP') +
          '). Online ▸ Upload loads it into the editor.', 'warn');
      } else {
        T.status('Connected to ' + plcName(O.info) + ' — ' + cpuText(), 'ok');
      }
    });
  };

  /* ------------------------------------------------- download / upload */
  O.download = function () {
    // TIA-style consistency check first: never download a program with hard errors
    const res = (T.app && T.app.compile) ? T.app.compile() : { errors: 0 };
    if (res && res.errors) {
      T.status('Download aborted — fix the ' + res.errors + ' compile error(s) first (see Output)', 'err');
      return Promise.resolve(false);
    }
    const io = (T.editors.esp32 && T.editors.esp32.validate) ? T.editors.esp32.validate() : { errors: [] };
    if (io.errors.length) {
      T.status('Download aborted — I/O assignment: ' + io.errors[0], 'err');
      T.bus.emit('open:esp32');
      return Promise.resolve(false);
    }
    const go = O.connected ? Promise.resolve(true) : O.connect();
    return go.then((ok) => {
      if (!ok) return false;
      T.status('Downloading to the PLC…');
      const body = JSON.stringify(T.project, T.stripRuntime);
      return api('/api/program', { method: 'POST', body: body }).then((r) => {
        O.running = true; O.hasProgram = true; O.project = T.project.name; O.rev = (r && r.programRev) || O.rev + 1;
        O.forced = 0;
        buildIndex();
        const warns = (r && r.warnings) || [];
        if (warns.length) T.status('Downloaded with warnings: ' + warns.join(' · '), 'warn');
        else T.status('Program downloaded — CPU in RUN on the ESP32 (' + Math.round(body.length / 1024) + ' KB)', 'ok');
        emit();
        O.startMonitor();
        return true;
      }).catch((e) => { T.status('Download failed: ' + e.message, 'err'); O.connect(true); return false; });
    });
  };

  function fetchProgram() {
    return api('/api/program').then((p) => {
      if (!p || !Array.isArray(p.blocks) || !Array.isArray(p.tags)) throw new Error('the PLC returned no valid project');
      return p;
    });
  }

  // TIA "Upload from device": load the program stored on the PLC into the editor
  O.upload = function () {
    const go = O.connected ? Promise.resolve(true) : O.connect();
    return go.then((ok) => {
      if (!ok) return false;
      return fetchProgram().then((p) => {
        if (T.project && !confirm('Load the program stored on the PLC ("' + (p.name || '?') + '") into the editor?\n' +
            'The current project "' + (T.project.name || '?') + '" stays saved in this browser.')) return false;
        if (T.project) T.storage.save();
        T.app.adoptProject(p);
        T.storage.save();
        T.status('Uploaded "' + (p.name || '?') + '" from the PLC', 'ok');
        return true;
      }).catch((e) => { T.status('Upload failed: ' + e.message, 'err'); return false; });
    });
  };

  /* --------------------------------------------------------- CPU / forcing */
  O.run = function () {
    return api('/api/run', { method: 'POST' }).then((r) => {
      O.running = !!(r && r.running); emit();
      T.status(O.running ? 'CPU in RUN' : 'The PLC has no program to run — download one first', O.running ? 'ok' : 'warn');
    }).catch((e) => T.status('Start failed: ' + e.message, 'err'));
  };
  O.stop = function () {
    return api('/api/stop', { method: 'POST' }).then((r) => {
      O.running = !!(r && r.running); emit();
      T.status('CPU in STOP — all outputs off', 'ok');
    }).catch((e) => T.status('Stop failed: ' + e.message, 'err'));
  };
  O.toggleCpu = function () {
    const go = O.connected ? Promise.resolve(true) : O.connect();
    return go.then((ok) => { if (ok) return O.running ? O.stop() : O.run(); });
  };

  // Called by the simulation table while monitoring. On a GPIO-mapped tag the
  // PLC keeps it as a FORCE (overrides the pin) until released; other tags
  // are simply written once (TIA "modify").
  O.force = function (key, value) {
    if (!O.connected) return;
    api('/api/force', { method: 'POST', body: { key: key, value: value } })
      .catch((e) => T.status('Force failed: ' + e.message, 'warn'));
  };
  // is this tag wired to a GPIO pin in the project's I/O map?
  O.isMapped = function (tag) {
    return (T.project.gpio || []).some((g) => g && g.tag === tag && !!g.dir &&
      ((g.pin != null && g.pin !== '') || ((!!g.sr || !!g.i2c) && g.bit != null && g.bit !== '')));   // GPIO, chain or I2C module channel
  };
  O.unforceAll = function () {
    return api('/api/unforce', { method: 'POST' }).then(() => {
      O.forced = 0; O._forcedMap = {}; markForced(); emit();
      T.status('Forcing stopped — inputs follow the pins again', 'ok');
    }).catch((e) => T.status('Unforce failed: ' + e.message, 'err'));
  };

  /* ------------------------------------------------------------- monitoring */
  O.startMonitor = function () {
    if (!O.connected || O.monitoring) return;
    if (T.sim && T.sim.running) T.sim.stop();   // the ESP32 is the PLC now
    O.monitoring = true;
    buildIndex();
    T.bus.emit('sim:state', { running: true });  // editors apply energized/de-energized colouring
    emit();
    poll();
    O._timer = setInterval(poll, 150);
  };
  O.stopMonitor = function () {
    if (O._timer) { clearInterval(O._timer); O._timer = null; }
    if (!O.monitoring) { emit(); return; }
    O.monitoring = false;
    T.bus.emit('sim:state', { running: false });  // clear highlights
    emit();
  };
  O.toggleMonitor = function () {
    if (O.monitoring) { O.stopMonitor(); return; }
    const go = O.connected ? Promise.resolve(true) : O.connect();
    go.then((ok) => { if (ok) O.startMonitor(); });
  };

  let _inflight = false, _fails = 0;
  function poll() {
    if (_inflight) return;                    // never stack requests on a slow link
    _inflight = true;
    api('/api/state')
      .then((s) => { _fails = 0; applyState(s); })
      .catch(() => {
        if (O.monitoring && ++_fails >= 10) { // ~1.5 s of silence: the PLC is gone
          O.stopMonitor();
          O.connected = false;
          emit();
          T.status('PLC unreachable — monitoring stopped', 'err');
        }
      })
      .finally(() => { _inflight = false; });
  }

  // index model objects by id so a snapshot can light them up
  function buildIndex() {
    const idx = { el: {}, net: {}, pin: {}, tag: {}, db: {} };
    (T.project.tags || []).forEach((t) => { if (t.name && !idx.tag[t.name]) idx.tag[t.name] = t; });
    (T.project.blocks || []).forEach((b) => {
      if (b.type === 'DB' && b.name) idx.db[b.name] = b;
      (b.networks || []).forEach((n) => {
        if (!n) return;
        idx.net[n.id] = n;
        (n.stages || []).forEach((s) => (s.branches || []).forEach((br) => (br.elements || []).forEach((e) => { idx.el[e.id] = e; })));
        (n.outputs || []).forEach((e) => { idx.el[e.id] = e; });
        (n.boxes || []).forEach((bx) => { idx.el[bx.id] = bx; (bx.inputs || []).concat(bx.outputs || []).forEach((p) => { idx.pin[p.id] = p; }); });
      });
    });
    O._index = idx;
  }

  const ADDR = /^[IQM](\d+\.\d+|[BWD]\d+)$/;
  function applyState(s) {
    if (!s || !O.monitoring) return;   // a late response must not re-light a stopped monitor
    O.running = !!s.running; O.scan = s.scan || 0;
    const forcedBefore = O.forced;
    O._forcedMap = s.forced || {};
    O.forced = Object.keys(O._forcedMap).length;
    const idx = O._index || {};
    // memory -> T.mem: tags by name, raw addresses, instance-DB members ("<db>.<member>")
    if (s.mem) for (const k in s.mem) {
      const v = s.mem[k];
      const t = idx.tag && idx.tag[k];
      if (t) { if (t.dataType === 'Bool') T.writeBit(t.name, !!v); else T.writeNum(t.name, +v || 0); continue; }
      if (ADDR.test(k)) { if (typeof v === 'boolean') T.writeBit(k, v); else T.writeNum(k, +v || 0); continue; }
      const dot = k.indexOf('.');
      const db = dot > 0 && idx.db && idx.db[k.slice(0, dot)];
      if (db) {
        const key = T.memberKey(db.id, k.slice(dot + 1));
        if (typeof v === 'boolean') T.mem.setBit(key, v); else T.mem.setWord(key, +v || 0);
      }
    }
    // liveness -> model flags the editors' highlight() reads
    if (s.live) for (const id in s.live) { const e = idx.el[id]; if (e) e._live = !!s.live[id]; }
    if (s.power) for (const id in s.power) { const n = idx.net[id]; if (n) n._power = !!s.power[id]; }
    if (s.pins) for (const id in s.pins) { const p = idx.pin[id]; if (p) p._val = !!s.pins[id]; }
    T.bus.emit('sim:tick');           // editors re-highlight, sim table refreshes
    T.bus.emit('online:tick', { scan: O.scan, cycle: s.cycle });
    markForced();
    if (forcedBefore !== O.forced) emit();
  }

  /* ------------------------------------------- forced rows in the sim table */
  T.injectCSS('tia-online-force-css', `
    tr.sim-forced td:first-child::after { content: 'F'; margin-left: 6px; padding: 0 4px; border-radius: 3px;
      background: #e0a800; color: #fff; font-size: 10px; font-weight: 700; }
    .tia-pill-force { background: #e0a800; color: #fff; cursor: pointer; }
  `);
  function markForced() {
    const map = O._forcedMap || {};
    T.$$('tr[data-row]').forEach((tr) => {
      tr.classList.toggle('sim-forced', Object.prototype.hasOwnProperty.call(map, tr.getAttribute('data-row')));
    });
  }

  /* ---------------------------------------------- connection-info popup */
  // Opened from the toolbar: shows where this PLC is reachable (for a phone,
  // another PC, or Automation Sim / a SCADA over Modbus).
  function injectInfoCSS() {
    T.injectCSS('tia-online-info-css', `
      .tia-oi-ov{position:fixed;inset:0;background:rgba(0,0,0,.42);display:flex;
        align-items:center;justify-content:center;z-index:10000;}
      .tia-oi{background:var(--tia-panel);color:var(--tia-text);border:1px solid var(--tia-border);
        border-radius:8px;min-width:340px;max-width:480px;box-shadow:0 14px 44px rgba(0,0,0,.45);
        font-family:var(--tia-font);}
      .tia-oi-head{padding:12px 16px;font-weight:600;border-bottom:1px solid var(--tia-border);}
      .tia-oi-body{padding:14px 16px;display:flex;flex-direction:column;gap:10px;font-size:13px;}
      .tia-oi-foot{padding:10px 16px;border-top:1px solid var(--tia-border);display:flex;
        justify-content:flex-end;gap:8px;}
      .tia-oi button{font:inherit;font-size:12px;padding:5px 12px;border-radius:5px;cursor:pointer;
        border:1px solid var(--tia-border);background:var(--tia-hover);color:var(--tia-text);}
      .tia-oi button.primary{background:var(--tia-accent);border-color:var(--tia-accent);color:var(--tia-text-inv);}
      .tia-oi-status{font-size:12px;color:var(--tia-text-soft);}
      .tia-oi-section{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--tia-text-soft);}
      .tia-oi-box{background:var(--tia-bg);border:1px solid var(--tia-border-soft);border-radius:6px;
        padding:10px 12px;font-size:12.5px;line-height:1.6;}
      .tia-oi-row{display:flex;align-items:center;gap:8px;margin:3px 0;}
      .tia-oi-url{font-family:var(--tia-mono);color:var(--tia-accent);word-break:break-all;flex:1;}
      .tia-oi-copy{padding:2px 8px !important;font-size:11px !important;}
      .tia-oi-hint{font-size:11.5px;color:var(--tia-text-soft);}
      .tia-oi-warn{color:#c0392b;}
    `);
  }

  O.showInfo = function () {
    injectInfoCSS();
    const old = document.querySelector('.tia-oi-ov');
    if (old) old.remove();

    const statusEl = T.el('div', { class: 'tia-oi-status' });
    const box = T.el('div', { class: 'tia-oi-box' }, 'Checking…');
    const checkBtn = T.el('button', { class: 'primary', onclick: check }, 'Refresh');
    const closeBtn = T.el('button', { onclick: closeIt }, 'Close');

    const modal = T.el('div', { class: 'tia-oi' },
      T.el('div', { class: 'tia-oi-head' }, 'PLC connection'),
      T.el('div', { class: 'tia-oi-body' },
        statusEl,
        T.el('div', { class: 'tia-oi-section' }, 'This PLC is reachable at'),
        box,
        T.el('div', { class: 'tia-oi-hint' },
          'Open one of these on any computer or phone on the same network. A SCADA/HMI or Automation Sim can use ' +
          'Modbus TCP on the same address; GET /api/modbus-map lists each tag\'s Modbus address.')
      ),
      T.el('div', { class: 'tia-oi-foot' }, closeBtn, checkBtn)
    );
    const ov = T.el('div', { class: 'tia-oi-ov' }, modal);
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) closeIt(); });
    ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeIt(); });
    ov.tabIndex = -1;
    document.body.appendChild(ov);
    ov.focus();

    renderStatus();
    check();

    function closeIt() { if (ov.parentNode) ov.parentNode.removeChild(ov); }

    function renderStatus() {
      const bits = [];
      bits.push(O.connected ? 'connected' : (O.available() ? 'not connected' : 'offline IDE (file)'));
      if (O.connected) bits.push(cpuText());
      if (O.monitoring) bits.push('monitoring');
      if (O.forced) bits.push(O.forced + ' forced');
      statusEl.textContent = 'Status: ' + bits.join(' · ');
    }

    function check() {
      if (!O.available()) {
        T.clear(box);
        box.appendChild(T.el('span', { class: 'tia-oi-warn' },
          'This IDE was opened from a file. Open it from the PLC (http://esp32-plc.local or the IP printed on the serial monitor).'));
        return;
      }
      box.textContent = 'Checking…';
      api('/api/netinfo').then(render).catch((e) => {
        T.clear(box);
        box.appendChild(T.el('span', { class: 'tia-oi-warn' }, 'Unavailable: ' + (e && e.message || e)));
      });
    }

    function render(ni) {
      T.clear(box);
      box.appendChild(T.el('div', { class: 'tia-oi-row' },
        T.el('span', { class: 'tia-oi-hint' }, 'name: '),
        T.el('b', null, ni.mdns || ni.hostname || '?')));
      const urls = (ni.urls && ni.urls.length) ? ni.urls : ['http://' + location.host];
      urls.forEach((u) => {
        const row = T.el('div', { class: 'tia-oi-row' }, T.el('span', { class: 'tia-oi-url' }, u));
        if (/^https?:\/\//.test(u) && navigator.clipboard) {
          row.appendChild(T.el('button', {
            class: 'tia-oi-copy', onclick: () => {
              navigator.clipboard.writeText(u).then(
                () => T.status('Copied ' + u, 'ok'), () => T.status('Copy failed', 'warn'));
            }
          }, 'Copy'));
        }
        box.appendChild(row);
      });
      if (ni.modbusPort) {
        box.appendChild(T.el('div', { class: 'tia-oi-row' },
          T.el('span', { class: 'tia-oi-hint' }, 'Modbus TCP on port '),
          T.el('b', null, String(ni.modbusPort))));
      }
    }
  };

  // rebuild the id index if the project reloads while monitoring
  T.bus.on('project:loaded', () => { if (O.monitoring) buildIndex(); });
  T.bus.on('tree:changed', () => { if (O.monitoring) buildIndex(); });
  T.bus.on('tags:changed', () => { if (O.monitoring) buildIndex(); });
})(window.TIA);
