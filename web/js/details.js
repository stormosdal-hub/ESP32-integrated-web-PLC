/* ===========================================================================
 * TIA-like Browser PLC IDE  —  details.js
 * The "Details view" — a small pane pinned to the BOTTOM of the project-tree
 * dock. It shows the CONTENTS of whatever tree node was last selected.
 *
 * Renders into #tia-details (a .tia-details-pane container the integrator adds
 * to index.html). Layout:
 *   - a "Details" header row with a ▾/▸ twisty that collapses the body
 *   - when expanded: a caption naming the current selection, then a scrollable
 *     list of draggable rows.
 *
 * Selection arrives via the bus event `tree:select`:
 *   { kind:'tags',  ref:null  } -> every tag in T.project.tags
 *   { kind:'db',    ref:<DB>  } -> the DB's instance members (the FB's
 *                                   input/output/inout/static)
 *   { kind:'block', ref:<blk> } -> that code block's interface members
 *   anything else               -> a hint
 *
 * Every leaf row is DRAGGABLE. dragstart writes the drop payload as MIME
 * 'text/tia-tag' = the tag/member NAME (or address if the tag has no name) —
 * the SAME MIME the LAD/FBD editors already accept as drop targets.
 *
 * Public API:  T.editors.details = { render() }
 * Listens   : 'tree:select', 'project:loaded', 'tags:changed',
 *             'iface:changed', 'tree:changed'
 *
 * Uses ONLY window.TIA.* helpers. IIFE — no globals beyond T.editors.details.
 * ==========================================================================*/
(function (T) {
  'use strict';

  /* ------------------------------------------------------------ component CSS
   * Mirrors the outline/tree row + twisty conventions. Colours come only from
   * the --tia-* theme variables (no hard-coded greys). */
  T.injectCSS('tia-details-css', `
    .tia-details-pane { display: flex; flex-direction: column;
      border-top: 1px solid var(--tia-border); background: var(--tia-panel);
      user-select: none; max-height: 45%; min-height: 24px; }

    /* "Details" header bar (collapsible) */
    .tia-dt-head { flex: 0 0 auto; display: flex; align-items: center; gap: 5px;
      padding: 3px 6px; cursor: pointer; font-weight: 600; font-size: 11.5px;
      color: var(--tia-text); background: var(--tia-net-head);
      border-bottom: 1px solid var(--tia-border-soft); }
    .tia-dt-head:hover { background: var(--tia-hover); }
    .tia-dt-head .tia-twisty { width: 12px; display: inline-flex;
      justify-content: center; color: var(--tia-text-soft); transition: transform .1s; }
    .tia-dt-head .tia-twisty.open { transform: rotate(90deg); }
    .tia-dt-head .tia-twisty svg { width: 12px; height: 12px; }

    /* scrollable body */
    .tia-dt-body { flex: 1 1 auto; overflow: auto; padding: 2px 0 5px; min-height: 0; }
    .tia-dt-caption { padding: 3px 8px; color: var(--tia-text-soft);
      font-weight: 600; font-size: 11px; text-transform: uppercase;
      letter-spacing: .3px; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; }

    /* draggable leaf rows (tags + members) — same look as the outline items */
    .tia-dt-row { display: flex; align-items: center; gap: 5px; padding: 2px 6px;
      white-space: nowrap; cursor: grab; }
    .tia-dt-row:hover { background: var(--tia-hover); outline: 1px solid var(--tia-select-bd); }
    .tia-dt-row:active { cursor: grabbing; }
    .tia-dt-row .tia-tree-icon { width: 16px; height: 16px;
      color: var(--tia-petrol-dark); display: inline-flex; }
    .tia-dt-name { font-weight: 600; flex: 0 1 auto; overflow: hidden;
      text-overflow: ellipsis; }
    .tia-dt-sec { color: var(--tia-text-soft); margin-left: auto; flex: 0 0 auto;
      padding-left: 8px; font-style: italic; }
  `);

  /* ----------------------------------------------------------------- state */
  // Default to the tags view so something useful shows on first load.
  let lastSel = { kind: 'tags', ref: null };
  let collapsed = false;          // remembered across re-renders

  /* ----------------------------------------------------------- small helpers */
  function icon(name) {
    return T.el('span', { class: 'tia-tree-icon', html: T.icons[name] || '' });
  }
  function twisty(open) {
    return T.el('span', { class: 'tia-twisty' + (open ? ' open' : ''), html: T.icons.chevron });
  }

  /* A draggable leaf row.
   *   payload   : the MIME 'text/tia-tag' string written on dragstart
   *   iconName  : tree icon name
   *   name      : bold primary label
   *   secondary : muted right-aligned label
   *   title     : hover tooltip */
  function leafRow(opts) {
    const row = T.el('div', {
      class: 'tia-dt-row',
      title: opts.title || '',
      draggable: true,
      ondragstart: (e) => {
        e.stopPropagation();
        e.dataTransfer.effectAllowed = 'copy';
        e.dataTransfer.setData('text/tia-tag', opts.payload || '');
      },
    });
    row.appendChild(icon(opts.iconName || 'tag'));
    row.appendChild(T.el('span', { class: 'tia-dt-name' }, opts.name || '(unnamed)'));
    if (opts.secondary) row.appendChild(T.el('span', { class: 'tia-dt-sec' }, opts.secondary));
    return row;
  }

  /* A tag row: name (bold) + muted "address  dataType". */
  function tagRow(tag) {
    const payload = (tag.name && tag.name.trim()) ? tag.name : (tag.address || '');
    const secondary = [tag.address || '', tag.dataType || ''].filter(Boolean).join('  ');
    return leafRow({
      payload: payload,
      iconName: 'tag',
      name: tag.name || '(unnamed)',
      secondary: secondary,
      title: (tag.name || '') + ' ' + (tag.address || '') + ' — ' + (tag.comment || ''),
    });
  }

  /* A member row: name (bold) + muted "section  dataType". */
  function memberRow(section, member) {
    const secondary = [section || '', member.dataType || ''].filter(Boolean).join('  ');
    return leafRow({
      payload: member.name || '',
      iconName: 'tag',
      name: member.name || '(unnamed)',
      secondary: secondary,
      title: (member.name || '') + ' — ' + (member.comment || ''),
    });
  }

  /* ----------------------------------------------- selection resolution */
  // Re-resolve a block/db ref by id (the live object may have changed after a
  // tree:changed / iface:changed). Returns the freshest block, or the original.
  function freshRef(ref) {
    if (ref && ref.id) {
      const live = T.findBlock(ref.id);
      if (live) return live;
    }
    return ref;
  }

  // Display labels for interface section keys.
  const IFACE_LABELS = {
    input: 'Input', output: 'Output', inout: 'InOut',
    static: 'Static', temp: 'Temp', constant: 'Constant',
  };

  /* ====================================================================== */
  /*  RENDER                                                                 */
  /* ====================================================================== */
  function render() {
    const host = document.getElementById('tia-details');
    if (!host) return;
    T.clear(host);
    host.classList.add('tia-details-pane');

    /* --- header row with collapsing twisty --- */
    const head = T.el('div', {
      class: 'tia-dt-head',
      onclick: () => { collapsed = !collapsed; render(); },
    });
    head.appendChild(twisty(!collapsed));
    head.appendChild(T.el('span', null, 'Details'));
    host.appendChild(head);

    if (collapsed) return;

    /* --- body --- */
    const body = T.el('div', { class: 'tia-dt-body' });
    host.appendChild(body);

    const p = T.project;
    if (!p) {
      body.appendChild(T.el('div', { class: 'tia-empty' }, 'No project loaded'));
      return;
    }

    const kind = lastSel ? lastSel.kind : 'tags';

    /* --- tags: every project tag --- */
    if (kind === 'tags') {
      body.appendChild(T.el('div', { class: 'tia-dt-caption' }, 'PLC tags'));
      const tags = Array.isArray(p.tags) ? p.tags : [];
      if (!tags.length) {
        body.appendChild(T.el('div', { class: 'tia-empty' }, 'No tags defined'));
        return;
      }
      tags.forEach((t) => body.appendChild(tagRow(t)));
      return;
    }

    /* --- db: instance members of the backing FB --- */
    if (kind === 'db') {
      const db = freshRef(lastSel.ref);
      if (!db) {
        body.appendChild(T.el('div', { class: 'tia-empty' }, 'Data block not found'));
        return;
      }
      const fb = db.instanceOf ? T.findBlock(db.instanceOf) : null;
      body.appendChild(T.el('div', { class: 'tia-dt-caption' },
        (db.name || 'DB') + (fb ? ' (instance of ' + (fb.name || '') + ')' : '')));
      if (!fb) {
        body.appendChild(T.el('div', { class: 'tia-empty' }, 'No backing function block'));
        return;
      }
      T.ensureInterface(fb);
      // Instance data = the FB's input/output/inout/static members.
      const sections = ['input', 'output', 'inout', 'static'];
      let any = false;
      sections.forEach((sec) => {
        const members = (fb.iface && fb.iface[sec]) || [];
        members.forEach((m) => { body.appendChild(memberRow(IFACE_LABELS[sec] || sec, m)); any = true; });
      });
      if (!any) body.appendChild(T.el('div', { class: 'tia-empty' }, 'No instance data'));
      return;
    }

    /* --- block: the code block's interface members --- */
    if (kind === 'block') {
      const block = freshRef(lastSel.ref);
      if (!block) {
        body.appendChild(T.el('div', { class: 'tia-empty' }, 'Block not found'));
        return;
      }
      body.appendChild(T.el('div', { class: 'tia-dt-caption' },
        (block.name || 'Block') + ' — interface'));
      T.ensureInterface(block);
      const members = T.ifaceMembers(block);   // [{ section, member }]
      if (!members.length) {
        body.appendChild(T.el('div', { class: 'tia-empty' }, 'No interface members'));
        return;
      }
      members.forEach((mm) => body.appendChild(memberRow(IFACE_LABELS[mm.section] || mm.section, mm.member)));
      return;
    }

    /* --- anything else: hint --- */
    body.appendChild(T.el('div', { class: 'tia-empty' },
      'Select a tag table, block, or data block to see its details.'));
  }

  /* ====================================================================== */
  /*  PUBLIC API + EVENT WIRING                                              */
  /* ====================================================================== */
  T.editors = T.editors || {};
  T.editors.details = { render };

  // A node was selected in the project tree -> remember it and re-render.
  T.bus.on('tree:select', (sel) => {
    lastSel = sel && sel.kind ? sel : { kind: 'tags', ref: null };
    render();
  });
  // New project -> reset to the tags view.
  T.bus.on('project:loaded', () => { lastSel = { kind: 'tags', ref: null }; render(); });
  // Underlying data changed -> refresh the current selection (refs re-resolved
  // by id inside render via freshRef).
  T.bus.on('tags:changed', render);
  T.bus.on('iface:changed', render);
  T.bus.on('tree:changed', render);

  // Auto-render on load once the host exists.
  if (document.getElementById('tia-details')) {
    render();
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render, { once: true });
  } else {
    render();
  }

})(window.TIA);
