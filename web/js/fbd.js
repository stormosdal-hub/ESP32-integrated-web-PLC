/* ===========================================================================
 * TIA-like Browser PLC IDE  —  fbd.js
 * THE FUNCTION BLOCK DIAGRAM (FBD) EDITOR.
 *
 * Renders each network of a block as an FBD "sheet" (one SVG per network):
 * logic/function boxes with input pins on the left and output pins on the
 * right, orthogonal/smooth wires between them, inverted-pin bubbles, editable
 * operand & parameter labels, and live (green) power flow during simulation.
 *
 * The user can:
 *   - drag a box body to move it (wires redraw live),
 *   - click an OUTPUT pin then an INPUT pin to draw a wire,
 *   - click an unwired input pin's operand label to edit pin.operand,
 *   - double-click a pin to toggle pin.inverted,
 *   - edit assign/compare/timer/math params inline,
 *   - insert boxes via the instruction tree (insert(kind)) or drag-drop,
 *   - delete the selected box or wire,
 *   - add networks.
 *
 * Public API:
 *   T.editors.fbd = { open(hostEl, block) }
 *   open() also sets:
 *   T.activeEditor = { lang:'FBD', block, insert(kind), deleteSelection(),
 *                      addNetwork(), refresh(), highlight() }
 *
 * Bus events:
 *   listens : 'sim:tick'  -> highlight()        (cheap, queries existing nodes)
 *             'sim:state' -> clear highlight when sim stops
 *   emits   : 'tree:changed' (so autosave / properties pick up edits)
 *
 * Uses ONLY window.TIA.* helpers. IIFE, no globals beyond T.editors.fbd.
 * =========================================================================*/
(function (T) {
  'use strict';

  /* ======================================================================= *
   *  GEOMETRY CONSTANTS                                                      *
   * ======================================================================= */
  const G = {
    boxW: 70,         // default box width
    pinGap: 22,       // vertical spacing between pins
    pinTop: 26,       // y of first pin row inside the box (relative to box top)
    titleH: 18,       // height reserved for the box title bar
    stubLen: 18,      // length of a pin stub sticking out of the box edge
    bubbleR: 4,       // radius of the inverted-pin bubble
    pad: 28,          // SVG content padding around boxes
    minSheetW: 520,   // minimum sheet width
    minSheetH: 180,   // minimum sheet height
    snap: 8,          // drag snap grid
  };

  /* ======================================================================= *
   *  COMPONENT CSS  (uses the --tia-* theme variables only)                 *
   * ======================================================================= */
  T.injectCSS('tia-fbd-css', `
    .fbd-root { padding: 6px 8px 40px; min-width: max-content; }

    /* ---- network card (same chrome language as LAD) ---- */
    .fbd-net { background: var(--tia-canvas); border: 1px solid var(--tia-border);
      margin: 0 0 12px; box-shadow: 0 1px 0 rgba(0,0,0,.04); }
    .fbd-net.fbd-net-active { border-color: var(--tia-petrol); }

    .fbd-net-head { display: flex; align-items: center; gap: 8px;
      background: var(--tia-net-head); border-bottom: 1px solid var(--tia-border-soft);
      padding: 3px 8px; }
    .fbd-net-no { font-weight: 700; color: var(--tia-petrol-dark); white-space: nowrap; }
    .fbd-net-title { flex: 1 1 auto; color: var(--tia-text); cursor: text;
      min-width: 40px; padding: 1px 3px; border-radius: 2px; }
    .fbd-net-title:hover { background: #fff; outline: 1px dashed var(--tia-border); }
    .fbd-net-title.empty { color: var(--tia-text-soft); font-style: italic; }
    .fbd-net-tools { display: flex; gap: 2px; }
    .fbd-net-tool { display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 20px; border: 1px solid transparent; border-radius: 3px;
      cursor: pointer; color: var(--tia-text-soft); }
    .fbd-net-tool:hover { background: var(--tia-hover); border-color: var(--tia-petrol);
      color: var(--tia-petrol-dark); }
    .fbd-net-tool svg { width: 14px; height: 14px; }

    .fbd-net-comment { padding: 1px 8px 3px 8px; color: var(--tia-text-soft);
      font-size: 11.5px; cursor: text; }
    .fbd-net-comment:hover { background: #fafbfb; outline: 1px dashed var(--tia-border-soft); }
    .fbd-net-comment.empty { font-style: italic; opacity: .8; }

    .fbd-net-body { overflow: auto; padding: 2px 0; position: relative; }
    .fbd-net.fbd-drop-hot .fbd-net-body { background: var(--tia-live-bg);
      outline: 2px dashed var(--tia-petrol); outline-offset: -3px; }
    /* tag drag-over highlight on a drop target (pin operand / pin hit / param) */
    text.fbd-tag-hot { fill: var(--tia-petrol) !important; font-weight: 700; }
    rect.fbd-tag-hot { fill: rgba(0,153,153,.20); stroke: var(--tia-petrol); stroke-width: 1; }
    /* operand (assigned tag) text follows the live/low flow during simulation */
    .fbd-operand.fbd-live { fill: var(--tia-live); font-weight: 600; }
    .fbd-operand.fbd-low  { fill: var(--tia-low); }

    /* ---- SVG sheet ---- */
    .fbd-svg { display: block; font-family: var(--tia-font);
      background:
        linear-gradient(90deg, var(--tia-border-soft) 1px, transparent 1px) 0 0/20px 20px,
        linear-gradient(0deg, var(--tia-border-soft) 1px, transparent 1px) 0 0/20px 20px;
      background-color: var(--tia-canvas); }

    .fbd-box-rect { stroke: var(--tia-wire); stroke-width: 1.4; fill: #fdfefe; }
    .fbd-box-title { fill: var(--tia-petrol-deep); font-weight: 700; font-size: 13px;
      text-anchor: middle; }
    .fbd-box-instr { fill: var(--tia-petrol-deep); font-weight: 700; font-size: 12px;
      text-anchor: middle; }
    .fbd-box-divider { stroke: var(--tia-border); stroke-width: .8; }
    .fbd-box-operand { fill: var(--tia-text); font-size: 10px;
      font-family: var(--tia-mono); text-anchor: middle; }

    .fbd-pin-name { fill: var(--tia-text-soft); font-size: 9.5px; }
    .fbd-stub { stroke: var(--tia-wire); stroke-width: 1.6; }
    .fbd-bubble { stroke: var(--tia-wire); stroke-width: 1.4; fill: var(--tia-canvas); }

    /* clickable pin dots / hit zones */
    .fbd-pin-hit { fill: transparent; cursor: crosshair; }
    .fbd-pin-dot { fill: var(--tia-wire); }
    .fbd-pin-dot.out { fill: var(--tia-petrol-dark); }
    .fbd-pin-dot.pending { fill: var(--tia-petrol); }

    /* operand / param labels (click to edit inline) */
    .fbd-operand { fill: var(--tia-text); font-size: 10px; font-family: var(--tia-mono);
      cursor: text; }
    .fbd-operand.empty { fill: var(--tia-text-soft); font-style: italic; }

    /* wires */
    .fbd-wire { stroke: var(--tia-wire); stroke-width: 1.7; fill: none; }
    .fbd-wire-hit { stroke: transparent; stroke-width: 9; fill: none; cursor: pointer; }
    .fbd-wire.selected { stroke: var(--tia-petrol); stroke-width: 2.4; }

    /* pending-source feedback line that follows the cursor */
    .fbd-pending-line { stroke: var(--tia-petrol); stroke-width: 1.6;
      stroke-dasharray: 4 3; fill: none; pointer-events: none; }

    /* selection */
    .fbd-box { cursor: move; }
    .fbd-box.selected .fbd-box-rect { stroke: var(--tia-petrol); stroke-width: 2;
      fill: var(--tia-live-bg); }
    .fbd-box.dragging { opacity: .92; }

    /* the small "+" add-input affordance for expandable boxes */
    .fbd-add-in { cursor: pointer; }
    .fbd-add-in circle { fill: #fff; stroke: var(--tia-petrol); stroke-width: 1.2; }
    .fbd-add-in text { fill: var(--tia-petrol-dark); font-size: 12px; font-weight: 700;
      text-anchor: middle; pointer-events: none; }
    .fbd-add-in:hover circle { fill: var(--tia-hover); }

    /* live (energized) flow — toggled by highlight() without rebuilding SVG */
    .fbd-wire.fbd-live { stroke: var(--tia-live); stroke-width: 2.4; }
    .fbd-stub.fbd-live { stroke: var(--tia-live); }
    .fbd-pin-dot.fbd-live { fill: var(--tia-live); }
    .fbd-box.fbd-live .fbd-box-rect { stroke: var(--tia-live); }
    .fbd-box.fbd-live .fbd-box-instr,
    .fbd-box.fbd-live .fbd-box-title { fill: var(--tia-live); }

    /* low (de-energized while sim runs) — dashed blue wires/stubs, solid blue
       symbols/pins (mirrors the *-live rules but using --tia-low) */
    .fbd-wire.fbd-low { stroke: var(--tia-low); stroke-width: 1.7; stroke-dasharray: 5 3; }
    .fbd-stub.fbd-low { stroke: var(--tia-low); stroke-dasharray: 5 3; }
    .fbd-pin-dot.fbd-low { fill: var(--tia-low); }
    .fbd-box.fbd-low .fbd-box-rect { stroke: var(--tia-low); }
    .fbd-box.fbd-low .fbd-box-instr,
    .fbd-box.fbd-low .fbd-box-title { fill: var(--tia-low); }
    .fbd-box.fbd-low .fbd-call-title { fill: var(--tia-low); }

    /* ---- call box (a block call placed on the FBD sheet) ---- */
    .fbd-call-title { fill: var(--tia-petrol-deep); font-weight: 700; font-size: 12px;
      text-anchor: middle; }
    .fbd-call-sub { fill: var(--tia-text-soft); font-size: 9.5px; font-family: var(--tia-mono);
      text-anchor: middle; }
    .fbd-box.fbd-live .fbd-call-title { fill: var(--tia-live); }

    /* the "−" remove-input affordance for expandable boxes (mirrors .fbd-add-in) */
    .fbd-del-in { cursor: pointer; }
    .fbd-del-in circle { fill: #fff; stroke: var(--tia-petrol); stroke-width: 1.2; }
    .fbd-del-in text { fill: var(--tia-petrol-dark); font-size: 12px; font-weight: 700;
      text-anchor: middle; pointer-events: none; }
    .fbd-del-in:hover circle { fill: var(--tia-hover); }

    .fbd-empty-hint { fill: var(--tia-text-soft); font-style: italic; font-size: 12px;
      text-anchor: middle; }

    /* inline edit input floating over the SVG */
    .fbd-edit-input { position: absolute; z-index: 50; font-family: var(--tia-mono);
      font-size: 11px; padding: 1px 3px; border: 1px solid var(--tia-petrol);
      border-radius: 2px; background: #fff; color: var(--tia-text);
      box-shadow: 0 0 0 2px rgba(0,153,153,.20); }

    /* context menu */
    .fbd-menu { position: absolute; z-index: 9000; background: #fff;
      border: 1px solid var(--tia-border); box-shadow: 0 4px 14px rgba(0,0,0,.18);
      min-width: 180px; padding: 3px 0; border-radius: 3px; font-size: 12.5px; }
    .fbd-menu-item { padding: 5px 14px; cursor: pointer; color: var(--tia-text);
      white-space: nowrap; }
    .fbd-menu-item:hover { background: var(--tia-hover); }
    .fbd-menu-sep { height: 1px; background: var(--tia-border-soft); margin: 3px 0; }
  `);

  /* ======================================================================= *
   *  EDITOR STATE                                                            *
   * ======================================================================= */
  let host = null;          // #tia-editor host element
  let block = null;         // current block
  let rootEl = null;        // .fbd-root container inside host
  let activeNet = null;     // network for inserts / dropping
  let sel = null;           // { type:'box', box, net } | { type:'wire', wire, net } | null
  let pending = null;       // pending wire source: { net, boxId, pinId, x, y } | null
  let simRunning = false;   // true while the simulator runs (Feature 4 coloring)

  /* ======================================================================= *
   *  SMALL HELPERS                                                           *
   * ======================================================================= */
  const def = (kind) => T.catalog[kind] || {};
  /* ---------------------------------------------------------- undo / redo */
  // Mutation paths call markDirty() AFTER the change; keep the last serialized
  // state and push it when the model actually changed (same pattern as lad.js).
  const HIST_MAX = 60;
  let undoStack = [], redoStack = [], histBlk = null, lastSnap = '';
  function snapNow() { return block ? JSON.stringify(block, T.stripRuntime) : ''; }
  function markDirty() {
    if (block) {
      const now = snapNow();
      if (lastSnap && now !== lastSnap) {
        undoStack.push(lastSnap);
        if (undoStack.length > HIST_MAX) undoStack.shift();
        redoStack.length = 0;
      }
      lastSnap = now;
    }
    T.bus.emit('tree:changed');
  }
  // Restore INTO the same block object (identity shared with T.project/tabs).
  function applySnap(s) {
    const restored = JSON.parse(s);
    Object.keys(block).forEach((k) => { delete block[k]; });
    Object.assign(block, restored);
    lastSnap = snapNow();
    sel = null; pending = null; activeNet = null;
    T.bus.emit('tree:changed');
    render();
  }
  function undo() {
    if (!undoStack.length) { T.status('Nothing to undo', 'warn'); return; }
    redoStack.push(snapNow());
    applySnap(undoStack.pop());
    T.status('Undo (' + undoStack.length + ' left)', 'info');
  }
  function redo() {
    if (!redoStack.length) { T.status('Nothing to redo', 'warn'); return; }
    undoStack.push(snapNow());
    applySnap(redoStack.pop());
    T.status('Redo', 'info');
  }

  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  let clipBox = null;       // copy/paste buffer (one serialized box)
  let zoom = 1;             // editor zoom factor (CSS zoom on the root)
  function applyZoom() { if (rootEl) rootEl.style.zoom = zoom; }
  function setZoom(z) {
    zoom = Math.min(2, Math.max(0.4, Math.round(z * 10) / 10));
    applyZoom();
    T.status('Zoom ' + Math.round(zoom * 100) + '%', 'info');
  }

  // network currently holding the pending-wire source box (for the rubber band)
  function pendingNet() {
    if (!pending || !block) return null;
    for (const net of block.networks) {
      if ((net.boxes || []).some((b) => b.id === pending.boxId)) return net;
    }
    return null;
  }

  // Re-render only one network's card — a full render() rebuilds every sheet.
  function renderNet(net) {
    if (!rootEl || !block) return render();
    const idx = block.networks.indexOf(net);
    const old = rootEl.querySelector('.fbd-net[data-net-id="' + cssEsc(net.id) + '"]');
    if (idx < 0 || !old) return render();
    if (editInput) { try { editInput.blur(); } catch (e) { /* commits typed text */ } }
    killEditInput();
    closeMenu();
    old.replaceWith(renderNetwork(net, idx + 1));
    markActiveCards();
    if (pending && pendingNet() === net) attachPendingTracker(net);
    if (simRunning) { try { highlight(); } catch (e) { /* no-op */ } }
  }

  function findBoxInNet(net, id) { return (net.boxes || []).find((b) => b.id === id) || null; }
  function findPin(boxObj, pinId) {
    if (!boxObj) return null;
    return (boxObj.inputs || []).find((p) => p.id === pinId)
        || (boxObj.outputs || []).find((p) => p.id === pinId)
        || null;
  }
  function netOf(boxObj) {
    if (!block) return null;
    return block.networks.find((n) => (n.boxes || []).indexOf(boxObj) >= 0) || null;
  }

  // The instruction label shown inside a box (TIA-style).
  function boxLabel(kind) {
    switch (kind) {
      case 'fb_and': return '&';
      case 'fb_or':  return '>=1';
      case 'fb_xor': return '=1';
      case 'fb_not': return 'NOT';
      case 'assign': return '=';
      case 'compare': return 'CMP';   // operator appended separately
      case 'ton': return 'TON';
      case 'tof': return 'TOF';
      case 'tp':  return 'TP';
      case 'ctu': return 'CTU';
      case 'ctd': return 'CTD';
      case 'move': return 'MOVE';
      case 'add': return 'ADD';
      case 'sub': return 'SUB';
      case 'mul': return 'MUL';
      case 'div': return 'DIV';
      default: return (kind || '?').toUpperCase();
    }
  }
  // Boxes that carry a title bar (function/timer/counter/math) vs. the bare
  // gate-style boxes (&, >=1, =1, NOT, =) that show only a big centred glyph.
  function hasTitleBar(kind) {
    return ['compare', 'ton', 'tof', 'tp', 'ctu', 'ctd', 'ctud', 'move', 'add', 'sub', 'mul', 'div', 'call',
            'norm_x', 'scale_x',
            'sr', 'rs', 'p_trig', 'n_trig', 'r_trig', 'f_trig'].indexOf(kind) >= 0;
  }

  /* Resolve a call box's target block to { title, sub } per shared decision #2. */
  function callInfo(boxObj) {
    const target = (boxObj.params && boxObj.params.target) || '';
    const tb = target ? T.findBlock(target) : null;
    const db = boxObj.params && boxObj.params.instanceDb && T.findBlock(boxObj.params.instanceDb);
    return {
      tb: tb,
      title: (db ? db.name : (tb ? tb.name : '??? missing')),
      sub: tb ? ('%' + tb.type + tb.number + (db ? '' : '')) : '',
    };
  }

  /* Per-box geometry (width/height depend on pin counts & kind). */
  function boxGeom(boxObj) {
    const nin = (boxObj.inputs || []).length;
    const nout = (boxObj.outputs || []).length;
    const rows = Math.max(nin, nout, 1);
    const titled = hasTitleBar(boxObj.kind);
    // call boxes are wider so the target block name stays readable
    let w = titled ? 84 : G.boxW;
    if (boxObj.kind === 'call') {
      const title = callInfo(boxObj).title;
      w = Math.max(96, Math.min(200, 44 + title.length * 7));
    }
    const h = (titled ? G.titleH + 8 : 14) + rows * G.pinGap + 6;
    return { w, h, rows, titled };
  }

  // Absolute coordinates of a pin's connection point (tip of its stub).
  function pinPoint(boxObj, pin) {
    const g = boxGeom(boxObj);
    const isOut = (boxObj.outputs || []).indexOf(pin) >= 0;
    const list = isOut ? boxObj.outputs : boxObj.inputs;
    const idx = list.indexOf(pin);
    const top = g.titled ? G.titleH + 10 : 12;
    const py = boxObj.y + top + idx * G.pinGap + 6;
    const px = isOut ? (boxObj.x + g.w + G.stubLen) : (boxObj.x - G.stubLen);
    return { x: px, y: py, isOut };
  }

  /* ======================================================================= *
   *  RENDER — full re-render of the block into the host                     *
   * ======================================================================= */
  function render() {
    if (!host) return;
    // an externally-triggered render must COMMIT an open inline edit, not
    // discard the typed text (blur fires the input's commit synchronously)
    if (editInput) { try { editInput.blur(); } catch (e) { /* no-op */ } }
    killEditInput();
    closeMenu();
    // NOTE: do NOT cancelPending() here — onPinClick sets `pending` and then calls
    // render() to draw the pending source highlight + rubber-band tracker. Pending is
    // cleared explicitly by open() (block switch), Esc, empty-sheet click, and box-drag.
    T.clear(host);
    rootEl = T.el('div', { class: 'fbd-root' });

    if (!block || !block.networks || !block.networks.length) {
      rootEl.appendChild(T.el('div', { class: 'tia-empty' },
        'This block has no networks. Use "Insert network" to add one.'));
      host.appendChild(rootEl);
      return;
    }

    if (activeNet && block.networks.indexOf(activeNet) < 0) activeNet = null;
    if (!activeNet) activeNet = block.networks[0];
    // drop stale selection
    if (sel) {
      if (sel.type === 'box' && netOf(sel.box) == null) sel = null;
      else if (sel.type === 'wire' && (!sel.net.wires || sel.net.wires.indexOf(sel.wire) < 0)) sel = null;
    }

    block.networks.forEach((net, i) => rootEl.appendChild(renderNetwork(net, i + 1)));
    host.appendChild(rootEl);
    applyZoom();
    // keep the rubber-band line alive across re-renders while wiring
    if (pending) { const pn = pendingNet(); if (pn) attachPendingTracker(pn); }
  }

  /* ----------------------------------------------------------- one network */
  function renderNetwork(net, no) {
    net.boxes = net.boxes || [];
    net.wires = net.wires || [];
    const isActive = net === activeNet;
    const card = T.el('div', {
      class: 'fbd-net' + (isActive ? ' fbd-net-active' : ''),
      dataset: { netId: net.id },
    });

    /* --- header --- */
    const titleSpan = T.el('div', {
      class: 'fbd-net-title' + (net.title ? '' : ' empty'),
      title: 'Click to edit network title',
      onclick: () => editHeaderText(titleSpan, net, 'title'),
    }, net.title || '<title>');

    const tools = T.el('div', { class: 'fbd-net-tools' },
      toolBtn(T.icons.add, 'Insert network below', () => insertNetworkBelow(net)),
      toolBtn(T.icons.trash, 'Delete network', () => deleteNetwork(net)));

    const head = T.el('div', { class: 'fbd-net-head' },
      T.el('span', { class: 'fbd-net-no' }, 'Network ' + no + ':'),
      titleSpan, tools);

    /* --- comment --- */
    const commentEl = T.el('div', {
      class: 'fbd-net-comment' + (net.comment ? '' : ' empty'),
      title: 'Click to edit comment',
      onclick: () => editHeaderText(commentEl, net, 'comment'),
    }, net.comment || 'Comment');

    /* --- body holds the SVG sheet (and floating edit inputs) --- */
    const body = T.el('div', { class: 'fbd-net-body' });
    body.appendChild(buildSheet(net));

    enableDrop(card, body, net);

    // Clicking empty sheet space clears selection and sets the active network.
    body.addEventListener('mousedown', (e) => {
      const onSvg = e.target.classList && e.target.classList.contains('fbd-svg');
      if (e.target === body || onSvg) {
        if (pending) cancelPending();
        select(null);
        activeNet = net; markActiveCards();
      }
    });

    card.appendChild(head);
    card.appendChild(commentEl);
    card.appendChild(body);
    return card;
  }

  function toolBtn(svgHtml, title, onclick) {
    return T.el('div', { class: 'fbd-net-tool', title, onclick: (e) => { e.stopPropagation(); onclick(); } },
      T.el('span', { html: svgHtml }));
  }

  /* ======================================================================= *
   *  SHEET BUILD — lay out one network's boxes & wires as an SVG            *
   * ======================================================================= */
  // Keep a call box's pins in sync with the callee's CURRENT interface: pins
  // were snapshotted at drop time, so adding/removing members left stale pins
  // (renames are handled by T.refactor.renameMember, which renames pins in
  // place, preserving their wires). Matching is by name; removed members drop
  // their pin and any wires touching it.
  function syncCallPins(net, boxObj) {
    const tb = boxObj.params && T.findBlock(boxObj.params.target);
    if (!tb) return;
    T.ensureInterface(tb);
    const reconcile = (existing, fixedFirst, members, isOut) => {
      const out = [existing.find((p) => p.name === fixedFirst) ||
        (isOut ? { id: T.uid('pin'), name: fixedFirst }
               : { id: T.uid('pin'), name: fixedFirst, inverted: false, operand: '' })];
      members.forEach((m) => {
        const have = existing.find((p) => p.name === m.name);
        out.push(have || (isOut ? { id: T.uid('pin'), name: m.name }
                                : { id: T.uid('pin'), name: m.name, inverted: false, operand: '' }));
      });
      return out;
    };
    const ins = reconcile(boxObj.inputs || [], 'EN', T.ifaceCallInputs(tb), false);
    const outs = reconcile(boxObj.outputs || [], 'ENO', T.ifaceCallOutputs(tb), true);
    const changed = ins.length !== (boxObj.inputs || []).length
      || outs.length !== (boxObj.outputs || []).length
      || ins.some((p, i) => boxObj.inputs[i] !== p)
      || outs.some((p, i) => boxObj.outputs[i] !== p);
    if (!changed) return;
    boxObj.inputs = ins;
    boxObj.outputs = outs;
    // purge wires that touched a removed pin
    const pinIds = new Set(ins.concat(outs).map((p) => p.id));
    net.wires = (net.wires || []).filter((w) =>
      (w.from.box !== boxObj.id || pinIds.has(w.from.pin)) &&
      (w.to.box !== boxObj.id || pinIds.has(w.to.pin)));
    // model changed during render: autosave + sim structural caches must know
    T.bus.emit('tree:changed');
  }

  function buildSheet(net) {
    // call boxes follow the callee's current interface (members added/removed)
    (net.boxes || []).forEach((b) => { if (b.kind === 'call') syncCallPins(net, b); });
    // measure required canvas size from box extents
    let maxX = G.minSheetW, maxY = G.minSheetH;
    (net.boxes || []).forEach((b) => {
      const g = boxGeom(b);
      maxX = Math.max(maxX, b.x + g.w + 120);   // room for output operand labels
      maxY = Math.max(maxY, b.y + g.h + 30);
    });
    const w = maxX + G.pad, h = maxY + G.pad;

    const svg = T.svg('svg', {
      class: 'fbd-svg', width: w, height: h, viewBox: '0 0 ' + w + ' ' + h,
      'data-net-id': net.id,
    });

    // placeholder when network has no boxes
    if (!net.boxes.length) {
      svg.appendChild(T.svg('text', {
        class: 'fbd-empty-hint', x: w / 2, y: h / 2,
      }, 'Empty network — click an instruction or drag one here'));
    }

    // 1) wires first (so boxes & pins sit on top for easy hit-testing)
    const wireLayer = T.svg('g', { class: 'fbd-wire-layer' });
    (net.wires || []).forEach((wire) => {
      const node = buildWire(net, wire);
      if (node) wireLayer.appendChild(node);
    });
    svg.appendChild(wireLayer);

    // 2) boxes
    (net.boxes || []).forEach((b) => svg.appendChild(buildBox(net, b)));

    // 3) live "pending wire" rubber-band line (rebuilt on demand)
    const pl = T.svg('path', { class: 'fbd-pending-line', 'data-pending': '1', d: '' });
    pl.style.display = 'none';
    svg.appendChild(pl);

    return svg;
  }

  /* ----------------------------------------------------------- one wire */
  function buildWire(net, wire) {
    const fromBox = findBoxInNet(net, wire.from.box);
    const toBox = findBoxInNet(net, wire.to.box);
    if (!fromBox || !toBox) return null;
    const fromPin = findPin(fromBox, wire.from.pin);
    const toPin = findPin(toBox, wire.to.pin);
    if (!fromPin || !toPin) return null;

    const a = pinPoint(fromBox, fromPin);   // output tip (right)
    const b = pinPoint(toBox, toPin);       // input tip (left)
    const d = wirePath(a.x, a.y, b.x, b.y);

    const g = T.svg('g', { 'data-wire-id': wire.id });
    // wide invisible hit path for easy clicking
    const hit = T.svg('path', { class: 'fbd-wire-hit', d });
    hit.addEventListener('mousedown', (e) => { e.stopPropagation(); selectWire(net, wire); });
    hit.addEventListener('contextmenu', (e) => {
      e.preventDefault(); e.stopPropagation(); selectWire(net, wire);
      openWireMenu(e, net, wire);
    });
    g.appendChild(hit);
    g.appendChild(T.svg('path', {
      class: 'fbd-wire' + (sel && sel.type === 'wire' && sel.wire === wire ? ' selected' : ''),
      d, 'data-wire-line': wire.id,
    }));
    return g;
  }

  // Smooth orthogonal-ish bezier from an output (right) to an input (left).
  function wirePath(x1, y1, x2, y2) {
    const dx = Math.max(24, Math.abs(x2 - x1) * 0.5);
    return 'M' + x1 + ' ' + y1 +
           ' C' + (x1 + dx) + ' ' + y1 + ' ' + (x2 - dx) + ' ' + y2 + ' ' + x2 + ' ' + y2;
  }

  /* ----------------------------------------------------------- one box */
  function buildBox(net, boxObj) {
    const d = def(boxObj.kind);
    const geom = boxGeom(boxObj);
    const isSel = sel && sel.type === 'box' && sel.box === boxObj;

    const g = T.svg('g', {
      class: 'fbd-box' + (isSel ? ' selected' : ''),
      'data-box-id': boxObj.id, 'data-net-id': net.id,
      transform: 'translate(' + boxObj.x + ',' + boxObj.y + ')',
    });

    // box rectangle (local coords; group is translated)
    g.appendChild(T.svg('rect', {
      class: 'fbd-box-rect', x: 0, y: 0, width: geom.w, height: geom.h, rx: 3,
    }));

    // title / glyph
    if (boxObj.kind === 'call') {
      // call box: title = target block's name, subtitle = %TYPEn
      const info = callInfo(boxObj);
      g.appendChild(T.svg('text', { class: 'fbd-call-title', x: geom.w / 2, y: 13 }, info.title));
      if (info.sub) g.appendChild(T.svg('text', { class: 'fbd-call-sub', x: geom.w / 2, y: G.titleH - 4 }, info.sub));
      g.appendChild(T.svg('line', { class: 'fbd-box-divider', x1: 0, y1: G.titleH, x2: geom.w, y2: G.titleH }));
      // double-click navigates to the called block (shared decision #3)
      g.addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); openCalledBlock(boxObj); });
    } else if (geom.titled) {
      const lbl = boxLabel(boxObj.kind) + (boxObj.kind === 'compare' ? ' ' + (cmpOp(boxObj)) : '');
      const titleText = T.svg('text', { class: 'fbd-box-title', x: geom.w / 2, y: 13 }, lbl);
      if (boxObj.kind === 'compare') {
        // clicking the title cycles the comparison operator (LAD parity)
        titleText.style.cursor = 'pointer';
        titleText.addEventListener('mousedown', (e) => e.stopPropagation());
        titleText.addEventListener('click', (e) => {
          e.stopPropagation();
          const ops = ['==', '<>', '>', '>=', '<', '<='];
          boxObj.params = boxObj.params || {};
          boxObj.params.op = ops[(ops.indexOf(boxObj.params.op || '==') + 1) % ops.length];
          markDirty();
          renderNet(net);
        });
      }
      g.appendChild(titleText);
      g.appendChild(T.svg('line', { class: 'fbd-box-divider', x1: 0, y1: G.titleH, x2: geom.w, y2: G.titleH }));
    } else {
      // big centred gate glyph
      g.appendChild(T.svg('text', {
        class: 'fbd-box-instr', x: geom.w / 2, y: geom.h / 2 + 4,
      }, boxLabel(boxObj.kind)));
    }

    // body-drag handle: dragging the rectangle moves the box
    enableBoxDrag(g, net, boxObj);

    // pins (inputs left, outputs right)
    (boxObj.inputs || []).forEach((pin, i) => buildPin(g, net, boxObj, pin, i, false, geom));
    (boxObj.outputs || []).forEach((pin, i) => buildPin(g, net, boxObj, pin, i, true, geom));

    // the assignment box writes its operand to the right of its output pin
    if (boxObj.kind === 'assign') {
      const outPin = boxObj.outputs[0];
      if (outPin) {
        const pt = pinPoint(boxObj, outPin);
        addOperandLabel(g, net, boxObj, 'box-operand', pt.x - boxObj.x + 6, pt.y - boxObj.y + 3, 'start',
          boxObj.operand, (v) => { boxObj.operand = v; });
      }
    }

    // titled function boxes show their param labels (instance/PT/PV/IN/OUT...)
    if (geom.titled) buildBoxParams(g, net, boxObj, geom);

    // expandable boxes (&, >=1, =1, ADD, MUL) get a "+" to append an input,
    // and a "−" to remove the last input (only when more than 2 inputs exist).
    if (d.expand === 'in') {
      const plusY = geom.h + 8;
      const plus = T.svg('g', { class: 'fbd-add-in', 'data-add-in': boxObj.id });
      plus.appendChild(T.svg('circle', { cx: 8, cy: plusY, r: 7 }));
      plus.appendChild(T.svg('text', { x: 8, y: plusY + 4 }, '+'));
      plus.addEventListener('mousedown', (e) => { e.stopPropagation(); appendInput(net, boxObj); });
      g.appendChild(plus);

      if ((boxObj.inputs || []).length > 2) {
        const minus = T.svg('g', { class: 'fbd-del-in', 'data-del-in': boxObj.id });
        minus.appendChild(T.svg('circle', { cx: 26, cy: plusY, r: 7 }));
        minus.appendChild(T.svg('text', { x: 26, y: plusY + 4 }, '−'));
        minus.addEventListener('mousedown', (e) => { e.stopPropagation(); removeInput(net, boxObj); });
        g.appendChild(minus);
      }
    }

    return g;
  }

  function cmpOp(boxObj) {
    return (boxObj.params && boxObj.params.op) || '==';
  }

  /* ----------------------------------------------------------- one pin */
  function buildPin(g, net, boxObj, pin, idx, isOut, geom) {
    const top = geom.titled ? G.titleH + 10 : 12;
    const py = top + idx * G.pinGap + 6;           // local y
    const edgeX = isOut ? geom.w : 0;              // local x of box edge
    const tipX = isOut ? geom.w + G.stubLen : -G.stubLen;

    // stub line
    g.appendChild(T.svg('line', {
      class: 'fbd-stub', 'data-stub-of': boxObj.id, 'data-stub-pin': pin.id,
      x1: edgeX, y1: py, x2: tipX, y2: py,
    }));

    // inverted bubble (drawn on the stub near the box edge)
    if (!isOut && pin.inverted) {
      g.appendChild(T.svg('circle', {
        class: 'fbd-bubble', 'data-bubble-pin': pin.id,
        cx: edgeX - G.bubbleR, cy: py, r: G.bubbleR,
      }));
    }

    // pin name label inside the box near the stub
    g.appendChild(T.svg('text', {
      class: 'fbd-pin-name',
      x: isOut ? geom.w - 5 : 5, y: py + 3,
      'text-anchor': isOut ? 'end' : 'start',
    }, pin.name));

    // connection dot at the stub tip
    const dot = T.svg('circle', {
      class: 'fbd-pin-dot' + (isOut ? ' out' : '')
        + (pending && pending.boxId === boxObj.id && pending.pinId === pin.id ? ' pending' : ''),
      'data-dot-of': boxObj.id, 'data-dot-pin': pin.id,
      cx: tipX, cy: py, r: 3,
    });
    g.appendChild(dot);

    // generous transparent hit zone around the stub tip for wiring clicks
    const hit = T.svg('rect', {
      class: 'fbd-pin-hit',
      x: tipX - 9, y: py - 9, width: 18, height: 18,
      'data-pin-hit': boxObj.id, 'data-pin-id': pin.id, 'data-pin-out': isOut ? '1' : '0',
    });
    hit.addEventListener('mousedown', (e) => { e.stopPropagation(); onPinClick(net, boxObj, pin, isOut); });
    hit.addEventListener('dblclick', (e) => { e.stopPropagation(); togglePinInverted(boxObj, pin); });
    // dropping a tag on an INPUT pin sets that pin's operand (the parameter value)
    if (!isOut) attachTagDrop(hit, (name) => { pin.operand = name; });
    // right-click an INPUT pin of an expandable box -> "Delete pin"
    if (!isOut) {
      hit.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        openPinMenu(e, net, boxObj, pin);
      });
    }
    g.appendChild(hit);

    // unwired INPUT pin: show its operand as an editable label to the left
    if (!isOut && !isInputWired(net, boxObj.id, pin.id)) {
      addOperandLabel(g, net, boxObj, 'pin-' + pin.id,
        tipX - 6, py + 3, 'end', pin.operand, (v) => { pin.operand = v; });
    }
  }

  // Does any wire terminate on this input pin?
  function isInputWired(net, boxId, pinId) {
    return (net.wires || []).some((w) => w.to.box === boxId && w.to.pin === pinId);
  }

  /* ----------------------------------------------- tag drag-drop onto a target */
  function hasTag(e) { return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'text/tia-tag') >= 0; }
  function getTag(e) { try { return e.dataTransfer.getData('text/tia-tag'); } catch (_) { return ''; } }
  // Make `node` accept a tag dragged from the Tags outline; applyFn(tagName) writes it.
  function attachTagDrop(node, applyFn) {
    node.addEventListener('dragover', (e) => {
      if (!hasTag(e)) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      node.classList.add('fbd-tag-hot');
    });
    node.addEventListener('dragleave', () => node.classList.remove('fbd-tag-hot'));
    node.addEventListener('drop', (e) => {
      if (!hasTag(e)) return;
      e.preventDefault(); e.stopPropagation();
      node.classList.remove('fbd-tag-hot');
      const name = getTag(e);
      if (name) { applyFn(name); markDirty(); render(); }
    });
  }

  /* ---- editable operand / param label inside a box group ---- */
  function addOperandLabel(g, net, boxObj, key, x, y, anchor, value, setter) {
    const empty = (value == null || value === '');
    const t = T.svg('text', {
      class: 'fbd-operand' + (empty ? ' empty' : ''),
      x: x, y: y, 'text-anchor': anchor || 'start',
      'data-operand-of': boxObj.id, 'data-operand-key': key,
    }, empty ? '???' : String(value));
    t.addEventListener('mousedown', (e) => { e.stopPropagation(); });
    t.addEventListener('click', (e) => {
      e.stopPropagation();
      selectBox(net, boxObj, true);   // noRender: keep this text node attached for the inline editor
      openInlineEdit(t, value, (nv) => { setter(nv); markDirty(); renderNet(net); });
    });
    attachTagDrop(t, (name) => { setter(name); });
    g.appendChild(t);
    return t;
  }

  /* ---- titled-box param labels (PT/PV/IN/OUT/instance/CMP inputs...) ---- */
  function buildBoxParams(g, net, boxObj, geom) {
    const k = boxObj.kind;
    boxObj.params = boxObj.params || {};
    const inMap = inputParamMap(k);
    const outMap = outputParamMap(k);
    const top = geom.titled ? G.titleH + 10 : 12;

    // input-side param values (to the left of unwired input pins)
    (boxObj.inputs || []).forEach((pin, i) => {
      const pk = inMap[pin.name];
      if (!pk) return;
      if (isInputWired(net, boxObj.id, pin.id)) return;  // wired => driven by RLO
      const py = top + i * G.pinGap + 6;
      paramLabel(g, net, boxObj, pk, -G.stubLen - 6, py + 3, 'end');
    });

    // output-side param values (to the right of output pins)
    (boxObj.outputs || []).forEach((pin, i) => {
      const pk = outMap[pin.name];
      if (!pk) return;
      const py = top + i * G.pinGap + 6;
      paramLabel(g, net, boxObj, pk, geom.w + G.stubLen + 6, py + 3, 'start');
    });

    // operand shown above the box: timer/counter instance tag, or the SR/RS stored bit
    if (['ton', 'tof', 'tp', 'ctu', 'ctd', 'sr', 'rs'].indexOf(k) >= 0) {
      addOperandLabel(g, net, boxObj, 'box-operand', geom.w / 2, -6, 'middle',
        boxObj.operand, (v) => { boxObj.operand = v; });
    }
  }

  function paramLabel(g, net, boxObj, pkey, x, y, anchor) {
    boxObj.params = boxObj.params || {};
    const val = boxObj.params[pkey];
    const empty = (val == null || val === '');
    const t = T.svg('text', {
      class: 'fbd-operand' + (empty ? ' empty' : ''),
      x: x, y: y, 'text-anchor': anchor || 'start',
      'data-param-of': boxObj.id, 'data-param-key': pkey,
    }, empty ? '...' : String(val));
    t.addEventListener('mousedown', (e) => e.stopPropagation());
    t.addEventListener('click', (e) => {
      e.stopPropagation();
      selectBox(net, boxObj, true);   // noRender: keep this text node attached for the inline editor
      // for the compare box, clicking the operator (title) cycles it; params edit inline
      openInlineEdit(t, val, (nv) => { boxObj.params[pkey] = nv; markDirty(); renderNet(net); });
    });
    attachTagDrop(t, (name) => { boxObj.params[pkey] = name; });
    g.appendChild(t);
  }

  // Map a box pin NAME -> params key it reads (inputs).
  function inputParamMap(kind) {
    switch (kind) {
      case 'compare': return { in1: 'in1', in2: 'in2' };
      case 'ton': case 'tof': case 'tp': return { PT: 'pt' };
      case 'ctu': return { PV: 'pv' };
      case 'ctd': return { PV: 'pv' };
      case 'ctud': return { PV: 'pv' };
      case 'move': return { IN: 'in' };
      case 'add': case 'sub': case 'mul': case 'div': return { in1: 'in1', in2: 'in2' };
      case 'norm_x': case 'scale_x': return { MIN: 'min', VALUE: 'val', MAX: 'max' };
      default: return {};
    }
  }
  // Map a box pin NAME -> params key it writes (outputs).
  function outputParamMap(kind) {
    switch (kind) {
      case 'ton': case 'tof': case 'tp': return { Q: 'q', ET: 'et' };
      case 'ctu': case 'ctd': return { Q: 'q', CV: 'cv' };
      case 'ctud': return { QU: 'qu', QD: 'qd', CV: 'cv' };
      case 'move': return { OUT: 'out' };
      case 'add': case 'sub': case 'mul': case 'div': return { OUT: 'out', ENO: 'eno' };
      case 'norm_x': case 'scale_x': return { OUT: 'out', ENO: 'eno' };
      default: return {};
    }
  }

  /* ======================================================================= *
   *  BOX DRAGGING — move a box, redraw its wires live                       *
   * ======================================================================= */
  function enableBoxDrag(g, net, boxObj) {
    g.addEventListener('mousedown', (e) => {
      // ignore clicks that originate on interactive sub-targets (pins, labels)
      const t = e.target;
      if (t.classList && (t.classList.contains('fbd-pin-hit')
        || t.classList.contains('fbd-operand')
        || t.closest && t.closest('.fbd-add-in'))) return;
      e.stopPropagation();
      e.preventDefault();
      if (pending) cancelPending();
      selectBox(net, boxObj);

      // selectBox re-rendered the card, detaching `g` — continue the drag on
      // the freshly-built node so the box visibly follows the cursor.
      const gd = (rootEl && rootEl.querySelector('.fbd-box[data-box-id="' + cssEsc(boxObj.id) + '"]')) || g;
      const svg = gd.ownerSVGElement;
      const start = clientToSvg(svg, e);
      const ox = boxObj.x, oy = boxObj.y;
      let moved = false;
      gd.classList.add('dragging');

      const onMove = (ev) => {
        const p = clientToSvg(svg, ev);
        let nx = ox + (p.x - start.x);
        let ny = oy + (p.y - start.y);
        nx = Math.max(G.stubLen + 4, Math.round(nx / G.snap) * G.snap);
        ny = Math.max(8, Math.round(ny / G.snap) * G.snap);
        if (nx !== boxObj.x || ny !== boxObj.y) moved = true;
        boxObj.x = nx; boxObj.y = ny;
        gd.setAttribute('transform', 'translate(' + nx + ',' + ny + ')');
        redrawWires(net);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        gd.classList.remove('dragging');
        if (moved) { markDirty(); renderNet(net); }   // re-render to grow the sheet & re-place labels
      };
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    });
  }

  // Convert a mouse event to SVG user coordinates.
  function clientToSvg(svg, e) {
    const r = svg.getBoundingClientRect();
    // viewBox == intrinsic px here (1:1), so subtract the bounding rect origin.
    // The rect is in visual px while user units are layout px — ÷ zoom.
    const z = zoom || 1;
    return { x: (e.clientX - r.left) / z, y: (e.clientY - r.top) / z };
  }

  // Recompute wire paths in place (no rebuild) during a drag.
  function redrawWires(net) {
    if (!rootEl) return;
    const card = rootEl.querySelector('.fbd-net[data-net-id="' + cssEsc(net.id) + '"]');
    if (!card) return;
    (net.wires || []).forEach((wire) => {
      const fromBox = findBoxInNet(net, wire.from.box);
      const toBox = findBoxInNet(net, wire.to.box);
      if (!fromBox || !toBox) return;
      const fp = findPin(fromBox, wire.from.pin);
      const tp = findPin(toBox, wire.to.pin);
      if (!fp || !tp) return;
      const a = pinPoint(fromBox, fp), b = pinPoint(toBox, tp);
      const d = wirePath(a.x, a.y, b.x, b.y);
      const grp = card.querySelector('[data-wire-id="' + cssEsc(wire.id) + '"]');
      if (!grp) return;
      grp.querySelectorAll('path').forEach((p) => p.setAttribute('d', d));
    });
  }

  /* ======================================================================= *
   *  WIRING — click an output pin then an input pin                         *
   * ======================================================================= */
  function onPinClick(net, boxObj, pin, isOut) {
    // double-click toggles inverted (handled separately); here single clicks wire.
    if (!pending) {
      // start a new wire only from an OUTPUT pin
      if (isOut) {
        const pt = pinPoint(boxObj, pin);
        pending = { net, boxId: boxObj.id, pinId: pin.id, x: pt.x, y: pt.y };
        select(null);              // clear box/wire selection
        selectBox(net, boxObj, true); // keep source box highlighted lightly? -> just re-render dot
        render();
        attachPendingTracker(net);
        T.status('Click an input pin to complete the wire (Esc to cancel)', 'info');
      } else {
        T.status('Start wiring from an OUTPUT pin (right side)', 'warn');
      }
      return;
    }

    // we have a pending source; complete only onto an INPUT pin
    if (isOut) {
      // clicking another output just re-targets the source
      const pt = pinPoint(boxObj, pin);
      pending = { net, boxId: boxObj.id, pinId: pin.id, x: pt.x, y: pt.y };
      render(); attachPendingTracker(net);
      return;
    }
    if (pending.net !== net) {
      T.status('Wires cannot cross networks', 'warn');
      cancelPending(); render();
      return;
    }
    if (pending.boxId === boxObj.id) {
      T.status('Cannot wire a box to itself', 'warn');
      return;
    }
    // replace any existing wire feeding this input pin
    net.wires = (net.wires || []).filter((w) => !(w.to.box === boxObj.id && w.to.pin === pin.id));
    net.wires.push(T.model.newWire(pending.boxId, pending.pinId, boxObj.id, pin.id));
    cancelPending();
    markDirty();
    render();
    T.status('Wire created', 'info');
  }

  function togglePinInverted(boxObj, pin) {
    // only input pins have an 'inverted' field
    if (!(boxObj.inputs || []).some((p) => p === pin)) return;
    pin.inverted = !pin.inverted;
    markDirty();
    render();
  }

  function cancelPending() {
    if (!pending) return;
    pending = null;
    if (pendingMoveHandler && pendingSvg) {
      pendingSvg.removeEventListener('mousemove', pendingMoveHandler);
    }
    pendingMoveHandler = null; pendingSvg = null;
  }

  // Rubber-band line from the source pin to the cursor while wiring.
  let pendingMoveHandler = null, pendingSvg = null;
  function attachPendingTracker(net) {
    if (!rootEl || !pending) return;
    const card = rootEl.querySelector('.fbd-net[data-net-id="' + cssEsc(net.id) + '"]');
    if (!card) return;
    const svg = card.querySelector('svg.fbd-svg');
    const line = card.querySelector('[data-pending="1"]');
    if (!svg || !line) return;
    pendingSvg = svg;
    line.style.display = '';
    pendingMoveHandler = (ev) => {
      if (!pending) return;
      const p = clientToSvg(svg, ev);
      line.setAttribute('d', wirePath(pending.x, pending.y, p.x, p.y));
    };
    svg.addEventListener('mousemove', pendingMoveHandler);
  }

  /* ======================================================================= *
   *  SELECTION                                                              *
   * ======================================================================= */
  function select(s) {
    const prev = sel;
    sel = s || null;
    if (!s && prev && prev.net) renderNet(prev.net);   // clear the stale outline
  }

  function selectBox(net, boxObj, noRender) {
    const prevNet = sel && sel.net;
    sel = { type: 'box', box: boxObj, net };
    activeNet = net;
    if (!noRender) {
      if (prevNet && prevNet !== net) renderNet(prevNet);
      renderNet(net);
    }
  }
  function selectWire(net, wire) {
    if (pending) cancelPending();
    const prevNet = sel && sel.net;
    sel = { type: 'wire', wire, net };
    activeNet = net;
    if (prevNet && prevNet !== net) renderNet(prevNet);
    renderNet(net);
  }

  function markActiveCards() {
    if (!rootEl) return;
    T.$$('.fbd-net', rootEl).forEach((c) => {
      const isAct = activeNet && c.dataset.netId === activeNet.id;
      c.classList.toggle('fbd-net-active', !!isAct);
    });
  }

  /* ======================================================================= *
   *  INLINE EDIT INPUT — floats an <input> over a clicked label             *
   * ======================================================================= */
  let editInput = null;
  let editAC = null;       // autocomplete controller for the open editor
  // Null the reference BEFORE detaching so the synchronous `blur` fired while
  // removing a focused node can't re-enter and remove the same node twice.
  function killEditInput() {
    const inp = editInput;
    editInput = null;
    if (editAC) { editAC.destroy(); editAC = null; }
    if (inp && inp.parentNode) { try { inp.parentNode.removeChild(inp); } catch (e) { /* already detached */ } }
  }

  function openInlineEdit(textNode, curVal, commitFn) {
    killEditInput();
    const body = textNode.closest('.fbd-net-body');
    if (!body) return;
    const bodyRect = body.getBoundingClientRect();
    const tr = textNode.getBoundingClientRect();

    const inp = T.el('input', {
      class: 'fbd-edit-input', type: 'text',
      value: (curVal == null ? '' : String(curVal)),
      spellcheck: 'false', autocomplete: 'off',
    });
    // rects are visual px while style.left is layout px inside the zoomed root
    const z = zoom || 1;
    const left = (tr.left - bodyRect.left) / z + body.scrollLeft - 4;
    const top = (tr.top - bodyRect.top) / z + body.scrollTop - 2;
    inp.style.left = Math.max(2, left) + 'px';
    inp.style.top = Math.max(2, top) + 'px';
    inp.style.minWidth = Math.max(56, tr.width / z + 16) + 'px';

    let done = false;
    const commit = () => {
      // bail if already handled, or if an external render already tore down this input
      if (done || editInput !== inp) return;
      done = true;
      const v = inp.value.trim();
      killEditInput();
      commitFn(v);
    };
    inp.addEventListener('mousedown', (e) => e.stopPropagation());

    body.appendChild(inp);
    editInput = inp;

    // Suggestion dropdown (tags + this block's interface variables). Attached BEFORE
    // the commit keydown so its stopImmediatePropagation can pre-empt Enter/arrows.
    editAC = T.attachAutocomplete(inp, {
      items: () => T.operandCandidates(block),
      onPick: (v) => { inp.value = v; commit(); },
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); done = true; killEditInput(); }
      e.stopPropagation();
    });
    inp.addEventListener('blur', commit);
    inp.focus(); inp.select();
  }

  /* header (title/comment) inline edit */
  function editHeaderText(spanEl, net, field) {
    const cur = net[field] || '';
    const inp = T.el('input', {
      class: 'tia-input', type: 'text', value: cur,
      style: { width: '60%', font: 'inherit' },
    });
    // `done` guards double-commit (Enter → render → detach-blur → finish again)
    // and makes Escape actually CANCEL (the detach-blur would otherwise commit).
    let done = false;
    const finish = () => { if (done) return; done = true; net[field] = inp.value.trim(); markDirty(); renderNet(net); };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(); }
      else if (e.key === 'Escape') { e.preventDefault(); done = true; renderNet(net); }
      e.stopPropagation();
    });
    inp.addEventListener('blur', finish);
    spanEl.replaceWith(inp);
    inp.focus(); inp.select();
  }

  /* ======================================================================= *
   *  CONTEXT MENU                                                            *
   * ======================================================================= */
  let menuEl = null;
  function closeMenu() {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl);
    menuEl = null;
    document.removeEventListener('mousedown', onMenuDocDown, true);
  }
  function onMenuDocDown(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }

  function openWireMenu(evt, net, wire) {
    closeMenu();
    showMenu(evt.clientX, evt.clientY, [
      ['Delete wire', () => { selectWire(net, wire); deleteSelection(); }],
      '-',
      ['Insert network below', () => insertNetworkBelow(net)],
      ['Delete network', () => deleteNetwork(net)],
    ]);
  }

  // Right-click on an input pin: offer "Delete pin" for expandable boxes
  // (kept enabled only while at least 2 inputs would remain).
  function openPinMenu(evt, net, boxObj, pin) {
    closeMenu();
    const d = def(boxObj.kind);
    const canDelete = d.expand === 'in' && (boxObj.inputs || []).length > 2;
    if (!canDelete) return;   // nothing to offer for fixed-arity boxes
    showMenu(evt.clientX, evt.clientY, [
      ['Delete pin', () => removePin(net, boxObj, pin)],
    ]);
  }

  function showMenu(x, y, items) {
    const m = T.el('div', { class: 'fbd-menu', style: { left: x + 'px', top: y + 'px' } });
    items.forEach((it) => {
      if (it === '-') { m.appendChild(T.el('div', { class: 'fbd-menu-sep' })); return; }
      const [label, fn] = it;
      m.appendChild(T.el('div', {
        class: 'fbd-menu-item', onclick: () => { closeMenu(); fn(); },
      }, label));
    });
    document.body.appendChild(m);
    menuEl = m;
    const r = m.getBoundingClientRect();
    if (r.right > window.innerWidth) m.style.left = (window.innerWidth - r.width - 6) + 'px';
    if (r.bottom > window.innerHeight) m.style.top = (window.innerHeight - r.height - 6) + 'px';
    setTimeout(() => document.addEventListener('mousedown', onMenuDocDown, true), 0);
  }

  /* ======================================================================= *
   *  DRAG-DROP an instruction onto the sheet                                *
   * ======================================================================= */
  function enableDrop(card, body, net) {
    const over = (e) => {
      if (!hasKind(e) && !hasBlock(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      card.classList.add('fbd-drop-hot');
    };
    body.addEventListener('dragover', over);
    body.addEventListener('dragenter', over);
    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget)) card.classList.remove('fbd-drop-hot');
    });
    body.addEventListener('drop', (e) => {
      card.classList.remove('fbd-drop-hot');

      // figure out the drop point in sheet coordinates (shared by both paths)
      const svg = body.querySelector('svg.fbd-svg');
      let x = 60, y = 50;
      if (svg) { const p = clientToSvg(svg, e); x = Math.max(20, p.x - 30); y = Math.max(12, p.y - 20); }
      const sx = Math.round(x / G.snap) * G.snap, sy = Math.round(y / G.snap) * G.snap;

      // A block dragged from the project tree -> insert a call box.
      if (hasBlock(e)) {
        e.preventDefault();
        activeNet = net;
        dropBlockCall(net, getBlockId(e), sx, sy);
        return;
      }

      const kind = getKind(e);
      if (!kind || !T.catalog[kind] || T.catalog[kind].fbd === false) return;
      e.preventDefault();
      activeNet = net;
      insertAt(kind, net, sx, sy);
    });
  }
  function hasKind(e) {
    return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'text/tia-kind') >= 0;
  }
  function getKind(e) { try { return e.dataTransfer.getData('text/tia-kind'); } catch (_) { return ''; } }
  function hasBlock(e) {
    return e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'text/tia-block') >= 0;
  }
  function getBlockId(e) { try { return e.dataTransfer.getData('text/tia-block'); } catch (_) { return ''; } }

  // Insert a call box for a dropped block at (x,y). Refuses self-calls.
  function dropBlockCall(net, blockId, x, y) {
    if (!net || !blockId) return;
    if (block && blockId === block.id) {
      T.status('A block cannot call itself', 'warn');
      return;
    }
    const tb = T.findBlock(blockId);
    if (!tb) { T.status('Dropped block not found', 'warn'); return; }
    if (tb.type === 'DB') { T.status('Data blocks are not callable', 'warn'); return; }
    T.ensureInterface(tb);
    const boxObj = T.model.newBox('call', x, y);
    boxObj.params = boxObj.params || {};
    boxObj.params.target = blockId;
    // Pins follow the target's interface: EN + inputs (left), ENO + outputs (right).
    // FBD args are simply each member pin's operand or wired source.
    boxObj.inputs = [{ id: T.uid('pin'), name: 'EN', inverted: false, operand: '' }]
      .concat(T.ifaceCallInputs(tb).map((m) => ({ id: T.uid('pin'), name: m.name, inverted: false, operand: '' })));
    boxObj.outputs = [{ id: T.uid('pin'), name: 'ENO' }]
      .concat(T.ifaceCallOutputs(tb).map((m) => ({ id: T.uid('pin'), name: m.name })));
    // A function block needs an instance data block.
    if (tb.type === 'FB') {
      const db = T.model.newInstanceDB(tb);
      T.project.blocks.push(db);
      boxObj.params.instanceDb = db.id;
      T.status('Created instance "' + db.name + '" for ' + tb.name, 'ok');
    }
    net.boxes = net.boxes || [];
    net.boxes.push(boxObj);
    selectBox(net, boxObj);
    markDirty();
    T.bus.emit('tree:changed');
    render();
  }

  /* ======================================================================= *
   *  EDITING OPERATIONS                                                      *
   * ======================================================================= */

  // Place a new box of `kind` near the visible centre of the active network.
  function insert(kind) {
    if (!block) return;
    const d = def(kind);
    if (!d || d.fbd === false) { T.status('Instruction not available in FBD', 'warn'); return; }
    const net = activeNet || block.networks[0];
    if (!net) return;

    // visible centre of this network's sheet (account for scroll)
    let x = 80, y = 60;
    if (rootEl) {
      const card = rootEl.querySelector('.fbd-net[data-net-id="' + cssEsc(net.id) + '"]');
      const bodyEl = card && card.querySelector('.fbd-net-body');
      if (bodyEl) {
        x = bodyEl.scrollLeft + Math.min(bodyEl.clientWidth, 260) / 2;
        y = bodyEl.scrollTop + Math.min(bodyEl.clientHeight, 200) / 2;
      }
    }
    // offset by existing box count so new boxes do not stack exactly
    const n = (net.boxes || []).length;
    x += (n % 4) * 18;
    y += (n % 4) * 14;
    insertAt(kind, net, Math.round(x / G.snap) * G.snap, Math.round(y / G.snap) * G.snap);
  }

  function insertAt(kind, net, x, y) {
    const boxObj = T.model.newBox(kind, x, y);
    net.boxes = net.boxes || [];
    net.boxes.push(boxObj);
    selectBox(net, boxObj);
    markDirty();
    render();
    // for operand-bearing boxes, focus the operand/param for immediate entry
    focusNewOperand(boxObj);
  }

  // After insert, open the first operand/param label so the user can type.
  function focusNewOperand(boxObj) {
    if (!rootEl) return;
    const g = rootEl.querySelector('[data-box-id="' + cssEsc(boxObj.id) + '"]');
    if (!g) return;
    let label = g.querySelector('[data-operand-of]');
    if (!label) label = g.querySelector('[data-param-of]');
    if (label) {
      // trigger its click handler to open inline edit
      const ev = new MouseEvent('click', { bubbles: true, cancelable: true });
      label.dispatchEvent(ev);
    }
  }

  // Append an extra input pin to an expandable box (&, >=1, =1, ADD, MUL).
  function appendInput(net, boxObj) {
    const d = def(boxObj.kind);
    if (d.expand !== 'in') return;
    // name new pin in sequence: in1, in2, in3 ...  (or generic 'in' for NOT-like)
    const n = (boxObj.inputs || []).length + 1;
    boxObj.inputs.push({ id: T.uid('pin'), name: 'in' + n, inverted: false, operand: '' });
    markDirty();
    render();
  }

  // Remove the LAST input pin (and any wire on it) from an expandable box.
  // Keeps at least 2 inputs.
  function removeInput(net, boxObj) {
    const d = def(boxObj.kind);
    if (d.expand !== 'in') return;
    if ((boxObj.inputs || []).length <= 2) return;
    const pin = boxObj.inputs[boxObj.inputs.length - 1];
    removePin(net, boxObj, pin);
  }

  // Remove a specific input pin and any wire connected to it. Only allowed on
  // expandable boxes, and only while at least 2 inputs would remain.
  function removePin(net, boxObj, pin) {
    const d = def(boxObj.kind);
    if (d.expand !== 'in') return;
    const idx = (boxObj.inputs || []).indexOf(pin);
    if (idx < 0) return;
    if (boxObj.inputs.length <= 2) { T.status('Box needs at least 2 inputs', 'warn'); return; }
    boxObj.inputs.splice(idx, 1);
    // drop any wire terminating on this pin
    net.wires = (net.wires || []).filter((w) => !(w.to.box === boxObj.id && w.to.pin === pin.id));
    markDirty();
    render();
  }

  // Open the block referenced by a call box (guard if missing) — decision #3.
  function openCalledBlock(boxObj) {
    const tb = boxObj && boxObj.params && T.findBlock(boxObj.params.target);
    if (!tb) { T.status('Call target block not found', 'warn'); return; }
    T.setActiveBlock(tb.id);
    T.bus.emit('open:block', tb);
  }

  // deleteSelection(): remove the selected box (and touching wires) or wire.
  function deleteSelection() {
    if (!sel) { T.status('Nothing selected to delete', 'warn'); return; }
    if (sel.type === 'box') {
      const net = sel.net;
      const i = (net.boxes || []).indexOf(sel.box);
      if (i >= 0) net.boxes.splice(i, 1);
      // drop every wire touching the deleted box
      net.wires = (net.wires || []).filter(
        (w) => w.from.box !== sel.box.id && w.to.box !== sel.box.id);
    } else if (sel.type === 'wire') {
      const net = sel.net;
      const i = (net.wires || []).indexOf(sel.wire);
      if (i >= 0) net.wires.splice(i, 1);
    }
    sel = null;
    markDirty();
    render();
  }

  function insertNetworkBelow(net) {
    const i = block.networks.indexOf(net);
    const nn = T.model.newNetwork();
    block.networks.splice(i + 1, 0, nn);
    activeNet = nn; sel = null;
    markDirty();
    render();
    scrollToNet(nn);
  }

  function deleteNetwork(net) {
    const i = block.networks.indexOf(net);
    if (i < 0) return;
    block.networks.splice(i, 1);
    if (activeNet === net) activeNet = block.networks[Math.max(0, i - 1)] || null;
    if (sel && sel.net === net) sel = null;
    markDirty();
    render();
  }

  function addNetwork() {
    if (!block) return;
    const nn = T.model.newNetwork();
    block.networks.push(nn);
    activeNet = nn; sel = null;
    markDirty();
    render();
    scrollToNet(nn);
  }

  function scrollToNet(net) {
    if (!rootEl) return;
    const card = rootEl.querySelector('.fbd-net[data-net-id="' + cssEsc(net.id) + '"]');
    if (card && card.scrollIntoView) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /* ======================================================================= *
   *  KEYBOARD                                                               *
   * ======================================================================= */
  function onKeyDown(e) {
    if (T.activeEditor !== api) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo(); else undo();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'y') {
      e.preventDefault(); redo(); return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key.toLowerCase() === 'c' || e.key.toLowerCase() === 'x')) {
      if (sel && sel.type === 'box') {
        e.preventDefault();
        clipBox = JSON.parse(JSON.stringify(sel.box, T.stripRuntime));
        if (e.key.toLowerCase() === 'x') deleteSelection();
        T.status((e.key.toLowerCase() === 'x' ? 'Cut ' : 'Copied ') + boxLabel(clipBox.kind), 'info');
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v') {
      if (clipBox) { e.preventDefault(); pasteBox(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) { e.preventDefault(); setZoom(zoom + 0.1); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); setZoom(zoom - 0.1); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); setZoom(1); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (sel) { e.preventDefault(); deleteSelection(); }
    } else if (e.key === 'Escape') {
      closeMenu(); killEditInput();
      if (pending) { cancelPending(); render(); }
      else if (sel) { select(null); }
    }
  }

  // Paste the copied box: clone with fresh box/pin ids at a small offset.
  // Wires are not cloned (they reference pins that stay with the original).
  function pasteBox() {
    if (!clipBox || !block) return;
    const net = activeNet || block.networks[0];
    if (!net) return;
    const b = JSON.parse(JSON.stringify(clipBox));
    b.id = T.uid('box');
    (b.inputs || []).forEach((p) => { p.id = T.uid('pin'); });
    (b.outputs || []).forEach((p) => { p.id = T.uid('pin'); });
    b.x = (b.x || 40) + 24;
    b.y = (b.y || 40) + 24;
    clipBox.x = b.x; clipBox.y = b.y;      // successive pastes cascade
    (net.boxes = net.boxes || []).push(b);
    sel = { type: 'box', box: b, net };
    activeNet = net;
    markDirty();
    renderNet(net);
    T.status('Pasted ' + boxLabel(b.kind), 'info');
  }

  /* ======================================================================= *
   *  SIMULATION HIGHLIGHT  (cheap — query existing nodes, no rebuild)       *
   *  Simulator sets pin._val (true) and box._live (true).                   *
   * ======================================================================= */
  function highlight() {
    if (!rootEl || !block) return;
    block.networks.forEach((net) => {
      const card = rootEl.querySelector('.fbd-net[data-net-id="' + cssEsc(net.id) + '"]');
      if (!card) return;

      // box live state. Energized => green (-live). De-energized while the sim
      // runs => solid blue (-low). Stopped => neither (normal black).
      (net.boxes || []).forEach((b) => {
        const on = !!b._live;
        const g = card.querySelector('[data-box-id="' + cssEsc(b.id) + '"]');
        if (g) setFlow(g, on);

        // pin dots / stubs / the assigned operand label follow their pin._val
        (b.inputs || []).concat(b.outputs || []).forEach((pin) => {
          const pon = !!pin._val;
          const dot = card.querySelector('[data-dot-pin="' + cssEsc(pin.id) + '"]');
          if (dot) setFlow(dot, pon);
          const stub = card.querySelector('[data-stub-pin="' + cssEsc(pin.id) + '"]');
          if (stub) setFlow(stub, pon);
          const opLabel = card.querySelector('[data-operand-of="' + cssEsc(b.id) + '"][data-operand-key="pin-' + cssEsc(pin.id) + '"]');
          if (opLabel) setFlow(opLabel, pon);
        });
        // the assignment box's written tag (box-operand) follows the box value
        const boxOp = card.querySelector('[data-operand-of="' + cssEsc(b.id) + '"][data-operand-key="box-operand"]');
        if (boxOp) setFlow(boxOp, on);
      });

      // wire live state: a wire is energized if its SOURCE output pin is true.
      (net.wires || []).forEach((wire) => {
        const fromBox = findBoxInNet(net, wire.from.box);
        const fromPin = fromBox && findPin(fromBox, wire.from.pin);
        const on = !!(fromPin && fromPin._val);
        const line = card.querySelector('[data-wire-line="' + cssEsc(wire.id) + '"]');
        if (line) setFlow(line, on);
      });
    });
  }

  // Apply the energized/de-energized flow classes to one node (Feature 4):
  //   on  -> green (.fbd-live)
  //   off -> while the sim runs, blue (.fbd-low); when stopped, neither.
  function setFlow(node, on) {
    node.classList.toggle('fbd-live', on);
    node.classList.toggle('fbd-low', simRunning && !on);
  }

  function clearHighlight() {
    if (!rootEl) return;
    T.$$('.fbd-live', rootEl).forEach((n) => n.classList.remove('fbd-live'));
    T.$$('.fbd-low', rootEl).forEach((n) => n.classList.remove('fbd-low'));
  }

  /* ======================================================================= *
   *  PUBLIC API                                                             *
   * ======================================================================= */
  let api = null;

  function open(hostEl, blk) {
    host = hostEl;
    block = blk;
    sel = null;
    pending = null;
    activeNet = (blk && blk.networks && blk.networks[0]) || null;
    if (histBlk !== blk) { undoStack = []; redoStack = []; histBlk = blk; }
    lastSnap = snapNow();
    render();

    // Ctrl+scroll zooms the sheet (host is recreated per tab activation)
    host.addEventListener('wheel', (e) => {
      if (!e.ctrlKey || T.activeEditor !== api) return;
      e.preventDefault();
      setZoom(zoom + (e.deltaY < 0 ? 0.1 : -0.1));
    }, { passive: false });

    api = {
      lang: 'FBD',
      block: blk,
      insert: insert,
      deleteSelection: deleteSelection,
      addNetwork: addNetwork,
      refresh: render,
      highlight: highlight,
    };
    T.activeEditor = api;
    return api;
  }

  T.editors = T.editors || {};
  T.editors.fbd = { open: open };

  /* ----------------------------------------------------------- bus wiring */
  T.bus.on('sim:tick', () => {
    if (T.activeEditor === api) { try { highlight(); } catch (_) {} }
  });
  T.bus.on('sim:state', (s) => {
    simRunning = !!(s && s.running);   // drives Feature 4 de-energized coloring
    if (!simRunning) { if (T.activeEditor === api) clearHighlight(); }
  });

  document.addEventListener('keydown', onKeyDown);
  window.addEventListener('resize', () => { closeMenu(); killEditInput(); });
})(window.TIA);
