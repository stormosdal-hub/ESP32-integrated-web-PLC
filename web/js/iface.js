/* ===========================================================================
 * TIA-like Browser PLC IDE  —  iface.js
 * The declaration editors and the data block view:
 *
 *   1) Block interface editor  (T.editors.iface)
 *      A collapsible "Block interface" table for an OB / FC / FB. Edits the
 *      typed local declarations on `block.iface` (input / output / inout /
 *      static / temp / constant / an FC's return type).
 *
 *   2) PLC data type editor  (T.editors.udt)
 *      The members of a PLC data type (project.types[i]), opened as a tab.
 *
 *   3) Data block view  (T.editors.db)
 *      Instance DBs (of an FB), global DBs (own members, or of a PLC data
 *      type): the typed structure with offsets, start values (editable) and
 *      live values — from the simulator, or from the ESP32 while monitoring
 *      online (online.js fetches the DB's bytes, see watching()). A global DB
 *      with its own members gets the member editor above the table.
 *
 * All three member tables share one editor: data types are typed freely
 * (with suggestions: elementary types, String[n], Array[..] of T, Struct,
 * DTL, system FBs, PLC data types, FBs) and checked as you go; a Struct
 * member opens nested rows for its members.
 *
 * Public API (attached to window.TIA):
 *   T.editors.iface = { render(hostEl, block) }
 *   T.editors.udt   = { open(hostEl, type) }
 *   T.editors.db    = { render(hostEl, dbBlock), watching() -> [DB names] }
 *
 * Bus:
 *   emits   'iface:changed' (block / DB) + 'tree:changed' on an interface edit,
 *           'types:changed' (type) on a data type edit.
 *   listens 'sim:tick' -> refresh the DB view's values,
 *           'iface:changed' / 'types:changed' -> rebuild the DB view's table.
 *
 * Pure vanilla JS, file:// safe. Only uses window.TIA.* helpers from core.js.
 * =========================================================================*/
(function (T) {
  'use strict';

  /* -------------------------------------------------------- component CSS */
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
    .tia-iface.tall .tia-iface-body { max-height: none; }

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
    table.tia-iface-table .tia-iface-cell:focus {
      outline: none; background: #fff; border-color: var(--tia-petrol);
      box-shadow: inset 0 0 0 1px rgba(0,153,153,.25); }
    table.tia-iface-table .tia-iface-cell:disabled { color: var(--tia-text-soft); }
    table.tia-iface-table .tia-iface-cell.tia-dt-bad { color: #c0392b;
      text-decoration: underline wavy #c0392b; text-underline-offset: 3px; }
    table.tia-iface-table .col-iname .tia-iface-cell { font-weight: 600; }
    .tia-iname-wrap { display: flex; align-items: center; gap: 3px; }
    .tia-iname-wrap .tia-iface-cell { flex: 1 1 auto; min-width: 0; }
    .tia-iname-wrap .tia-iface-nest { color: var(--tia-text-soft); font-size: 11px; flex: 0 0 auto; }
    .tia-iface-grip { cursor: grab; color: var(--tia-text-soft); user-select: none;
      font-size: 11px; line-height: 1; padding: 0 1px; flex: 0 0 auto; }
    .tia-iface-grip:hover { color: var(--tia-petrol); }
    .tia-iface-grip:active { cursor: grabbing; }
    .tia-iface-fixed { padding: 2px 7px; color: var(--tia-text-soft); font-weight: 600; }

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

    /* ---- PLC data type editor ---- */
    .tia-udt { display: flex; flex-direction: column; height: 100%; min-height: 0;
      background: var(--tia-canvas); }
    .tia-udt-scroll { flex: 1 1 auto; overflow: auto; }
    .tia-udt-cmt { width: 100%; box-sizing: border-box; margin-top: 4px; }

    /* ---- Data block view ---- */
    .tia-db { display: flex; flex-direction: column; height: 100%; min-height: 0;
      background: var(--tia-canvas); }
    .tia-db-head { flex: 0 0 auto; padding: 6px 9px; background: var(--tia-toolbar);
      border-bottom: 1px solid var(--tia-border); font-size: 12.5px; }
    .tia-db-head .tia-db-name { font-weight: 700; color: var(--tia-petrol-deep); }
    .tia-db-head .tia-db-sub { color: var(--tia-text-soft); }
    .tia-db-decl { flex: 0 0 auto; }
    .tia-db-scroll { flex: 1 1 auto; overflow: auto; min-height: 0; }
    .tia-db-err { padding: 10px; color: #c0392b; }

    table.tia-db-table { border-collapse: collapse; width: 100%; font-size: 12px; }
    table.tia-db-table th {
      background: var(--tia-panel-head); color: #fff; font-weight: 600; text-align: left;
      padding: 4px 7px; position: sticky; top: 0; z-index: 1;
      border-right: 1px solid rgba(255,255,255,.18); white-space: nowrap; }
    table.tia-db-table td { border: 1px solid var(--tia-border-soft); padding: 2px 7px;
      height: 21px; white-space: nowrap; }
    table.tia-db-table tr:nth-child(even) td { background: var(--tia-row-alt); }
    table.tia-db-table .col-dname { font-weight: 600; }
    table.tia-db-table .col-doff { color: var(--tia-text-soft); font-family: var(--tia-mono); }
    table.tia-db-table .col-dmon { font-family: var(--tia-mono); }
    table.tia-db-table td.col-dstart { padding: 0; }
    table.tia-db-table .tia-db-start { width: 100%; box-sizing: border-box; height: 21px;
      border: 1px solid transparent; background: transparent; font-family: var(--tia-mono);
      font-size: 12px; padding: 1px 6px; color: var(--tia-text); }
    table.tia-db-table .tia-db-start:focus { outline: none; background: #fff; border-color: var(--tia-petrol); }
    table.tia-db-table .tia-db-start.bad { color: #c0392b; }
    .tia-db-tw { display: inline-block; width: 12px; cursor: pointer; color: var(--tia-text-soft);
      user-select: none; }
    .tia-db-tw:hover { color: var(--tia-petrol); }
    .tia-db-true  { color: var(--tia-live); font-weight: 700; }
    .tia-db-false { color: var(--tia-text-soft); }
    .tia-db-section { color: var(--tia-petrol-deep); font-weight: 700; }
    .tia-db-more { color: var(--tia-text-soft); font-style: italic; }
  `);

  /* ========================================================================
   * SHARED: data type suggestions, checks, the member table
   * ======================================================================*/
  const ELEMENTARY = ['Bool', 'Byte', 'Word', 'DWord', 'SInt', 'USInt', 'Int', 'UInt', 'DInt', 'UDInt',
    'Real', 'LReal', 'Time', 'Date', 'Time_Of_Day', 'Char'];
  const COMMON = ['String', 'String[20]', 'Array[0..9] of Int', 'Array[0..15] of Bool', 'Struct', 'DTL',
    'IEC_TIMER', 'TON', 'TOF', 'TP', 'R_TRIG', 'F_TRIG', 'CTU', 'CTD', 'CTUD',
    'TCON_IP_v4', 'TCON', 'TDISCON', 'TSEND', 'TRCV', 'Variant'];
  let dtSig = '';
  // the <datalist> behind every data type cell (rebuilt when types / FBs change)
  function typeListId() {
    const p = T.project || {};
    const names = ELEMENTARY.concat(COMMON,
      (p.types || []).map((u) => '"' + u.name + '"'),
      (p.blocks || []).filter((b) => b.type === 'FB').map((b) => '"' + b.name + '"'));
    const sig = names.join('|');
    let dl = document.getElementById('tia-dt-list');
    if (!dl) { dl = T.el('datalist', { id: 'tia-dt-list' }); document.body.appendChild(dl); dtSig = ''; }
    if (sig !== dtSig) {
      T.clear(dl);
      names.forEach((n) => dl.appendChild(T.el('option', { value: n })));
      dtSig = sig;
    }
    return 'tia-dt-list';
  }
  // Struct, or Array[..] of Struct: its members are listed below it
  const isStruct = (dt) => /(^|\s)struct\s*$/i.test(String(dt || '').trim());
  // why a member's data type does not work, or null
  function typeError(m) {
    if (!T.types || !String(m.name || '').trim()) return null;
    try { T.types.memberType(m); return null; } catch (e) { return e.message; }
  }

  /* A member table: rows for `list`, nested Struct members indented below
   * their struct with their own "＋ Add". ctx:
   *   notify()    a value changed (no re-render: the user may be typing)
   *   rerender()  the structure changed
   *   block       code block whose renames propagate to its call sites
   *   grip        draggable name grip (variables of a code block)
   *   cols        number of table columns (for the add / section rows) */
  function memberRows(ctx, tbody, list, depth) {
    list.forEach((m) => {
      tbody.appendChild(memberRow(ctx, list, m, depth));
      if (isStruct(m.dataType)) {
        if (!Array.isArray(m.members)) m.members = [];
        memberRows(ctx, tbody, m.members, depth + 1);
        tbody.appendChild(addRow(ctx, m.members, depth + 1, 'Add a member of ' + (m.name || 'the struct')));
      }
    });
  }

  function memberRow(ctx, list, member, depth) {
    const tr = T.el('tr', { class: 'tia-iface-row', dataset: { memId: member.id || '' } });

    /* --- Name (code blocks: with a drag grip so the variable can be dropped
       onto a pin). A top-level rename propagates to operands inside the block
       and to call-site argument pins everywhere the block is used. --- */
    const nameInput = T.el('input', {
      class: 'tia-iface-cell', type: 'text', value: member.name || '',
      placeholder: 'Name', spellcheck: 'false',
      oninput: (e) => { member.name = e.target.value; ctx.notify(); },
      onfocus: (e) => { e.target.dataset.oldName = member.name || ''; },
      onchange: (e) => {
        const old = e.target.dataset.oldName || '';
        e.target.dataset.oldName = member.name || '';
        if (!ctx.block || depth || !T.refactor || !old || old === member.name) return;
        const n = T.refactor.renameMember(ctx.block, old, member.name);
        if (n) {
          T.status('Renamed "' + old + '" → "' + member.name + '" — updated ' + n + ' reference(s)', 'ok');
          ctx.notify();
          if (T.activeEditor && T.activeEditor.refresh) T.activeEditor.refresh();
        }
      },
    });
    const wrap = T.el('div', { class: 'tia-iname-wrap', style: { paddingLeft: (depth * 14) + 'px' } });
    if (ctx.grip && !depth) {
      wrap.appendChild(T.el('span', {
        class: 'tia-iface-grip', title: 'Drag this variable onto an input/output pin',
        draggable: true,
        ondragstart: (e) => {
          e.stopPropagation();
          if (!member.name) { e.preventDefault(); return; }
          e.dataTransfer.setData('text/tia-tag', member.name);
          e.dataTransfer.effectAllowed = 'copy';
        },
      }, '⠿'));
    } else if (depth) wrap.appendChild(T.el('span', { class: 'tia-iface-nest' }, '└'));
    wrap.appendChild(nameInput);
    tr.appendChild(T.el('td', { class: 'col-iname' }, wrap));

    /* --- Data type: typed freely, suggestions from the datalist --- */
    const typeInput = T.el('input', {
      class: 'tia-iface-cell', type: 'text', value: member.dataType || '', list: typeListId(),
      spellcheck: 'false', placeholder: 'Data type',
      oninput: (e) => { member.dataType = e.target.value; ctx.notify(); },
      onchange: (e) => {
        member.dataType = e.target.value.trim();
        if (isStruct(member.dataType) && !Array.isArray(member.members)) member.members = [];
        ctx.notify();
        ctx.rerender();
      },
    });
    const bad = typeError(member);
    if (bad) { typeInput.classList.add('tia-dt-bad'); typeInput.title = bad; }
    tr.appendChild(T.el('td', { class: 'col-itype' }, typeInput));

    /* --- Default value (none for a Struct: its members have their own) --- */
    const defInput = T.el('input', {
      class: 'tia-iface-cell', type: 'text',
      value: member.default != null ? member.default : '',
      placeholder: '', spellcheck: 'false', disabled: isStruct(member.dataType),
      oninput: (e) => { member.default = e.target.value; ctx.notify(); },
    });
    tr.appendChild(T.el('td', { class: 'col-idef' }, defInput));

    /* --- Comment --- */
    tr.appendChild(T.el('td', { class: 'col-icmt' }, T.el('input', {
      class: 'tia-iface-cell', type: 'text', value: member.comment || '',
      placeholder: 'Comment',
      oninput: (e) => { member.comment = e.target.value; ctx.notify(); },
    })));

    /* --- Delete (✕) --- */
    tr.appendChild(T.el('td', { class: 'col-idel' }, T.el('button', {
      class: 'tia-iface-del', type: 'button', title: 'Delete member',
      onclick: () => {
        const i = list.indexOf(member);
        if (i >= 0) list.splice(i, 1);
        ctx.notify();
        ctx.rerender();
      },
    }, '✕')));
    return tr;
  }

  function addRow(ctx, list, depth, title, prefix) {
    const btn = T.el('button', {
      class: 'tia-iface-add-btn', type: 'button', title,
      style: { marginLeft: (depth * 14) + 'px' },
      onclick: () => {
        const m = T.model.newMember((prefix || 'm') + (list.length + 1), 'Bool');
        list.push(m);
        ctx.notify();
        ctx.rerender();
        focusMember(ctx.host, m);
      },
    }, '＋ Add');
    return T.el('tr', { class: 'tia-iface-add' }, T.el('td', { colspan: ctx.cols || 5 }, btn));
  }

  // focus a freshly added member's name cell
  function focusMember(host, m) {
    if (!host) return;
    const row = host.querySelector('tr[data-mem-id="' + cssEscape(m.id || '') + '"]');
    if (!row) return;
    const nameInput = row.querySelector('.col-iname .tia-iface-cell');
    if (nameInput) { nameInput.focus({ preventScroll: true }); nameInput.select(); }
    row.scrollIntoView({ block: 'nearest' });
  }

  function memberTable(sectionsFn) {
    const thead = T.el('thead', null,
      T.el('tr', null,
        T.el('th', { style: { width: '26%' } }, 'Name'),
        T.el('th', { style: { width: '22%' } }, 'Data type'),
        T.el('th', { style: { width: '16%' } }, 'Default value'),
        T.el('th', null, 'Comment'),
        T.el('th', { style: { width: '26px' } }, '')
      ));
    const tbody = T.el('tbody');
    sectionsFn(tbody);
    return T.el('table', { class: 'tia-iface-table' }, thead, tbody);
  }

  /* ========================================================================
   * 1) BLOCK INTERFACE EDITOR
   * ======================================================================*/

  // Collapsed state persists across re-renders (module-level, as required).
  let ifaceCollapsed = false;

  // Human label for each interface section key.
  const SECTION_LABELS = {
    input: 'Input', output: 'Output', inout: 'InOut',
    static: 'Static', temp: 'Temp', constant: 'Constant', return: 'Return',
  };

  // After an interface edit: mutate already happened in place; notify the app.
  function notifyIface(block) {
    T.bus.emit('iface:changed', block);
    T.bus.emit('tree:changed');
  }

  // Module state for the interface panel (so add/delete can re-render in place).
  let ifaceHost = null;
  let ifaceBlock = null;

  // An FC's return type: one row, "Void" = no return value
  function returnRow(block) {
    const list = block.iface.return;
    const cur = list[0] ? list[0].dataType : 'Void';
    const input = T.el('input', {
      class: 'tia-iface-cell', type: 'text', value: cur, list: typeListId(), spellcheck: 'false',
      title: 'Return type (RET_VAL); Void = none',
      onchange: (e) => {
        const v = e.target.value.trim();
        if (!v || /^void$/i.test(v)) list.length = 0;
        else if (list[0]) list[0].dataType = v;
        else list.push(T.model.newMember('RET_VAL', v));
        notifyIface(block);
        renderIface();
      },
    });
    const bad = list[0] && typeError(list[0]);
    if (bad) { input.classList.add('tia-dt-bad'); input.title = bad; }
    return T.el('tr', { class: 'tia-iface-row' },
      T.el('td', null, T.el('div', { class: 'tia-iface-fixed' }, block.name || 'RET_VAL')),
      T.el('td', null, input),
      T.el('td', { colspan: 3 })
    );
  }

  // Render the whole interface panel into `ifaceHost` for `ifaceBlock`.
  function renderIface() {
    if (!ifaceHost) return;
    const scroller = ifaceHost.querySelector('.tia-iface-body');
    const keep = scroller ? scroller.scrollTop : 0;
    T.clear(ifaceHost);
    const block = ifaceBlock;
    // Nothing to show for a missing block or a DB (handled by render(), but guard again).
    if (!block || block.type === 'DB') return;

    T.ensureInterface(block);

    const wrap = T.el('div', { class: 'tia-iface' });

    /* ------------------------------ header ------------------------------ */
    wrap.appendChild(T.el('div', {
      class: 'tia-iface-head', title: ifaceCollapsed ? 'Expand interface' : 'Collapse interface',
      onclick: () => { ifaceCollapsed = !ifaceCollapsed; renderIface(); },
    },
      T.el('span', { class: 'tia-iface-tw' }, ifaceCollapsed ? '▸' : '▾'),
      T.el('span', { class: 'tia-iface-htitle' }, 'Block interface')
    ));

    /* ------------------------------- body ------------------------------- */
    if (!ifaceCollapsed) {
      const body = T.el('div', { class: 'tia-iface-body' });
      const ctx = { block, grip: true, cols: 5, host: ifaceHost, notify: () => notifyIface(block), rerender: renderIface };
      body.appendChild(memberTable((tbody) => {
        // One section header + its member rows + an "Add" affordance, per section.
        T.ifaceSections(block.type).forEach((section) => {
          tbody.appendChild(T.el('tr', { class: 'tia-iface-section' },
            T.el('td', { colspan: 5 }, SECTION_LABELS[section] || section)));
          if (section === 'return') { tbody.appendChild(returnRow(block)); return; }
          const members = block.iface[section] || (block.iface[section] = []);
          memberRows(ctx, tbody, members, 0);
          const initial = (SECTION_LABELS[section] || section).charAt(0);   // I/O/S/T/C ...
          tbody.appendChild(addRow(ctx, members, 0, 'Add a ' + (SECTION_LABELS[section] || section) + ' member', initial));
        });
      }));
      wrap.appendChild(body);
      ifaceHost.appendChild(wrap);
      body.scrollTop = keep;
      return;
    }
    ifaceHost.appendChild(wrap);
  }

  /* ========================================================================
   * 2) PLC DATA TYPE EDITOR
   * ======================================================================*/
  let udtHost = null, udtRef = null;
  function notifyType(t) {
    T.bus.emit('types:changed', t);
  }
  function renderUdt() {
    if (!udtHost) return;
    const old = udtHost.querySelector('.tia-udt-scroll');
    const keep = old ? old.scrollTop : 0;
    T.clear(udtHost);
    const ty = udtRef;
    if (!ty) return;
    if (!Array.isArray(ty.members)) ty.members = [];
    const wrap = T.el('div', { class: 'tia-udt' });
    const cmt = T.el('input', {
      class: 'tia-input tia-udt-cmt', type: 'text', value: ty.comment || '', placeholder: 'Comment',
      oninput: (e) => { ty.comment = e.target.value; notifyType(ty); },
    });
    let err = null;
    try { T.types.parse('"' + ty.name + '"'); } catch (e) { err = e.message; }
    let size = '';
    if (!err) try { size = ' — ' + T.types.parse('"' + ty.name + '"').size + ' bytes'; } catch (e) { /* shown above */ }
    wrap.appendChild(T.el('div', { class: 'tia-db-head' },
      T.el('span', { class: 'tia-db-sub' }, 'PLC data type  '),
      T.el('span', { class: 'tia-db-name' }, '"' + (ty.name || '') + '"'),
      T.el('span', { class: 'tia-db-sub' }, size),
      err ? T.el('div', { class: 'tia-db-err', style: { padding: '4px 0 0' } }, '✖ ' + err) : null,
      cmt));
    const scroll = T.el('div', { class: 'tia-udt-scroll' });
    const panel = T.el('div', { class: 'tia-iface tall' });
    const body = T.el('div', { class: 'tia-iface-body' });
    const ctx = { cols: 5, host: udtHost, notify: () => notifyType(ty), rerender: renderUdt };
    body.appendChild(memberTable((tbody) => {
      memberRows(ctx, tbody, ty.members, 0);
      tbody.appendChild(addRow(ctx, ty.members, 0, 'Add a member', 'm'));
    }));
    panel.appendChild(body);
    scroll.appendChild(panel);
    wrap.appendChild(scroll);
    udtHost.appendChild(wrap);
    scroll.scrollTop = keep;
  }

  /* ========================================================================
   * 3) DATA BLOCK VIEW
   * ======================================================================*/
  let dbHost = null, dbBlockRef = null, dbTableHost = null, dbCells = [];
  const dbOpen = new Set();          // expanded rows: '<db id>|<path>'
  const MAX_ELEMENTS = 100;          // array elements listed before "… n more"
  const pad2 = (n) => String(n).padStart(2, '0');

  // the DB's memory (simulator; online.js copies the PLC's bytes into it)
  function dbMemory(db) {
    try { return T.inst.db(db); } catch (e) { return null; }
  }

  function fmtValue(t, buf, off, bit) {
    if (t.k === 'str') return "'" + T.types.strRead(buf, off, t) + "'";
    if (t.k !== 'el') return '';
    const v = T.types.read(buf, off, bit, t);
    switch (t.cls) {
      case 'bool': return v ? 'TRUE' : 'FALSE';
      case 'bits': return '16#' + (v >>> 0).toString(16).toUpperCase().padStart(t.size * 2, '0');
      case 'time': return v < 0 ? '-' + T.fmtTime(-v) : T.fmtTime(v);
      case 'date': {
        const d = T.types.daysToCivil(v + 7305);   // days since 1990-01-01
        return 'D#' + d[0] + '-' + pad2(d[1]) + '-' + pad2(d[2]);
      }
      case 'tod':
        return 'TOD#' + pad2(Math.floor(v / 3600000)) + ':' + pad2(Math.floor(v / 60000) % 60) + ':' +
          pad2(Math.floor(v / 1000) % 60) + '.' + String(v % 1000).padStart(3, '0');
      case 'char': return "'" + String.fromCharCode(v) + "'";
      default: return String(v);
    }
  }
  function fmtDtl(buf, off) {
    const y = (buf[off] << 8) | buf[off + 1];
    const ns = ((buf[off + 8] << 24) | (buf[off + 9] << 16) | (buf[off + 10] << 8) | buf[off + 11]) >>> 0;
    return 'DTL#' + y + '-' + pad2(buf[off + 2]) + '-' + pad2(buf[off + 3]) + '-' + pad2(buf[off + 5]) + ':' +
      pad2(buf[off + 6]) + ':' + pad2(buf[off + 7]) + '.' + String(Math.floor(ns / 1e6)).padStart(3, '0');
  }
  function monitorText(t, buf, off, bit) {
    if (t.k === 'struct' && t.name && t.name.toUpperCase() === 'DTL') return fmtDtl(buf, off);
    return fmtValue(t, buf, off, bit);
  }
  function paintMonitor(cell, t, buf, off, bit) {
    const s = monitorText(t, buf, off, bit);
    if (cell._last === s) return;
    cell._last = s;
    cell.textContent = s;
    cell.className = 'col-dmon' + (t.k === 'el' && t.cls === 'bool' ? (s === 'TRUE' ? ' tia-db-true' : ' tia-db-false') : '');
  }

  // a start value literal the type accepts (empty = none)
  function startOk(t, text) {
    const s = String(text || '').trim();
    if (!s) return true;
    const lit = T.types.parseLiteral(s);
    if (!lit) return false;
    return t.k === 'str' ? lit.s != null : lit.v != null;
  }

  // sections of an FB instance that are not stored in the instance DB
  const HIDDEN_SECTIONS = { temp: 1, const: 1 };
  const SECTION_NAMES = { in: 'Input', out: 'Output', inout: 'InOut', stat: 'Static', ret: 'Return' };

  function dbRow(ctx, item) {
    const { t, off, bit, path, label, depth, meta } = item;
    const composite = t.k === 'struct' || t.k === 'fb' || t.k === 'arr';
    const key = ctx.db.id + '|' + path;
    const open = composite && dbOpen.has(key);
    const tr = T.el('tr');
    const nameCell = T.el('td', { class: 'col-dname', style: { paddingLeft: (7 + depth * 16) + 'px' } });
    nameCell.appendChild(T.el('span', {
      class: 'tia-db-tw',
      onclick: composite ? () => { if (open) dbOpen.delete(key); else dbOpen.add(key); renderDbTable(); } : null,
    }, composite ? (open ? '▾' : '▸') : ''));
    if (meta && meta.section) nameCell.appendChild(T.el('span', { class: 'tia-db-section' }, meta.section + ': '));
    nameCell.appendChild(T.el('span', null, label));
    tr.appendChild(nameCell);
    tr.appendChild(T.el('td', null, meta && meta.ref ? T.types.typeName(meta.reft) + ' (reference)' : T.types.typeName(t)));
    tr.appendChild(T.el('td', { class: 'col-doff' }, off + '.' + (t.k === 'el' && t.cls === 'bool' ? bit : 0)));

    /* start value: elementary and String leaves (written as in a source file) */
    const sc = T.el('td', { class: 'col-dstart' });
    if (!composite && !(meta && meta.ref) && (t.k === 'el' || t.k === 'str')) {
      const sv = ctx.db.startValues || {};
      const inp = T.el('input', {
        class: 'tia-db-start', type: 'text', spellcheck: 'false',
        value: sv[path] != null ? sv[path] : '',
        placeholder: meta && meta.def != null && String(meta.def).trim() ? String(meta.def) : '',
        title: 'Start value of ' + path + ' (applies when the program is loaded / the simulation restarts)',
        oninput: (e) => e.target.classList.toggle('bad', !startOk(t, e.target.value)),
        onchange: (e) => {
          const v = e.target.value.trim();
          if (!startOk(t, v)) { T.status('"' + v + '" is not a valid ' + T.types.typeName(t) + ' value', 'warn'); return; }
          ctx.db.startValues = ctx.db.startValues || {};
          if (v) ctx.db.startValues[path] = v; else delete ctx.db.startValues[path];
          // offline and stopped: the simulator's DB takes the new start value now
          // (running / online it applies on the next download, as in TIA)
          const d = !(T.sim && T.sim.running) && !(T.online && T.online.monitoring) && v && dbMemory(ctx.db);
          if (d) {
            const lit = T.types.parseLiteral(v);
            if (t.k === 'str') T.types.strWrite(d.buf, off, t, lit.s);
            else T.types.write(d.buf, off, bit, t, T.types.conv(lit.v, t));
            refreshDbValues();
          }
          T.bus.emit('db:changed', ctx.db);
          T.status('Start value of ' + ctx.db.name + '.' + path + (v ? ' = ' + v : ' cleared') + ' — used on the next download / simulation start', 'info');
        },
      });
      sc.appendChild(inp);
    }
    tr.appendChild(sc);

    const mon = T.el('td', { class: 'col-dmon' });
    if (!(meta && meta.ref) && (!composite || (t.name && t.name.toUpperCase() === 'DTL'))) {
      ctx.cells.push({ cell: mon, t, off, bit });
    }
    tr.appendChild(mon);
    tr.appendChild(T.el('td', null, (meta && meta.comment) || ''));
    ctx.tbody.appendChild(tr);
    if (open) dbChildren(ctx, item);
  }

  function dbChildren(ctx, item) {
    const { t, off, path, depth } = item;
    if (t.k === 'arr') {
      const n = Math.min(t.count, MAX_ELEMENTS);
      const bool = t.el.k === 'el' && t.el.cls === 'bool';
      for (let i = 0; i < n; i++) {
        // linear index -> one index per dimension
        const idx = [];
        let r = i;
        for (let d = t.dims.length - 1; d >= 0; d--) {
          const span = t.dims[d].hi - t.dims[d].lo + 1;
          idx.unshift(t.dims[d].lo + (r % span));
          r = Math.floor(r / span);
        }
        const sub = '[' + idx.join(',') + ']';
        dbRow(ctx, { t: t.el, off: bool ? off + (i >> 3) : off + i * t.stride, bit: bool ? i & 7 : 0,
          path: path + sub, label: sub, depth: depth + 1, meta: null });
      }
      if (t.count > n) {
        ctx.tbody.appendChild(T.el('tr', null, T.el('td', { colspan: 6, class: 'tia-db-more', style: { paddingLeft: (23 + (depth + 1) * 16) + 'px' } },
          '… ' + (t.count - n) + ' more element(s)')));
      }
      return;
    }
    (t.fields || []).forEach((f) => {
      if (HIDDEN_SECTIONS[f.section]) return;
      dbRow(ctx, { t: f.t, off: off + f.off, bit: f.bit, path: path ? path + '.' + f.name : f.name, label: f.name,
        depth: depth + 1, meta: { def: f.def, comment: f.m && f.m.comment, ref: f.ref, reft: f.reft } });
    });
  }

  function renderDbTable() {
    if (!dbTableHost) return;
    const keep = dbTableHost.scrollTop;
    T.clear(dbTableHost);
    dbCells = [];
    const db = dbBlockRef;
    const sizeEl = dbHost && dbHost.querySelector('.tia-db-size');
    let t;
    try { t = T.types.blockType(db); } catch (e) {
      if (sizeEl) sizeEl.textContent = '';
      dbTableHost.appendChild(T.el('div', { class: 'tia-db-err' }, '✖ ' + e.message));
      return;
    }
    if (sizeEl) sizeEl.textContent = ' — ' + t.size + ' bytes';
    const fields = (t.fields || []).filter((f) => !HIDDEN_SECTIONS[f.section]);
    if (!fields.length) {
      dbTableHost.appendChild(T.el('div', { class: 'tia-empty' },
        db.instanceOf ? 'This function block declares no stored data (input/output/inout/static).' : 'This data block has no members yet.'));
      return;
    }
    const tbody = T.el('tbody');
    const ctx = { db, tbody, cells: dbCells };
    let lastSec = null;
    fields.forEach((f) => {
      const sec = db.instanceOf && f.section !== lastSec ? (SECTION_NAMES[f.section] || f.section) : null;
      lastSec = f.section;
      dbRow(ctx, { t: f.t, off: f.off, bit: f.bit, path: f.name, label: f.name, depth: 0,
        meta: { def: f.def, comment: f.m && f.m.comment, ref: f.ref, reft: f.reft, section: sec } });
    });
    dbTableHost.appendChild(T.el('table', { class: 'tia-db-table' },
      T.el('thead', null, T.el('tr', null,
        T.el('th', null, 'Name'), T.el('th', null, 'Data type'), T.el('th', null, 'Offset'),
        T.el('th', null, 'Start value'), T.el('th', null, 'Monitor value'), T.el('th', null, 'Comment'))),
      tbody));
    dbTableHost.scrollTop = keep;
    refreshDbValues();
  }

  // Render the DB view into `dbHost` for `dbBlockRef`.
  function renderDb() {
    if (dbHost && !dbHost.isConnected) { dbHost = null; dbBlockRef = null; }
    if (!dbHost) return;
    T.clear(dbHost);
    const db = dbBlockRef;
    if (!db) return;
    const wrap = T.el('div', { class: 'tia-db' });
    const fb = db.instanceOf ? T.findBlock(db.instanceOf) : null;

    /* ------------------------------ header ------------------------------ */
    // e.g.  Data block  Motor_DB [DB1]  — instance of  Motor
    wrap.appendChild(T.el('div', { class: 'tia-db-head' },
      T.el('span', { class: 'tia-db-sub' }, 'Data block  '),
      T.el('span', { class: 'tia-db-name' }, db.name || ''),
      T.el('span', { class: 'tia-db-sub' }, '  [DB' + (db.number != null ? db.number : '') + ']'),
      db.instanceOf ? T.el('span', { class: 'tia-db-sub' }, '  — instance of ') : null,
      db.instanceOf ? T.el('span', { class: 'tia-db-name' }, fb ? fb.name : '(missing FB)') : null,
      db.dbType ? T.el('span', { class: 'tia-db-sub' }, '  — of type ') : null,
      db.dbType ? T.el('span', { class: 'tia-db-name' }, '"' + String(db.dbType).replace(/"/g, '') + '"') : null,
      T.el('span', { class: 'tia-db-sub tia-db-size' })
    ));

    /* a global DB with its own members: their declaration */
    if (!db.instanceOf && !db.dbType) {
      if (!Array.isArray(db.members)) db.members = [];
      const decl = T.el('div', { class: 'tia-db-decl' });
      const renderDecl = () => {
        T.clear(decl);
        const panel = T.el('div', { class: 'tia-iface' });
        panel.appendChild(T.el('div', {
          class: 'tia-iface-head', onclick: () => { declCollapsed = !declCollapsed; renderDecl(); },
        }, T.el('span', { class: 'tia-iface-tw' }, declCollapsed ? '▸' : '▾'),
           T.el('span', { class: 'tia-iface-htitle' }, 'Declaration')));
        if (!declCollapsed) {
          const body = T.el('div', { class: 'tia-iface-body' });
          const ctx = { cols: 5, host: decl,
            notify: () => { T.bus.emit('iface:changed', db); T.bus.emit('tree:changed'); },
            rerender: () => { renderDecl(); renderDbTable(); } };
          body.appendChild(memberTable((tbody) => {
            memberRows(ctx, tbody, db.members, 0);
            tbody.appendChild(addRow(ctx, db.members, 0, 'Add a member', 'm'));
          }));
          panel.appendChild(body);
        }
        decl.appendChild(panel);
      };
      renderDecl();
      wrap.appendChild(decl);
    }

    dbTableHost = T.el('div', { class: 'tia-db-scroll' });
    wrap.appendChild(dbTableHost);
    dbHost.appendChild(wrap);
    renderDbTable();
  }
  let declCollapsed = false;

  // Cheap refresh of just the monitor cells (sim:tick).
  function refreshDbValues() {
    if (!dbHost || !dbBlockRef) return;
    // the DB tab was closed / replaced: stop refreshing a detached table and
    // release the stale block reference
    if (!dbHost.isConnected) { dbHost = null; dbBlockRef = null; dbTableHost = null; dbCells = []; return; }
    const d = dbMemory(dbBlockRef);
    if (!d) return;
    dbCells.forEach((c) => paintMonitor(c.cell, c.t, d.buf, c.off, c.bit));
  }

  // Minimal attribute-selector escaping for ids / names used in querySelector.
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

  T.editors.udt = {
    // Open the member editor of a PLC data type (project.types entry).
    open(hostEl, type) {
      if (!hostEl) return;
      udtHost = hostEl;
      udtRef = type || null;
      renderUdt();
    },
  };

  T.editors.db = {
    // Render a data block's structure, start values and live values.
    render(hostEl, dbBlock) {
      if (!hostEl) return;
      dbHost = hostEl;
      dbBlockRef = (dbBlock && dbBlock.type === 'DB') ? dbBlock : null;
      renderDb();
    },
    // names of the DBs on screen (online.js asks the PLC for their bytes)
    watching() {
      if (!dbHost || !dbHost.isConnected || !dbBlockRef) return [];
      return [dbBlockRef.name];
    },
  };

  /* --------------------------------------------------------------- events */
  // Refresh live monitor values each simulation tick (only when mounted).
  T.bus.on('sim:tick', refreshDbValues);
  // A declaration the DB depends on may have changed -> rebuild its table.
  const rebuildDb = () => { if (dbHost && dbBlockRef && dbHost.isConnected) renderDbTable(); };
  T.bus.on('iface:changed', rebuildDb);
  T.bus.on('types:changed', rebuildDb);
  // the data type editor follows renames from the tree
  T.bus.on('tree:changed', () => {
    if (udtHost && !udtHost.isConnected) { udtHost = null; udtRef = null; }
  });

})(window.TIA);
