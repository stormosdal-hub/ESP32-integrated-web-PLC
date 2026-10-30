/* ===========================================================================
 * TIA-like Browser PLC IDE  —  iface.js
 * Two related editors that live above/around the network editors:
 *
 *   1) Block interface editor  (T.editors.iface)
 *      A collapsible "Block interface" table for an OB / FC / FB. Edits the
 *      typed local declarations on `block.iface` (input / output / inout /
 *      static / temp / constant — whichever sections the block type has).
 *
 *   2) Instance Data Block view  (T.editors.db)
 *      A read-only structure + live-monitor view of an instance DB that backs
 *      one FB call. Shows the FB's input/output/inout/static members and their
 *      current simulation values.
 *
 * Public API (attached to window.TIA):
 *   T.editors.iface = { render(hostEl, block) }
 *   T.editors.db    = { render(hostEl, dbBlock) }
 *
 * Bus:
 *   emits   'iface:changed' (block) + 'tree:changed'  on any interface edit.
 *   listens 'sim:tick'      -> refresh the DB monitor values (if mounted).
 *           'iface:changed' -> refresh the DB view (its structure may have changed).
 *
 * Pure vanilla JS, file:// safe. Only uses window.TIA.* helpers from core.js.
 * Styled to mirror tags.js (petrol header rows, light table, in-cell editors).
 * =========================================================================*/
(function (T) {
  'use strict';

  /* -------------------------------------------------------- component CSS */
  // Reuses the same visual language as the tag table: a petrol/grey header,
  // borderless in-cell inputs that get a petrol focus ring, and subtle
  // "section" rows in a lighter petrol tint to group members by section.
  T.injectCSS('tia-iface-css', `
    /* ---- Block interface panel ---- */
    .tia-iface { border-bottom: 1px solid var(--tia-border);
      background: var(--tia-canvas); font-size: 12px; }

    /* header bar with twisty (collapses the whole panel) */
    .tia-iface-head { display: flex; align-items: center; gap: 6px;
      height: 24px; padding: 0 8px; cursor: pointer; user-select: none;
      background: var(--tia-panel-head); color: #fff; font-weight: 600; }
    .tia-iface-head:hover { background: var(--tia-petrol-dark); }
    .tia-iface-head .tia-iface-tw { width: 12px; display: inline-flex;
      justify-content: center; font-size: 11px; }
    .tia-iface-head .tia-iface-htitle { font-size: 11.5px; }

    /* scroll body (hidden when collapsed) */
    .tia-iface-body { max-height: 240px; overflow: auto; }

    table.tia-iface-table { border-collapse: collapse; width: 100%;
      font-size: 12px; table-layout: fixed; }
    table.tia-iface-table th {
      background: var(--tia-panel-head); color: #fff; font-weight: 600;
      text-align: left; padding: 3px 7px; position: sticky; top: 0; z-index: 1;
      border-right: 1px solid rgba(255,255,255,.18); white-space: nowrap; }
    table.tia-iface-table td {
      border: 1px solid var(--tia-border-soft); padding: 0; height: 23px;
      vertical-align: middle; }

    /* a "section" header row (Input / Output / ...) spanning the table */
    table.tia-iface-table tr.tia-iface-section td {
      background: var(--tia-net-head); color: var(--tia-petrol-deep);
      font-weight: 700; padding: 2px 7px; height: 21px; letter-spacing: .2px;
      border-top: 1px solid var(--tia-border); }

    table.tia-iface-table tr.tia-iface-row:nth-child(even) td { background: var(--tia-row-alt); }
    table.tia-iface-table tr.tia-iface-row:hover td { background: var(--tia-hover); }

    /* in-cell editors fill the cell, borderless until focus (like tags.js) */
    table.tia-iface-table .tia-iface-cell {
      width: 100%; height: 100%; min-height: 21px; box-sizing: border-box;
      border: 1px solid transparent; background: transparent; color: var(--tia-text);
      font-family: inherit; font-size: 12px; padding: 2px 6px; }
    table.tia-iface-table select.tia-iface-cell { cursor: pointer; }
    table.tia-iface-table .tia-iface-cell:focus {
      outline: none; background: #fff; border-color: var(--tia-petrol);
      box-shadow: inset 0 0 0 1px rgba(0,153,153,.25); }
    table.tia-iface-table .col-iname .tia-iface-cell { font-weight: 600; }
    .tia-iname-wrap { display: flex; align-items: center; gap: 3px; }
    .tia-iname-wrap .tia-iface-cell { flex: 1 1 auto; min-width: 0; }
    .tia-iface-grip { cursor: grab; color: var(--tia-text-soft); user-select: none;
      font-size: 11px; line-height: 1; padding: 0 1px; flex: 0 0 auto; }
    .tia-iface-grip:hover { color: var(--tia-petrol); }
    .tia-iface-grip:active { cursor: grabbing; }

    /* delete (✕) + add (＋) affordances */
    .tia-iface-del { display: inline-flex; align-items: center; justify-content: center;
      width: 100%; height: 100%; min-height: 21px; cursor: pointer; color: var(--tia-text-soft);
      background: transparent; border: 0; font-size: 12px; }
    .tia-iface-del:hover { color: #c0392b; background: #f6d9d9; }
    table.tia-iface-table td.col-idel { width: 26px; text-align: center; }

    tr.tia-iface-add td { padding: 0; background: var(--tia-canvas); }
    .tia-iface-add-btn { display: inline-flex; align-items: center; gap: 5px;
      padding: 2px 7px; margin: 1px 0; cursor: pointer; color: var(--tia-petrol-dark);
      background: transparent; border: 0; font-size: 11.5px; }
    .tia-iface-add-btn:hover { color: var(--tia-petrol); text-decoration: underline; }

    /* ---- Instance Data Block view ---- */
    .tia-db { display: flex; flex-direction: column; height: 100%; min-height: 0;
      background: var(--tia-canvas); }
    .tia-db-head { flex: 0 0 auto; padding: 6px 9px; background: var(--tia-toolbar);
      border-bottom: 1px solid var(--tia-border); font-size: 12.5px; }
    .tia-db-head .tia-db-name { font-weight: 700; color: var(--tia-petrol-deep); }
    .tia-db-head .tia-db-sub { color: var(--tia-text-soft); }
    .tia-db-scroll { flex: 1 1 auto; overflow: auto; }

    table.tia-db-table { border-collapse: collapse; width: 100%; font-size: 12px; }
    table.tia-db-table th {
      background: var(--tia-panel-head); color: #fff; font-weight: 600; text-align: left;
      padding: 4px 7px; position: sticky; top: 0; z-index: 1;
      border-right: 1px solid rgba(255,255,255,.18); white-space: nowrap; }
    table.tia-db-table td { border: 1px solid var(--tia-border-soft); padding: 3px 7px;
      height: 23px; }
    table.tia-db-table tr:nth-child(even) td { background: var(--tia-row-alt); }
    table.tia-db-table .col-dname { font-weight: 600; }
    table.tia-db-table .col-dmon { font-family: var(--tia-mono); white-space: nowrap; }
    .tia-db-true  { color: var(--tia-live); font-weight: 700; }
    .tia-db-false { color: var(--tia-text-soft); }
    .tia-db-section { color: var(--tia-petrol-deep); font-weight: 700; }
  `);

  /* ========================================================================
   * 1) BLOCK INTERFACE EDITOR
   * ======================================================================*/

  // Collapsed state persists across re-renders (module-level, as required).
  let ifaceCollapsed = false;

  // Human label for each interface section key.
  const SECTION_LABELS = {
    input: 'Input', output: 'Output', inout: 'InOut',
    static: 'Static', temp: 'Temp', constant: 'Constant',
  };

  // After an interface edit: mutate already happened in place; notify the app.
  function notifyIface(block) {
    T.bus.emit('iface:changed', block);
    T.bus.emit('tree:changed');
  }

  // Build one editable member <tr> for `member` inside `section` of `block`.
  function buildMemberRow(block, section, member) {
    const tr = T.el('tr', { class: 'tia-iface-row', dataset: { memId: member.id } });

    /* --- Name (with a drag grip so the variable can be dropped onto a pin).
       On commit (blur/Enter) the rename is propagated to operands inside the
       block and to call-site argument pins everywhere the block is used. --- */
    const nameInput = T.el('input', {
      class: 'tia-iface-cell', type: 'text', value: member.name || '',
      placeholder: 'Name', spellcheck: 'false',
      oninput: (e) => { member.name = e.target.value; notifyIface(block); },
      onfocus: (e) => { e.target.dataset.oldName = member.name || ''; },
      onchange: (e) => {
        const old = e.target.dataset.oldName || '';
        e.target.dataset.oldName = member.name || '';
        if (!T.refactor || !old || old === member.name) return;
        const n = T.refactor.renameMember(block, old, member.name);
        if (n) {
          T.status('Renamed "' + old + '" → "' + member.name + '" — updated ' + n + ' reference(s)', 'ok');
          notifyIface(block);
          if (T.activeEditor && T.activeEditor.refresh) T.activeEditor.refresh();
        }
      },
    });
    const grip = T.el('span', {
      class: 'tia-iface-grip', title: 'Drag this variable onto an input/output pin',
      draggable: true,
      ondragstart: (e) => {
        e.stopPropagation();
        if (!member.name) { e.preventDefault(); return; }
        e.dataTransfer.setData('text/tia-tag', member.name);
        e.dataTransfer.effectAllowed = 'copy';
      },
    }, '⠿');
    tr.appendChild(T.el('td', { class: 'col-iname' },
      T.el('div', { class: 'tia-iname-wrap' }, grip, nameInput)));

    /* --- Data type (select of T.DataTypes) --- */
    const typeSel = T.el('select', {
      class: 'tia-iface-cell',
      onchange: (e) => { member.dataType = e.target.value; notifyIface(block); },
    });
    T.DataTypes.forEach((dt) => {
      typeSel.appendChild(T.el('option', { value: dt, selected: member.dataType === dt }, dt));
    });
    // Preserve an unknown stored dataType so it is not silently lost.
    if (T.DataTypes.indexOf(member.dataType) < 0 && member.dataType) {
      typeSel.appendChild(T.el('option', { value: member.dataType, selected: true }, member.dataType));
    }
    tr.appendChild(T.el('td', { class: 'col-itype' }, typeSel));

    /* --- Default value --- */
    const defInput = T.el('input', {
      class: 'tia-iface-cell', type: 'text',
      value: member.default != null ? member.default : '',
      placeholder: '', spellcheck: 'false',
      oninput: (e) => { member.default = e.target.value; notifyIface(block); },
    });
    tr.appendChild(T.el('td', { class: 'col-idef' }, defInput));

    /* --- Comment --- */
    const cmtInput = T.el('input', {
      class: 'tia-iface-cell', type: 'text', value: member.comment || '',
      placeholder: 'Comment',
      oninput: (e) => { member.comment = e.target.value; notifyIface(block); },
    });
    tr.appendChild(T.el('td', { class: 'col-icmt' }, cmtInput));

    /* --- Delete (✕) --- */
    const del = T.el('button', {
      class: 'tia-iface-del', type: 'button', title: 'Delete member',
      onclick: () => removeMember(block, section, member),
    }, '✕');
    tr.appendChild(T.el('td', { class: 'col-idel' }, del));

    return tr;
  }

  // Remove a member from a section, then re-render the panel.
  function removeMember(block, section, member) {
    const arr = block.iface[section] || [];
    const i = arr.indexOf(member);
    if (i >= 0) arr.splice(i, 1);
    notifyIface(block);
    renderIface();   // structure changed -> rebuild
  }

  // Add a fresh member to a section, re-render, then focus its name cell.
  function addMember(block, section) {
    const arr = block.iface[section] || (block.iface[section] = []);
    const initial = (SECTION_LABELS[section] || section).charAt(0); // I/O/S/T/C ...
    const member = T.model.newMember(initial + (arr.length + 1), 'Bool');
    arr.push(member);
    notifyIface(block);
    renderIface();

    // Focus the new member's name input so the user can type immediately.
    if (ifaceHost) {
      const row = T.$('.tia-iface-table tr[data-mem-id="' + member.id + '"]', ifaceHost);
      if (row) {
        const nameInput = row.querySelector('.col-iname .tia-iface-cell');
        if (nameInput) { nameInput.focus({ preventScroll: true }); nameInput.select(); }
        row.scrollIntoView({ block: 'nearest' });   // scrolls only within the interface pane now
      }
    }
  }

  // Module state for the interface panel (so add/delete can re-render in place).
  let ifaceHost = null;
  let ifaceBlock = null;

  // Render the whole interface panel into `ifaceHost` for `ifaceBlock`.
  function renderIface() {
    if (!ifaceHost) return;
    T.clear(ifaceHost);
    const block = ifaceBlock;
    // Nothing to show for a missing block or a DB (handled by render(), but guard again).
    if (!block || block.type === 'DB') return;

    T.ensureInterface(block);

    const wrap = T.el('div', { class: 'tia-iface' });

    /* ------------------------------ header ------------------------------ */
    const head = T.el('div', {
      class: 'tia-iface-head', title: ifaceCollapsed ? 'Expand interface' : 'Collapse interface',
      onclick: () => { ifaceCollapsed = !ifaceCollapsed; renderIface(); },
    },
      T.el('span', { class: 'tia-iface-tw' }, ifaceCollapsed ? '▸' : '▾'), // ▸ / ▾
      T.el('span', { class: 'tia-iface-htitle' }, 'Block interface')
    );
    wrap.appendChild(head);

    /* ------------------------------- body ------------------------------- */
    if (!ifaceCollapsed) {
      const body = T.el('div', { class: 'tia-iface-body' });
      const thead = T.el('thead', null,
        T.el('tr', null,
          T.el('th', { style: { width: '26%' } }, 'Name'),
          T.el('th', { style: { width: '16%' } }, 'Data type'),
          T.el('th', { style: { width: '20%' } }, 'Default value'),
          T.el('th', null, 'Comment'),
          T.el('th', { style: { width: '26px' } }, '')
        ));
      const tbody = T.el('tbody');

      // One section header + its member rows + an "Add" affordance, per section.
      T.ifaceSections(block.type).forEach((section) => {
        const members = block.iface[section] || [];

        // Section label row.
        tbody.appendChild(T.el('tr', { class: 'tia-iface-section' },
          T.el('td', { colspan: 5 }, SECTION_LABELS[section] || section)));

        // Member rows.
        members.forEach((m) => tbody.appendChild(buildMemberRow(block, section, m)));

        // "＋ Add" affordance for this section.
        const addBtn = T.el('button', {
          class: 'tia-iface-add-btn', type: 'button',
          title: 'Add a ' + (SECTION_LABELS[section] || section) + ' member',
          onclick: () => addMember(block, section),
        }, '＋ Add');   // ＋ Add
        tbody.appendChild(T.el('tr', { class: 'tia-iface-add' },
          T.el('td', { colspan: 5 }, addBtn)));
      });

      body.appendChild(T.el('table', { class: 'tia-iface-table' }, thead, tbody));
      wrap.appendChild(body);
    }

    ifaceHost.appendChild(wrap);
  }

  /* ========================================================================
   * 2) INSTANCE DATA BLOCK VIEW (read-only structure + live monitor)
   * ======================================================================*/

  // Sections of the backing FB that make up the instance DB's data.
  // (temp/constant are scratch/named-constants and are NOT stored in the DB.)
  const DB_SECTIONS = ['input', 'output', 'inout', 'static'];

  // Module state for the DB view, so the bus handlers can refresh in place.
  let dbHost = null;
  let dbBlockRef = null;

  // Format a member's current monitored value. Returns a DOM node (coloured).
  function monitorCell(dbBlock, member) {
    const key = T.memberKey(dbBlock.id, member.name);
    if (member.dataType === 'Bool') {
      const on = T.mem.getBit(key);
      return T.el('span', { class: on ? 'tia-db-true' : 'tia-db-false' },
        on ? '● TRUE' : '○ FALSE');   // ● TRUE / ○ FALSE
    }
    return T.el('span', null, String(T.mem.getWord(key)));
  }

  // Render the DB view into `dbHost` for `dbBlockRef`.
  function renderDb() {
    if (dbHost && !dbHost.isConnected) { dbHost = null; dbBlockRef = null; }
    if (!dbHost) return;
    T.clear(dbHost);
    const dbBlock = dbBlockRef;
    if (!dbBlock) return;

    // Resolve the FB this DB is an instance of.
    const fb = T.findBlock(dbBlock.instanceOf);
    if (!fb) {
      dbHost.appendChild(T.el('div', { class: 'tia-empty' },
        'Instance data block "' + (dbBlock.name || '') +
        '": backing function block not found.'));
      return;
    }
    T.ensureInterface(fb);

    const wrap = T.el('div', { class: 'tia-db' });

    /* ------------------------------ header ------------------------------ */
    // e.g.  Data block  Motor_DB [DB1]  — instance of  Motor
    wrap.appendChild(T.el('div', { class: 'tia-db-head' },
      T.el('span', { class: 'tia-db-sub' }, 'Data block  '),
      T.el('span', { class: 'tia-db-name' }, dbBlock.name || ''),
      T.el('span', { class: 'tia-db-sub' }, '  [DB' + (dbBlock.number != null ? dbBlock.number : '') + ']'),
      T.el('span', { class: 'tia-db-sub' }, '  — instance of '),   // — instance of
      T.el('span', { class: 'tia-db-name' }, fb.name || '')
    ));

    /* ------------------------- structure table -------------------------- */
    const scroll = T.el('div', { class: 'tia-db-scroll' });

    // Collect members from the relevant FB sections (with their section tag).
    const rows = [];
    DB_SECTIONS.forEach((section) => {
      (fb.iface[section] || []).forEach((m) => rows.push({ section, member: m }));
    });

    if (rows.length === 0) {
      scroll.appendChild(T.el('div', { class: 'tia-empty' },
        'This function block declares no stored data (input/output/inout/static).'));
    } else {
      const thead = T.el('thead', null,
        T.el('tr', null,
          T.el('th', null, 'Name'),
          T.el('th', null, 'Data type'),
          T.el('th', null, 'Default'),
          T.el('th', null, 'Monitor value'),
          T.el('th', null, 'Comment')
        ));
      const tbody = T.el('tbody');
      let lastSection = null;
      rows.forEach(({ section, member }) => {
        const tr = T.el('tr', { dataset: { memName: member.name || '' } });
        // Name cell; prefix the first row of each section with the section name.
        const nameCell = T.el('td', { class: 'col-dname' });
        if (section !== lastSection) {
          nameCell.appendChild(T.el('span', { class: 'tia-db-section' },
            (SECTION_LABELS[section] || section) + ': '));
          lastSection = section;
        }
        nameCell.appendChild(T.el('span', null, member.name || ''));
        tr.appendChild(nameCell);

        tr.appendChild(T.el('td', null, member.dataType || ''));
        tr.appendChild(T.el('td', null, member.default != null ? String(member.default) : ''));
        tr.appendChild(T.el('td', { class: 'col-dmon' }, monitorCell(dbBlock, member)));
        tr.appendChild(T.el('td', null, member.comment || ''));
        tbody.appendChild(tr);
      });
      scroll.appendChild(T.el('table', { class: 'tia-db-table' }, thead, tbody));
    }

    wrap.appendChild(scroll);
    dbHost.appendChild(wrap);
  }

  // Cheap refresh of just the monitor cells (used on sim:tick).
  // Falls back to a full re-render if the host content is unexpectedly absent.
  function refreshDbValues() {
    if (!dbHost || !dbBlockRef) return;
    // the DB tab was closed / replaced: stop refreshing a detached table and
    // release the stale block reference
    if (!dbHost.isConnected) { dbHost = null; dbBlockRef = null; return; }
    const fb = T.findBlock(dbBlockRef.instanceOf);
    if (!fb) return;
    const table = dbHost.querySelector('table.tia-db-table');
    if (!table) return;   // nothing mounted (e.g. FB missing message) — skip
    // Rebuild the value column cell-by-cell. Member names are unique within a DB,
    // so [data-mem-name] is a safe selector key.
    DB_SECTIONS.forEach((section) => {
      (fb.iface[section] || []).forEach((m) => {
        const tr = table.querySelector('tr[data-mem-name="' + cssEscape(m.name || '') + '"]');
        if (!tr) return;
        const cell = tr.querySelector('.col-dmon');
        if (!cell) return;
        T.clear(cell).appendChild(monitorCell(dbBlockRef, m));
      });
    });
  }

  // Minimal attribute-selector escaping for member names used in querySelector.
  // (Names are user text; quotes/backslashes would break the selector.)
  function cssEscape(s) {
    return String(s).replace(/(["\\\]])/g, '\\$1');
  }

  /* ------------------------------------------------------ public surface */
  T.editors = T.editors || {};

  T.editors.iface = {
    // Render the collapsible block-interface panel for `block` into `hostEl`.
    // Renders nothing for a null block or a DB (those use the DB view instead).
    render(hostEl, block) {
      if (!hostEl) return;
      ifaceHost = hostEl;
      ifaceBlock = block || null;
      if (!block || block.type === 'DB') { T.clear(hostEl); ifaceBlock = null; return; }
      renderIface();
    },
  };

  T.editors.db = {
    // Render the instance-DB structure + live monitor for `dbBlock` into `hostEl`.
    render(hostEl, dbBlock) {
      if (!hostEl) return;
      dbHost = hostEl;
      dbBlockRef = (dbBlock && dbBlock.type === 'DB') ? dbBlock : null;
      renderDb();
    },
  };

  /* --------------------------------------------------------------- events */
  // Refresh live monitor values each simulation tick (only when mounted).
  T.bus.on('sim:tick', refreshDbValues);
  // The interface of the backing FB may have changed -> rebuild the DB view.
  T.bus.on('iface:changed', () => { if (dbHost && dbBlockRef) renderDb(); });

})(window.TIA);
