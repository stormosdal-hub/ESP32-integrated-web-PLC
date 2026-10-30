/* ===========================================================================
 * TIA-like Browser PLC IDE  —  tree.js
 * The left-hand PROJECT TREE.
 *
 * Renders the collapsible project hierarchy into #tia-tree:
 *
 *   Project: <project.name>                       (icon: plc)
 *     └ <device.name> [<device.type>]             (icon: device)
 *         ├ Program blocks                         (icon: folder)
 *         │   ├ <block.name> [<TYPE><number>]      (icon: block)
 *         │   └ (＋ Add new block ...)             (affordance)
 *         └ PLC tags                               (icon: folder)
 *             └ Default tag table                  (icon: tag)
 *
 * Public API:  T.editors.tree = { render() }
 *
 * Emits  : 'open:block' (block), 'open:tags', 'tree:changed'
 * Listens: 'project:loaded', 'tree:changed', 'block:activated'
 *
 * Uses ONLY window.TIA.* helpers. IIFE — no globals beyond T.editors.tree.
 * ==========================================================================*/
(function (T) {
  'use strict';

  /* ------------------------------------------------------------ component CSS
   * The base shell stylesheet (css/tia.css) already styles .tia-tree-node,
   * .tia-twisty, .tia-tree-icon, .tia-input, etc. Here we only add what is
   * specific to this module: indentation, the leaf/branch label, the
   * "add new block" affordance, the right-click context menu and the modal.
   * All colours come from the --tia-* theme variables (no hard-coded greys). */
  T.injectCSS('tia-tree-css', `
    #tia-tree { padding: 4px 0; user-select: none; }

    /* node label grows to fill the row so the whole row is a click target */
    .tia-tree-node .tia-tree-label { flex: 1 1 auto; overflow: hidden;
      text-overflow: ellipsis; }
    .tia-tree-node .tia-tree-sub { color: var(--tia-text-soft); margin-left: 4px; }

    /* a twisty placeholder keeps leaf rows aligned with branch rows */
    .tia-tree-node .tia-twisty.leaf { visibility: hidden; }
    .tia-tree-node .tia-twisty svg { width: 12px; height: 12px; }

    /* "add new block" affordance — subtle, dashed, petrol on hover */
    .tia-tree-add { color: var(--tia-text-soft); font-style: italic; }
    .tia-tree-add:hover { color: var(--tia-petrol-dark); }
    .tia-tree-add .tia-tree-icon { color: var(--tia-petrol); }

    /* ---- right-click context menu ---- */
    .tia-ctx {
      position: fixed; z-index: 9000; min-width: 150px; padding: 3px;
      background: var(--tia-panel); border: 1px solid var(--tia-border);
      border-radius: 3px; box-shadow: 0 4px 14px rgba(0,0,0,.25);
      font-size: var(--tia-fs);
    }
    .tia-ctx-item { display: flex; align-items: center; gap: 7px;
      padding: 4px 12px 4px 9px; cursor: pointer; border-radius: 2px;
      color: var(--tia-text); white-space: nowrap; }
    .tia-ctx-item:hover { background: var(--tia-hover); }
    .tia-ctx-item.danger:hover { background: #f6d9d9; color: #9c2a1e; }
    .tia-ctx-item .tia-tree-icon { width: 14px; height: 14px; }
    .tia-ctx-sep { height: 1px; margin: 3px 6px; background: var(--tia-border-soft); }

    /* ---- modal overlay (add / rename) ---- */
    .tia-modal-ov {
      position: fixed; inset: 0; z-index: 9500; display: flex;
      align-items: center; justify-content: center;
      background: rgba(20,30,35,.42);
    }
    .tia-modal {
      width: 320px; max-width: 90vw; background: var(--tia-panel);
      border: 1px solid var(--tia-border); border-radius: 5px;
      box-shadow: 0 10px 38px rgba(0,0,0,.4); overflow: hidden;
    }
    .tia-modal-head {
      background: var(--tia-panel-head); color: #fff; font-weight: 600;
      padding: 7px 12px; font-size: 12.5px;
    }
    .tia-modal-body { padding: 12px 14px; display: grid;
      grid-template-columns: 78px 1fr; gap: 9px 8px; align-items: center; }
    .tia-modal-body label { color: var(--tia-text-soft); }
    .tia-modal-body .tia-input { width: 100%; }
    .tia-modal-foot { display: flex; justify-content: flex-end; gap: 8px;
      padding: 9px 14px; border-top: 1px solid var(--tia-border-soft);
      background: var(--tia-toolbar); }
    .tia-modal-foot button {
      height: 26px; padding: 0 14px; border-radius: 3px; cursor: pointer;
      border: 1px solid var(--tia-border); background: #fbfcfc; color: var(--tia-text);
    }
    .tia-modal-foot button:hover { background: var(--tia-hover); border-color: var(--tia-petrol); }
    .tia-modal-foot button.primary { background: var(--tia-petrol); color: #fff;
      border-color: var(--tia-petrol-dark); }
    .tia-modal-foot button.primary:hover { background: var(--tia-petrol-dark); }
    .tia-modal-err { grid-column: 1 / -1; color: #c0392b; font-size: 11.5px;
      min-height: 14px; }
  `);

  /* ----------------------------------------------------------------- state
   * `expanded` keeps a Set of node keys that are open, so the open/closed
   * state survives full re-renders. Sensible defaults are seeded on first run. */
  const expanded = new Set();
  let seeded = false;
  function seedDefaults() {
    if (seeded) return;
    seeded = true;
    ['project', 'device', 'blocks', 'tags'].forEach((k) => expanded.add(k));
  }
  const isOpen = (key) => expanded.has(key);
  function toggle(key) {
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
    render();
  }

  /* Single-click selects a node (highlights it + fills the Details view) WITHOUT
   * opening it; double-click opens it. selKey is the currently selected node. */
  let selKey = null;
  function previewBlock(b) {
    selKey = b.id;
    T.bus.emit('tree:select', { kind: b.type === 'DB' ? 'db' : 'block', ref: b });
    render();
  }
  function previewTags() {
    selKey = 'tags';
    T.bus.emit('tree:select', { kind: 'tags', ref: null });
    render();
  }

  /* ----------------------------------------------------------- icon helper */
  function icon(name) {
    return T.el('span', { class: 'tia-tree-icon', html: T.icons[name] || '' });
  }
  function twisty(open, leaf) {
    return T.el('span', {
      class: 'tia-twisty' + (leaf ? ' leaf' : (open ? ' open' : '')),
      html: leaf ? '' : T.icons.chevron,
    });
  }

  /* --------------------------------------------------------------- node row
   * Build one tree row. `opts`:
   *   key        - expand-state key (branch rows only)
   *   depth      - indentation level (0-based)
   *   iconName   - T.icons key
   *   label      - main text
   *   sub        - dimmed suffix text (e.g. "[OB1]")
   *   leaf       - true => no twisty, no children
   *   open       - current expanded flag (branch rows)
   *   selected   - highlight as active
   *   extraClass - additional class on the row
   *   onClick    - row click handler
   *   onToggle   - twisty click handler (defaults to toggling `key`)
   *   onContext  - right-click handler
   *   onDblClick - double-click handler (program-block rows)
   *   draggable  - true => row is draggable
   *   onDragStart- dragstart handler (program-block rows)
   */
  function nodeRow(opts) {
    const row = T.el('div', {
      class: 'tia-tree-node' + (opts.selected ? ' selected' : '') +
             (opts.extraClass ? ' ' + opts.extraClass : ''),
      style: { paddingLeft: (4 + opts.depth * 14) + 'px' },
      title: opts.title || (opts.label + (opts.sub ? ' ' + opts.sub : '')),
      onclick: opts.onClick || null,
      oncontextmenu: opts.onContext || null,
      ondblclick: opts.onDblClick || null,
      draggable: opts.draggable ? true : null,
      ondragstart: opts.onDragStart || null,
    });

    const tw = twisty(opts.open, opts.leaf);
    if (!opts.leaf) {
      tw.addEventListener('click', (e) => {
        e.stopPropagation();
        (opts.onToggle || (() => toggle(opts.key)))();
      });
    }
    row.appendChild(tw);
    row.appendChild(icon(opts.iconName));

    const label = T.el('span', { class: 'tia-tree-label' }, opts.label);
    if (opts.sub) label.appendChild(T.el('span', { class: 'tia-tree-sub' }, opts.sub));
    row.appendChild(label);
    return row;
  }

  /* ====================================================================== */
  /*  RENDER                                                                 */
  /* ====================================================================== */
  function render() {
    const host = document.getElementById('tia-tree');
    if (!host) return;            // DOM not ready yet — nothing to do
    T.clear(host);
    closeContextMenu();          // any stale menu must not survive a re-render
    seedDefaults();

    const p = T.project;
    if (!p) {                    // defensive: no project loaded yet
      host.appendChild(T.el('div', { class: 'tia-empty' }, 'No project loaded'));
      return;
    }

    const device = p.device || { name: 'PLC_1', type: 'CPU' };
    const blocks = Array.isArray(p.blocks) ? p.blocks : [];
    const activeId = p.activeBlockId;

    /* --- Project (root) --- */
    host.appendChild(nodeRow({
      key: 'project', depth: 0, iconName: 'plc',
      label: 'Project: ' + (p.name || 'PLC_Project'),
      open: isOpen('project'),
    }));
    if (!isOpen('project')) return;

    /* --- Device --- */
    host.appendChild(nodeRow({
      key: 'device', depth: 1, iconName: 'device',
      label: device.name || 'PLC_1',
      sub: '[' + (device.type || 'CPU') + ']',
      open: isOpen('device'),
    }));
    if (!isOpen('device')) return;

    /* --- Program blocks --- */
    host.appendChild(nodeRow({
      key: 'blocks', depth: 2, iconName: 'folder',
      label: 'Program blocks', open: isOpen('blocks'),
    }));
    if (isOpen('blocks')) {
      blocks.forEach((b) => {
        const isDB = b.type === 'DB';
        const instFB = isDB && b.instanceOf && T.findBlock(b.instanceOf);
        host.appendChild(nodeRow({
          depth: 3, leaf: true, iconName: isDB ? 'db' : 'block',
          label: b.name,
          sub: '[' + b.type + b.number + ']' + (instFB ? ' → ' + instFB.name : ''),
          selected: selKey === b.id,
          onClick: () => previewBlock(b),     // single click: select + Details view only
          onDblClick: () => openBlock(b),      // double click: open it
          onContext: (e) => showBlockMenu(e, b),
          // A code block can be dragged onto a network to create a Call. DBs aren't callable.
          draggable: !isDB,
          onDragStart: isDB ? null : (e) => {
            e.stopPropagation();
            e.dataTransfer.setData('text/tia-block', b.id);
            e.dataTransfer.effectAllowed = 'copy';
          },
        }));
      });
      // "Add new block" affordance
      const addRow = nodeRow({
        depth: 3, leaf: true, iconName: 'add',
        label: 'Add new block ...',
        extraClass: 'tia-tree-add',
        onClick: () => openAddBlockModal(),
      });
      host.appendChild(addRow);
    }

    /* --- PLC tags --- */
    host.appendChild(nodeRow({
      key: 'tags', depth: 2, iconName: 'folder',
      label: 'PLC tags', open: isOpen('tags'),
      selected: selKey === 'tags',
      onClick: () => previewTags(),                 // single click: Details view only
      onDblClick: () => T.bus.emit('open:tags'),    // double click: open the tag table
    }));
    if (isOpen('tags')) {
      host.appendChild(nodeRow({
        depth: 3, leaf: true, iconName: 'tag',
        label: 'Default tag table',
        selected: selKey === 'tags',
        onClick: () => previewTags(),
        onDblClick: () => T.bus.emit('open:tags'),
      }));
    }
  }

  /* --------------------------------------------------------- open a block */
  function openBlock(b) {
    if (!b) return;
    T.setActiveBlock(b.id);       // emits 'block:activated' (we re-highlight)
    T.bus.emit('open:block', b);
    // feed the Details view: a code block shows its interface, a DB shows its members
    T.bus.emit('tree:select', { kind: b.type === 'DB' ? 'db' : 'block', ref: b });
  }

  /* ====================================================================== */
  /*  CONTEXT MENU  (right-click a program block)                            */
  /* ====================================================================== */
  let ctxEl = null;
  function closeContextMenu() {
    if (ctxEl && ctxEl.parentNode) ctxEl.parentNode.removeChild(ctxEl);
    ctxEl = null;
    document.removeEventListener('mousedown', onDocDownForCtx, true);
    document.removeEventListener('keydown', onEscForCtx, true);
  }
  function onDocDownForCtx(e) { if (ctxEl && !ctxEl.contains(e.target)) closeContextMenu(); }
  function onEscForCtx(e) { if (e.key === 'Escape') closeContextMenu(); }

  function ctxItem(label, iconName, handler, danger) {
    return T.el('div', {
      class: 'tia-ctx-item' + (danger ? ' danger' : ''),
      onclick: () => { closeContextMenu(); handler(); },
    }, icon(iconName), label);
  }

  function showBlockMenu(e, b) {
    e.preventDefault();
    e.stopPropagation();
    closeContextMenu();

    ctxEl = T.el('div', { class: 'tia-ctx' },
      ctxItem('Open', 'open', () => openBlock(b)),
      ctxItem('Rename', 'block', () => openRenameModal(b)),
      T.el('div', { class: 'tia-ctx-sep' }),
      ctxItem('Delete', 'trash', () => deleteBlock(b), true)
    );
    document.body.appendChild(ctxEl);

    // position, keeping the menu inside the viewport
    const mw = ctxEl.offsetWidth, mh = ctxEl.offsetHeight;
    let x = e.clientX, y = e.clientY;
    if (x + mw > window.innerWidth) x = Math.max(2, window.innerWidth - mw - 4);
    if (y + mh > window.innerHeight) y = Math.max(2, window.innerHeight - mh - 4);
    ctxEl.style.left = x + 'px';
    ctxEl.style.top = y + 'px';

    document.addEventListener('mousedown', onDocDownForCtx, true);
    document.addEventListener('keydown', onEscForCtx, true);
  }

  /* --------------------------------------------------------- delete a block */
  function deleteBlock(b) {
    const blocks = T.project && T.project.blocks;
    if (!blocks) return;

    // Refuse to delete the last remaining block.
    if (blocks.length <= 1) {
      T.status('Cannot delete the last remaining block.', 'warn');
      return;
    }
    // Refuse to delete OB1 (the main organization block).
    if (b.type === 'OB' && b.number === 1) {
      T.status('Cannot delete OB1 (main program).', 'warn');
      return;
    }

    // Reference check: call sites targeting this block / using it as instance,
    // plus its own instance DBs (which become useless and are cascade-deleted).
    let callRefs = 0, instRefs = 0;
    blocks.forEach((ob) => (ob.networks || []).forEach((net) => {
      const check = (el) => {
        if (!el || el.kind !== 'call' || !el.params) return;
        if (el.params.target === b.id) callRefs++;
        if (b.type === 'DB' && el.params.instanceDb === b.id) instRefs++;
      };
      (net.outputs || []).forEach(check);
      (net.boxes || []).forEach(check);
    }));
    const instDbs = blocks.filter((x) => x.type === 'DB' && x.instanceOf === b.id);

    let msg = 'Delete block "' + b.name + ' [' + b.type + b.number + ']" ?';
    if (callRefs) msg += '\n\n⚠ It is called from ' + callRefs + ' place(s) — those calls become invalid (Compile will flag them).';
    if (instRefs) msg += '\n\n⚠ ' + instRefs + ' FB call(s) use this instance data block.';
    if (instDbs.length) msg += '\n\n⚠ Its instance data block(s) will be deleted too: ' + instDbs.map((d) => d.name).join(', ');
    if (!window.confirm(msg)) return;

    const idx = blocks.indexOf(b);
    if (idx < 0) return;
    [b].concat(instDbs).forEach((x) => {
      const i = blocks.indexOf(x);
      if (i >= 0) blocks.splice(i, 1);
    });

    if (!T.findBlock(T.project.activeBlockId)) {
      // activate a neighbour so the editor always has a valid block.
      const next = blocks[Math.min(idx, blocks.length - 1)];
      if (next) {
        T.setActiveBlock(next.id);
        T.bus.emit('open:block', next);
      } else {
        T.project.activeBlockId = null;
      }
    }
    T.status('Deleted ' + b.type + b.number +
      (instDbs.length ? ' (+' + instDbs.length + ' instance DB)' : '') + '.', 'info');
    T.bus.emit('tree:changed');
  }

  /* ====================================================================== */
  /*  MODAL  (generic centered overlay built with T.el)                      */
  /* ====================================================================== */
  let modalCleanup = null;
  function closeModal() {
    if (modalCleanup) { modalCleanup(); modalCleanup = null; }
  }

  /* buildModal({ title, rows:[{label, field}], onOk(), focusEl })
   * `rows[i].field` is the input element; `onOk` returns false to keep the
   * modal open (e.g. validation failed). Returns the overlay element. */
  function buildModal(cfg) {
    closeModal();

    const errEl = T.el('div', { class: 'tia-modal-err' });
    const body = T.el('div', { class: 'tia-modal-body' });
    cfg.rows.forEach((r) => {
      body.appendChild(T.el('label', null, r.label));
      body.appendChild(r.field);
    });
    body.appendChild(errEl);

    const ok = T.el('button', { class: 'primary', onclick: doOk }, 'OK');
    const cancel = T.el('button', { onclick: closeModal }, 'Cancel');

    const modal = T.el('div', { class: 'tia-modal' },
      T.el('div', { class: 'tia-modal-head' }, cfg.title),
      body,
      T.el('div', { class: 'tia-modal-foot' }, cancel, ok)
    );
    const overlay = T.el('div', { class: 'tia-modal-ov' }, modal);

    // click outside the dialog closes it
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) closeModal(); });
    // Enter = OK, Esc = cancel (while focus is inside the modal)
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doOk(); }
      else if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
    });

    function doOk() {
      errEl.textContent = '';
      const res = cfg.onOk(showErr);
      if (res !== false) closeModal();
    }
    function showErr(msg) { errEl.textContent = msg || ''; }

    document.body.appendChild(overlay);
    modalCleanup = () => { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); };

    // focus the requested field
    setTimeout(() => {
      const f = cfg.focusEl || (cfg.rows[0] && cfg.rows[0].field);
      if (f && f.focus) { f.focus(); if (f.select) f.select(); }
    }, 0);

    return overlay;
  }

  /* --------------------------------------------------------- add new block */
  function openAddBlockModal() {
    closeContextMenu();
    if (!T.project) { T.status('No project loaded.', 'warn'); return; }

    const nameInp = T.el('input', { class: 'tia-input', type: 'text', value: 'Block' });
    const typeSel = T.el('select', { class: 'tia-input' },
      T.el('option', { value: 'OB' }, 'OB — Organization block'),
      T.el('option', { value: 'FC' }, 'FC — Function'),
      T.el('option', { value: 'FB' }, 'FB — Function block')
    );
    const langSel = T.el('select', { class: 'tia-input' },
      T.el('option', { value: 'LAD' }, 'LAD — Ladder logic'),
      T.el('option', { value: 'FBD' }, 'FBD — Function block diagram'),
      T.el('option', { value: 'SCL' }, 'SCL — Structured Control Language')
    );

    // suggest a default name that tracks the chosen type — but stop once the user
    // has typed their own name, so changing the type later won't wipe it.
    let autoName = true;
    nameInp.addEventListener('input', () => { autoName = false; });
    function suggest() {
      if (!autoName) return;
      const t = typeSel.value;
      const n = T.nextBlockNumber(t);
      nameInp.value = (t === 'OB' ? 'Block_' : (t === 'FB' ? 'FunctionBlock_' : 'Function_')) + n;
    }
    typeSel.addEventListener('change', suggest);
    suggest();

    buildModal({
      title: 'Add new block',
      rows: [
        { label: 'Name', field: nameInp },
        { label: 'Type', field: typeSel },
        { label: 'Language', field: langSel },
      ],
      focusEl: nameInp,
      onOk(showErr) {
        const name = (nameInp.value || '').trim();
        if (!name) { showErr('Please enter a block name.'); return false; }
        if (nameClash(name, null)) { showErr('A block with that name already exists.'); return false; }

        const type = typeSel.value;
        const lang = langSel.value;
        const b = T.model.newBlock(type, name, T.nextBlockNumber(type), lang);
        T.project.blocks.push(b);
        T.bus.emit('tree:changed');
        // open the freshly created block
        T.setActiveBlock(b.id);
        T.bus.emit('open:block', b);
        T.status('Created ' + b.type + b.number + ' "' + b.name + '".', 'info');
      },
    });
  }

  /* ------------------------------------------------------------- rename */
  function openRenameModal(b) {
    closeContextMenu();
    const nameInp = T.el('input', { class: 'tia-input', type: 'text', value: b.name });

    buildModal({
      title: 'Rename ' + b.type + b.number,
      rows: [{ label: 'Name', field: nameInp }],
      focusEl: nameInp,
      onOk(showErr) {
        const name = (nameInp.value || '').trim();
        if (!name) { showErr('Please enter a block name.'); return false; }
        if (nameClash(name, b.id)) { showErr('A block with that name already exists.'); return false; }
        if (name === b.name) return;   // no change — just close
        b.name = name;
        T.bus.emit('tree:changed');
        T.status('Renamed to "' + name + '".', 'info');
      },
    });
  }

  /* case-insensitive duplicate-name guard (ignoring the block being edited) */
  function nameClash(name, ownId) {
    if (!T.project) return false;
    const lc = name.toLowerCase();
    return T.project.blocks.some((x) => x.id !== ownId && (x.name || '').toLowerCase() === lc);
  }

  /* ====================================================================== */
  /*  PUBLIC API + EVENT WIRING                                              */
  /* ====================================================================== */
  T.editors = T.editors || {};
  T.editors.tree = { render };

  // Full re-render when the project or its block set changes.
  T.bus.on('project:loaded', render);
  T.bus.on('tree:changed', render);
  // Active block changed elsewhere — re-render to move the selection highlight.
  // when a block is opened (here or via a call-box double-click) keep it highlighted
  T.bus.on('block:activated', () => { const a = T.getActiveBlock(); if (a) selKey = a.id; render(); });

  // Auto-render on load. If the DOM/host isn't ready yet, wait for it.
  if (document.getElementById('tia-tree')) {
    render();
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render, { once: true });
  } else {
    render();
  }

})(window.TIA);
