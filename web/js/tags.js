/* ===========================================================================
 * TIA-like Browser PLC IDE  —  tags.js
 * The PLC tag table editor.
 *
 * Public API (attached to window.TIA):
 *   T.editors.tags = { open(hostEl) }
 *     - Renders an editable PLC tag table (bound to T.project.tags) into hostEl.
 *
 * Bus:
 *   emits  'tags:changed'  on every cell edit / add / delete.
 *   listens 'project:loaded' -> re-renders into the last host element.
 *
 * Pure vanilla JS, file:// safe. Only uses window.TIA.* helpers from core.js.
 * =========================================================================*/
(function (T) {
  'use strict';

  /* -------------------------------------------------------- component CSS */
  // Styled like a TIA tag table: petrol/grey header row, alternating rows,
  // a status dot + row-number gutter, and an "Add tag" toolbar on top.
  T.injectCSS('tia-tags-css', `
    .tia-tags { display: flex; flex-direction: column; height: 100%; min-height: 0;
      background: var(--tia-canvas); }

    /* toolbar above the table */
    .tia-tags-tb { flex: 0 0 auto; display: flex; align-items: center; gap: 4px;
      padding: 4px 6px; background: var(--tia-toolbar);
      border-bottom: 1px solid var(--tia-border); }
    .tia-tags-tb .tia-tags-btn {
      display: inline-flex; align-items: center; gap: 5px; height: 24px; padding: 0 9px;
      background: #fbfcfc; border: 1px solid var(--tia-border); border-radius: 3px;
      color: var(--tia-text); cursor: pointer; white-space: nowrap; font-size: 12px; }
    .tia-tags-tb .tia-tags-btn:hover { background: var(--tia-hover); border-color: var(--tia-petrol); }
    .tia-tags-tb .tia-tags-btn:active { background: var(--tia-select); }
    .tia-tags-tb .tia-tags-btn[disabled] { opacity: .45; cursor: default; }
    .tia-tags-tb .tia-tags-btn svg { width: 14px; height: 14px; }
    .tia-tags-tb .tia-tags-btn.danger:hover { background: #f6d9d9; border-color: #c0392b; }
    .tia-tags-tb .tia-tags-title { margin-left: 6px; color: var(--tia-text-soft);
      font-weight: 600; }
    .tia-tags-tb .tia-tags-count { margin-left: auto; color: var(--tia-text-soft);
      font-size: 11px; }

    /* scrollable table area */
    .tia-tags-scroll { flex: 1 1 auto; overflow: auto; }

    /* the table itself */
    table.tia-tags-table { border-collapse: collapse; width: 100%; font-size: 12px; }
    table.tia-tags-table th {
      background: var(--tia-panel-head); color: #fff; font-weight: 600; text-align: left;
      padding: 4px 7px; position: sticky; top: 0; z-index: 1;
      border-right: 1px solid rgba(255,255,255,.18); white-space: nowrap; }
    table.tia-tags-table td {
      border: 1px solid var(--tia-border-soft); padding: 0; height: 24px; }
    table.tia-tags-table tr:nth-child(even) td { background: var(--tia-row-alt); }
    table.tia-tags-table tr:hover td { background: var(--tia-hover); }
    table.tia-tags-table tr.selected td { background: var(--tia-select); }

    /* gutter: row number + status dot (click to select) */
    .tia-tags-table .col-gutter { width: 34px; text-align: center; cursor: pointer;
      color: var(--tia-text-soft); user-select: none; }
    .tia-tags-table .col-gutter .tia-tags-rowidx { font-size: 10px; }
    .tia-tags-dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%;
      background: var(--tia-petrol); border: 1px solid var(--tia-petrol-dark);
      vertical-align: middle; }
    .tia-tags-dot.warn { background: #d9a400; border-color: #a07900; }

    /* in-cell editors fill the cell, no border until focus */
    .tia-tags-table .tia-tags-cell {
      width: 100%; height: 100%; min-height: 22px; box-sizing: border-box;
      border: 1px solid transparent; background: transparent; color: var(--tia-text);
      font-family: inherit; font-size: 12px; padding: 2px 6px; }
    .tia-tags-table select.tia-tags-cell { cursor: pointer; }
    .tia-tags-table .tia-tags-cell:focus {
      outline: none; background: #fff; border-color: var(--tia-petrol);
      box-shadow: inset 0 0 0 1px rgba(0,153,153,.25); }
    .tia-tags-table .col-addr .tia-tags-cell { font-family: var(--tia-mono); }
    .tia-tags-table .col-name .tia-tags-cell { font-weight: 600; }
  `);

  /* ----------------------------------------------------------- module state */
  let host = null;        // last host element passed to open() — used for re-render
  let selectedId = null;  // currently selected tag id (row highlight)

  /* --------------------------------------------------------------- helpers */

  // Suggest the next free address for a freshly-added bit tag.
  // Walks the %M (memory flag) space, picking the first byte.bit not in use.
  // Returns '' if anything is off (blank address is always acceptable).
  function suggestAddress() {
    try {
      const used = Object.create(null);
      (T.project.tags || []).forEach((t) => {
        const a = (t.address || '').trim().toUpperCase();
        if (a) used[a] = true;
      });
      for (let byte = 0; byte < 256; byte++) {
        for (let bit = 0; bit < 8; bit++) {
          const a = 'M' + byte + '.' + bit;
          if (!used[a]) return a;
        }
      }
    } catch (e) { /* fall through to blank */ }
    return '';
  }

  // A simple validity check used only to colour the status dot.
  // Valid = blank OR a recognised bit/word address (I/Q/M area).
  const ADDR_OK = /^[IQM](\d+\.\d+|W\d+|B\d+|D\d+)$/i;
  function addressLooksValid(addr) {
    const a = (addr || '').trim();
    return a === '' || ADDR_OK.test(a);
  }

  function emitChanged() {
    T.bus.emit('tags:changed');
  }

  /* ------------------------------------------------------------ rendering */

  // Build one editable <tr> for a tag.
  function buildRow(tag, index) {
    const tr = T.el('tr', { class: selectedId === tag.id ? 'selected' : null,
                            dataset: { tagId: tag.id } });

    /* --- gutter cell: row number + status dot; clicking selects the row --- */
    const dot = T.el('span', {
      class: 'tia-tags-dot' + (addressLooksValid(tag.address) ? '' : ' warn'),
      title: addressLooksValid(tag.address) ? 'OK' : 'Address not recognised',
    });
    const gutter = T.el('td', {
      class: 'col-gutter',
      title: 'Select row ' + (index + 1),
      onclick: () => selectRow(tag.id),
    },
      T.el('span', { class: 'tia-tags-rowidx' }, String(index + 1)),
      T.el('br'),
      dot
    );
    tr.appendChild(gutter);

    /* --- Name: free text -> tag.name. On commit (blur/Enter) the rename is
       propagated to every operand that referenced the old name. --- */
    const nameInput = T.el('input', {
      class: 'tia-tags-cell', type: 'text', value: tag.name || '',
      placeholder: 'Tag name', spellcheck: 'false',
      oninput: (e) => { tag.name = e.target.value; refreshDot(dot, tag); emitChanged(); },
      onfocus: (e) => { selectRow(tag.id, true); e.target.dataset.oldName = tag.name || ''; },
      onchange: (e) => {
        const old = e.target.dataset.oldName || '';
        e.target.dataset.oldName = tag.name || '';
        if (!T.refactor || !old || old === tag.name) return;
        const n = T.refactor.renameTag(old, tag.name);
        if (n) {
          T.status('Renamed "' + old + '" → "' + tag.name + '" — updated ' + n + ' reference(s)', 'ok');
          T.bus.emit('tree:changed');
          if (T.activeEditor && T.activeEditor.refresh) T.activeEditor.refresh();
        }
      },
    });
    tr.appendChild(T.el('td', { class: 'col-name' }, nameInput));

    /* --- Data type: <select> of T.DataTypes -> tag.dataType --- */
    const typeSel = T.el('select', {
      class: 'tia-tags-cell',
      onchange: (e) => { tag.dataType = e.target.value; emitChanged(); },
      onfocus: () => selectRow(tag.id, true),
    });
    T.DataTypes.forEach((dt) => {
      typeSel.appendChild(T.el('option', { value: dt, selected: tag.dataType === dt }, dt));
    });
    // Guard against a tag whose stored dataType is not in the list.
    if (T.DataTypes.indexOf(tag.dataType) < 0 && tag.dataType) {
      typeSel.appendChild(T.el('option', { value: tag.dataType, selected: true }, tag.dataType));
    }
    tr.appendChild(T.el('td', { class: 'col-type' }, typeSel));

    /* --- Address: free text (may be blank) -> tag.address --- */
    const addrInput = T.el('input', {
      class: 'tia-tags-cell', type: 'text', value: tag.address || '',
      placeholder: '%I0.0 / %Q0.0 / %M0.0', spellcheck: 'false',
      oninput: (e) => {
        // Accept either "I0.0" or "%I0.0"; strip a leading % for the model
        // so it matches what T.resolve / T.tagByAddress expect.
        tag.address = e.target.value.replace(/^%/, '');
        refreshDot(dot, tag);
        emitChanged();
      },
      onfocus: () => selectRow(tag.id, true),
    });
    tr.appendChild(T.el('td', { class: 'col-addr' }, addrInput));

    /* --- Comment: free text -> tag.comment --- */
    const cmtInput = T.el('input', {
      class: 'tia-tags-cell', type: 'text', value: tag.comment || '',
      placeholder: 'Comment',
      oninput: (e) => { tag.comment = e.target.value; emitChanged(); },
      onfocus: () => selectRow(tag.id, true),
    });
    tr.appendChild(T.el('td', { class: 'col-cmt' }, cmtInput));

    return tr;
  }

  function refreshDot(dotEl, tag) {
    if (!dotEl) return;
    const ok = addressLooksValid(tag.address);
    dotEl.className = 'tia-tags-dot' + (ok ? '' : ' warn');
    dotEl.title = ok ? 'OK' : 'Address not recognised';
  }

  // Highlight a row. `keepFocus` avoids a full re-render while typing.
  function selectRow(id, keepFocus) {
    selectedId = id;
    if (!host) return;
    const rows = T.$$('.tia-tags-table tr[data-tag-id]', host);
    rows.forEach((r) => {
      r.classList.toggle('selected', r.dataset.tagId === id);
    });
    if (!keepFocus) { /* selection via gutter click: nothing else to do */ }
  }

  // Render the whole editor (toolbar + table) into `host`.
  function render() {
    if (!host) return;
    T.clear(host);

    // Defensive: no project loaded yet.
    if (!T.project) {
      host.appendChild(T.el('div', { class: 'tia-empty' },
        'No project loaded. Create or open a project to edit PLC tags.'));
      return;
    }

    const tags = T.project.tags || (T.project.tags = []);

    // Keep selection valid; default to last tag if the selected one is gone.
    if (selectedId && !tags.some((t) => t.id === selectedId)) selectedId = null;

    const wrap = T.el('div', { class: 'tia-tags' });

    /* ------------------------------ toolbar ------------------------------ */
    const addBtn = T.el('button', {
      class: 'tia-tags-btn', type: 'button', title: 'Add a new tag',
      onclick: addTag,
    });
    addBtn.innerHTML = T.icons.add;
    addBtn.appendChild(T.el('span', null, 'Add tag'));

    const delBtn = T.el('button', {
      class: 'tia-tags-btn danger', type: 'button',
      title: 'Delete selected tag', onclick: deleteSelected,
      disabled: tags.length === 0,
    });
    delBtn.innerHTML = T.icons.trash;
    delBtn.appendChild(T.el('span', null, 'Delete'));

    const tb = T.el('div', { class: 'tia-tags-tb' },
      addBtn, delBtn,
      T.el('span', { class: 'tia-tags-title' }, 'Default tag table'),
      T.el('span', { class: 'tia-tags-count' },
        tags.length + (tags.length === 1 ? ' tag' : ' tags'))
    );
    wrap.appendChild(tb);

    /* ------------------------------- table ------------------------------- */
    const scroll = T.el('div', { class: 'tia-tags-scroll' });

    if (tags.length === 0) {
      scroll.appendChild(T.el('div', { class: 'tia-empty' },
        'No tags yet. Click "Add tag" to create one.'));
    } else {
      const thead = T.el('thead', null,
        T.el('tr', null,
          T.el('th', { class: 'col-gutter', title: 'Status / row' }, ''),
          T.el('th', null, 'Name'),
          T.el('th', null, 'Data type'),
          T.el('th', null, 'Address'),
          T.el('th', null, 'Comment')
        ));
      const tbody = T.el('tbody');
      tags.forEach((t, i) => tbody.appendChild(buildRow(t, i)));
      scroll.appendChild(T.el('table', { class: 'tia-tags-table' }, thead, tbody));
    }

    wrap.appendChild(scroll);
    host.appendChild(wrap);
  }

  /* --------------------------------------------------------- actions */

  // Add a fresh tag, re-render, select it, and focus its name cell.
  function addTag() {
    if (!T.project) return;
    const tags = T.project.tags || (T.project.tags = []);
    // Name like "Tag_1" choosing the next free numeric suffix.
    let n = tags.length + 1;
    const names = new Set(tags.map((t) => t.name));
    while (names.has('Tag_' + n)) n++;
    const tag = T.model.newTag('Tag_' + n, 'Bool', suggestAddress(), '');
    tags.push(tag);
    selectedId = tag.id;
    emitChanged();
    render();

    // Focus the new tag's name input so the user can type immediately.
    if (host) {
      const row = T.$('.tia-tags-table tr[data-tag-id="' + tag.id + '"]', host);
      if (row) {
        const nameInput = row.querySelector('.col-name .tia-tags-cell');
        if (nameInput) { nameInput.focus(); nameInput.select(); }
        row.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  // Delete the selected tag; warn when program logic still references it.
  function deleteSelected() {
    if (!T.project) return;
    const tags = T.project.tags || [];
    if (tags.length === 0) return;

    const idx = tags.findIndex((t) => t.id === selectedId);
    if (idx < 0) {
      T.status('Select a tag first (click its row number)', 'warn');
      return;
    }
    const tag = tags[idx];
    const refs = (T.refactor && tag.name) ? T.refactor.countTagRefs(tag.name) : 0;
    const msg = refs
      ? 'Tag "' + tag.name + '" is referenced by ' + refs + ' operand(s).\n' +
        'Delete anyway? (the operands keep the name and will read FALSE/0)'
      : 'Delete tag "' + (tag.name || tag.address || '?') + '"?';
    if (!window.confirm(msg)) return;
    tags.splice(idx, 1);
    // drop its GPIO pin mapping so no dangling entry remains
    if (Array.isArray(T.project.gpio) && tag.name) {
      T.project.gpio = T.project.gpio.filter((g) => !(g && g.tag === tag.name));
    }

    // Move selection to a sensible neighbour.
    if (tags.length === 0) selectedId = null;
    else selectedId = (tags[idx] || tags[idx - 1] || tags[0]).id;

    emitChanged();
    render();
  }

  /* ------------------------------------------------------ public surface */
  T.editors = T.editors || {};
  T.editors.tags = {
    // Render the editable tag table into hostEl. Stores hostEl for re-renders.
    open(hostEl) {
      if (!hostEl) return;
      host = hostEl;
      render();
    },
  };

  /* --------------------------------------------------------------- events */
  // A new/loaded project means brand-new tag objects: drop selection & redraw.
  T.bus.on('project:loaded', () => {
    selectedId = null;
    if (host) render();
  });

})(window.TIA);
