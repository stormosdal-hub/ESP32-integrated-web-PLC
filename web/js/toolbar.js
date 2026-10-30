/* ============================================================================
 * toolbar.js — ribbon toolbar + shared action set (T.actions)
 * Uses .tia-tb-* classes already defined in css/tia.css.
 * ==========================================================================*/
(function (T) {
  'use strict';

  /* Shared actions — also called from the menu bar (app.js builds the menu). */
  T.actions = {
    newProject() {
      if (T.project && !confirm('Create a new project? Unsaved changes will be lost.')) return;
      T.app.newProject();
      T.status('New project created', 'ok');
    },
    openProject() {
      T.storage.importFile((p) => {
        // a random .json would otherwise "load" as an empty project and be
        // autosaved over the current one moments later
        if (!p || !Array.isArray(p.blocks) || !Array.isArray(p.tags)) {
          alert('This file is not a TIA Web project (missing blocks/tags).');
          return;
        }
        if (T.project && !confirm('Open project "' + (p.name || '?') + '"?\n' +
            'The current project "' + (T.project.name || '?') + '" stays saved in browser storage.')) return;
        if (T.project) T.storage.save();
        T.app.adoptProject(p);
        T.storage.save();
        T.status('Project loaded', 'ok');
      });
    },
    save() {
      const ok = T.storage.save();
      T.status(ok ? 'Project saved to browser storage' : 'Save failed (storage unavailable)', ok ? 'ok' : 'warn');
    },
    exportProject() {
      T.storage.exportFile();
      T.status('Project exported to file', 'ok');
    },
    addNetwork() {
      if (T.activeEditor && T.activeEditor.addNetwork) { T.activeEditor.addNetwork(); }
      else T.status('Open a program block first', 'warn');
    },
    deleteSelection() {
      if (T.activeEditor && T.activeEditor.deleteSelection) T.activeEditor.deleteSelection();
    },
    compile() { T.app.compile(); },
    toggleSim() {
      if (!T.sim) { T.status('Simulator not loaded', 'warn'); return; }
      T.sim.toggle();
    },
    openEsp32() { T.bus.emit('open:esp32'); },
    onlineConnect() { T.online && T.online.connect(); },
    onlineDownload() { T.online && T.online.download(); },
    onlineUpload() { T.online && T.online.upload(); },
    onlineMonitor() { T.online && T.online.toggleMonitor(); },
    onlineCpu() { T.online && T.online.toggleCpu(); },
    onlineStartCpu() { T.online && T.online.run(); },
    onlineStopCpu() { T.online && T.online.stop(); },
    onlineUnforce() { T.online && T.online.unforceAll(); },
    onlineInfo() { T.online && T.online.showInfo(); },
  };

  function btn(opts) {
    const b = T.el('button', {
      class: 'tia-tb-btn' + (opts.cls ? ' ' + opts.cls : ''),
      title: opts.title || opts.label,
      onclick: opts.onclick,
    });
    if (opts.icon) { const s = T.el('span'); s.innerHTML = opts.icon; b.appendChild(s.firstChild); }
    b.appendChild(document.createTextNode(opts.label));
    if (opts.id) b.id = opts.id;
    return b;
  }
  function group(label, rowChildren) {
    return T.el('div', { class: 'tia-tb-group' },
      T.el('div', { class: 'tia-tb-row' }, rowChildren),
      T.el('div', { class: 'tia-tb-label' }, label));
  }

  function build() {
    const bar = document.getElementById('tia-toolbar');
    if (!bar) return;
    T.clear(bar);

    bar.appendChild(group('Project', [
      btn({ label: 'New', icon: T.icons.add, onclick: T.actions.newProject }),
      btn({ label: 'Open', icon: T.icons.open, onclick: T.actions.openProject, title: 'Open project from file' }),
      btn({ label: 'Save', icon: T.icons.save, onclick: T.actions.save, title: 'Save to browser storage' }),
      btn({ label: 'Export', icon: T.icons.download, onclick: T.actions.exportProject, title: 'Download project file' }),
    ]));

    bar.appendChild(group('Edit', [
      btn({ label: 'Network', icon: T.icons.network, onclick: T.actions.addNetwork, title: 'Insert empty network' }),
      btn({ label: 'Delete', icon: T.icons.trash, cls: 'danger', onclick: T.actions.deleteSelection, title: 'Delete selected element' }),
    ]));

    bar.appendChild(group('Compile', [
      btn({ label: 'Compile', icon: T.icons.compile, onclick: T.actions.compile, title: 'Check the program' }),
    ]));

    bar.appendChild(group('Simulation', [
      btn({ id: 'tia-sim-btn', label: 'Start', icon: T.icons.run, cls: 'primary',
            onclick: T.actions.toggleSim, title: 'Start / stop PLC simulation (S7-PLCSIM)' }),
    ]));

    bar.appendChild(group('ESP32', [
      btn({ label: 'I/O config', icon: T.icons.plc, onclick: T.actions.openEsp32,
            title: 'Assign tags to GPIO pins, set the scan time, see the board and the device status' }),
    ]));

    bar.appendChild(group('Online (PLC)', [
      btn({ id: 'tia-online-connect', label: 'Connect', icon: T.icons.device, onclick: T.actions.onlineConnect,
            title: 'Go online with the ESP32 this IDE was opened from' }),
      btn({ id: 'tia-online-download', label: 'Download → PLC', icon: T.icons.download, onclick: T.actions.onlineDownload,
            title: 'Compile and send this program to the ESP32; it is stored in flash and runs at once' }),
      btn({ id: 'tia-online-upload', label: 'Upload ← PLC', icon: T.icons.open, onclick: T.actions.onlineUpload,
            title: 'Load the program stored on the ESP32 into the editor' }),
      btn({ id: 'tia-online-monitor', label: 'Monitor', icon: T.icons.run, onclick: T.actions.onlineMonitor,
            title: 'Live-monitor the real GPIO / memory of the ESP32 on the diagram' }),
      btn({ id: 'tia-online-cpu', label: 'CPU', icon: T.icons.stop, onclick: T.actions.onlineCpu,
            title: 'Switch the ESP32 CPU between RUN and STOP (STOP switches every output off)' }),
      btn({ id: 'tia-online-info', label: 'Address', icon: T.icons.device, onclick: T.actions.onlineInfo,
            title: 'Where this PLC is reachable (name, IP, Modbus port)' }),
    ]));

    updateSimBtn(T.sim && T.sim.running);
    updateOnlineBtns(T.online && { connected: T.online.connected, monitoring: T.online.monitoring,
      running: T.online.running, hasProgram: T.online.hasProgram, forced: T.online.forced });
  }

  function updateSimBtn(running) {
    const b = document.getElementById('tia-sim-btn');
    if (!b) return;
    b.innerHTML = '';
    const s = T.el('span'); s.innerHTML = running ? T.icons.stop : T.icons.run;
    b.appendChild(s.firstChild);
    b.appendChild(document.createTextNode(running ? 'Stop' : 'Start'));
    b.classList.toggle('danger', !!running);
    b.classList.toggle('primary', !running);
  }

  function updateOnlineBtns(st) {
    st = st || {};
    const mon = document.getElementById('tia-online-monitor');
    if (mon) {
      mon.innerHTML = '';
      const s = T.el('span'); s.innerHTML = st.monitoring ? T.icons.stop : T.icons.run;
      mon.appendChild(s.firstChild);
      mon.appendChild(document.createTextNode(st.monitoring ? 'Stop monitor' : 'Monitor'));
      mon.classList.toggle('danger', !!st.monitoring);
    }
    const con = document.getElementById('tia-online-connect');
    if (con) con.classList.toggle('primary', !!st.connected);
    // CPU RUN/STOP toggle: shows the action it performs
    const cpu = document.getElementById('tia-online-cpu');
    if (cpu) {
      cpu.innerHTML = '';
      const s = T.el('span'); s.innerHTML = st.running ? T.icons.stop : T.icons.run;
      cpu.appendChild(s.firstChild);
      cpu.appendChild(document.createTextNode(st.connected ? (st.running ? 'Stop CPU' : 'Start CPU') : 'CPU'));
      cpu.classList.toggle('danger', !!(st.connected && st.running));
    }
    // status-bar pills: link state, CPU state, forced I/O
    const pill = document.getElementById('tia-status-online');
    if (pill) {
      const txt = st.monitoring ? '🔵 ONLINE' : (st.connected ? '● connected' : (T.online && T.online.available() ? '○ offline' : ''));
      pill.textContent = txt;
      pill.className = 'tia-status-pill ' + (st.monitoring ? 'tia-pill-run' : 'tia-pill-stop');
      pill.style.display = txt ? '' : 'none';
    }
    const cpuPill = document.getElementById('tia-status-cpu');
    if (cpuPill) {
      cpuPill.style.display = st.connected ? '' : 'none';
      cpuPill.textContent = !st.hasProgram ? 'PLC: no program' : ('PLC: ' + (st.running ? 'RUN' : 'STOP'));
      cpuPill.className = 'tia-status-pill ' + (st.running ? 'tia-pill-run' : 'tia-pill-stop');
    }
    const fp = document.getElementById('tia-status-force');
    if (fp) {
      fp.style.display = (st.connected && st.forced) ? '' : 'none';
      fp.textContent = 'F ' + (st.forced || '');
      fp.onclick = () => { if (confirm('Stop forcing all I/O?')) T.actions.onlineUnforce(); };
    }
  }

  T.bus.on('sim:state', (s) => updateSimBtn(s && s.running));
  T.bus.on('online:state', updateOnlineBtns);
  T.bus.on('boot', build);

  T.editors = T.editors || {};
  T.editors.toolbar = { build, updateSimBtn, updateOnlineBtns };
})(window.TIA);
