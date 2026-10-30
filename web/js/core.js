/* ============================================================================
 * TIA-like Browser PLC IDE  —  core.js
 * Foundation / shared contract for all modules. Loaded FIRST.
 *
 * Everything attaches to the global namespace `window.TIA` (alias `T`).
 * No ES modules (must run from file://). Classic <script> only.
 *
 * This file defines the DATA CONTRACT that every other module depends on:
 *   - TIA.bus        : tiny event bus
 *   - TIA.el/svg/...  : DOM helpers
 *   - TIA.catalog    : the element/box CATALOG (canonical `kind` strings)
 *   - TIA.model      : factory functions for project/block/network/element...
 *   - TIA.project    : the live project (set via TIA.setProject)
 *   - TIA.mem        : simulation memory (bits/words) + address resolution
 *   - TIA.storage    : localStorage + JSON import/export
 *   - TIA.icons      : inline SVG icon strings
 * ==========================================================================*/
window.TIA = window.TIA || {};
(function (T) {
  'use strict';

  /* -------------------------------------------------------------- event bus */
  const _listeners = Object.create(null);
  T.bus = {
    on(evt, fn) {
      (_listeners[evt] = _listeners[evt] || []).push(fn);
      return () => T.bus.off(evt, fn);
    },
    off(evt, fn) {
      const a = _listeners[evt];
      if (!a) return;
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    emit(evt, data) {
      (_listeners[evt] || []).slice().forEach((fn) => {
        try { fn(data); } catch (e) { console.error('[bus]', evt, e); }
      });
    },
  };

  /* ------------------------------------------------------------------ ids */
  let _seq = 0;
  T.uid = (p) => (p || 'id') + '_' + (Date.now().toString(36)) + (_seq++).toString(36);

  /* ----------------------------------------------------------- dom helpers */
  // T.el('div', {class:'x', onclick:fn, dataset:{k:'v'}}, child, child...)
  T.el = function (tag, attrs, ...children) {
    const n = document.createElement(tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k === 'html') n.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      // `draggable` is an enumerated attribute: it must be the literal "true",
      // not an empty string (which resolves to "auto" = not draggable on a div).
      else if (v === true) n.setAttribute(k, k === 'draggable' ? 'true' : '');
      else if (v === false) { /* skip */ }
      else n.setAttribute(k, v);
    }
    T.append(n, children);
    return n;
  };
  const SVGNS = 'http://www.w3.org/2000/svg';
  T.svg = function (tag, attrs, ...children) {
    const n = document.createElementNS(SVGNS, tag);
    if (attrs) for (const k in attrs) {
      const v = attrs[k];
      if (v == null) continue;
      if (k === 'class') n.setAttribute('class', v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else if (k === 'text') n.textContent = v;
      else n.setAttribute(k, v);
    }
    T.append(n, children);
    return n;
  };
  T.append = function (node, children) {
    (Array.isArray(children) ? children : [children]).forEach((c) => {
      if (c == null || c === false) return;
      if (Array.isArray(c)) T.append(node, c);
      else node.appendChild(typeof c === 'string' || typeof c === 'number'
        ? document.createTextNode(String(c)) : c);
    });
    return node;
  };
  T.clear = (node) => { if (node) while (node.firstChild) node.removeChild(node.firstChild); return node; };
  T.injectCSS = function (id, css) {
    if (document.getElementById(id)) return;
    const s = document.createElement('style');
    s.id = id; s.textContent = css;
    document.head.appendChild(s);
  };
  T.$ = (sel, root) => (root || document).querySelector(sel);
  T.$$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

  /* ------------------------------------------------------------ data types */
  T.DataTypes = ['Bool', 'Int', 'Real', 'Word', 'Time'];
  // Memory areas. I=inputs, Q=outputs, M=bit memory (flags).
  T.MemAreas = ['I', 'Q', 'M'];

  /* ========================================================================
   * CATALOG  — the canonical set of element/box `kind`s.
   * EVERY module must use these exact kind strings.
   *
   * Fields:
   *   name      : human label (shown in instruction tree / tooltips)
   *   group     : instruction-tree group
   *   area      : 'inline'  -> LAD condition area (contributes to power flow)
   *               'output'  -> LAD output area (consumes rung power)
   *   lad/fbd   : availability per language (default both unless set false)
   *   box       : true for box-style symbols (timers, math, compare...)
   *   operandRole: 'read' | 'write' | null  (primary operand semantics in LAD)
   *   dataType  : default operand data type ('Bool' for contacts/coils)
   *   defParams : default `params` object for the element
   *   pins      : FBD pin layout { in:[names], out:[names] }
   *   expand    : 'in' if number of inputs can grow (AND/OR/XOR/ADD...)
   * ======================================================================*/
  T.catalog = {
    /* ---- Bit logic : inline contacts ---- */
    contact_no: { name: 'Normally open contact', group: 'Bit logic', area: 'inline', operandRole: 'read', dataType: 'Bool', fbd: false },
    contact_nc: { name: 'Normally closed contact', group: 'Bit logic', area: 'inline', operandRole: 'read', dataType: 'Bool', fbd: false },
    edge_p:     { name: 'Scan operand for positive edge (P)', group: 'Bit logic', area: 'inline', operandRole: 'read', dataType: 'Bool', fbd: false },
    edge_n:     { name: 'Scan operand for negative edge (N)', group: 'Bit logic', area: 'inline', operandRole: 'read', dataType: 'Bool', fbd: false },

    /* ---- Bit logic : outputs ---- */
    coil:       { name: 'Assignment (coil)', group: 'Bit logic', area: 'output', operandRole: 'write', dataType: 'Bool', fbd: false },
    coil_neg:   { name: 'Negated assignment', group: 'Bit logic', area: 'output', operandRole: 'write', dataType: 'Bool', fbd: false },
    coil_set:   { name: 'Set output (S)', group: 'Bit logic', area: 'output', operandRole: 'write', dataType: 'Bool', fbd: false },
    coil_reset: { name: 'Reset output (R)', group: 'Bit logic', area: 'output', operandRole: 'write', dataType: 'Bool', fbd: false },

    /* ---- Latches (the operand on top is the stored bit Q) ---- */
    sr: { name: 'SR — Set/reset flip-flop (reset dominant)', group: 'Bit logic', area: 'output', box: true,
          operandRole: 'write', dataType: 'Bool', defParams: { r: '' }, pins: { in: ['S', 'R1'], out: ['Q'] } },
    rs: { name: 'RS — Reset/set flip-flop (set dominant)', group: 'Bit logic', area: 'output', box: true,
          operandRole: 'write', dataType: 'Bool', defParams: { s: '' }, pins: { in: ['R', 'S1'], out: ['Q'] } },

    /* ---- Edge-trigger boxes (Q pulses for one scan on the CLK edge) ---- */
    p_trig: { name: 'P_TRIG — Rising edge of RLO', group: 'Bit logic', area: 'output', box: true,
              defParams: { q: '' }, pins: { in: ['CLK'], out: ['Q'] } },
    n_trig: { name: 'N_TRIG — Falling edge of RLO', group: 'Bit logic', area: 'output', box: true,
              defParams: { q: '' }, pins: { in: ['CLK'], out: ['Q'] } },
    r_trig: { name: 'R_TRIG — Detect rising edge', group: 'Bit logic', area: 'output', box: true,
              defParams: { q: '' }, pins: { in: ['CLK'], out: ['Q'] } },
    f_trig: { name: 'F_TRIG — Detect falling edge', group: 'Bit logic', area: 'output', box: true,
              defParams: { q: '' }, pins: { in: ['CLK'], out: ['Q'] } },

    /* ---- FBD logic boxes ---- */
    fb_and: { name: 'AND logic operation', group: 'Bit logic', box: true, lad: false, pins: { in: ['in1', 'in2'], out: ['out'] }, expand: 'in' },
    fb_or:  { name: 'OR logic operation', group: 'Bit logic', box: true, lad: false, pins: { in: ['in1', 'in2'], out: ['out'] }, expand: 'in' },
    fb_xor: { name: 'XOR logic operation', group: 'Bit logic', box: true, lad: false, pins: { in: ['in1', 'in2'], out: ['out'] }, expand: 'in' },
    fb_not: { name: 'Invert RLO (NOT)', group: 'Bit logic', box: true, lad: false, pins: { in: ['in'], out: ['out'] } },
    assign: { name: 'Assignment =', group: 'Bit logic', box: true, lad: false, operandRole: 'write', dataType: 'Bool', pins: { in: ['in'], out: ['out'] } },

    /* ---- Compare (inline / box) ---- */
    compare: { name: 'Compare values', group: 'Comparator', area: 'inline', box: true, dataType: 'Int',
               defParams: { op: '==', in1: '0', in2: '0' }, pins: { in: ['in1', 'in2'], out: ['out'] }, operandRole: null },

    /* ---- Timers (IEC) ---- */
    ton: { name: 'TON — Generate on-delay', group: 'Timers', area: 'output', box: true,
           defParams: { pt: 'T#5s', q: '', et: '' }, pins: { in: ['IN', 'PT'], out: ['Q', 'ET'] } },
    tof: { name: 'TOF — Generate off-delay', group: 'Timers', area: 'output', box: true,
           defParams: { pt: 'T#5s', q: '', et: '' }, pins: { in: ['IN', 'PT'], out: ['Q', 'ET'] } },
    tp:  { name: 'TP — Generate pulse', group: 'Timers', area: 'output', box: true,
           defParams: { pt: 'T#5s', q: '', et: '' }, pins: { in: ['IN', 'PT'], out: ['Q', 'ET'] } },

    /* ---- Counters (IEC) ---- */
    ctu: { name: 'CTU — Count up', group: 'Counters', area: 'output', box: true,
           defParams: { pv: '5', q: '', cv: '' }, pins: { in: ['CU', 'R', 'PV'], out: ['Q', 'CV'] } },
    ctd: { name: 'CTD — Count down', group: 'Counters', area: 'output', box: true,
           defParams: { pv: '5', q: '', cv: '' }, pins: { in: ['CD', 'LD', 'PV'], out: ['Q', 'CV'] } },
    ctud: { name: 'CTUD — Count up and down', group: 'Counters', area: 'output', box: true,
            defParams: { pv: '5', cd: '', r: '', ld: '', qu: '', qd: '', cv: '' },
            pins: { in: ['CU', 'CD', 'R', 'LD', 'PV'], out: ['QU', 'QD', 'CV'] } },

    /* ---- Move & Math ---- */
    move: { name: 'MOVE — Move value', group: 'Move operations', area: 'output', box: true,
            defParams: { in: '0', out: '' }, pins: { in: ['IN'], out: ['OUT'] } },
    add:  { name: 'ADD — Add', group: 'Math functions', area: 'output', box: true,
            defParams: { in1: '0', in2: '0', out: '', eno: '' }, pins: { in: ['in1', 'in2'], out: ['OUT', 'ENO'] }, expand: 'in' },
    sub:  { name: 'SUB — Subtract', group: 'Math functions', area: 'output', box: true,
            defParams: { in1: '0', in2: '0', out: '', eno: '' }, pins: { in: ['in1', 'in2'], out: ['OUT', 'ENO'] } },
    mul:  { name: 'MUL — Multiply', group: 'Math functions', area: 'output', box: true,
            defParams: { in1: '0', in2: '0', out: '', eno: '' }, pins: { in: ['in1', 'in2'], out: ['OUT', 'ENO'] }, expand: 'in' },
    div:  { name: 'DIV — Divide', group: 'Math functions', area: 'output', box: true,
            defParams: { in1: '0', in2: '0', out: '', eno: '' }, pins: { in: ['in1', 'in2'], out: ['OUT', 'ENO'] } },

    /* ---- Conversion (scaling) — OUT = (VALUE-MIN)/(MAX-MIN) ; SCALE = VALUE*(MAX-MIN)+MIN.
       ENO = EN && no error (div by zero / MAX==MIN / numeric overflow); wire a
       bit operand to ENO to chain error status like TIA. ---- */
    norm_x:  { name: 'NORM_X — Normalize', group: 'Conversion', area: 'output', box: true,
               defParams: { min: '0', val: '0', max: '1', out: '', eno: '' }, pins: { in: ['MIN', 'VALUE', 'MAX'], out: ['OUT', 'ENO'] } },
    scale_x: { name: 'SCALE_X — Scale', group: 'Conversion', area: 'output', box: true,
               defParams: { min: '0', val: '0', max: '1', out: '', eno: '' }, pins: { in: ['MIN', 'VALUE', 'MAX'], out: ['OUT', 'ENO'] } },

    /* ---- Block call (created by dragging a block from the project tree onto a
       network; NOT shown in the instruction tree because group 'Calls' is not in
       T.catalogGroups). params.target holds the called block's id. ---- */
    call: { name: 'Call block', group: 'Calls', box: true, area: 'output',
            operandRole: null, defParams: { target: '' }, pins: { in: ['EN'], out: ['ENO'] } },
  };

  // Ordered groups for the instruction tree.
  T.catalogGroups = ['Bit logic', 'Comparator', 'Timers', 'Counters', 'Move operations', 'Math functions', 'Conversion'];
  T.catalogFor = function (lang) {
    // returns array of {kind, def} available in the given language ('LAD'|'FBD').
    // SCL (and any non-graphical language) has no drag-and-drop instructions.
    const out = [];
    if (lang !== 'LAD' && lang !== 'FBD') return out;
    for (const kind in T.catalog) {
      const def = T.catalog[kind];
      const ok = lang === 'LAD' ? def.lad !== false : def.fbd !== false;
      if (ok) out.push({ kind, def });
    }
    return out;
  };

  /* ---------------------------------------------------------- model factory */
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  T.model = {
    newProject(name) {
      return {
        name: name || 'PLC_Project',
        device: { name: 'PLC_1', type: 'ESP32 Web PLC' },
        tags: [],
        blocks: [],
        activeBlockId: null,
        scanMs: 50,            // PLC scan cycle time (ms) — limits how fast timers/blinkers can change
        _seq: { OB: 1, FC: 0, FB: 0, DB: 0 },
      };
    },
    newTag(name, dataType, address, comment) {
      return { id: T.uid('tag'), name: name || '', dataType: dataType || 'Bool', address: address || '', comment: comment || '' };
    },
    newBlock(type, name, number, lang) {
      const b = { id: T.uid('blk'), type: type || 'OB', name: name || 'Block', number: number || 1,
                  lang: lang || 'LAD', comment: '', networks: [] };
      // DB holds no logic; SCL holds a single text body (`code`) instead of
      // graphical networks; LAD/FBD start with one empty network.
      if (b.type === 'DB') { /* no logic */ }
      else if (b.lang === 'SCL') { b.code = ''; }
      else b.networks.push(T.model.newNetwork());
      b.iface = T.model.newInterface(b.type);
      return b;
    },
    // The block interface (TIA "block interface"): typed local declarations.
    //   input/output/inout : call parameters (shown as pins on the call box)
    //   static             : FB-only, persisted in the instance DB across scans
    //   temp               : scratch, cleared each call
    //   constant           : named constants
    newInterface(type) {
      const i = { input: [], output: [], inout: [], temp: [], constant: [] };
      if (type === 'FB') i.static = [];
      if (type === 'FC') i.return = [];      // [] = Void, or [{name:'RET_VAL', dataType}]
      return i;
    },
    newMember(name, dataType, def, comment) {
      return { id: T.uid('mem'), name: name || '', dataType: dataType || 'Bool',
               default: (def != null ? def : ''), comment: comment || '' };
    },
    // Instance data block backing one FB call (created when an FB is dropped onto a network).
    newInstanceDB(fb) {
      return { id: T.uid('blk'), type: 'DB', name: (fb.name || 'Block') + '_DB',
               number: T.nextBlockNumber('DB'), lang: 'DB', comment: '',
               instanceOf: fb.id, networks: [] };
    },
    newNetwork(title) {
      return { id: T.uid('net'), title: title || '', comment: '',
               // LAD representation:
               stages: [],            // [{ id, branches:[{id, elements:[Element]}] }]
               outputs: [],           // [Element]  (output-area elements, stacked)
               // FBD representation:
               boxes: [],             // [Box]
               wires: [] };           // [Wire]
    },
    newStage() { return { id: T.uid('stg'), branches: [{ id: T.uid('br'), elements: [] }] }; },
    newBranch() { return { id: T.uid('br'), elements: [] }; },
    newElement(kind, operand) {
      const def = T.catalog[kind] || {};
      const e = { id: T.uid('el'), kind, operand: operand || '' };
      if (def.defParams) e.params = clone(def.defParams);
      return e;
    },
    newBox(kind, x, y) {
      const def = T.catalog[kind] || {};
      const b = { id: T.uid('box'), kind, x: x || 40, y: y || 40,
                  operand: '', inputs: [], outputs: [] };
      if (def.defParams) b.params = clone(def.defParams);
      const pins = def.pins || { in: [], out: [] };
      b.inputs = (pins.in || []).map((nm) => ({ id: T.uid('pin'), name: nm, inverted: false, operand: '' }));
      b.outputs = (pins.out || []).map((nm) => ({ id: T.uid('pin'), name: nm }));
      return b;
    },
    newWire(fromBox, fromPin, toBox, toPin) {
      return { id: T.uid('wire'), from: { box: fromBox, pin: fromPin }, to: { box: toBox, pin: toPin } };
    },
  };

  /* --------------------------------------------------------- project access */
  T.project = null;
  T.setProject = function (p) {
    T.project = p;
    if (p && !p.activeBlockId && p.blocks.length) p.activeBlockId = p.blocks[0].id;
    T.bus.emit('project:loaded', p);
  };
  T.getActiveBlock = function () {
    if (!T.project) return null;
    return T.project.blocks.find((b) => b.id === T.project.activeBlockId) || null;
  };
  T.setActiveBlock = function (id) {
    if (!T.project) return;
    T.project.activeBlockId = id;
    T.bus.emit('block:activated', T.getActiveBlock());
  };
  T.findBlock = (id) => T.project && T.project.blocks.find((b) => b.id === id);
  T.tagByName = (name) => T.project && T.project.tags.find((t) => t.name === name);
  T.tagByAddress = (addr) => T.project && T.project.tags.find((t) => (t.address || '').toUpperCase() === String(addr).toUpperCase());

  /* ----------------------------------------------------- block interface ---- */
  // Ensure a block has a well-formed interface (used by factories & migration).
  T.ensureInterface = function (b) {
    if (!b || b.type === 'DB') return;
    b.iface = b.iface || T.model.newInterface(b.type);
    ['input', 'output', 'inout', 'temp', 'constant'].forEach((s) => { b.iface[s] = b.iface[s] || []; });
    if (b.type === 'FB') b.iface.static = b.iface.static || [];
    if (b.type === 'FC') b.iface.return = b.iface.return || [];
  };
  // The interface sections that exist for a given block type, in display order.
  T.ifaceSections = function (type) {
    if (type === 'FB') return ['input', 'output', 'inout', 'static', 'temp', 'constant'];
    if (type === 'FC') return ['input', 'output', 'inout', 'temp', 'constant', 'return'];
    return ['temp', 'constant'];   // OB
  };
  // Parameters carried on a call box. inout appears on BOTH sides (read in, write out).
  T.ifaceCallInputs = function (b) {
    const i = (b && b.iface) || {};
    return (i.input || []).concat(i.inout || []);
  };
  T.ifaceCallOutputs = function (b) {
    const i = (b && b.iface) || {};
    return (i.output || []).concat(i.inout || []).concat(b && b.type === 'FC' ? (i.return || []) : []);
  };
  // Every declared member of a block (across all sections), with its section tag.
  T.ifaceMembers = function (b) {
    if (!b || !b.iface) return [];
    const out = [];
    T.ifaceSections(b.type).forEach((s) => (b.iface[s] || []).forEach((m) => out.push({ section: s, member: m })));
    return out;
  };

  /* -------------------------------------------------- local scope (sim) ----- */
  // While the simulator executes a block, T._scope maps a local member NAME to its
  // storage { key, bit }. T.resolve consults it BEFORE global tags so an operand
  // that names an interface member resolves to per-instance storage (shadowing tags).
  T._scope = null;
  T.setScope = function (s) { const prev = T._scope; T._scope = s || null; return prev; };
  // Canonical sim-memory key for an interface member of a given instance
  // (instanceId = instance-DB id for FB persisted members / FB id for an orphan FB /
  //  call-element id for FC & temp scratch). Shared by sim.js, iface.js, the DB view.
  T.memberKey = function (instanceId, name) {
    return '@' + String(instanceId).toUpperCase() + ':' + String(name).toUpperCase();
  };

  /* ================================================== operand autocomplete ==
   * Suggestion list of things you can type into an operand field: every PLC tag
   * (by name and address) plus the given/active block's interface variables.
   * ======================================================================== */
  T.operandCandidates = function (block) {
    const out = [];
    if (!T.project) return out;
    (T.project.tags || []).forEach((t) => {
      const v = t.name || t.address;
      if (!v) return;
      out.push({ value: v, label: t.name || t.address, hint: (t.address || '') + (t.dataType ? ' · ' + t.dataType : '') });
    });
    block = block || T.getActiveBlock();
    if (block && block.iface) {
      T.ifaceMembers(block).forEach((e) => {
        out.push({ value: e.member.name, label: e.member.name, hint: e.section + ' · ' + e.member.dataType });
      });
    }
    return out;
  };

  // Attach a TIA-style suggestion dropdown to an <input>.
  //   opts.items()    -> array of { value, label, hint } candidates
  //   opts.onPick(v)  -> called when the user accepts a suggestion (fills + commits)
  // Returns { destroy(), close(), reposition() }. Register this BEFORE the input's
  // own keydown handler so its stopImmediatePropagation can pre-empt commit on Enter.
  T.attachAutocomplete = function (input, opts) {
    opts = opts || {};
    const items = opts.items || (() => []);
    const onPick = opts.onPick || (() => {});
    const maxItems = opts.maxItems || 12;
    let dd = null, rows = [], hi = -1;

    function filter(q) {
      q = (q || '').trim().toLowerCase();
      const all = items();
      if (!q) return all.slice(0, maxItems);
      const pre = [], sub = [];
      all.forEach((it) => {
        const v = String(it.value || '').toLowerCase(), h = String(it.hint || '').toLowerCase();
        if (v.indexOf(q) === 0) pre.push(it);
        else if (v.indexOf(q) >= 0 || h.indexOf(q) >= 0) sub.push(it);
      });
      return pre.concat(sub).slice(0, maxItems);
    }
    function position() {
      if (!dd) return;
      const r = input.getBoundingClientRect();
      dd.style.left = r.left + 'px';
      dd.style.top = (r.bottom + 1) + 'px';
      dd.style.minWidth = Math.max(150, r.width) + 'px';
    }
    function render() {
      rows = filter(input.value);
      if (!rows.length) { close(); return; }
      if (hi >= rows.length) hi = rows.length - 1;
      if (!dd) { dd = T.el('div', { class: 'tia-ac' }); document.body.appendChild(dd); }
      T.clear(dd);
      rows.forEach((it, i) => {
        dd.appendChild(T.el('div', {
          class: 'tia-ac-item' + (i === hi ? ' hi' : ''),
          onmousedown: (e) => { e.preventDefault(); hi = i; pick(); },
          onmousemove: () => { if (hi !== i) { hi = i; paint(); } },
        }, T.el('span', { class: 'tia-ac-name' }, it.label || it.value),
           it.hint ? T.el('span', { class: 'tia-ac-hint' }, it.hint) : null));
      });
      position();
    }
    function paint() { // cheap re-highlight without rebuilding
      if (!dd) return;
      T.$$('.tia-ac-item', dd).forEach((el, i) => el.classList.toggle('hi', i === hi));
    }
    function close() { if (dd) { dd.remove(); dd = null; } rows = []; hi = -1; }
    function pick() { if (hi >= 0 && hi < rows.length) { const v = rows[hi].value; close(); onPick(v); } }
    function move(d) { if (!dd) render(); if (!rows.length) return; hi = (hi + d + rows.length) % rows.length; paint(); }

    function onKey(e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); e.stopImmediatePropagation(); move(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopImmediatePropagation(); move(-1); }
      else if (e.key === 'Enter') { if (dd && hi >= 0) { e.preventDefault(); e.stopImmediatePropagation(); pick(); } }
      else if (e.key === 'Escape') { if (dd) { e.preventDefault(); e.stopImmediatePropagation(); close(); } }
      else if (e.key === 'Tab') { if (dd && hi >= 0) { e.preventDefault(); pick(); } }
    }
    function onInput() { hi = -1; render(); }
    function onBlur() { setTimeout(close, 150); }   // delay so an item mousedown can fire

    input.addEventListener('keydown', onKey);
    input.addEventListener('input', onInput);
    input.addEventListener('blur', onBlur);
    render();   // show the full list as soon as the field opens

    return {
      reposition: position,
      close: close,
      destroy() {
        input.removeEventListener('keydown', onKey);
        input.removeEventListener('input', onInput);
        input.removeEventListener('blur', onBlur);
        close();
      },
    };
  };

  /* nextNumber: pick next free block number for a type */
  T.nextBlockNumber = function (type) {
    if (!T.project) return 1;
    const used = T.project.blocks.filter((b) => b.type === type).map((b) => b.number);
    let n = type === 'OB' ? 1 : 1;
    while (used.indexOf(n) >= 0) n++;
    return n;
  };

  /* ========================================================================
   * SIMULATION MEMORY
   * Flat maps keyed by canonical UPPERCASE address.
   *   bits  : "I0.0","Q0.0","M0.0", and timer/counter Q outputs by tag/address
   *   words : "MW0","IW64", numeric values for Int/Real/Word/Time
   * resolve(operand) understands: a tag name, a raw address, or a numeric/T# literal.
   * ======================================================================*/
  /* I/Q/M addresses are backed by a BYTE array per area (S7 semantics), so
   * %M0.3 really is bit 3 of %MB0 and %MW0 overlaps %M0.0..%M1.7 (big-endian:
   * MW0 = MB0<<8 | MB1). W is a signed 16-bit word, B an unsigned byte, D a
   * signed 32-bit dword — or an IEEE-754 float32 when the address carries a
   * Real tag (or a non-integer is written). Symbolic '@NAME' cells stay flat. */
  const MEM_BIT = /^([IQM])(\d+)\.(\d+)$/;
  const MEM_WBD = /^([IQM])([BWD])(\d+)$/;
  const _f32 = new DataView(new ArrayBuffer(4));
  function isRealAddr(k) {
    const t = T.tagByAddress && T.project ? T.tagByAddress(k) : null;
    return !!(t && t.dataType === 'Real');
  }
  T.mem = {
    bits: Object.create(null),      // non-area (symbolic) bit cells
    words: Object.create(null),     // non-area numeric cells
    bytes: null,                    // area byte stores, built in reset()
    _touched: null,                 // area addresses seen (for the sim table)
    // Block instances, FC frames and DBs are typed byte buffers (types.js):
    //   dbs : instance key -> { buf: Uint8Array, t: type, sig, refs }
    //   locs: UPPERCASE operand key ('@INST:MEMBER', '@DB:A.B[2]') -> { db, off, bit, t }
    // so an interface member / DB element is read and written through the
    // same getBit/getWord/setBit/setWord as every other operand.
    dbs: null,
    locs: null,
    reset() {
      this.bits = Object.create(null);
      this.words = Object.create(null);
      this.bytes = { I: Object.create(null), Q: Object.create(null), M: Object.create(null) };
      this._touched = Object.create(null);
      this.dbs = Object.create(null);
      this.locs = Object.create(null);
    },
    areaKeys() { return Object.keys(this._touched); },
    readLoc(L) {
      const d = this.dbs[L.db];
      if (!d) return L.t.cls === 'bool' ? false : 0;
      return T.types.read(d.buf, L.off, L.bit, L.t);
    },
    writeLoc(L, v) {
      const d = this.dbs[L.db];
      if (d) T.types.write(d.buf, L.off, L.bit, L.t, T.types.conv(v, L.t));
    },
    getBit(addr) {
      const k = String(addr).toUpperCase();
      const L = this.locs[k];
      if (L) { const v = this.readLoc(L); return typeof v === 'boolean' ? v : v !== 0; }
      const m = MEM_BIT.exec(k);
      if (m) return !!(((this.bytes[m[1]][+m[2]] || 0) >> +m[3]) & 1);
      return !!this.bits[k];
    },
    setBit(addr, v) {
      const k = String(addr).toUpperCase();
      const L = this.locs[k];
      if (L) { this.writeLoc(L, !!v); return; }
      const m = MEM_BIT.exec(k);
      if (m) {
        const a = this.bytes[m[1]], by = +m[2], bi = +m[3];
        const cur = a[by] || 0;
        a[by] = v ? (cur | (1 << bi)) : (cur & ~(1 << bi) & 0xFF);
        this._touched[k] = true;
        return;
      }
      this.bits[k] = !!v;
    },
    getWord(addr) {
      const k = String(addr).toUpperCase();
      const L = this.locs[k];
      if (L) { const v = this.readLoc(L); return typeof v === 'boolean' ? (v ? 1 : 0) : v; }
      const m = MEM_WBD.exec(k);
      if (m) {
        const a = this.bytes[m[1]], off = +m[3];
        const g = (i) => a[i] || 0;
        if (m[2] === 'B') return g(off);
        if (m[2] === 'W') {
          const v = (g(off) << 8) | g(off + 1);
          return v >= 0x8000 ? v - 0x10000 : v;
        }
        if (isRealAddr(k)) {
          _f32.setUint8(0, g(off)); _f32.setUint8(1, g(off + 1));
          _f32.setUint8(2, g(off + 2)); _f32.setUint8(3, g(off + 3));
          const f = _f32.getFloat32(0);
          return f === 0 ? 0 : parseFloat(f.toPrecision(7));   // hide float32 noise
        }
        return ((g(off) << 24) | (g(off + 1) << 16) | (g(off + 2) << 8) | g(off + 3)) | 0;
      }
      return +this.words[k] || 0;
    },
    setWord(addr, v) {
      const k = String(addr).toUpperCase();
      let n = +v;
      if (!isFinite(n)) n = 0;
      const L = this.locs[k];
      if (L) { this.writeLoc(L, n); return; }
      const m = MEM_WBD.exec(k);
      if (m) {
        const a = this.bytes[m[1]], off = +m[3];
        this._touched[k] = true;
        if (m[2] === 'B') {
          a[off] = Math.floor(n + 0.5) & 0xFF;
        } else if (m[2] === 'W') {
          const w = Math.floor(n + 0.5) & 0xFFFF;
          a[off] = w >>> 8; a[off + 1] = w & 0xFF;
        } else if (isRealAddr(k)) {
          _f32.setFloat32(0, n);
          a[off] = _f32.getUint8(0); a[off + 1] = _f32.getUint8(1);
          a[off + 2] = _f32.getUint8(2); a[off + 3] = _f32.getUint8(3);
        } else {
          // DInt / Time: a whole number, wrapped to signed 32-bit like the hardware
          // (a fraction used to be stored as float32 bits = garbage through this view)
          const d = Math.floor(n + 0.5) | 0;
          a[off] = (d >>> 24) & 0xFF; a[off + 1] = (d >>> 16) & 0xFF;
          a[off + 2] = (d >>> 8) & 0xFF; a[off + 3] = d & 0xFF;
        }
        return;
      }
      this.words[k] = n;
    },
  };
  T.mem.reset();

  // Time-literal prefix: T#, TIME#, S5T#, S5TIME# (S5TIME parses like TIME here;
  // the real S5 granularity/range limits are not enforced).
  T.TIME_LIT = /^(s5)?t(ime)?#/i;
  // Parse IEC time literal "T#5s","T#1m30s","500ms" -> milliseconds. Also accepts plain ms number.
  T.parseTime = function (s) {
    if (s == null) return 0;
    if (typeof s === 'number') return s;
    s = String(s).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(parseFloat(s));   // plain ms
    let ms = 0; const body = s.replace(T.TIME_LIT, '');
    const re = /(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gi; let m, matched = false;
    while ((m = re.exec(body))) {
      matched = true; const v = parseFloat(m[1]);
      switch (m[2].toLowerCase()) {
        case 'ms': ms += v; break;
        case 's': ms += v * 1000; break;
        case 'm': ms += v * 60000; break;
        case 'h': ms += v * 3600000; break;
        case 'd': ms += v * 86400000; break;
      }
    }
    return matched ? Math.round(ms) : (parseFloat(body) || 0);
  };
  T.fmtTime = function (ms) {
    ms = Math.max(0, Math.round(ms));
    if (ms < 1000) return 'T#' + ms + 'ms';
    const s = ms / 1000;
    if (s < 60) return 'T#' + (Number.isInteger(s) ? s : s.toFixed(3).replace(/0+$/, '')) + 's';
    const m = Math.floor(s / 60), rs = Math.round(s % 60);
    return 'T#' + m + 'm' + (rs ? rs + 's' : '');
  };

  /* resolve an operand string to a typed reference for the simulator.
   * returns { type:'bit'|'word'|'const'|'time'|'none', addr, value, tag }
   */
  const ADDR_BIT = /^[IQM]\d+\.\d+$/i;
  const ADDR_WORD = /^[IQM][BWD]\d+$/i;
  T.resolve = function (operand, expect) {
    let raw = (operand == null ? '' : String(operand)).trim();
    if (raw === '') return { type: 'none', raw };
    // TIA absolute-address prefix: %I0.0 ≡ I0.0 (also lets %MW10 hit ADDR_WORD)
    if (raw.charAt(0) === '%') raw = raw.slice(1).trim();
    // numeric literal
    if (/^-?\d+(\.\d+)?$/.test(raw)) return { type: 'const', value: parseFloat(raw), raw };
    // boolean literal
    if (/^(true|false|1|0)$/i.test(raw) && expect === 'bit') return { type: 'const', value: /^(true|1)$/i.test(raw), raw };
    // time literal (T# / TIME# / S5T# / S5TIME#)
    if (T.TIME_LIT.test(raw)) return { type: 'time', value: T.parseTime(raw), raw };
    // raw address
    if (ADDR_BIT.test(raw)) return { type: 'bit', addr: raw.toUpperCase(), raw };
    if (ADDR_WORD.test(raw)) return { type: 'word', addr: raw.toUpperCase(), raw };
    // TIA spellings: #member (local), "Tag" (global)
    if (raw.charAt(0) === '#' && /^#[A-Za-z_]\w*$/.test(raw)) raw = raw.slice(1);
    else if (/^"[^"]+"$/.test(raw)) raw = raw.slice(1, -1);
    // local interface member (only while a block is executing) — shadows global tags
    if (T._scope) {
      const key = raw.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(T._scope, key)) {
        const m = T._scope[key];
        if (m.complex) return { type: 'none', raw, scoped: true };
        return { type: m.bit ? 'bit' : 'word', addr: m.addr, raw, scoped: true };
      }
    }
    // a path into a structured member or a data block: "Data".values[3], #rec.flag
    if (/[.\[]/.test(raw) && T.resolvePath) {
      const L = T.resolvePath(raw);
      if (L) {
        if (L.t.k !== 'el') return { type: 'none', raw };
        T.mem.locs[L.key] = { db: L.db, off: L.off, bit: L.bit, t: L.t };
        return { type: L.t.cls === 'bool' ? 'bit' : 'word', addr: L.key, raw, loc: true };
      }
    }
    // symbolic tag (exact first, then case-insensitive — matches the ESP32 runtime)
    const tag = T.tagByName(raw)
      || (T.project && T.project.tags.find((t) => t.name && t.name.toLowerCase() === raw.toLowerCase()));
    if (tag) {
      const isBit = tag.dataType === 'Bool';
      // key bit/word memory by the symbolic NAME when no address given, else by address
      const key = (tag.address && tag.address.trim()) ? tag.address.toUpperCase() : ('@' + tag.name.toUpperCase());
      return { type: isBit ? 'bit' : 'word', addr: key, raw, tag };
    }
    // unknown symbol: treat as named bit/word storage so sim still runs
    const key = '@' + raw.toUpperCase();
    return { type: expect === 'word' ? 'word' : 'bit', addr: key, raw, unknown: true };
  };

  T.readBit = function (operand) {
    const r = T.resolve(operand, 'bit');
    if (r.type === 'const') return !!r.value;
    if (r.type === 'bit') return T.mem.getBit(r.addr);
    if (r.type === 'word') return T.mem.getWord(r.addr) !== 0;
    return false;
  };
  T.writeBit = function (operand, v) {
    const r = T.resolve(operand, 'bit');
    if (r.type === 'bit') T.mem.setBit(r.addr, v);
    else if (r.type === 'word') T.mem.setWord(r.addr, v ? 1 : 0);
  };
  T.readNum = function (operand) {
    const r = T.resolve(operand, 'word');
    if (r.type === 'const') return r.value;
    if (r.type === 'time') return r.value;
    if (r.type === 'word') return T.mem.getWord(r.addr);
    if (r.type === 'bit') return T.mem.getBit(r.addr) ? 1 : 0;
    return 0;
  };
  T.writeNum = function (operand, v) {
    const r = T.resolve(operand, 'word');
    if (r.type === 'word') T.mem.setWord(r.addr, v);
    else if (r.type === 'bit') T.mem.setBit(r.addr, v !== 0);
  };

  /* ============================================================ persistence */
  // Runtime-only fields (leading underscore: _live, _power, _val, sim scratch)
  // must not be persisted — an exported project would otherwise carry stale
  // energized/latch state. _seq is real model data (block numbering) and stays.
  function stripRuntime(k, v) { return (k.charAt(0) === '_' && k !== '_seq') ? undefined : v; }
  T.stripRuntime = stripRuntime;   // shared with the editors' undo snapshots
  T.storage = {
    KEY: 'tia_browser_project_v1',
    LIB_PREFIX: 'tia_proj:',
    LIB_INDEX: 'tia_proj_index',
    save() {
      try {
        localStorage.setItem(this.KEY, JSON.stringify(T.project, stripRuntime));
        this.saveToLibrary();          // best-effort per-name copy for "Open recent"
        return true;
      }
      catch (e) { console.warn('localStorage save failed', e); return false; }
    },
    // Per-project-name slots so opening/creating another project no longer
    // overwrites the only saved one. Index: { name: lastSavedMs }.
    saveToLibrary() {
      if (!T.project || !T.project.name) return false;
      try {
        localStorage.setItem(this.LIB_PREFIX + T.project.name, JSON.stringify(T.project, stripRuntime));
        const idx = this.libraryIndex();
        idx[T.project.name] = Date.now();
        localStorage.setItem(this.LIB_INDEX, JSON.stringify(idx));
        return true;
      } catch (e) { return false; }
    },
    libraryIndex() {
      try { return JSON.parse(localStorage.getItem(this.LIB_INDEX)) || {}; }
      catch (e) { return {}; }
    },
    loadFromLibrary(name) {
      try {
        const s = localStorage.getItem(this.LIB_PREFIX + name);
        return s ? JSON.parse(s) : null;
      } catch (e) { return null; }
    },
    load() {
      let s = null;
      try { s = localStorage.getItem(this.KEY); } catch (e) { return null; }
      if (!s) return null;
      try { return JSON.parse(s); }
      catch (e) {
        // keep the raw text so a corrupted save can be recovered, not silently
        // overwritten by the demo project on the next autosave
        try { localStorage.setItem(this.KEY + '_corrupt', s); } catch (e2) { /* full */ }
        console.error('[TIA] saved project is corrupt — raw copy kept under ' + this.KEY + '_corrupt', e);
        return null;
      }
    },
    exportFile() {
      const data = JSON.stringify(T.project, stripRuntime, 2);
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = T.el('a', { href: url, download: (T.project.name || 'project') + '.tiaweb.json' });
      document.body.appendChild(a); a.click();
      setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 100);
    },
    importFile(onload) {
      const inp = T.el('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' } });
      inp.addEventListener('change', () => {
        const f = inp.files[0]; if (!f) return;
        const r = new FileReader();
        r.onload = () => { try { onload(JSON.parse(r.result)); } catch (e) { alert('Invalid project file: ' + e.message); } };
        r.readAsText(f);
        inp.remove();
      });
      document.body.appendChild(inp); inp.click();
    },
  };

  /* ==================================================== rename refactoring ==
   * Operands are plain strings, so renaming a tag / interface member must
   * rewrite every reference or the logic silently reads FALSE/0 forever.
   * ======================================================================== */
  const REN_PARAM_SKIP = { op: 1, target: 1, instanceDb: 1 };
  // Visit every operand-bearing slot of a block: element/box operands, operand
  // params, call args (values), FBD pin operands. visit(get, set, info) where
  // info = { ni: network index, slot: human label } (used by the xref list).
  function forEachOperandSlot(block, visit) {
    (block.networks || []).forEach((net, ni) => {
      const doEl = (el) => {
        const kn = el.kind || 'box';
        visit(() => el.operand, (v) => { el.operand = v; }, { ni, slot: kn + ' operand' });
        const par = el.params;
        if (par) Object.keys(par).forEach((k) => {
          if (!REN_PARAM_SKIP[k]) visit(() => par[k], (v) => { par[k] = v; }, { ni, slot: kn + ' · ' + k.toUpperCase() });
        });
        if (el.args) Object.keys(el.args).forEach((k) =>
          visit(() => el.args[k], (v) => { el.args[k] = v; }, { ni, slot: 'call parameter ' + k }));
        (el.inputs || []).forEach((p) =>
          visit(() => p.operand, (v) => { p.operand = v; }, { ni, slot: kn + ' pin ' + p.name }));
      };
      (net.stages || []).forEach((s) => (s.branches || []).forEach((br) => (br.elements || []).forEach(doEl)));
      (net.outputs || []).forEach(doEl);
      (net.boxes || []).forEach(doEl);
    });
  }
  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  // rewrite `code` occurrences of identifier old -> new (word-boundary, ci)
  function renameInScl(block, oldName, newName, count) {
    if (block.lang !== 'SCL' || typeof block.code !== 'string') return count;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(oldName)) return count;   // not an SCL identifier
    const re = new RegExp('\\b' + escRe(oldName) + '\\b', 'gi');
    block.code = block.code.replace(re, () => { count++; return newName; });
    return count;
  }
  function rewriteSlots(block, oldName, newName) {
    const low = String(oldName).toLowerCase();
    let n = 0;
    forEachOperandSlot(block, (get, set) => {
      const v = get();
      if (v == null) return;
      if (String(v).trim().replace(/^%/, '').toLowerCase() === low) { set(newName); n++; }
    });
    return n;
  }

  T.refactor = {
    // Rewrite every reference to a renamed GLOBAL tag. Skips blocks whose own
    // interface declares the same name (there the operand means the member).
    // Returns the number of rewritten references.
    renameTag(oldName, newName) {
      oldName = String(oldName == null ? '' : oldName).trim();
      newName = String(newName == null ? '' : newName).trim();
      if (!T.project || !oldName || !newName || oldName === newName) return 0;
      // another tag still carries the old name — its references must stay
      if ((T.project.tags || []).some((t) => t.name === oldName)) return 0;
      let n = 0;
      (T.project.blocks || []).forEach((b) => {
        if (b.type === 'DB') return;
        const locals = T.ifaceMembers(b).some((e) =>
          String(e.member.name || '').toLowerCase() === oldName.toLowerCase());
        if (locals) return;                       // shadowed inside this block
        n += rewriteSlots(b, oldName, newName);
        n = renameInScl(b, oldName, newName, n);
      });
      (T.project.gpio || []).forEach((g) => { if (g && g.tag === oldName) { g.tag = newName; n++; } });
      return n;
    },

    // Rewrite references to a renamed interface MEMBER: operands inside the
    // block, plus call-site arg keys / FBD pin names everywhere it is called.
    renameMember(block, oldName, newName) {
      oldName = String(oldName == null ? '' : oldName).trim();
      newName = String(newName == null ? '' : newName).trim();
      if (!T.project || !block || !oldName || !newName || oldName === newName) return 0;
      if (T.ifaceMembers(block).some((e) => e.member.name === oldName)) return 0;  // old name still declared
      let n = rewriteSlots(block, oldName, newName);
      n = renameInScl(block, oldName, newName, n);
      (T.project.blocks || []).forEach((b) => {
        (b.networks || []).forEach((net) => {
          (net.outputs || []).forEach((el) => {
            if (el.kind === 'call' && el.params && el.params.target === block.id && el.args &&
                Object.prototype.hasOwnProperty.call(el.args, oldName)) {
              el.args[newName] = el.args[oldName];
              delete el.args[oldName];
              n++;
            }
          });
          (net.boxes || []).forEach((bx) => {
            if (bx.kind === 'call' && bx.params && bx.params.target === block.id) {
              (bx.inputs || []).concat(bx.outputs || []).forEach((p) => {
                if (p.name === oldName) { p.name = newName; n++; }
              });
            }
          });
        });
      });
      return n;
    },

    // Cross-reference list: every place a tag / member NAME (or its address) is
    // used. Returns [{ blockId, block, net (1-based, 0 for SCL), where }].
    findRefs(name) {
      const out = [];
      name = String(name == null ? '' : name).trim().replace(/^%/, '');
      if (!T.project || !name) return out;
      // match the queried spelling AND the tag's other identity (name <-> address)
      const alts = new Set([name.toLowerCase()]);
      const tags = T.project.tags || [];
      const tag = tags.find((t) => (t.name || '').toLowerCase() === name.toLowerCase())
        || tags.find((t) => (t.address || '').trim().toLowerCase() === name.toLowerCase());
      if (tag) {
        if (tag.name) alts.add(tag.name.toLowerCase());
        if (tag.address) alts.add(tag.address.trim().toLowerCase());
      }
      (T.project.blocks || []).forEach((b) => {
        if (b.type === 'DB') return;
        const label = b.name + ' [' + b.type + b.number + ']';
        const shadowed = T.ifaceMembers(b).some((e) =>
          String(e.member.name || '').toLowerCase() === name.toLowerCase());
        forEachOperandSlot(b, (get, set, info) => {
          const v = get();
          if (v != null && alts.has(String(v).trim().replace(/^%/, '').toLowerCase())) {
            out.push({ blockId: b.id, block: label, net: info.ni + 1,
                       where: info.slot + (shadowed ? ' (local member)' : '') });
          }
        });
        if (b.lang === 'SCL' && typeof b.code === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          const re = new RegExp('\\b' + escRe(name) + '\\b', 'i');
          String(b.code).split('\n').forEach((lineTxt, li) => {
            if (re.test(lineTxt)) out.push({ blockId: b.id, block: label, net: 0, where: 'SCL line ' + (li + 1) });
          });
        }
      });
      return out;
    },

    // How many operand slots reference this tag name (for delete confirmation).
    countTagRefs(name) {
      name = String(name == null ? '' : name).trim();
      if (!T.project || !name) return 0;
      const low = name.toLowerCase();
      let n = 0;
      (T.project.blocks || []).forEach((b) => {
        if (b.type === 'DB') return;
        if (T.ifaceMembers(b).some((e) => String(e.member.name || '').toLowerCase() === low)) return;
        forEachOperandSlot(b, (get) => {
          const v = get();
          if (v != null && String(v).trim().replace(/^%/, '').toLowerCase() === low) n++;
        });
        if (b.lang === 'SCL' && typeof b.code === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
          const m = b.code.match(new RegExp('\\b' + escRe(name) + '\\b', 'gi'));
          if (m) n += m.length;
        }
      });
      return n;
    },
  };

  /* ----------------------------------------------------------------- icons */
  // Minimal inline SVG icon set (stroke = currentColor).
  const I = (p) => '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  T.icons = {
    plc:    I('<rect x="2" y="3" width="12" height="10" rx="1"/><path d="M5 3v10M8 3v10M11 3v10"/>'),
    folder: I('<path d="M2 5l1-1h3l1 1h6v7H2z"/>'),
    block:  I('<rect x="2.5" y="2.5" width="11" height="11" rx="1"/><path d="M2.5 6h11"/>'),
    db:     I('<path d="M3 4c0-1.1 2.2-2 5-2s5 .9 5 2v8c0 1.1-2.2 2-5 2s-5-.9-5-2z"/><path d="M3 4c0 1.1 2.2 2 5 2s5-.9 5-2"/><path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>'),
    tag:    I('<path d="M2 8l5-5h6v6l-5 5z"/><circle cx="10" cy="6" r="1"/>'),
    device: I('<rect x="2" y="4" width="12" height="8" rx="1"/><path d="M4 12v2M12 12v2"/>'),
    run:    I('<path d="M4 3l9 5-9 5z" fill="currentColor"/>'),
    stop:   I('<rect x="4" y="4" width="8" height="8" fill="currentColor"/>'),
    compile:I('<path d="M3 8l3 3 7-7"/>'),
    save:   I('<path d="M3 2h8l2 2v10H3z"/><path d="M5 2v4h5V2M5 14v-4h6v4"/>'),
    open:   I('<path d="M2 4h5l1 1h6v8H2z"/>'),
    download:I('<path d="M8 2v8M5 7l3 3 3-3M3 13h10"/>'),
    add:    I('<path d="M8 3v10M3 8h10"/>'),
    trash:  I('<path d="M3 4h10M6 4V2.5h4V4M5 4l1 9h4l1-9"/>'),
    network:I('<rect x="2" y="3" width="12" height="4" rx="1"/><rect x="2" y="9" width="12" height="4" rx="1"/>'),
    chevron:I('<path d="M6 4l4 4-4 4"/>'),
  };

  /* status bar helper */
  T.status = function (msg, kind) {
    T.bus.emit('status', { msg, kind: kind || 'info' });
  };

  console.log('[TIA] core loaded. catalog kinds:', Object.keys(T.catalog).length);
})(window.TIA);
