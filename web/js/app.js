/* ============================================================================
 * app.js — bootstrap & integration. Loaded LAST.
 * Wires tree/tags/instructions/lad/fbd/sim/toolbar together, owns tabs,
 * the inspector dock, splitters, autosave, compile, and the demo project.
 * ==========================================================================*/
(function (T) {
  'use strict';

  const openTabs = [];           // [{ key, title, type:'block'|'tags', blockId }]
  let activeTabKey = null;
  let inspectorTab = 'sim';      // 'props' | 'sim' | 'output'
  let outputLog = [];

  const byId = (id) => document.getElementById(id);

  /* -------------------------------------------------------- demo project */
  function buildDemoProject() {
    const p = T.model.newProject('Conveyor_Demo');
    p.device = { name: 'PLC_1', type: 'ESP32 Web PLC' };

    const tag = (n, dt, addr, c) => { const t = T.model.newTag(n, dt, addr, c); p.tags.push(t); return t; };
    tag('Start_PB',   'Bool', 'I0.0', 'Start push button (NO)');
    tag('Stop_PB',    'Bool', 'I0.1', 'Stop push button');
    tag('Part_Sensor','Bool', 'I0.2', 'Part detection sensor');
    tag('Motor',      'Bool', 'Q0.0', 'Conveyor motor');
    tag('Run_Lamp',   'Bool', 'Q0.1', 'Running indicator');
    tag('Count_Done', 'Bool', 'M0.0', 'Batch complete flag');
    tag('AND_Out',    'Bool', 'M0.2', 'FBD demo output');
    tag('Part_Count', 'Int',  'MW10', 'Parts counted');
    tag('Conveyor_PWM', 'Real', 'MD20', 'Conveyor speed duty (0..1) -> PWM GPIO');

    /* ---- OB1 Main (LAD) ---- */
    const ob1 = T.model.newBlock('OB', 'Main', 1, 'LAD');
    ob1.networks = [];

    // Network 1: motor seal-in
    const n1 = T.model.newNetwork('Motor seal-in (start / stop latch)');
    const stgA = T.model.newStage();
    stgA.branches = [
      { id: T.uid('br'), elements: [T.model.newElement('contact_no', 'Start_PB')] },
      { id: T.uid('br'), elements: [T.model.newElement('contact_no', 'Motor')] },
    ];
    const stgB = T.model.newStage();
    stgB.branches = [{ id: T.uid('br'), elements: [T.model.newElement('contact_nc', 'Stop_PB')] }];
    n1.stages = [stgA, stgB];
    n1.outputs = [T.model.newElement('coil', 'Motor')];

    // Network 2: run lamp on-delay timer
    const n2 = T.model.newNetwork('Run lamp on-delay (TON 3s)');
    n2.stages = [{ id: T.uid('stg'), branches: [{ id: T.uid('br'), elements: [T.model.newElement('contact_no', 'Motor')] }] }];
    const ton = T.model.newElement('ton'); ton.params.pt = 'T#3s'; ton.params.q = 'Run_Lamp';
    n2.outputs = [ton];

    // Network 3: count parts (CTU)
    const n3 = T.model.newNetwork('Count parts on sensor');
    n3.stages = [{ id: T.uid('stg'), branches: [{ id: T.uid('br'), elements: [T.model.newElement('contact_no', 'Part_Sensor')] }] }];
    const ctu = T.model.newElement('ctu'); ctu.params.pv = '5'; ctu.params.cv = 'Part_Count'; ctu.params.q = '';
    n3.outputs = [ctu];

    // Network 4: compare count -> batch done
    const n4 = T.model.newNetwork('Batch complete when count reaches preset');
    const cmp = T.model.newElement('compare'); cmp.params = { op: '>=', in1: 'Part_Count', in2: '5' };
    n4.stages = [{ id: T.uid('stg'), branches: [{ id: T.uid('br'), elements: [cmp] }] }];
    n4.outputs = [T.model.newElement('coil', 'Count_Done')];

    // Network 4b: normalize Part_Count (0..5) into a 0..1 duty for the PWM GPIO
    const nPwm = T.model.newNetwork('Conveyor PWM duty = NORM_X(Part_Count, 0..5)');
    const norm = T.model.newElement('norm_x');
    norm.params = { min: '0', val: 'Part_Count', max: '5', out: 'Conveyor_PWM' };
    nPwm.outputs = [norm];   // empty stages => rung power always true

    /* ---- FB1 Logic (FBD) — a parameterized block: Out := In1 AND In2 ---- */
    const fb1 = T.model.newBlock('FB', 'Logic', 1, 'FBD');
    fb1.iface.input.push(T.model.newMember('In1', 'Bool', '', 'First input'),
                         T.model.newMember('In2', 'Bool', '', 'Second input'));
    fb1.iface.output.push(T.model.newMember('Out', 'Bool', '', 'In1 AND In2'));
    fb1.iface.static.push(T.model.newMember('runs', 'Int', '0', 'demo static counter'));
    fb1.networks = [];
    const fn = T.model.newNetwork('Out := In1 AND In2');
    const bAnd = T.model.newBox('fb_and', 90, 70);
    bAnd.inputs[0].operand = 'In1';          // interface members (resolved per instance)
    bAnd.inputs[1].operand = 'In2';
    const bAssign = T.model.newBox('assign', 320, 86);
    bAssign.operand = 'Out';
    fn.boxes = [bAnd, bAssign];
    fn.wires = [T.model.newWire(bAnd.id, bAnd.outputs[0].id, bAssign.id, bAssign.inputs[0].id)];
    fb1.networks = [fn];

    /* ---- DB1: instance data block for the FB1 call below ---- */
    const db1 = { id: T.uid('blk'), type: 'DB', name: 'Logic_DB', number: 1, lang: 'DB',
                  comment: '', instanceOf: fb1.id, networks: [] };

    /* ---- OB1 Network 5: call FB "Logic" with parameters ---- */
    const n5 = T.model.newNetwork('Call FB "Logic" (In1:=Start_PB, In2:=Part_Sensor, Out=>AND_Out)');
    const callEl = T.model.newElement('call');
    callEl.params = { target: fb1.id, instanceDb: db1.id };
    callEl.args = { In1: 'Start_PB', In2: 'Part_Sensor', Out: 'AND_Out' };
    n5.outputs = [callEl];

    ob1.networks = [n1, n2, n3, n4, nPwm, n5];

    p.blocks = [ob1, fb1, db1];
    p.activeBlockId = ob1.id;

    /* ---- I/O map (ESP32 tab). Push buttons switch to GND, using the internal
       pull-ups (active-low). Start_PB is the dev board's own BOOT button, so
       the demo runs with no wiring at all. Pins suit the chip of the last
       connected PLC: the classic ESP32's GPIO5/15/16/17 are strapping / PSRAM
       pins, and the P4 boards' BOOT button is GPIO35, the rest on header pins
       all three Waveshare P4 boards have. ---- */
    const chip = T.editors && T.editors.esp32 ? T.editors.esp32.chip() : 'ESP32-S3';
    const pins = { 'ESP32': [0, 4, 13, 18, 19, 21], 'ESP32-P4': [35, 20, 21, 22, 23, 26],
      'ESP32-C3': [9, 10, 20, 21, 3, 1], 'ESP32-C6': [9, 18, 19, 20, 21, 22] }[chip] || [0, 4, 5, 15, 16, 17];
    p.gpio = [
      { tag: 'Start_PB',    pin: pins[0], dir: 'in',  pull: 'up', activeLow: true, debounce: 20 },
      { tag: 'Stop_PB',     pin: pins[1], dir: 'in',  pull: 'up', activeLow: true, debounce: 20 },
      { tag: 'Part_Sensor', pin: pins[2], dir: 'in',  pull: 'up', activeLow: true, debounce: 20 },
      { tag: 'Motor',       pin: pins[3], dir: 'out', activeLow: false },
      { tag: 'Run_Lamp',    pin: pins[4], dir: 'out', activeLow: false },
      { tag: 'Conveyor_PWM', pin: pins[5], dir: 'pwm', freq: 1000 },   // LEDC PWM, duty = value 0..1
    ];
    return p;
  }

  /* ------------------------------------------------ project lifecycle */
  function migrate(p) {
    if (!p || typeof p !== 'object') return buildDemoProject();
    p.tags = p.tags || [];
    p.device = p.device || { name: 'PLC_1', type: 'CPU 1214C' };
    p.blocks = p.blocks || [];
    p.types = Array.isArray(p.types) ? p.types : [];       // PLC data types (UDTs)
    p.sources = Array.isArray(p.sources) ? p.sources : [];  // external source files
    p.gpio = Array.isArray(p.gpio) ? p.gpio : [];   // ESP32 I/O map (tag -> GPIO or shift-register channel)
    p.shiftRegs = Array.isArray(p.shiftRegs) ? p.shiftRegs : [];   // 74HC595 / 74HC165 chains
    if (!p.i2c || typeof p.i2c !== 'object') p.i2c = { sda: null, scl: null, khz: 100, devices: [] };   // I2C I/O modules
    if (!(typeof p.scanMs === 'number' && p.scanMs > 0)) p.scanMs = 50;   // scan cycle (ms)
    p.blocks.forEach((b) => {
      b.networks = b.networks || [];
      b.networks.forEach((n) => {
        n.stages = n.stages || [];
        n.outputs = n.outputs || [];
        n.boxes = n.boxes || [];
        n.wires = n.wires || [];
      });
      if (!b.lang) b.lang = (b.type === 'DB' ? 'DB' : 'LAD');
      if (b.type !== 'DB') T.ensureInterface(b);    // backfill the block interface
    });
    if (!p.activeBlockId && p.blocks[0]) p.activeBlockId = p.blocks[0].id;
    return p;
  }

  function adoptProject(p) {
    if (T.sim && T.sim.running) T.sim.stop();
    openTabs.length = 0; activeTabKey = null;
    T.setProject(migrate(p));
    byId('tia-project-name').textContent = T.project.name || 'PLC_Project';
    const blk = T.getActiveBlock();
    if (blk) openBlock(blk);
    renderInspector();
  }
  T.app = T.app || {};
  T.app.adoptProject = adoptProject;
  T.app.newProject = function () { adoptProject(buildDemoProject()); };

  /* ------------------------------------------------------ tab management */
  function renderTabs() {
    const host = byId('tia-tabs'); T.clear(host);
    openTabs.forEach((tab) => {
      const el = T.el('div', {
        class: 'tia-tab' + (tab.key === activeTabKey ? ' active' : ''),
        onclick: () => activateTab(tab.key),
      },
        T.el('span', null, tab.title),
        T.el('span', {
          class: 'tia-tab-close', title: 'Close',
          onclick: (e) => { e.stopPropagation(); closeTab(tab.key); },
        }, '✕'));
      host.appendChild(el);
    });
  }

  function activateTab(key) {
    activeTabKey = key;
    const tab = openTabs.find((t) => t.key === key);
    const host = byId('tia-editor'); T.clear(host);
    host.classList.remove('tia-split-host');   // reset; set only for code blocks below
    T.activeEditor = null;
    if (!tab) { renderTabs(); return; }
    if (tab.type === 'tags') {
      if (T.editors.tags && T.editors.tags.open) T.editors.tags.open(host);
      else host.appendChild(T.el('div', { class: 'tia-empty' }, 'Tag editor not available'));
    } else if (tab.type === 'esp32') {
      if (T.editors.esp32 && T.editors.esp32.open) T.editors.esp32.open(host);
      else host.appendChild(T.el('div', { class: 'tia-empty' }, 'ESP32 view not available'));
    } else if (tab.type === 'type') {
      const ty = (T.project.types || []).find((x) => x.id === tab.refId);
      if (ty && T.editors.udt) T.editors.udt.open(host, ty);
    } else if (tab.type === 'source') {
      const src = (T.project.sources || []).find((x) => x.id === tab.refId);
      if (src && T.editors.source) T.editors.source.open(host, src);
    } else {
      const block = T.findBlock(tab.blockId);
      if (block) {
        T.setActiveBlock(block.id);
        if (block.type === 'DB') {
          // data block: show its instance structure / live values
          if (T.editors.db && T.editors.db.render) T.editors.db.render(host, block);
          else host.appendChild(T.el('div', { class: 'tia-empty' }, 'Data block viewer not available'));
        } else {
          // code block: block interface panel on top (its own scroll pane), the
          // LAD/FBD editor below in a separate scroll region so editing the interface
          // never scrolls the network out of view.
          host.classList.add('tia-split-host');
          const ifaceMount = T.el('div', { class: 'tia-iface-mount' });
          const codeMount = T.el('div', { class: 'tia-code-mount' });
          host.appendChild(ifaceMount);
          host.appendChild(codeMount);
          if (T.editors.iface && T.editors.iface.render) T.editors.iface.render(ifaceMount, block);
          const ed = block.lang === 'SCL' ? T.editors.scl
                   : block.lang === 'FBD' ? T.editors.fbd : T.editors.lad;
          if (ed && ed.open) ed.open(codeMount, block);
          else codeMount.appendChild(T.el('div', { class: 'tia-empty' }, block.lang + ' editor not available'));
        }
      }
    }
    renderTabs();
  }

  function openBlock(block) {
    const key = 'blk:' + block.id;
    if (!openTabs.find((t) => t.key === key)) {
      openTabs.push({ key, title: block.name + ' [' + block.type + block.number + ']', type: 'block', blockId: block.id });
    }
    activateTab(key);
  }
  function openTags() {
    const key = 'tags';
    if (!openTabs.find((t) => t.key === key)) {
      openTabs.push({ key, title: 'PLC tags', type: 'tags' });
    }
    activateTab(key);
  }
  // a PLC data type / an external source file in its own tab
  function openRef(kind, obj) {
    const key = kind + ':' + obj.id;
    if (!openTabs.find((t) => t.key === key)) {
      openTabs.push({ key, title: kind === 'type' ? '"' + obj.name + '"' : obj.name, type: kind, refId: obj.id });
    }
    activateTab(key);
  }
  // re-render the active tab (its model changed underneath, e.g. generated from source)
  T.app.refreshTab = function () { if (activeTabKey) activateTab(activeTabKey); };
  function openEsp32() {
    const key = 'esp32';
    if (!openTabs.find((t) => t.key === key)) {
      openTabs.push({ key, title: 'ESP32', type: 'esp32' });
    }
    activateTab(key);
  }
  function closeTab(key) {
    const i = openTabs.findIndex((t) => t.key === key);
    if (i < 0) return;
    openTabs.splice(i, 1);
    if (activeTabKey === key) {
      const next = openTabs[Math.max(0, i - 1)];
      if (next) activateTab(next.key);
      else { activeTabKey = null; T.clear(byId('tia-editor')); renderTabs(); }
    } else renderTabs();
  }

  /* update tab title if a block is renamed */
  T.bus.on('tree:changed', () => {
    openTabs.forEach((t) => {
      if (t.type === 'block') {
        const b = T.findBlock(t.blockId);
        if (b) t.title = b.name + ' [' + b.type + b.number + ']';
        else t.key = '__dead__';
      } else if (t.type === 'type' || t.type === 'source') {
        const o = ((t.type === 'type' ? T.project.types : T.project.sources) || []).find((x) => x.id === t.refId);
        if (o) t.title = t.type === 'type' ? '"' + o.name + '"' : o.name;
        else t.key = '__dead__';
      }
    });
    if (activeTabKey && !openTabs.some((t) => t.key === activeTabKey && t.key !== '__dead__')) {
      for (let i = openTabs.length - 1; i >= 0; i--) if (openTabs[i].key === '__dead__') openTabs.splice(i, 1);
      const next = openTabs[openTabs.length - 1];
      if (next) activateTab(next.key);
      else { activeTabKey = null; T.clear(byId('tia-editor')); }
    }
    for (let i = openTabs.length - 1; i >= 0; i--) if (openTabs[i].key === '__dead__') openTabs.splice(i, 1);
    renderTabs();
  });

  /* ------------------------------------------------------ inspector dock */
  function renderInspectorTabs() {
    const host = byId('tia-inspector-tabs'); T.clear(host);
    [['props', 'Properties'], ['sim', 'Simulation table'], ['output', 'Output']].forEach(([k, label]) => {
      host.appendChild(T.el('div', {
        class: 'tia-itab' + (k === inspectorTab ? ' active' : ''),
        onclick: () => { inspectorTab = k; renderInspector(); },
      }, label));
    });
  }
  function renderInspector() {
    renderInspectorTabs();
    const host = byId('tia-inspector'); T.clear(host);
    if (inspectorTab === 'sim') {
      if (T.sim && T.sim.renderTable) T.sim.renderTable(host);
      else host.appendChild(T.el('div', { class: 'tia-empty' }, 'Simulator not available'));
    } else if (inspectorTab === 'output') {
      const pre = T.el('div', { class: 'tia-output-log' });
      pre.innerHTML = outputLog.length ? outputLog.join('<br>') : '<span class="tia-muted">No messages. Press Compile.</span>';
      host.appendChild(pre);
    } else {
      renderProperties(host);
    }
  }
  function renderProperties(host) {
    const blk = T.getActiveBlock();
    const dl = T.el('div', { class: 'tia-props' });
    const row = (k, v) => dl.appendChild(T.el('div', { class: 'tia-prop-row' },
      T.el('span', { class: 'tia-prop-k' }, k), T.el('span', { class: 'tia-prop-v' }, v)));
    row('Device', (T.project.device.name || '') + '  (' + (T.project.device.type || '') + ')');
    row('Project', T.project.name || '');
    row('Blocks', String(T.project.blocks.length));
    row('Tags', String(T.project.tags.length));
    if (blk) {
      dl.appendChild(T.el('hr'));
      row('Block', blk.name + ' [' + blk.type + blk.number + ']');
      row('Language', blk.lang);
      row('Networks', String((blk.networks || []).length));
    }

    /* ---- cross-references: where is a tag / member used? ---- */
    dl.appendChild(T.el('hr'));
    const res = T.el('div', { class: 'tia-xref-res' });
    const inp = T.el('input', {
      class: 'tia-input', type: 'text', placeholder: 'Tag / member name…',
      style: { width: '170px' }, spellcheck: 'false',
    });
    const runXref = () => {
      T.clear(res);
      const q = inp.value.trim();
      if (!q) return;
      const refs = (T.refactor && T.refactor.findRefs) ? T.refactor.findRefs(q) : [];
      if (!refs.length) {
        res.appendChild(T.el('div', { class: 'tia-muted' }, 'No references to "' + q + '".'));
        return;
      }
      refs.forEach((r) => {
        res.appendChild(T.el('div', {
          class: 'tia-xref-row', title: 'Open ' + r.block,
          onclick: () => { const b = T.findBlock(r.blockId); if (b) T.bus.emit('open:block', b); },
        },
          T.el('span', { class: 'tia-xref-blk' }, r.block),
          T.el('span', { class: 'tia-xref-where' },
            (r.net ? ' · network ' + r.net : '') + ' · ' + r.where)));
      });
      res.appendChild(T.el('div', { class: 'tia-muted' }, refs.length + ' reference(s)'));
    };
    // suggestion dropdown, attached lazily so it positions against the mounted input
    inp.addEventListener('focus', () => {
      if (!inp._ac) inp._ac = T.attachAutocomplete(inp, {
        items: () => T.operandCandidates(),
        onPick: (v) => { inp.value = v; runXref(); },
      });
    });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') runXref(); });
    dl.appendChild(T.el('div', { class: 'tia-prop-row' },
      T.el('span', { class: 'tia-prop-k' }, 'Where used'),
      T.el('span', {}, inp,
        T.el('button', { class: 'tia-tb-btn', style: { marginLeft: '6px' }, onclick: runXref }, 'Find'))));
    dl.appendChild(res);

    host.appendChild(dl);
  }

  T.injectCSS('tia-app-css', `
    /* code-block editor: interface pane (own scroll, capped height) above the
       network editor (own scroll), so adding interface members never shifts the code. */
    .tia-editor-host.tia-split-host { display:flex; flex-direction:column; overflow:hidden; }
    .tia-split-host > .tia-iface-mount { flex:0 0 auto; max-height:45%; overflow:auto;
      border-bottom:2px solid var(--tia-border); }
    .tia-split-host > .tia-code-mount { flex:1 1 auto; overflow:auto; min-height:0; }
    /* project-tree Details pane (bottom of the left dock) */
    #tia-details { flex:0 0 auto; height:185px; min-height:0; display:flex; flex-direction:column;
      overflow:hidden; border-top:2px solid var(--tia-border); background:var(--tia-panel); }
    #tia-details .tia-dt-body { flex:1 1 auto; overflow:auto; min-height:0; }
    .tia-props { padding:4px 2px; }
    .tia-prop-row { display:flex; gap:8px; padding:2px 4px; }
    .tia-prop-k { width:90px; color:var(--tia-text-soft); }
    .tia-prop-v { color:var(--tia-text); font-weight:500; }
    .tia-output-log { font-family:var(--tia-mono); font-size:12px; line-height:1.6; white-space:pre-wrap; }
    /* cross-reference list (Properties tab) */
    .tia-xref-res { margin-top:4px; max-height:180px; overflow:auto; }
    .tia-xref-row { padding:2px 6px; cursor:pointer; border-radius:2px; font-size:12px; }
    .tia-xref-row:hover { background:var(--tia-hover); }
    .tia-xref-blk { font-weight:600; color:var(--tia-petrol-deep); }
    .tia-xref-where { color:var(--tia-text-soft); }
    .tia-output-ok { color:#1a7a3a; } .tia-output-warn { color:#b8860b; } .tia-output-err { color:#c0392b; }
    /* dropdown menus */
    .tia-dropdown { position:absolute; background:#fff; border:1px solid var(--tia-border);
      box-shadow:0 4px 14px rgba(0,0,0,.18); z-index:9000; min-width:160px; padding:3px 0; border-radius:3px; }
    .tia-dropdown .tia-dd-item { padding:5px 14px; cursor:pointer; color:var(--tia-text); }
    .tia-dropdown .tia-dd-item:hover { background:var(--tia-hover); }
    .tia-dropdown .tia-dd-sep { height:1px; background:var(--tia-border-soft); margin:3px 0; }
  `);

  /* ------------------------------------------------------ menu bar */
  // Open another project saved in this browser (the current one stays saved).
  function openSaved(name) {
    if (T.project) T.storage.save();
    const p = T.storage.loadFromLibrary(name);
    if (!p) { T.status('Saved project "' + name + '" not found', 'warn'); return; }
    adoptProject(p);
    T.storage.save();                    // it is the "current" project now
    T.status('Opened "' + name + '" from browser storage', 'ok');
  }
  function renameProject() {
    if (!T.project) return;
    const cur = T.project.name || '';
    const name = window.prompt('Project name:', cur);
    if (!name || !name.trim() || name.trim() === cur) return;
    T.project.name = name.trim();
    byId('tia-project-name').textContent = T.project.name;
    T.storage.save();
    T.bus.emit('tree:changed');
    T.status('Project renamed to "' + T.project.name + '"', 'ok');
  }
  // Built at click time so the "recent projects" list is always current.
  function projectMenuItems() {
    const items = [
      ['New project', T.actions.newProject],
      ['Open file…', T.actions.openProject],
      ['Save', T.actions.save],
      ['Export to file…', T.actions.exportProject],
      ['Rename project…', renameProject],
    ];
    const idx = T.storage.libraryIndex();
    const names = Object.keys(idx).sort((a, b) => idx[b] - idx[a])
      .filter((n) => !T.project || n !== T.project.name)
      .slice(0, 8);
    if (names.length) {
      items.push('-');
      names.forEach((n) => items.push(['Open "' + n + '"', () => openSaved(n)]));
    }
    return items;
  }
  function buildMenu() {
    const host = byId('tia-menu'); if (!host) return; T.clear(host);
    const menus = [
      ['Project', projectMenuItems],
      ['Edit', [
        ['Insert network', T.actions.addNetwork],
        ['Delete selection', T.actions.deleteSelection],
      ]],
      ['Online', [
        ['Start/Stop simulation', T.actions.toggleSim],
        ['Compile', T.actions.compile],
        '-',
        ['Go online (connect)', T.actions.onlineConnect],
        ['Download to PLC', T.actions.onlineDownload],
        ['Upload from PLC', T.actions.onlineUpload],
        ['Monitor on / off', T.actions.onlineMonitor],
        ['Start CPU (RUN)', T.actions.onlineStartCpu],
        ['Stop CPU (STOP)', T.actions.onlineStopCpu],
        ['Stop forcing', T.actions.onlineUnforce],
        ['PLC address…', T.actions.onlineInfo],
        '-',
        ['ESP32 I/O config', T.actions.openEsp32],
      ]],
      ['Help', [
        ['Quick help', showHelp],
      ]],
    ];
    menus.forEach(([label, items]) => {
      host.appendChild(T.el('div', {
        class: 'tia-menu-item',
        onclick: (e) => showDropdown(e.currentTarget, typeof items === 'function' ? items() : items),
      }, label));
    });
  }
  function showDropdown(anchor, items) {
    closeDropdown();
    const r = anchor.getBoundingClientRect();
    const dd = T.el('div', { class: 'tia-dropdown', style: { left: r.left + 'px', top: r.bottom + 'px' } });
    items.forEach((it) => {
      if (it === '-') { dd.appendChild(T.el('div', { class: 'tia-dd-sep' })); return; }
      dd.appendChild(T.el('div', { class: 'tia-dd-item', onclick: () => { closeDropdown(); it[1](); } }, it[0]));
    });
    document.body.appendChild(dd);
    setTimeout(() => document.addEventListener('mousedown', onDocDown), 0);
    function onDocDown(e) { if (!dd.contains(e.target)) closeDropdown(); }
    closeDropdown._cleanup = () => document.removeEventListener('mousedown', onDocDown);
  }
  function closeDropdown() {
    T.$$('.tia-dropdown').forEach((d) => d.remove());
    if (closeDropdown._cleanup) { closeDropdown._cleanup(); closeDropdown._cleanup = null; }
  }
  function showHelp() {
    alert('TIA Web PLC (ESP32) — quick help\n\n' +
      '• Project tree (left): click a block to open it; right-click for rename/delete; use ＋ to add blocks.\n' +
      '• Instructions (right): click or drag an instruction into the editor.\n' +
      '• Ladder: click an operand to type a tag (e.g. Start_PB or I0.0).\n' +
      '• Press Start (Simulation) to run the program in the browser, toggling inputs in the Simulation table.\n' +
      '• ESP32 ▸ I/O config: assign tags to GPIO pins (digital in/out, PWM, analog in).\n' +
      '• Online ▸ Download → PLC runs it on the ESP32 (stored in flash, survives power cycles); Monitor shows the\n' +
      '  real pins on the diagram. Toggling a GPIO input in the Simulation table FORCES it (F in the status bar).\n' +
      '• Save stores to the browser; Export downloads a .json you can re-open; Upload ← PLC fetches the PLC\'s program.');
  }

  /* ------------------------------------------------------ compile */
  // Consistency check: missing operands, unknown (typo) operands, dangling call
  // targets / missing instance DBs, SCL parse errors, duplicate tags.
  // Returns { errors, warnings } so callers (e.g. PLC download) can gate on it.
  T.app.compile = function () {
    outputLog = [];
    const stamp = new Date().toLocaleTimeString();
    let warnings = 0, errors = 0, elements = 0, networks = 0;
    const warn = (m) => { warnings++; outputLog.push('<span class="tia-output-warn">⚠ ' + m + '</span>'); };
    const err = (m) => { errors++; outputLog.push('<span class="tia-output-err">✖ ' + m + '</span>'); };

    // duplicate tag names / addresses (the runtime binds to the FIRST match)
    const seenName = Object.create(null), seenAddr = Object.create(null);
    (T.project.tags || []).forEach((t) => {
      const n = (t.name || '').trim().toLowerCase();
      if (n) { if (seenName[n]) warn('Tag table: duplicate tag name "' + t.name + '" (first one wins)'); seenName[n] = 1; }
      const a = (t.address || '').trim().toUpperCase();
      if (a) { if (seenAddr[a]) warn('Tag table: two tags share address ' + a); seenAddr[a] = 1; }
    });
    // overlapping addresses: I/Q/M bytes are SHARED (S7 semantics — %MW0 covers
    // %M0.0..%M1.7), so a word tag silently clobbers bit tags in its bytes
    const addrRange = (a) => {
      let m = /^([IQM])(\d+)\.(\d+)$/.exec(a);
      if (m) return { area: m[1], start: +m[2], len: 1, bit: true };
      m = /^([IQM])([BWD])(\d+)$/.exec(a);
      if (m) return { area: m[1], start: +m[3], len: m[2] === 'B' ? 1 : m[2] === 'W' ? 2 : 4, bit: false };
      return null;
    };
    const ranges = [];
    (T.project.tags || []).forEach((t) => {
      const a = (t.address || '').trim().toUpperCase();
      const r = a && addrRange(a);
      if (r) ranges.push(Object.assign(r, { name: t.name || a, addr: a }));
    });
    for (let i = 0; i < ranges.length; i++) {
      for (let j = i + 1; j < ranges.length; j++) {
        const A = ranges[i], Bb = ranges[j];
        if (A.area !== Bb.area) continue;
        if (A.bit && Bb.bit) continue;               // two bits only clash on the exact address (dup check)
        if (A.addr === Bb.addr) continue;            // exact dup already warned
        if (A.start < Bb.start + Bb.len && Bb.start < A.start + A.len) {
          warn('Tag table: "' + A.name + '" (' + A.addr + ') and "' + Bb.name + '" (' + Bb.addr +
            ') OVERLAP — they share memory bytes and will corrupt each other');
        }
      }
    }

    // Operand check: literals / addresses / tags / the block's own interface
    // members are fine; anything else is a typo-shaped unknown reading FALSE/0.
    const opCheck = (locals, v, where) => {
      const raw = (v == null ? '' : String(v)).trim();
      if (raw === '' || /^(true|false)$/i.test(raw)) return;
      const r = T.resolve(raw);
      if (r.unknown && !locals.has(raw.replace(/^%/, '').toLowerCase())) {
        warn(where + ': unknown operand "' + raw + '" (reads FALSE/0 — typo?)');
      }
    };
    const PARAM_SKIP = { op: 1, target: 1, instanceDb: 1 };

    // data types and block layouts: unknown types, bad arrays, a type that
    // contains itself, more than 64 KB ...
    (T.project.types || []).forEach((ty) => {
      try { T.types.parse('"' + ty.name + '"'); } catch (e) { err('PLC data type "' + ty.name + '": ' + e.message); }
    });
    (T.project.blocks || []).forEach((b) => {
      try { T.types.blockType(b); } catch (e) { err(b.name + ' [' + b.type + b.number + '] ' + (b.type === 'DB' ? 'data' : 'interface') + ': ' + e.message); }
    });

    (T.project.blocks || []).forEach((b) => {
      if (b.type === 'DB') return;
      const locals = new Set(T.ifaceMembers(b).map((e) => String(e.member.name || '').toLowerCase()));
      if (b.lang === 'SCL') {
        if (T.scl && T.scl.check) {
          const c = T.scl.check(b);
          if (c.error) err(b.name + ' (SCL) line ' + c.error.line + ': ' + c.error.msg);
        }
        return;
      }
      (b.networks || []).forEach((n, ni) => {
        networks++;
        const where = b.name + ' network ' + (ni + 1);
        const flat = [];
        (n.stages || []).forEach((s) => (s.branches || []).forEach((br) => (br.elements || []).forEach((e) => flat.push(e))));
        (n.outputs || []).forEach((e) => flat.push(e));
        (n.boxes || []).forEach((e) => flat.push(e));
        flat.forEach((e) => {
          elements++;
          const d = T.catalog[e.kind] || {};
          const label = where + ': ' + (d.name || e.kind);
          const needsOperand = d.operandRole && !e.operand && !(e.params && (e.params.out || e.params.q));
          if (needsOperand) warn(label + ' has no operand');
          if (e.kind === 'call') {
            const t = e.params && e.params.target && T.findBlock(e.params.target);
            if (!t) err(where + ': call target block is missing (deleted?)');
            else if (t.type === 'FB' && !(e.params.instanceDb && T.findBlock(e.params.instanceDb)))
              err(where + ': FB call "' + t.name + '" has no instance data block');
            Object.keys(e.args || {}).forEach((k) =>
              opCheck(locals, e.args[k], where + ': call parameter ' + k));
          }
          opCheck(locals, e.operand, label);
          const par = e.params || {};
          Object.keys(par).forEach((k) => { if (!PARAM_SKIP[k]) opCheck(locals, par[k], label + ' · ' + k.toUpperCase()); });
          (e.inputs || []).forEach((p) => opCheck(locals, p.operand, label + ' · pin ' + p.name));
        });
      });
    });

    outputLog.unshift('<span class="tia-output-' + (errors ? 'err' : 'ok') + '">' + (errors ? '✖ Compiled with errors' : '✔ Compile completed') +
      ' — ' + T.project.blocks.length + ' block(s), ' + networks + ' network(s), ' + elements + ' element(s), ' +
      errors + ' error(s), ' + warnings + ' warning(s) [' + stamp + ']</span>');
    inspectorTab = 'output';
    renderInspector();
    T.status(errors ? 'Compiled with errors' : 'Compile completed (' + warnings + ' warnings)', errors ? 'err' : 'ok');
    return { errors, warnings };
  };

  /* ------------------------------------------------------ status bar */
  T.bus.on('status', (s) => {
    const el = byId('tia-status-msg'); if (el) el.textContent = s.msg;
  });
  T.bus.on('sim:state', (s) => {
    const pill = byId('tia-status-sim');
    if (pill) {
      pill.textContent = (s && s.running) ? '● RUN' : '● STOP';
      pill.className = 'tia-status-pill ' + ((s && s.running) ? 'tia-pill-run' : 'tia-pill-stop');
    }
    if (s && s.running) { inspectorTab = 'sim'; renderInspector(); }
  });
  let scanCount = 0;
  T.bus.on('sim:tick', () => {
    scanCount++;
    const el = byId('tia-status-scan');
    if (el && scanCount % 6 === 0) el.textContent = 'scan #' + scanCount;
  });

  /* ------------------------------------------------------ bus wiring */
  T.bus.on('open:block', (block) => block && openBlock(block));
  T.bus.on('open:tags', () => openTags());
  T.bus.on('open:type', (ty) => ty && openRef('type', ty));
  T.bus.on('open:source', (src) => src && openRef('source', src));
  T.bus.on('open:esp32', () => openEsp32());
  T.bus.on('block:activated', () => { if (inspectorTab === 'props') renderInspector(); });
  T.bus.on('tags:changed', () => { if (inspectorTab === 'sim') renderInspector(); });

  /* ------------------------------------------------------ splitters */
  function initSplitters() {
    T.$$('.tia-splitter, .tia-splitter-h').forEach((sp) => {
      sp.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const horizontal = sp.classList.contains('tia-splitter-h');
        const targetId = sp.dataset.target;
        const panel = byId(targetId);
        if (!panel) return;
        const startX = e.clientX, startY = e.clientY;
        const startW = panel.getBoundingClientRect().width;
        const startH = panel.getBoundingClientRect().height;
        const isRight = targetId === 'tia-task-panel';
        document.body.style.cursor = horizontal ? 'row-resize' : 'col-resize';
        function move(ev) {
          if (horizontal) {
            const h = Math.max(80, Math.min(500, startH - (ev.clientY - startY)));
            panel.style.height = h + 'px'; panel.style.flexBasis = h + 'px';
          } else {
            const dx = ev.clientX - startX;
            const w = Math.max(150, Math.min(560, startW + (isRight ? -dx : dx)));
            panel.style.width = w + 'px'; panel.style.flexBasis = w + 'px';
          }
        }
        function up() {
          document.removeEventListener('mousemove', move);
          document.removeEventListener('mouseup', up);
          document.body.style.cursor = '';
        }
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
      });
    });
  }

  /* ------------------------------------------------------ autosave */
  function initAutosave() {
    let dirty = false, failed = false;
    // iface:changed covers block-interface edits AND the SCL editor's typing signal
    ['tags:changed', 'tree:changed', 'block:activated', 'iface:changed', 'types:changed', 'sources:changed', 'db:changed']
      .forEach((ev) => T.bus.on(ev, () => { dirty = true; }));
    const flush = () => {
      if (!dirty || !T.project) return;
      if (T.storage.save()) {
        dirty = false;
        if (failed) { failed = false; T.status('Autosave working again', 'ok'); }
      } else if (!failed) {           // warn once, keep dirty so we retry
        failed = true;
        T.status('AUTOSAVE FAILED (browser storage full?) — use Project ▸ Export to file to protect your work', 'err');
      }
    };
    setInterval(flush, 4000);
    window.addEventListener('beforeunload', flush);   // catch the last <4 s of edits
  }

  /* ------------------------------------------------------ boot */
  /* ------------------------------------------------------ left-panel tabs */
  function switchLeftPanel(which) {
    T.$$('.tia-lpanel-tab').forEach((t) => t.classList.toggle('active', t.dataset.lp === which));
    T.$$('[data-lp-panel]').forEach((p) => { p.style.display = (p.dataset.lpPanel === which) ? '' : 'none'; });
    if (which === 'tags' && T.editors.outline && T.editors.outline.render) T.editors.outline.render();
  }
  function initLeftPanelTabs() {
    T.$$('.tia-lpanel-tab').forEach((tab) => tab.addEventListener('click', () => switchLeftPanel(tab.dataset.lp)));
  }

  function boot() {
    buildMenu();
    T.bus.emit('boot');                 // toolbar builds
    initSplitters();
    initLeftPanelTabs();
    initAutosave();

    const saved = T.storage.load();
    const proj = saved ? migrate(saved) : buildDemoProject();
    T.setProject(proj);                 // triggers tree/tags/instructions render
    byId('tia-project-name').textContent = proj.name || 'PLC_Project';

    const blk = T.getActiveBlock();
    if (blk) openBlock(blk);
    inspectorTab = 'sim';
    renderInspector();
    T.status('Ready — ' + (saved ? 'restored saved project' : 'loaded demo project') + '. Press Start to simulate.', 'ok');
    // served by the ESP32: go online quietly (a fresh browser loads the PLC's program)
    if (T.online && T.online.autoStart) T.online.autoStart(!!saved);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.TIA);
