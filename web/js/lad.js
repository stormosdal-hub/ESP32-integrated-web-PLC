/* ===========================================================================
 * TIA-like Browser PLC IDE  —  lad.js
 * THE LADDER (LAD) EDITOR — the centerpiece. Renders each network of a block
 * as an SVG ladder diagram (left/right power rails, series stages, parallel
 * OR-branches, an output area with coils/boxes) and lets the user edit the
 * model directly: insert/delete elements, open parallel branches, add networks,
 * type operands inline, drag-drop instructions, and watch live power flow turn
 * green during simulation.
 *
 * Public API:
 *   T.editors.lad = { open(hostEl, block) }
 *   open() also sets:
 *   T.activeEditor = { lang:'LAD', block, insert(kind), deleteSelection(),
 *                      addNetwork(), refresh(), highlight() }
 *
 * Bus events:
 *   listens : 'sim:tick'  -> highlight()       (cheap, no rebuild)
 *             'sim:state' -> clear highlight when sim stops
 *   emits   : 'tree:changed' (so autosave/properties pick up edits)
 *
 * Uses ONLY window.TIA.* helpers. IIFE, no globals beyond T.editors.lad.
 * =========================================================================*/
(function (T) {
  'use strict';

  /* ======================================================================= *
   *  GEOMETRY CONSTANTS — a fixed grid keeps the ladder crisp & predictable. *
   * ======================================================================= */
  const G = {
    railL: 26,          // x of left power rail
    cellW: 96,          // horizontal slot width for one inline element
    cellH: 48,          // vertical slot height for one branch row
    midOffset: 24,      // vertical centre within a branch row
    symHalf: 18,        // half-width of a contact/coil symbol
    boxW: 92,           // condition-area box width (compare)
    outBoxW: 132,       // output-area box width (timers/counters/move/math)
    outColW: 160,       // horizontal room reserved for an output symbol
    topPad: 14,         // padding above first rung inside the SVG
    botPad: 16,         // padding below last rung
    railGap: 60,        // min gap from condition area to output rail
  };

  /* ======================================================================= *
   *  COMPONENT CSS                                                           *
   * ======================================================================= */
  T.injectCSS('tia-lad-css', `
    .lad-root { padding: 6px 8px 40px; min-width: max-content; }

    /* ---- network card ---- */
    .lad-net { background: var(--tia-canvas); border: 1px solid var(--tia-border);
      margin: 0 0 12px; box-shadow: 0 1px 0 rgba(0,0,0,.04); }
    .lad-net.lad-net-active { border-color: var(--tia-petrol); }

    .lad-net-head { display: flex; align-items: center; gap: 8px;
      background: var(--tia-net-head); border-bottom: 1px solid var(--tia-border-soft);
      padding: 3px 8px; }
    .lad-net-no { font-weight: 700; color: var(--tia-petrol-dark);
      white-space: nowrap; }
    .lad-net-title { flex: 1 1 auto; color: var(--tia-text); cursor: text;
      min-width: 40px; padding: 1px 3px; border-radius: 2px; }
    .lad-net-title:hover { background: #fff; outline: 1px dashed var(--tia-border); }
    .lad-net-title.empty { color: var(--tia-text-soft); font-style: italic; }
    .lad-net-tools { display: flex; gap: 2px; }
    .lad-net-tool { display: inline-flex; align-items: center; justify-content: center;
      width: 22px; height: 20px; border: 1px solid transparent; border-radius: 3px;
      cursor: pointer; color: var(--tia-text-soft); }
    .lad-net-tool:hover { background: var(--tia-hover); border-color: var(--tia-petrol);
      color: var(--tia-petrol-dark); }
    .lad-net-tool svg { width: 14px; height: 14px; }

    .lad-net-comment { padding: 1px 8px 3px 8px; color: var(--tia-text-soft);
      font-size: 11.5px; cursor: text; }
    .lad-net-comment:hover { background: #fafbfb; outline: 1px dashed var(--tia-border-soft); }
    .lad-net-comment.empty { font-style: italic; opacity: .8; }

    .lad-net-body { overflow-x: auto; padding: 2px 0 2px 0; position: relative; }
    .lad-net.lad-drop-hot .lad-net-body { background: var(--tia-live-bg);
      outline: 2px dashed var(--tia-petrol); outline-offset: -3px; }
    /* tag drag-over highlight on a drop target (operand label / symbol hit) */
    text.lad-tag-hot { fill: var(--tia-petrol) !important; font-weight: 700; }
    rect.lad-tag-hot { fill: rgba(0,153,153,.20); stroke: var(--tia-petrol); stroke-width: 1; }

    .lad-empty-hint { padding: 18px 16px; color: var(--tia-text-soft);
      font-style: italic; text-align: center; }

    /* ---- SVG element styling ---- */
    .lad-svg { display: block; font-family: var(--tia-font); }
    .lad-rail { stroke: var(--tia-rail); stroke-width: 2.5; }
    .lad-wire { stroke: var(--tia-wire); stroke-width: 1.6; fill: none; }
    .lad-sym  { stroke: var(--tia-wire); stroke-width: 1.8; fill: none;
      stroke-linecap: round; }
    .lad-box  { stroke: var(--tia-wire); stroke-width: 1.4; fill: #fdfefe; }
    .lad-box-title { fill: var(--tia-petrol-deep); font-weight: 700; font-size: 11px; }
    .lad-pin-label { fill: var(--tia-text-soft); font-size: 9.5px; }
    .lad-pin-val   { fill: var(--tia-text); font-size: 10px; font-family: var(--tia-mono); }
    .lad-operand   { fill: var(--tia-text); font-size: 10.5px; font-family: var(--tia-mono);
      text-anchor: middle; }
    .lad-operand.empty { fill: var(--tia-text-soft); font-style: italic; }
    .lad-sym-letter { fill: var(--tia-wire); font-size: 11px; font-weight: 700;
      text-anchor: middle; font-family: var(--tia-mono); }

    /* clickable hit areas */
    .lad-el { cursor: pointer; }
    .lad-hit { fill: transparent; stroke: none; }
    .lad-operand-hit { cursor: text; }

    /* selection */
    .lad-sel-box { fill: rgba(0,153,153,.10); stroke: var(--tia-petrol);
      stroke-width: 1.4; stroke-dasharray: 3 2; rx: 3; }

    /* live (energized) flow — toggled by highlight() without rebuilding SVG */
    .lad-live.lad-wire, .lad-live .lad-wire { stroke: var(--tia-live); stroke-width: 2.4; }
    .lad-live.lad-rail  { stroke: var(--tia-live); stroke-width: 3; }
    .lad-el.lad-live .lad-sym { stroke: var(--tia-live); }
    .lad-el.lad-live .lad-box { stroke: var(--tia-live); }
    .lad-el.lad-live .lad-sym-letter { fill: var(--tia-live); }
    .lad-seg.lad-live { stroke: var(--tia-live); stroke-width: 2.4; }

    /* low (de-energized while sim runs) flow — dashed blue wires/segments,
       solid blue rails/symbols/boxes. Mirrors the .lad-live rules above. */
    .lad-low.lad-wire, .lad-low .lad-wire { stroke: var(--tia-low); stroke-dasharray: 5 3; }
    .lad-low.lad-rail  { stroke: var(--tia-low); }
    .lad-el.lad-low .lad-sym { stroke: var(--tia-low); }
    .lad-el.lad-low .lad-box { stroke: var(--tia-low); }
    .lad-el.lad-low .lad-sym-letter { fill: var(--tia-low); }
    .lad-el.lad-low .lad-box-title { fill: var(--tia-low); }
    .lad-seg.lad-low { stroke: var(--tia-low); stroke-dasharray: 5 3; }

    /* ---- call box (a block call dropped onto the network) ---- */
    .lad-call-box { stroke: var(--tia-wire); stroke-width: 1.4; fill: #f4fbfb; }
    .lad-el.lad-live .lad-call-box { stroke: var(--tia-live); }
    .lad-el.lad-low  .lad-call-box { stroke: var(--tia-low); }
    .lad-call-title { fill: var(--tia-petrol-deep); font-weight: 700; font-size: 12px;
      text-anchor: middle; }
    .lad-call-sub   { fill: var(--tia-text-soft); font-size: 9.5px; font-family: var(--tia-mono); }
    .lad-call-inst  { fill: var(--tia-text-soft); font-size: 10px; font-style: italic;
      font-family: var(--tia-mono); text-anchor: middle; }
    .lad-call-box-g { cursor: pointer; }

    /* inline edit input floating over the SVG */
    .lad-edit-input { position: absolute; z-index: 50; font-family: var(--tia-mono);
      font-size: 11px; padding: 1px 3px; border: 1px solid var(--tia-petrol);
      border-radius: 2px; background: #fff; color: var(--tia-text);
      box-shadow: 0 0 0 2px rgba(0,153,153,.20); }

    /* context menu */
    .lad-menu { position: absolute; z-index: 9000; background: #fff;
      border: 1px solid var(--tia-border); box-shadow: 0 4px 14px rgba(0,0,0,.18);
      min-width: 184px; padding: 3px 0; border-radius: 3px; font-size: 12.5px; }
    .lad-menu-item { padding: 5px 14px; cursor: pointer; color: var(--tia-text);
      white-space: nowrap; }
    .lad-menu-item:hover { background: var(--tia-hover); }
    .lad-menu-item.disabled { color: var(--tia-text-soft); cursor: default; }
    .lad-menu-item.disabled:hover { background: transparent; }
    .lad-menu-sep { height: 1px; background: var(--tia-border-soft); margin: 3px 0; }
  `);

  /* ======================================================================= *
   *  EDITOR STATE                                                            *
   * ======================================================================= */
  let host = null;          // #tia-editor host element
  let block = null;         // current block
  let rootEl = null;        // .lad-root container inside host
  let selEl = null;         // selected Element (model object) or null
  let selBranch = null;     // selected EMPTY parallel branch (insert target) or null
  let activeNet = null;     // network containing the selection (else first)
  let simRunning = false;   // true while the simulator runs (Feature 4 coloring)
  let clipEl = null;        // copy/paste buffer (one serialized element)
  let insertBefore = false; // one-shot: next inline insert goes BEFORE the selection
  let zoom = 1;             // editor zoom factor (CSS zoom on the root)

  /* ======================================================================= *
   *  SMALL HELPERS                                                           *
   * ======================================================================= */
  const def = (kind) => T.catalog[kind] || {};
  const isInline = (kind) => def(kind).area === 'inline';
  const isBox = (kind) => !!def(kind).box;

  // Walk the whole block to locate an element's stage/branch (condition area)
  // or output array. Returns a "location" descriptor or null.
  function locate(el) {
    if (!block || !el) return null;
    for (const net of block.networks) {
      for (const stage of (net.stages || [])) {
        for (const br of stage.branches) {
          const i = br.elements.indexOf(el);
          if (i >= 0) return { net, stage, branch: br, list: br.elements, index: i, area: 'inline' };
        }
      }
      const oi = (net.outputs || []).indexOf(el);
      if (oi >= 0) return { net, list: net.outputs, index: oi, area: 'output' };
    }
    return null;
  }

  // Locate a branch's stage/network (empty-branch selection & insertion).
  function locateBranch(br) {
    if (!block || !br) return null;
    for (const net of block.networks) {
      for (const stage of (net.stages || [])) {
        if (stage.branches.indexOf(br) >= 0) return { net, stage };
      }
    }
    return null;
  }
  function findBranchById(id) {
    if (!block) return null;
    for (const net of block.networks) {
      for (const stg of (net.stages || [])) {
        const f = stg.branches.find((b) => b.id === id);
        if (f) return f;
      }
    }
    return null;
  }

  // The network we should act on for inserts: the one holding the selection,
  // else the previously-active one, else the first network.
  function getActiveNet() {
    const loc = selEl && locate(selEl);
    if (loc) { activeNet = loc.net; return loc.net; }
    if (activeNet && block.networks.indexOf(activeNet) >= 0) return activeNet;
    activeNet = block.networks[0] || null;
    return activeNet;
  }

  /* ---------------------------------------------------------- undo / redo */
  // Every mutation path calls markDirty() AFTER the change, so we keep the
  // last-known serialized state and push it when the model actually changed.
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
  // Restore a snapshot INTO the same block object (its identity is shared with
  // T.project.blocks and the open tab, so it must not be replaced).
  function applySnap(s) {
    const restored = JSON.parse(s);
    Object.keys(block).forEach((k) => { delete block[k]; });
    Object.assign(block, restored);
    lastSnap = snapNow();
    selEl = null; selBranch = null; activeNet = null;
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

  /* ======================================================================= *
   *  RENDER — full re-render of the block into the host                     *
   * ======================================================================= */
  function render() {
    if (!host) return;
    killEditInput(true);
    closeMenu();
    T.clear(host);
    rootEl = T.el('div', { class: 'lad-root' });

    if (!block || !block.networks || !block.networks.length) {
      rootEl.appendChild(T.el('div', { class: 'tia-empty' },
        'This block has no networks. Use “Insert network” to add one.'));
      host.appendChild(rootEl);
      return;
    }

    // Make sure activeNet is still valid (it may have been deleted).
    if (activeNet && block.networks.indexOf(activeNet) < 0) activeNet = null;
    if (selEl && !locate(selEl)) selEl = null;
    if (selBranch && (!locateBranch(selBranch) || selBranch.elements.length)) selBranch = null;
    getActiveNet();

    block.networks.forEach((net, i) => rootEl.appendChild(renderNetwork(net, i + 1)));
    host.appendChild(rootEl);
    applyZoom();
  }

  /* ---- zoom (CSS zoom on the root; Ctrl+wheel / Ctrl +/-/0) ---- */
  function applyZoom() { if (rootEl) rootEl.style.zoom = zoom; }
  function setZoom(z) {
    zoom = Math.min(2, Math.max(0.4, Math.round(z * 10) / 10));
    applyZoom();
    T.status('Zoom ' + Math.round(zoom * 100) + '%', 'info');
  }

  // Re-render only one network's card — a full render() rebuilds every SVG in
  // the block, which is the root cause of click latency on large blocks.
  function renderNet(net) {
    if (!rootEl || !block) return render();
    const idx = block.networks.indexOf(net);
    const old = rootEl.querySelector('.lad-net[data-net-id="' + cssEsc(net.id) + '"]');
    if (idx < 0 || !old) return render();
    killEditInput(true);
    closeMenu();
    old.replaceWith(renderNetwork(net, idx + 1));
    markActiveCards();
    if (simRunning) { try { highlight(); } catch (e) { /* no-op */ } }
  }

  /* ----------------------------------------------------------- one network */
  function renderNetwork(net, no) {
    const isActive = net === activeNet;
    const card = T.el('div', {
      class: 'lad-net' + (isActive ? ' lad-net-active' : ''),
      dataset: { netId: net.id },
    });

    /* --- header: number + editable title + tools --- */
    const titleSpan = T.el('div', {
      class: 'lad-net-title' + (net.title ? '' : ' empty'),
      title: 'Click to edit network title',
      onclick: () => editHeaderText(titleSpan, net, 'title'),
    }, net.title || '<title>');

    const tools = T.el('div', { class: 'lad-net-tools' },
      toolBtn(T.icons.network, 'Open parallel branch', () => openParallelBranch(net)),
      toolBtn(T.icons.add, 'Insert network below', () => insertNetworkBelow(net)),
      toolBtn(T.icons.trash, 'Delete network', () => deleteNetwork(net)));

    const head = T.el('div', { class: 'lad-net-head' },
      T.el('span', { class: 'lad-net-no' }, 'Network ' + no + ':'),
      titleSpan, tools);

    /* --- comment line --- */
    const commentEl = T.el('div', {
      class: 'lad-net-comment' + (net.comment ? '' : ' empty'),
      title: 'Click to edit comment',
      onclick: () => editHeaderText(commentEl, net, 'comment'),
    }, net.comment || 'Comment');

    /* --- body holds the SVG (and floating edit inputs) --- */
    const body = T.el('div', { class: 'lad-net-body' });
    body.appendChild(buildNetworkSVG(net));

    // Drag-drop an instruction onto the network.
    enableDrop(card, body, net);

    // Clicking empty body space clears selection (but keeps active net).
    body.addEventListener('mousedown', (e) => {
      if (e.target === body || e.target.classList.contains('lad-svg')) {
        select(null); activeNet = net; markActiveCards();
      }
    });

    card.appendChild(head);
    card.appendChild(commentEl);
    card.appendChild(body);
    return card;
  }

  function toolBtn(svgHtml, title, onclick) {
    return T.el('div', { class: 'lad-net-tool', title, onclick: (e) => { e.stopPropagation(); onclick(); } },
      T.el('span', { html: svgHtml }));
  }

  /* ======================================================================= *
   *  SVG BUILD — lay out one network as a ladder diagram                     *
   * ======================================================================= */
  function buildNetworkSVG(net) {
    const stages = net.stages || [];
    const outputs = net.outputs || [];

    /* ---- 1. measure the condition area ---- */
    // Each stage occupies one column-group of width = (max elements in any
    // branch) * cellW.  Total rung rows = max branch count across stages, but
    // each stage stacks its own branches independently for its own height.
    let condX = G.railL;
    const stageLayout = stages.map((stage) => {
      const branches = stage.branches.length ? stage.branches : [{ id: '_', elements: [] }];
      const maxEls = Math.max(1, ...branches.map((b) => b.elements.length));
      const w = maxEls * G.cellW;
      const lay = { stage, branches, x: condX, w, maxEls, rows: branches.length };
      condX += w;
      return lay;
    });

    // Vertical rows: the rung baseline is row 0; extra branches stack downward.
    const maxBranchRows = Math.max(1, ...stageLayout.map((s) => s.rows), 1);
    const condRowsH = maxBranchRows * G.cellH;

    // Output area height: each output gets a slot sized to its kind (call boxes
    // with interface pins are taller than a single coil row).
    const outH = outputs.length
      ? outputs.reduce((a, el) => a + outputSlotH(el), 0)
      : G.cellH;

    const contentH = Math.max(condRowsH, outH);
    const svgH = G.topPad + contentH + G.botPad;

    // x positions
    const condEndX = Math.max(condX, G.railL + G.cellW); // at least one cell wide
    const outStartX = condEndX + G.railGap;
    // Output boxes (timers/counters/move/math) draw their out-pin tag labels (Q, ET, CV,
    // OUT) to the right of the box, so reserve extra room before the right rail.
    const hasOutBox = outputs.some((e) => /^(ton|tof|tp|ctu|ctd|ctud|move|add|sub|mul|div|norm_x|scale_x)$/.test(e.kind));
    // Call boxes are wider (block name + %TYPEn) and have an ENO pin to the right.
    const hasCallBox = outputs.some((e) => e.kind === 'call');
    const reservedOut = outputs.length
      ? (hasCallBox ? 320 : (hasOutBox ? 300 : G.outColW))
      : 40;
    const outRailX = outStartX + reservedOut;
    const svgW = outRailX + 24;

    const railTop = G.topPad;
    const railBot = G.topPad + contentH;
    const rungY = G.topPad + G.midOffset;  // baseline rung (top branch / first output)

    const svg = T.svg('svg', {
      class: 'lad-svg', width: svgW, height: svgH,
      viewBox: '0 0 ' + svgW + ' ' + svgH,
    });

    /* ---- 2. rails ---- */
    svg.appendChild(T.svg('line', {
      class: 'lad-rail', 'data-rail': 'L',
      x1: G.railL, y1: railTop, x2: G.railL, y2: railBot,
    }));
    svg.appendChild(T.svg('line', {
      class: 'lad-rail', 'data-rail': 'R',
      x1: outRailX, y1: railTop, x2: outRailX, y2: railBot,
    }));

    /* ---- 3. condition area: stages, branches, elements ---- */
    let prevX = G.railL;        // right edge of previous stage (power node)
    stageLayout.forEach((lay, si) => {
      const sx = lay.x;
      const sxEnd = sx + lay.w;

      // Connect previous power node to this stage's left node along the rung.
      // (top row only; vertical connectors join the branches)
      svg.appendChild(wire(prevX, rungY, sx, rungY, net, 'pre-' + si));

      // Each branch is one row, stacked downward from rungY.
      lay.branches.forEach((br, bi) => {
        const by = rungY + bi * G.cellH;

        // Branch left lead from stage's left node to first element.
        // Branch right lead from last element to stage's right node.
        renderBranch(svg, br, sx, sxEnd, by, net, lay.maxEls);
      });

      // Vertical OR connectors at the stage's left and right edges
      // joining every branch row of this stage.
      if (lay.branches.length > 1) {
        const yTop = rungY;
        const yBot = rungY + (lay.branches.length - 1) * G.cellH;
        svg.appendChild(seg(sx, yTop, sx, yBot, net, 'orL-' + si));
        svg.appendChild(seg(sxEnd, yTop, sxEnd, yBot, net, 'orR-' + si));
      }

      prevX = sxEnd;
    });

    // Wire from last condition node to the output start (the rung power node).
    svg.appendChild(wire(prevX, rungY, outStartX, rungY, net, 'tooutput'));

    /* ---- 4. output area ---- */
    if (outputs.length) {
      let oyTop = rungY - G.cellH / 2;     // top of the first output slot
      outputs.forEach((el, oi) => {
        const cy = oyTop + G.cellH / 2;    // rung line sits 24px below the slot top
        // vertical drop from rung node down to this output row (for stacked outs)
        if (oi > 0) {
          svg.appendChild(seg(outStartX, rungY, outStartX, cy, net, 'outdrop-' + oi));
        }
        renderOutput(svg, el, outStartX, outRailX, cy, net);
        oyTop += outputSlotH(el);
      });
    } else {
      // No output yet: just wire rung node straight to the right rail
      // and show a faint placeholder.
      svg.appendChild(wire(outStartX, rungY, outRailX, rungY, net, 'noout'));
      svg.appendChild(T.svg('text', {
        x: (outStartX + outRailX) / 2, y: rungY - 8,
        'text-anchor': 'middle', class: 'lad-pin-label',
        fill: 'var(--tia-text-soft)',
      }, '‹output›'));
    }

    // Empty network placeholder (no stages AND no outputs).
    if (!stages.length && !outputs.length) {
      svg.appendChild(T.svg('text', {
        x: (G.railL + outRailX) / 2, y: rungY + 4,
        'text-anchor': 'middle', class: 'lad-operand empty',
      }, 'empty rung — click an instruction or drag one here'));
    }

    return svg;
  }

  /* --------------------------------------------------- render one branch row */
  function renderBranch(svg, br, sx, sxEnd, by, net, maxEls) {
    const els = br.elements;
    if (!els.length) {
      // empty branch: straight wire + a selectable/droppable hit target so the
      // branch can actually be filled (click it, then insert — or drop onto it)
      svg.appendChild(wire(sx, by, sxEnd, by, net, 'emptybr-' + br.id));
      if (br === selBranch) {
        svg.appendChild(T.svg('rect', {
          class: 'lad-sel-box', x: sx + 3, y: by - 10,
          width: Math.max(24, sxEnd - sx - 6), height: 20,
        }));
      }
      const hit = T.svg('rect', {
        class: 'lad-hit', style: 'cursor:pointer',
        'data-branch-id': br.id, 'data-net-id': net.id,
        x: sx + 2, y: by - 12, width: Math.max(28, sxEnd - sx - 4), height: 24,
      });
      hit.addEventListener('mousedown', (e) => { e.stopPropagation(); selectBranch(br, net); });
      svg.appendChild(hit);
      return;
    }
    // Distribute elements across the stage width; each element gets one cell.
    let x = sx;
    els.forEach((el, ei) => {
      const cellX = sx + ei * G.cellW;
      const cx = cellX + G.cellW / 2;
      // lead wire into the element
      svg.appendChild(wire(cellX, by, cx - G.symHalf, by, net, 'lead-' + el.id));
      renderInlineElement(svg, el, cx, by, net);
      // trailing wire out of element
      svg.appendChild(wire(cx + G.symHalf, by, cellX + G.cellW, by, net, 'tail-' + el.id));
      x = cellX + G.cellW;
    });
    // pad remaining cells with straight wire to the stage end (for OR alignment)
    if (x < sxEnd) svg.appendChild(wire(x, by, sxEnd, by, net, 'pad-' + br.id));
  }

  /* ======================================================================= *
   *  INLINE ELEMENT SYMBOLS (condition area)                                *
   * ======================================================================= */
  function renderInlineElement(svg, el, cx, cy, net) {
    const g = elGroup(el, net);
    const k = el.kind;

    if (k === 'compare') {
      renderCompareBox(g, el, cx, cy);
    } else {
      // contacts & edges: two vertical bars
      const x1 = cx - G.symHalf, x2 = cx + G.symHalf, top = cy - 11, bot = cy + 11;
      g.appendChild(T.svg('line', { class: 'lad-sym', x1: x1, y1: top, x2: x1, y2: bot }));
      g.appendChild(T.svg('line', { class: 'lad-sym', x1: x2, y1: top, x2: x2, y2: bot }));
      if (k === 'contact_nc') {
        g.appendChild(T.svg('line', { class: 'lad-sym', x1: x1, y1: bot, x2: x2, y2: top }));
      } else if (k === 'edge_p' || k === 'edge_n') {
        g.appendChild(T.svg('text', {
          class: 'lad-sym-letter', x: cx, y: cy + 4,
        }, k === 'edge_p' ? 'P' : 'N'));
      }
      // operand label above the symbol
      operandLabel(g, el, cx, cy - 16, 'operand');
    }

    // transparent hit rectangle for easy selection
    addHit(g, cx - G.symHalf - 4, cy - 22, G.symHalf * 2 + 8, 36, el, net);
    svg.appendChild(g);
  }

  /* compare = small labelled box in the condition area */
  function renderCompareBox(g, el, cx, cy) {
    const w = G.boxW, h = 34, x = cx - w / 2, y = cy - h / 2;
    const p = el.params || (el.params = { op: '==', in1: '0', in2: '0' });
    g.appendChild(T.svg('rect', { class: 'lad-box', x, y, width: w, height: h, rx: 2 }));
    // comparison operator centred (clickable)
    const opText = T.svg('text', {
      class: 'lad-box-title lad-operand-hit', x: cx, y: cy + 5,
      'text-anchor': 'middle', style: 'cursor:text',
    }, '| ' + (p.op || '==') + ' |');
    opText.addEventListener('click', (e) => { e.stopPropagation(); cycleCompareOp(el); });
    g.appendChild(opText);
    // in1 above, in2 below — both editable param labels
    paramLabel(g, el, 'in1', cx, y - 4, 'middle');
    paramLabel(g, el, 'in2', cx, y + h + 12, 'middle');
  }

  function cycleCompareOp(el) {
    const ops = ['==', '<>', '>', '>=', '<', '<='];
    const cur = (el.params && el.params.op) || '==';
    const i = ops.indexOf(cur);
    el.params = el.params || {};
    el.params.op = ops[(i + 1) % ops.length];
    markDirty();
    const loc = locate(el);
    if (loc) renderNet(loc.net); else render();
  }

  /* ======================================================================= *
   *  OUTPUT ELEMENTS (coils & boxes)                                        *
   * ======================================================================= */
  function renderOutput(svg, el, startX, railX, cy, net) {
    const g = elGroup(el, net);
    const k = el.kind;
    const d = def(k);

    if (k === 'call') {
      renderCallBox(svg, g, el, startX, railX, cy, net);
    } else if (d.box) {
      renderOutputBox(svg, g, el, startX, railX, cy, net);
    } else {
      // coil sits near the right rail
      const coilCx = railX - 40;
      // wire from rung power node to the coil, and coil to rail
      svg.appendChild(wire(startX, cy, coilCx - 14, cy, net, 'cwire-' + el.id));
      renderCoil(g, el, coilCx, cy);
      svg.appendChild(wire(coilCx + 14, cy, railX, cy, net, 'crail-' + el.id));
      operandLabel(g, el, coilCx, cy - 16, 'operand');
      addHit(g, coilCx - 16, cy - 22, 36, 36, el, net);
    }
    svg.appendChild(g);
  }

  function renderCoil(g, el, cx, cy) {
    const k = el.kind;
    // two arcs forming -( )-
    g.appendChild(T.svg('path', { class: 'lad-sym', d: 'M' + (cx - 10) + ' ' + (cy - 11) + ' C' + (cx - 20) + ' ' + (cy - 4) + ' ' + (cx - 20) + ' ' + (cy + 4) + ' ' + (cx - 10) + ' ' + (cy + 11) }));
    g.appendChild(T.svg('path', { class: 'lad-sym', d: 'M' + (cx + 10) + ' ' + (cy - 11) + ' C' + (cx + 20) + ' ' + (cy - 4) + ' ' + (cx + 20) + ' ' + (cy + 4) + ' ' + (cx + 10) + ' ' + (cy + 11) }));
    const letter = k === 'coil_set' ? 'S' : k === 'coil_reset' ? 'R' : '';
    if (letter) {
      g.appendChild(T.svg('text', { class: 'lad-sym-letter', x: cx, y: cy + 4 }, letter));
    } else if (k === 'coil_neg') {
      g.appendChild(T.svg('line', { class: 'lad-sym', x1: cx - 6, y1: cy + 7, x2: cx + 6, y2: cy - 7 }));
    }
  }

  /* output box: timers / counters / move / math — labelled rect with pins */
  function renderOutputBox(svg, g, el, startX, railX, cy, net) {
    const d = def(el.kind);
    const pinsIn = (d.pins && d.pins.in) || [];
    const pinsOut = (d.pins && d.pins.out) || [];
    const rows = Math.max(pinsIn.length, pinsOut.length, 1);
    const h = Math.max(40, 16 + rows * 16);
    const w = G.outBoxW;
    const x = startX + 14;
    const y = cy - h / 2;

    // wire rung -> box EN (left side, top)
    svg.appendChild(wire(startX, cy, x, cy, net, 'bxen-' + el.id));

    g.appendChild(T.svg('rect', { class: 'lad-box', x, y, width: w, height: h, rx: 2 }));
    // instruction title bar
    const titleMap = {
      ton: 'TON', tof: 'TOF', tp: 'TP', ctu: 'CTU', ctd: 'CTD', ctud: 'CTUD',
      move: 'MOVE', add: 'ADD', sub: 'SUB', mul: 'MUL', div: 'DIV',
      norm_x: 'NORM_X', scale_x: 'SCALE_X',
      sr: 'SR', rs: 'RS', p_trig: 'P_TRIG', n_trig: 'N_TRIG', r_trig: 'R_TRIG', f_trig: 'F_TRIG',
    };
    g.appendChild(T.svg('text', {
      class: 'lad-box-title', x: x + w / 2, y: y + 13, 'text-anchor': 'middle',
    }, titleMap[el.kind] || el.kind.toUpperCase()));
    g.appendChild(T.svg('line', { class: 'lad-box', x1: x, y1: y + 18, x2: x + w, y2: y + 18, 'stroke-width': 0.8 }));

    // operand line above the box: timers/counters show an instance name; SR/RS show
    // the stored bit (Q); edge triggers show their edge-memory bit.
    if (el.kind === 'ton' || el.kind === 'tof' || el.kind === 'tp' ||
        el.kind === 'ctu' || el.kind === 'ctd' || el.kind === 'ctud') {
      const instName = (el.kind === 'ton' || el.kind === 'tof' || el.kind === 'tp') ? '"IEC_Timer_DB"' : '"IEC_Counter_DB"';
      operandLabel(g, el, x + w / 2, y - 4, 'operand', instName);
    } else if (el.kind === 'sr' || el.kind === 'rs') {
      operandLabel(g, el, x + w / 2, y - 4, 'operand', '<bit>');
    }

    // input pins (left) — each maps to a param field
    const inParam = inputParamMap(el.kind);
    pinsIn.forEach((pin, i) => {
      const py = y + 30 + i * 16;
      g.appendChild(T.svg('text', { class: 'lad-pin-label', x: x + 5, y: py + 3 }, pin));
      const pk = inParam[pin];
      if (pk) paramLabel(g, el, pk, x - 6, py + 3, 'end');
      // small stub
      g.appendChild(T.svg('line', { class: 'lad-wire', x1: x - 12, y1: py, x2: x, y2: py }));
    });

    // output pins (right) — Q wires onward; ET/CV/OUT show param value
    const outParam = outputParamMap(el.kind);
    pinsOut.forEach((pin, i) => {
      const py = y + 30 + i * 16;
      g.appendChild(T.svg('text', { class: 'lad-pin-label', x: x + w - 5, y: py + 3, 'text-anchor': 'end' }, pin));
      const pk = outParam[pin];
      if (pk) paramLabel(g, el, pk, x + w + 6, py + 3, 'start');
      g.appendChild(T.svg('line', { class: 'lad-wire', x1: x + w, y1: py, x2: x + w + 12, y2: py }));
    });

    // wire box right edge (top output) to the right rail
    svg.appendChild(wire(x + w + 12, cy, railX, cy, net, 'bxrail-' + el.id));

    addHit(g, x, y, w, h, el, net);
  }

  // Map a box pin name -> the params key that drives it (inputs).
  function inputParamMap(kind) {
    switch (kind) {
      case 'ton': case 'tof': case 'tp': return { PT: 'pt' };
      case 'ctu': return { PV: 'pv', R: 'r' };    // R = reset condition operand
      case 'ctd': return { PV: 'pv', LD: 'r' };   // LD = load condition (stored in params.r)
      case 'ctud': return { CD: 'cd', R: 'r', LD: 'ld', PV: 'pv' };   // CU = rung power
      case 'move': return { IN: 'in' };
      case 'add': case 'sub': case 'mul': case 'div': return { in1: 'in1', in2: 'in2' };
      case 'norm_x': case 'scale_x': return { MIN: 'min', VALUE: 'val', MAX: 'max' };
      case 'sr': return { R1: 'r' };          // S = rung power; R1 = referenced bit
      case 'rs': return { S1: 's' };          // R = rung power; S1 = referenced bit
      default: return {};
    }
  }
  // Map a box pin name -> the params key it writes (outputs).
  function outputParamMap(kind) {
    switch (kind) {
      case 'ton': case 'tof': case 'tp': return { Q: 'q', ET: 'et' };
      case 'ctu': case 'ctd': return { Q: 'q', CV: 'cv' };
      case 'ctud': return { QU: 'qu', QD: 'qd', CV: 'cv' };
      case 'move': return { OUT: 'out' };
      case 'add': case 'sub': case 'mul': case 'div': return { OUT: 'out', ENO: 'eno' };
      case 'norm_x': case 'scale_x': return { OUT: 'out', ENO: 'eno' };
      case 'p_trig': case 'n_trig': case 'r_trig': case 'f_trig': return { Q: 'q' };
      default: return {};
    }
  }

  /* call box: a block call placed in the output area. Title = target block's
     name, subtitle = %TYPEn. EN pin (left, wired from rung power), ENO pin
     (right, wired to the right rail). Double-click opens the target block. */
  // How many parameter rows a call box needs (max of input vs output params).
  function callBoxRows(el) {
    const tb = el && el.params && T.findBlock(el.params.target);
    return tb ? Math.max(T.ifaceCallInputs(tb).length, T.ifaceCallOutputs(tb).length) : 0;
  }
  // Vertical slot a stacked output occupies (call boxes are taller than a coil row).
  function outputSlotH(el) {
    if (el.kind === 'call') return Math.max(G.cellH, 34 + callBoxRows(el) * 17 + 8 + 12);
    return G.cellH;
  }

  // editable label for one call argument (binds to el.args[paramName])
  function callArgLabel(g, el, name, x, y, anchor) {
    el.args = el.args || {};
    const val = el.args[name];
    const t = T.svg('text', {
      class: 'lad-operand lad-operand-hit' + (val ? '' : ' empty'),
      x: x, y: y, 'text-anchor': anchor || 'start', 'data-arg-of': el.id, 'data-arg-name': name,
    }, (val != null && val !== '') ? String(val) : '???');
    // .lad-operand sets text-anchor:middle in CSS (for centered operands), which would
    // override the attribute above and center the arg over the pin name. Pin the anchor
    // via inline style so call args stay end/start-aligned and clear of the pin labels.
    t.style.textAnchor = anchor || 'start';
    t.addEventListener('click', (e) => { e.stopPropagation(); select(el, true); openInlineEdit(t, el, { kind: 'arg', argName: name }); });
    attachTagDrop(t, (tagName) => { el.args = el.args || {}; el.args[name] = tagName; });
    g.appendChild(t);
  }

  function renderCallBox(svg, g, el, startX, railX, cy, net) {
    el.params = el.params || {};
    el.args = el.args || {};
    const tb = T.findBlock(el.params.target);
    if (tb) T.ensureInterface(tb);
    const title = tb ? tb.name : '??? missing';
    const sub = tb ? ('%' + tb.type + tb.number) : '';
    const ins = tb ? T.ifaceCallInputs(tb) : [];
    const outs = tb ? T.ifaceCallOutputs(tb) : [];
    // instance DB name shown above an FB call
    const db = el.params.instanceDb && T.findBlock(el.params.instanceDb);

    g.classList.add('lad-call-box-g');

    const ROW = 17;                          // vertical spacing of parameter rows
    const head = 34;                         // title area height (name + %TYPEn + EN/ENO row)
    const rows = Math.max(ins.length, outs.length);
    const h = head + rows * ROW + 8;
    const w = Math.max(132, Math.min(240, 50 + title.length * 7));
    const x = startX + 14;
    const y = cy - 24;                        // box top; EN sits 24px down on the rung line
    const enY = cy;                           // EN/ENO pin row (the powered rung line)

    // wire rung power -> EN, and ENO -> right rail (both on the enY line)
    svg.appendChild(wire(startX, enY, x, enY, net, 'callen-' + el.id));

    g.appendChild(T.svg('rect', { class: 'lad-call-box', x, y, width: w, height: h, rx: 2 }));
    if (db) g.appendChild(T.svg('text', { class: 'lad-call-inst', x: x + w / 2, y: y - 4 }, '"' + db.name + '"'));
    g.appendChild(T.svg('text', { class: 'lad-call-title', x: x + w / 2, y: y + 14 }, title));
    if (sub) g.appendChild(T.svg('text', { class: 'lad-call-sub', x: x + w - 5, y: y + 14, 'text-anchor': 'end' }, sub));
    g.appendChild(T.svg('line', { class: 'lad-box', x1: x, y1: y + 20, x2: x + w, y2: y + 20, 'stroke-width': 0.8 }));

    // EN / ENO
    g.appendChild(T.svg('text', { class: 'lad-pin-label', x: x + 4, y: enY + 3 }, 'EN'));
    g.appendChild(T.svg('text', { class: 'lad-pin-label', x: x + w - 4, y: enY + 3, 'text-anchor': 'end' }, 'ENO'));
    g.appendChild(T.svg('line', { class: 'lad-wire', x1: x + w, y1: enY, x2: x + w + 12, y2: enY }));
    svg.appendChild(wire(x + w + 12, enY, railX, enY, net, 'callrail-' + el.id));

    // input params (left): pin name inside, stub, and the wired argument to the left
    ins.forEach((m, i) => {
      const py = y + head + i * ROW + 6;
      g.appendChild(T.svg('text', { class: 'lad-pin-label', x: x + 5, y: py + 3 }, m.name));
      g.appendChild(T.svg('line', { class: 'lad-wire', x1: x - 12, y1: py, x2: x, y2: py }));
      callArgLabel(g, el, m.name, x - 16, py + 3, 'end');
    });
    // output params (right): pin name inside, stub, and the wired argument to the right
    outs.forEach((m, i) => {
      const py = y + head + i * ROW + 6;
      g.appendChild(T.svg('text', { class: 'lad-pin-label', x: x + w - 5, y: py + 3, 'text-anchor': 'end' }, m.name));
      g.appendChild(T.svg('line', { class: 'lad-wire', x1: x + w, y1: py, x2: x + w + 12, y2: py }));
      callArgLabel(g, el, m.name, x + w + 16, py + 3, 'start');
    });

    addHit(g, x, y, w, h, el, net);
    // double-click navigation is handled in addHit (a native dblclick can't fire
    // here: select()'s re-render detaches this node between the two clicks).
  }

  // Open the block referenced by a call element (guard if missing).
  function openCalledBlock(el) {
    const tb = el && el.params && T.findBlock(el.params.target);
    if (!tb) { T.status('Call target block not found', 'warn'); return; }
    T.setActiveBlock(tb.id);
    T.bus.emit('open:block', tb);
  }

  /* ======================================================================= *
   *  WIRES & SEGMENTS                                                        *
   * ======================================================================= */
  function wire(x1, y1, x2, y2, net, tag) {
    return T.svg('line', {
      class: 'lad-wire', 'data-net-id': net.id, 'data-wire': tag || '',
      x1: x1, y1: y1, x2: x2, y2: y2,
    });
  }
  // vertical/branch connector segment (also live-able)
  function seg(x1, y1, x2, y2, net, tag) {
    return T.svg('line', {
      class: 'lad-wire lad-seg', 'data-net-id': net.id, 'data-seg': tag || '',
      x1: x1, y1: y1, x2: x2, y2: y2,
    });
  }

  /* element <g> carrying data-el-id (required for selection & highlight) */
  function elGroup(el, net) {
    const g = T.svg('g', {
      class: 'lad-el' + (el === selEl ? ' lad-selected' : ''),
      'data-el-id': el.id, 'data-net-id': net.id,
    });
    if (el === selEl) {
      // selection outline drawn first (behind symbol)
      g.appendChild(T.svg('rect', { class: 'lad-sel-box', x: -999, y: -999, width: 0, height: 0, 'data-selrect': '1' }));
    }
    return g;
  }

  // Manual double-click tracking. select() re-renders and detaches the clicked
  // SVG node, so a native 'dblclick' never lands on a stable target. We key on the
  // element id (stable across re-render) to recognise the second press ourselves.
  let lastHitId = null, lastHitT = 0;

  // After building a group we know its hit area; size the selection rect to it.
  function addHit(g, x, y, w, h, el, net) {
    const hit = T.svg('rect', { class: 'lad-hit', x, y, width: w, height: h });
    hit.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      const now = Date.now();
      const dbl = (lastHitId === el.id) && (now - lastHitT < 400);
      lastHitId = el.id; lastHitT = now;
      // double-click a call box -> open the called block (decision #3)
      if (dbl && el.kind === 'call') { openCalledBlock(el); return; }
      select(el);
    });
    hit.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); select(el); openElementMenu(e, el, net); });
    // dropping a tag anywhere on an operand-bearing symbol (contact/coil/edge) sets its operand
    const def = T.catalog[el.kind];
    if (def && def.operandRole) attachTagDrop(hit, (name) => { el.operand = name; });
    g.appendChild(hit);
    // size the selection rect (if present) to wrap the hit area
    const sr = g.querySelector('[data-selrect]');
    if (sr) { sr.setAttribute('x', x - 3); sr.setAttribute('y', y - 3); sr.setAttribute('width', w + 6); sr.setAttribute('height', h + 6); }
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
      node.classList.add('lad-tag-hot');
    });
    node.addEventListener('dragleave', () => node.classList.remove('lad-tag-hot'));
    node.addEventListener('drop', (e) => {
      if (!hasTag(e)) return;
      e.preventDefault(); e.stopPropagation();
      node.classList.remove('lad-tag-hot');
      const name = getTag(e);
      if (name) { applyFn(name); markDirty(); render(); }
    });
  }

  /* ======================================================================= *
   *  OPERAND / PARAM LABELS  (click to edit inline)                          *
   * ======================================================================= */
  function operandLabel(g, el, x, y, key, placeholder) {
    const val = el.operand;
    const t = T.svg('text', {
      class: 'lad-operand lad-operand-hit' + (val ? '' : ' empty'),
      x: x, y: y, 'data-operand-of': el.id,
    }, val || placeholder || '???');
    t.addEventListener('click', (e) => { e.stopPropagation(); select(el, true); openInlineEdit(t, el, { kind: 'operand' }); });
    attachTagDrop(t, (name) => { el.operand = name; });
    g.appendChild(t);
  }

  function paramLabel(g, el, pkey, x, y, anchor) {
    el.params = el.params || {};
    const val = el.params[pkey];
    const t = T.svg('text', {
      class: 'lad-pin-val lad-operand-hit' + (val ? '' : ' empty'),
      x: x, y: y, 'text-anchor': anchor || 'start',
      'data-param-of': el.id, 'data-param-key': pkey,
    }, (val != null && val !== '') ? String(val) : '…');
    if (!val) t.setAttribute('fill', 'var(--tia-text-soft)');
    t.addEventListener('click', (e) => { e.stopPropagation(); select(el, true); openInlineEdit(t, el, { kind: 'param', key: pkey }); });
    attachTagDrop(t, (name) => { el.params = el.params || {}; el.params[pkey] = name; });
    g.appendChild(t);
  }

  /* ======================================================================= *
   *  INLINE EDIT INPUT — floats an <input> over a clicked label             *
   * ======================================================================= */
  let editInput = null;
  let editTarget = null;   // { el, target } for the currently open inline editor
  let editAC = null;       // autocomplete controller for the open editor
  function applyEditValue() {
    if (!editInput || !editTarget) return;
    const v = editInput.value.trim();
    const { el, target } = editTarget;
    if (target.kind === 'operand') el.operand = v;
    else if (target.kind === 'arg') { el.args = el.args || {}; el.args[target.argName] = v; }
    else { el.params = el.params || {}; el.params[target.key] = v; }
  }
  // Remove the inline input. Null the reference FIRST so the synchronous `blur`
  // that fires while detaching a focused node can't re-enter and double-remove it.
  function killEditInput(applyFirst) {
    const inp = editInput;
    if (applyFirst) applyEditValue();
    if (editAC) { editAC.destroy(); editAC = null; }
    editInput = null; editTarget = null;
    if (inp && inp.parentNode) { try { inp.parentNode.removeChild(inp); } catch (e) { /* already detached */ } }
  }

  function openInlineEdit(textNode, el, target) {
    killEditInput(true);
    // Find the network body (positioned container) to place the input.
    const body = textNode.closest('.lad-net-body');
    if (!body) return;
    const bodyRect = body.getBoundingClientRect();
    const tr = textNode.getBoundingClientRect();

    const cur = target.kind === 'operand'
      ? (el.operand || '')
      : target.kind === 'arg'
        ? ((el.args && el.args[target.argName] != null) ? String(el.args[target.argName]) : '')
        : ((el.params && el.params[target.key] != null) ? String(el.params[target.key]) : '');

    const inp = T.el('input', {
      class: 'lad-edit-input', type: 'text', value: cur,
      spellcheck: 'false', autocomplete: 'off',
    });
    // position over the label (account for scroll inside the body; rects are
    // visual px while style.left is layout px inside the zoomed root — ÷ zoom)
    const z = zoom || 1;
    const left = (tr.left - bodyRect.left) / z + body.scrollLeft - 4;
    const top = (tr.top - bodyRect.top) / z + body.scrollTop - 2;
    inp.style.left = Math.max(2, left) + 'px';
    inp.style.top = Math.max(2, top) + 'px';
    inp.style.minWidth = Math.max(60, tr.width / z + 16) + 'px';

    const commit = () => {
      if (editInput !== inp) return;     // already torn down -> no-op (prevents re-entrancy)
      const loc = locate(el);
      killEditInput(true);               // apply value, then remove the input
      markDirty();
      if (loc) renderNet(loc.net); else render();
    };
    inp.addEventListener('mousedown', (e) => e.stopPropagation());

    body.appendChild(inp);
    editInput = inp;
    editTarget = { el, target };

    // Suggestion dropdown (tags + this block's interface variables). Attached BEFORE
    // the commit keydown so its stopImmediatePropagation can pre-empt Enter/arrows.
    editAC = T.attachAutocomplete(inp, {
      items: () => T.operandCandidates(block),
      onPick: (v) => { inp.value = v; commit(); },
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); if (editInput === inp) killEditInput(false); }
      e.stopPropagation();   // don't trigger Delete-key handler etc.
    });
    inp.addEventListener('blur', () => commit());
    inp.focus();
    inp.select();
  }

  /* ======================================================================= *
   *  HEADER (title / comment) INLINE EDIT                                    *
   * ======================================================================= */
  function editHeaderText(spanEl, net, field) {
    const cur = net[field] || '';
    const inp = T.el('input', {
      class: 'tia-input', type: 'text', value: cur,
      style: { width: '60%', font: 'inherit' },
    });
    // `done` guards double-commit (Enter → render → detach-blur → finish again)
    // and makes Escape actually CANCEL (the detach-blur would otherwise commit).
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      net[field] = inp.value.trim();
      markDirty();
      renderNet(net);
    };
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
   *  SELECTION                                                              *
   * ======================================================================= */
  function select(el, noRender) {
    const prevLoc = selEl && selEl !== el ? locate(selEl) : null;
    selEl = el || null;
    selBranch = null;                   // element selection replaces branch selection
    let curLoc = null;
    if (selEl) {
      curLoc = locate(selEl);
      if (curLoc) activeNet = curLoc.net;
    }
    if (!noRender) {
      // only the affected network card(s) need a rebuild
      const nets = [];
      if (prevLoc && nets.indexOf(prevLoc.net) < 0) nets.push(prevLoc.net);
      if (curLoc && nets.indexOf(curLoc.net) < 0) nets.push(curLoc.net);
      if (nets.length) { nets.forEach(renderNet); return; }
      render();
    }
    // noRender is used by the inline-edit click handlers so the clicked text node
    // stays attached (a rebuild would detach it and the floating <input> would land
    // in the discarded DOM).
  }

  // Select an empty parallel branch as the insertion target.
  function selectBranch(br, net) {
    selEl = null;
    selBranch = br;
    activeNet = net;
    render();
    T.status('Empty branch selected — insert or drop a contact into it', 'info');
  }

  function markActiveCards() {
    if (!rootEl) return;
    T.$$('.lad-net', rootEl).forEach((c) => {
      const isAct = activeNet && c.dataset.netId === activeNet.id;
      c.classList.toggle('lad-net-active', !!isAct);
    });
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

  function openElementMenu(evt, el, net) {
    closeMenu();
    const loc = locate(el);
    const items = [];
    if (loc && loc.area === 'inline') {
      items.push(['Open parallel branch', () => openParallelBranchAt(el)]);
      items.push('-');
    }
    items.push(['Delete element', () => { select(el); deleteSelection(); }]);
    items.push('-');
    items.push(['Insert network below', () => insertNetworkBelow(net)]);
    items.push(['Delete network', () => deleteNetwork(net)]);
    showMenu(evt.clientX, evt.clientY, items);
  }

  function showMenu(x, y, items) {
    const m = T.el('div', { class: 'lad-menu', style: { left: x + 'px', top: y + 'px' } });
    items.forEach((it) => {
      if (it === '-') { m.appendChild(T.el('div', { class: 'lad-menu-sep' })); return; }
      const [label, fn, disabled] = it;
      m.appendChild(T.el('div', {
        class: 'lad-menu-item' + (disabled ? ' disabled' : ''),
        onclick: () => { if (disabled) return; closeMenu(); fn(); },
      }, label));
    });
    document.body.appendChild(m);
    menuEl = m;
    // keep on screen
    const r = m.getBoundingClientRect();
    if (r.right > window.innerWidth) m.style.left = (window.innerWidth - r.width - 6) + 'px';
    if (r.bottom > window.innerHeight) m.style.top = (window.innerHeight - r.height - 6) + 'px';
    setTimeout(() => document.addEventListener('mousedown', onMenuDocDown, true), 0);
  }

  /* ======================================================================= *
   *  DRAG-DROP                                                               *
   * ======================================================================= */
  function enableDrop(card, body, net) {
    const over = (e) => {
      if (!hasKind(e) && !hasBlock(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      card.classList.add('lad-drop-hot');
    };
    body.addEventListener('dragover', over);
    body.addEventListener('dragenter', over);
    body.addEventListener('dragleave', (e) => {
      if (!body.contains(e.relatedTarget)) card.classList.remove('lad-drop-hot');
    });
    body.addEventListener('drop', (e) => {
      card.classList.remove('lad-drop-hot');

      // A block dragged from the project tree → insert a call into this network.
      if (hasBlock(e)) {
        e.preventDefault();
        dropBlockCall(net, getBlockId(e));
        return;
      }

      const kind = getKind(e);
      if (!kind || !T.catalog[kind] || T.catalog[kind].lad === false) return;
      e.preventDefault();
      // Drop targets this network; if an element under the cursor is inline and
      // selected, insert chains off it — otherwise insert into this network.
      activeNet = net;
      selBranch = null;
      // Dropped onto an empty parallel branch → insert into that branch.
      const brT = e.target.closest && e.target.closest('[data-branch-id]');
      if (brT && T.catalog[kind].area === 'inline') {
        const br = findBranchById(brT.getAttribute('data-branch-id'));
        if (br) { selBranch = br; selEl = null; insert(kind); return; }
      }
      // If dropped onto an existing element, select it first so inline chaining
      // works; the LEFT half of the element means "insert before it".
      const target = e.target.closest && e.target.closest('[data-el-id]');
      if (target) {
        const el = findElById(target.getAttribute('data-el-id'));
        if (el) {
          selEl = el;
          const r = target.getBoundingClientRect();
          insertBefore = T.catalog[kind].area === 'inline' && e.clientX < r.left + r.width / 2;
        }
      } else {
        selEl = null;
      }
      insert(kind);
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

  // Insert a block-call into a network's outputs from a dropped block id.
  function dropBlockCall(net, blockId) {
    if (!net || !blockId) return;
    if (block && blockId === block.id) {
      T.status('A block cannot call itself', 'warn');
      return;
    }
    const tb = T.findBlock(blockId);
    if (!tb) { T.status('Dropped block not found', 'warn'); return; }
    if (tb.type === 'DB') { T.status('Data blocks are not callable', 'warn'); return; }
    const el = T.model.newElement('call');
    el.params = el.params || {};
    el.params.target = blockId;
    el.args = {};
    // A function block needs an instance data block — create one (TIA does this on call).
    if (tb.type === 'FB') {
      const db = T.model.newInstanceDB(tb);
      T.project.blocks.push(db);
      el.params.instanceDb = db.id;
      T.status('Created instance "' + db.name + '" for ' + tb.name, 'ok');
    }
    net.outputs = net.outputs || [];
    net.outputs.push(el);
    activeNet = net;
    selEl = el;
    markDirty();
    T.bus.emit('tree:changed');     // new instance DB appears in the project tree
    render();
  }

  function findElById(id) {
    if (!block) return null;
    for (const net of block.networks) {
      for (const stg of (net.stages || [])) for (const br of stg.branches) {
        const f = br.elements.find((x) => x.id === id); if (f) return f;
      }
      const o = (net.outputs || []).find((x) => x.id === id); if (o) return o;
    }
    return null;
  }

  /* ======================================================================= *
   *  EDITING OPERATIONS                                                      *
   * ======================================================================= */

  // insert(kind): place a new element of `kind` at the current insertion point.
  function insert(kind) {
    if (!block) return;
    const d = def(kind);
    if (!T.catalog[kind]) { T.status('Unknown instruction: ' + kind, 'warn'); return; }
    if (d.lad === false) { T.status('Instruction not available in LAD', 'warn'); return; }
    const before = insertBefore; insertBefore = false;   // one-shot (set by drop position)
    const net = getActiveNet();
    if (!net) return;

    const el = T.model.newElement(kind);

    if (d.area === 'output') {
      // push to the active network's outputs
      net.outputs = net.outputs || [];
      net.outputs.push(el);
    } else {
      // inline: a selected empty branch takes the element; else if an inline
      // element is selected, append in series right after it inside its branch;
      // else append a brand-new stage holding the element.
      const brLoc = selBranch && locateBranch(selBranch);
      const loc = selEl && locate(selEl);
      if (brLoc && brLoc.net === net) {
        selBranch.elements.push(el);
        selBranch = null;
      } else if (loc && loc.area === 'inline') {
        loc.branch.elements.splice(loc.index + (before ? 0 : 1), 0, el);
      } else {
        const stage = T.model.newStage();          // one branch with empty elements
        stage.branches[0].elements.push(el);
        net.stages = net.stages || [];
        net.stages.push(stage);
      }
    }

    selEl = el;
    markDirty();
    render();
    // open operand input for immediate typing (operand-bearing kinds)
    focusNewOperand(el);
  }

  // After inserting, focus the operand (or first sensible param) input.
  function focusNewOperand(el) {
    if (!rootEl) return;
    const g = rootEl.querySelector('[data-el-id="' + cssEsc(el.id) + '"]');
    if (!g) return;
    // prefer operand label; else first param label
    let label = g.querySelector('[data-operand-of]');
    let target = { kind: 'operand' };
    if (!label) {
      label = g.querySelector('[data-param-of]');
      if (label) target = { kind: 'param', key: label.getAttribute('data-param-key') };
    }
    if (label) openInlineEdit(label, el, target);
  }
  function cssEsc(s) { return String(s).replace(/["\\]/g, '\\$&'); }

  // deleteSelection(): remove selected element; prune empties; keep selection sane.
  function deleteSelection() {
    if (!selEl && selBranch) {          // a selected empty parallel branch
      const bl = locateBranch(selBranch);
      if (bl && bl.stage.branches.length > 1) {
        bl.stage.branches.splice(bl.stage.branches.indexOf(selBranch), 1);
        selBranch = null;
        markDirty();
        render();
      } else {
        T.status('Cannot delete the only branch of a stage', 'warn');
      }
      return;
    }
    if (!selEl) { T.status('Nothing selected to delete', 'warn'); return; }
    const loc = locate(selEl);
    if (!loc) { selEl = null; render(); return; }

    let nextSel = null;
    if (loc.area === 'inline') {
      loc.list.splice(loc.index, 1);
      // pick a neighbour in the same branch as next selection
      nextSel = loc.list[loc.index] || loc.list[loc.index - 1] || null;
      // prune empty branch (unless it's the only branch in the stage)
      if (!loc.branch.elements.length) {
        const brs = loc.stage.branches;
        if (brs.length > 1) {
          const bi = brs.indexOf(loc.branch);
          brs.splice(bi, 1);
        }
      }
      // prune empty stage: a stage whose every branch has no elements
      const stageEmpty = loc.stage.branches.every((b) => !b.elements.length);
      if (stageEmpty) {
        const si = loc.net.stages.indexOf(loc.stage);
        if (si >= 0) loc.net.stages.splice(si, 1);
      }
    } else {
      // output
      loc.list.splice(loc.index, 1);
      nextSel = loc.list[loc.index] || loc.list[loc.index - 1] || null;
    }

    selEl = nextSel;
    if (selEl) { const l = locate(selEl); if (l) activeNet = l.net; }
    markDirty();
    render();
  }

  // Paste the copied element: clone with a fresh id, place like insert() does.
  function pasteElement() {
    if (!clipEl || !block) return;
    const el = JSON.parse(JSON.stringify(clipEl));
    el.id = T.uid('el');
    const d = def(el.kind);
    const net = getActiveNet();
    if (!net) return;
    if (d.area === 'output') {
      (net.outputs = net.outputs || []).push(el);
    } else {
      const brLoc = selBranch && locateBranch(selBranch);
      const loc = selEl && locate(selEl);
      if (brLoc && brLoc.net === net) { selBranch.elements.push(el); selBranch = null; }
      else if (loc && loc.area === 'inline') loc.branch.elements.splice(loc.index + 1, 0, el);
      else {
        const stage = T.model.newStage();
        stage.branches[0].elements.push(el);
        (net.stages = net.stages || []).push(stage);
      }
    }
    selEl = el;
    markDirty();
    render();
    T.status('Pasted ' + (d.name || el.kind), 'info');
  }

  // Open a parallel branch in the stage that contains the selected element.
  function openParallelBranchAt(el) {
    const loc = locate(el);
    if (!loc || loc.area !== 'inline') {
      T.status('Select a contact first to add a parallel branch', 'warn');
      return;
    }
    const br = T.model.newBranch();
    loc.stage.branches.push(br);
    activeNet = loc.net;
    selEl = null; selBranch = br;       // pre-select so the next insert lands in it
    markDirty();
    render();
    T.status('Parallel branch added — insert a contact into it', 'info');
  }

  // Network-level "Open parallel branch": act on selection if it's in this net,
  // else on the last stage of the network.
  function openParallelBranch(net) {
    if (selEl) {
      const loc = locate(selEl);
      if (loc && loc.net === net && loc.area === 'inline') { openParallelBranchAt(selEl); return; }
    }
    const stages = net.stages || [];
    if (!stages.length) {
      T.status('Add a contact first, then open a parallel branch', 'warn');
      return;
    }
    const stage = stages[stages.length - 1];
    const br = T.model.newBranch();
    stage.branches.push(br);
    activeNet = net;
    selEl = null; selBranch = br;       // pre-select so the next insert lands in it
    markDirty();
    render();
    T.status('Parallel branch added to last stage — insert a contact into it', 'info');
  }

  function insertNetworkBelow(net) {
    const i = block.networks.indexOf(net);
    const nn = T.model.newNetwork();
    block.networks.splice(i + 1, 0, nn);
    activeNet = nn; selEl = null;
    markDirty();
    render();
    scrollToNet(nn);
  }

  function deleteNetwork(net) {
    const i = block.networks.indexOf(net);
    if (i < 0) return;
    block.networks.splice(i, 1);
    if (activeNet === net) activeNet = block.networks[Math.max(0, i - 1)] || null;
    if (selEl && !locate(selEl)) selEl = null;
    markDirty();
    render();
  }

  // addNetwork(): append a new empty network and focus it.
  function addNetwork() {
    if (!block) return;
    const nn = T.model.newNetwork();
    block.networks.push(nn);
    activeNet = nn; selEl = null;
    markDirty();
    render();
    scrollToNet(nn);
  }

  function scrollToNet(net) {
    if (!rootEl) return;
    const card = rootEl.querySelector('.lad-net[data-net-id="' + cssEsc(net.id) + '"]');
    if (card && card.scrollIntoView) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  /* ======================================================================= *
   *  KEYBOARD                                                               *
   * ======================================================================= */
  function onKeyDown(e) {
    // only when this editor is active and not typing in an input/textarea
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
      if (selEl) {
        e.preventDefault();
        clipEl = JSON.parse(JSON.stringify(selEl, T.stripRuntime));
        if (e.key.toLowerCase() === 'x') deleteSelection();
        T.status((e.key.toLowerCase() === 'x' ? 'Cut ' : 'Copied ') + (def(clipEl.kind).name || clipEl.kind), 'info');
      }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'v') {
      if (clipEl) { e.preventDefault(); pasteElement(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === '+' || e.key === '=')) { e.preventDefault(); setZoom(zoom + 0.1); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === '-') { e.preventDefault(); setZoom(zoom - 0.1); return; }
    if ((e.ctrlKey || e.metaKey) && e.key === '0') { e.preventDefault(); setZoom(1); return; }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selEl || selBranch) { e.preventDefault(); deleteSelection(); }
    } else if (e.key === 'Escape') {
      closeMenu(); killEditInput();
      if (selEl || selBranch) { select(null); }
    }
  }

  /* ======================================================================= *
   *  SIMULATION HIGHLIGHT (cheap — no SVG rebuild)                           *
   * ======================================================================= */
  // Toggle 'lad-live' on each element group from element._live, and colour the
  // wires/rails green when their network's rung is powered.
  function highlight() {
    if (!rootEl) return;
    block.networks.forEach((net) => {
      // element groups: green when live, else (only while sim runs) blue.
      collectElements(net).forEach((el) => {
        const g = rootEl.querySelector('[data-el-id="' + cssEsc(el.id) + '"]');
        if (!g) return;
        const live = !!el._live;
        g.classList.toggle('lad-live', live);
        g.classList.toggle('lad-low', simRunning && !live);
      });
      // rung power: derive from whether any output is live OR (no outputs) the
      // last stage's branch is live. We approximate "powered" as: every stage
      // has at least one live element AND outputs (if any) reflect it. Simpler &
      // robust: a network is "powered" if its computed rung power is true. The
      // simulator marks output elements _live with rung power; use that when
      // outputs exist, else use condition liveness.
      const powered = rungPowered(net);
      const card = rootEl.querySelector('.lad-net[data-net-id="' + cssEsc(net.id) + '"]');
      if (!card) return;
      // colour all plain wires + rails of this network's SVG.
      // Powered → green. Otherwise, while the sim runs → dashed blue (low).
      T.$$('[data-net-id="' + cssEsc(net.id) + '"].lad-wire', card).forEach((w) => {
        w.classList.toggle('lad-live', powered);
        w.classList.toggle('lad-low', simRunning && !powered);
      });
      // Rails: green when powered, else blue while the sim runs (kept solid).
      T.$$('.lad-rail', card).forEach((r) => {
        r.classList.toggle('lad-live', powered);
        r.classList.toggle('lad-low', simRunning && !powered);
      });
    });
  }

  // Rung power for wire colouring. Prefer the simulator's authoritative value
  // (net._power = the condition-area RLO feeding the outputs' EN); this is correct
  // for timer/counter rungs whose Q is delayed. Fall back to deriving it from
  // element._live when the sim hasn't stamped a value yet.
  function rungPowered(net) {
    if (typeof net._power === 'boolean') return net._power;
    const stages = net.stages || [];
    if (!stages.length) return true;  // empty condition area = directly powered
    return stages.every((s) => s.branches.some((b) =>
      b.elements.length && b.elements.every((e) => e._live)));
  }

  function clearHighlight() {
    if (!rootEl) return;
    T.$$('.lad-live', rootEl).forEach((n) => n.classList.remove('lad-live'));
    T.$$('.lad-low', rootEl).forEach((n) => n.classList.remove('lad-low'));
  }

  function collectElements(net) {
    const out = [];
    (net.stages || []).forEach((s) => s.branches.forEach((b) => b.elements.forEach((e) => out.push(e))));
    (net.outputs || []).forEach((e) => out.push(e));
    return out;
  }

  /* ======================================================================= *
   *  PUBLIC API                                                             *
   * ======================================================================= */
  let api = null;

  function open(hostEl, blk) {
    host = hostEl;
    block = blk;
    selEl = null;
    selBranch = null;
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
      lang: 'LAD',
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
  T.editors.lad = { open: open };

  /* ----------------------------------------------------------- bus wiring */
  // Re-apply live classes each scan tick (cheap; queries existing nodes).
  T.bus.on('sim:tick', () => {
    if (T.activeEditor === api) { try { highlight(); } catch (_) {} }
  });
  // Track sim run-state (drives Feature 4 de-energized blue coloring) and
  // clear highlights when the simulator stops.
  T.bus.on('sim:state', (s) => {
    simRunning = !!(s && s.running);
    if (!simRunning) { if (T.activeEditor === api) clearHighlight(); }
  });

  // Global key handler (guards against acting when another editor is active).
  document.addEventListener('keydown', onKeyDown);

  // Tidy floating UI on scroll/resize.
  window.addEventListener('resize', () => { closeMenu(); killEditInput(); });
})(window.TIA);
