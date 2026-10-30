/* ===========================================================================
 * TIA-like Browser PLC IDE  —  instructions.js
 * The right-hand "Instructions" task card (TIA Instructions tree).
 *
 * Renders the catalog of available instructions for the ACTIVE block's
 * language (LAD/FBD), grouped by T.catalogGroups. Items are:
 *   - searchable (live, case-insensitive filter on def.name + kind)
 *   - collapsible per group (expand state remembered between renders)
 *   - draggable (dataTransfer 'text/tia-kind') so editors can drop them
 *   - clickable to call T.activeEditor.insert(kind)
 *
 * Public API:  T.editors.instructions = { render() }
 * Mount point: #tia-instructions
 *
 * Uses ONLY window.TIA.* helpers. IIFE — no globals beyond T.editors.instructions.
 * =========================================================================*/
(function (T) {
  'use strict';

  /* ------------------------------------------------------------- component CSS */
  T.injectCSS('tia-instructions-css', `
    .tia-ins-wrap { display: flex; flex-direction: column; height: 100%; }
    .tia-ins-search {
      flex: 0 0 auto; padding: 5px 6px;
      border-bottom: 1px solid var(--tia-border);
      background: var(--tia-toolbar);
    }
    .tia-ins-search input {
      width: 100%; box-sizing: border-box;
      font-family: inherit; font-size: inherit;
      padding: 3px 6px;
      border: 1px solid var(--tia-border); border-radius: 2px;
      background: #fff; color: var(--tia-text);
    }
    .tia-ins-search input:focus {
      outline: none; border-color: var(--tia-petrol);
      box-shadow: 0 0 0 2px rgba(0,153,153,.18);
    }
    .tia-ins-list { flex: 1 1 auto; overflow: auto; padding: 2px 0; }

    /* group header */
    .tia-ins-group-head {
      display: flex; align-items: center; gap: 4px;
      padding: 3px 6px; cursor: pointer;
      font-weight: 600; color: var(--tia-text);
      background: var(--tia-net-head);
      border-top: 1px solid var(--tia-border-soft);
      user-select: none; white-space: nowrap;
    }
    .tia-ins-group-head:hover { background: var(--tia-hover); }
    .tia-ins-twisty {
      width: 12px; display: inline-flex; justify-content: center;
      color: var(--tia-text-soft); transition: transform .1s;
    }
    .tia-ins-twisty.open { transform: rotate(90deg); }
    .tia-ins-twisty svg { width: 12px; height: 12px; }
    .tia-ins-group-count { color: var(--tia-text-soft); font-weight: 400; font-size: 11px; }

    /* items */
    .tia-ins-item {
      display: flex; align-items: center; gap: 6px;
      padding: 2px 6px 2px 20px; cursor: grab; white-space: nowrap;
    }
    .tia-ins-item:hover { background: var(--tia-hover); }
    .tia-ins-item:active { cursor: grabbing; background: var(--tia-select); }
    .tia-ins-glyph {
      flex: 0 0 26px; width: 26px; height: 16px;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--tia-rail);
    }
    .tia-ins-glyph svg { display: block; }
    .tia-ins-name {
      flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis;
      color: var(--tia-text);
    }
    .tia-ins-kind {
      flex: 0 0 auto; color: var(--tia-text-soft);
      font-family: var(--tia-mono); font-size: 10.5px;
    }
    .tia-ins-empty {
      padding: 16px; color: var(--tia-text-soft);
      text-align: center; font-style: italic;
    }
  `);

  /* expand/collapse state per group (remembered across renders). All open by default. */
  const expanded = Object.create(null);
  T.catalogGroups.forEach((g) => { expanded[g] = true; });

  /* last filter text — survives language/project re-renders */
  let filterText = '';

  /* --------------------------------------------------------------- tiny glyphs */
  // Build a small inline SVG glyph appropriate to the instruction's symbol style.
  // Three recognizable families: contact ─┤ ├─ , coil ─( )─ , box ▭.
  function glyphFor(kind, def) {
    const W = 26, H = 16, midY = 8;
    const attrs = {
      viewBox: '0 0 ' + W + ' ' + H, width: W, height: H,
      fill: 'none', stroke: 'currentColor', 'stroke-width': '1.3',
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    };
    const wireL = T.svg('line', { x1: 0, y1: midY, x2: 7, y2: midY });
    const wireR = T.svg('line', { x1: 19, y1: midY, x2: W, y2: midY });

    // Inline contacts: two vertical bars ─| |─ ; NC/edge add a diagonal/letter.
    if (kind === 'contact_no' || kind === 'contact_nc' || kind === 'edge_p' || kind === 'edge_n') {
      const parts = [
        wireL, wireR,
        T.svg('line', { x1: 8, y1: 3, x2: 8, y2: 13 }),
        T.svg('line', { x1: 18, y1: 3, x2: 18, y2: 13 }),
      ];
      if (kind === 'contact_nc') {
        parts.push(T.svg('line', { x1: 8, y1: 13, x2: 18, y2: 3 })); // diagonal slash
      } else if (kind === 'edge_p' || kind === 'edge_n') {
        parts.push(T.svg('text', {
          x: 13, y: 11, 'text-anchor': 'middle',
          'font-size': '7', 'font-family': 'Consolas, monospace',
          fill: 'currentColor', stroke: 'none',
        }, kind === 'edge_p' ? 'P' : 'N'));
      }
      return T.svg('svg', attrs, parts);
    }

    // Output coils: ─( )─ ; set/reset/negated carry a letter / slash.
    if (kind === 'coil' || kind === 'coil_neg' || kind === 'coil_set' || kind === 'coil_reset') {
      const parts = [
        wireL, wireR,
        // open parentheses pair forming the coil
        T.svg('path', { d: 'M9 3 C5 5 5 11 9 13' }),
        T.svg('path', { d: 'M17 3 C21 5 21 11 17 13' }),
      ];
      const letter = kind === 'coil_set' ? 'S' : kind === 'coil_reset' ? 'R' : '';
      if (letter) {
        parts.push(T.svg('text', {
          x: 13, y: 11, 'text-anchor': 'middle',
          'font-size': '7', 'font-family': 'Consolas, monospace',
          fill: 'currentColor', stroke: 'none',
        }, letter));
      } else if (kind === 'coil_neg') {
        parts.push(T.svg('line', { x1: 10, y1: 12, x2: 16, y2: 4 })); // negation slash
      }
      return T.svg('svg', attrs, parts);
    }

    // Everything else (boxes, timers, counters, math, move, compare, FBD logic):
    // a labeled rectangle. Show 1–3 chars derived from the kind for recognizability.
    const labelMap = {
      compare: '?', ton: 'TON', tof: 'TOF', tp: 'TP',
      ctu: 'CTU', ctd: 'CTD', move: '→', add: '+', sub: '−',
      mul: '×', div: '÷', fb_and: '&', fb_or: '≥1', fb_xor: '=1',
      fb_not: '!', assign: '=',
    };
    const label = labelMap[kind] || (def && def.name ? def.name.charAt(0) : '▭');
    return T.svg('svg', attrs, [
      wireL, wireR,
      T.svg('rect', { x: 7, y: 2, width: 12, height: 12, rx: 1 }),
      T.svg('text', {
        x: 13, y: 11, 'text-anchor': 'middle',
        'font-size': label.length > 1 ? '5.5' : '8',
        'font-family': 'Consolas, monospace', fill: 'currentColor', stroke: 'none',
      }, label),
    ]);
  }

  // Short "kind token" describing the symbol family, shown muted next to the name.
  function kindToken(def) {
    if (!def) return '';
    if (def.box) return 'box';
    if (def.area === 'output') return 'coil';
    if (def.area === 'inline') return 'contact';
    return '';
  }

  /* ------------------------------------------------------------------- insert */
  function doInsert(kind) {
    if (T.activeEditor && typeof T.activeEditor.insert === 'function') {
      T.activeEditor.insert(kind);
    } else {
      T.status('Open a block to insert instructions', 'warn');
    }
  }

  /* ------------------------------------------------------------------ an item */
  function buildItem(kind, def) {
    const node = T.el('div', {
      class: 'tia-ins-item',
      title: def.name,
      draggable: true,
      ondragstart: (e) => {
        try {
          e.dataTransfer.setData('text/tia-kind', kind);
          e.dataTransfer.effectAllowed = 'copy';
        } catch (_) { /* some browsers restrict during synthetic events */ }
      },
      onclick: () => doInsert(kind),
    },
      T.el('span', { class: 'tia-ins-glyph' }, glyphFor(kind, def)),
      T.el('span', { class: 'tia-ins-name' }, def.name),
      T.el('span', { class: 'tia-ins-kind' }, kindToken(def))
    );
    return node;
  }

  /* --------------------------------------------------------------- main render */
  function render() {
    const host = document.getElementById('tia-instructions');
    if (!host) return;
    T.clear(host);

    // Determine current editor language from the active block.
    const blk = T.getActiveBlock();
    const lang = (blk && blk.lang) || 'LAD';

    // SCL is text, not drag-and-drop instructions — show a syntax reference instead.
    if (lang === 'SCL') { renderSclReference(host); return; }

    // Available instructions for this language, indexed by group.
    const available = T.catalogFor(lang);   // [{kind, def}]
    const byGroup = Object.create(null);
    available.forEach((it) => {
      (byGroup[it.def.group] = byGroup[it.def.group] || []).push(it);
    });

    const wrap = T.el('div', { class: 'tia-ins-wrap' });

    /* --- search box --- */
    const searchBox = T.el('div', { class: 'tia-ins-search' });
    const input = T.el('input', {
      type: 'search',
      placeholder: 'Search instructions… (' + lang + ')',
      value: filterText,
      // live filter, case-insensitive
      oninput: (e) => { filterText = e.target.value; applyFilter(list); },
    });
    searchBox.appendChild(input);
    wrap.appendChild(searchBox);

    /* --- grouped list --- */
    const list = T.el('div', { class: 'tia-ins-list' });

    // Build groups in canonical catalog order; skip groups with no items for this lang.
    T.catalogGroups.forEach((group) => {
      const items = byGroup[group];
      if (!items || !items.length) return;
      if (!(group in expanded)) expanded[group] = true;

      const twisty = T.el('span', { class: 'tia-ins-twisty' + (expanded[group] ? ' open' : ''), html: T.icons.chevron });
      const childWrap = T.el('div', { class: 'tia-ins-group-items', style: { display: expanded[group] ? '' : 'none' } });

      const head = T.el('div', {
        class: 'tia-ins-group-head',
        onclick: () => {
          expanded[group] = !expanded[group];
          twisty.classList.toggle('open', expanded[group]);
          childWrap.style.display = expanded[group] ? '' : 'none';
        },
      },
        twisty,
        T.el('span', {}, group),
        T.el('span', { class: 'tia-ins-group-count' }, '(' + items.length + ')')
      );

      items.forEach((it) => childWrap.appendChild(buildItem(it.kind, it.def)));

      // Tag the group block so the filter can hide whole empty groups.
      const block = T.el('div', { class: 'tia-ins-group', dataset: { group: group } }, head, childWrap);
      list.appendChild(block);
    });

    // Empty-state placeholder (shown when nothing matches the filter).
    const empty = T.el('div', { class: 'tia-ins-empty', style: { display: 'none' } }, 'No matching instructions');
    list.appendChild(empty);

    wrap.appendChild(list);
    host.appendChild(wrap);

    // Apply the remembered filter text immediately.
    applyFilter(list);
  }

  /* ------------------------------------------------------------------ filter */
  // Live, case-insensitive filter over item name + kind token. Hides empty groups.
  function applyFilter(list) {
    const q = (filterText || '').trim().toLowerCase();
    let anyVisible = false;

    T.$$('.tia-ins-group', list).forEach((block) => {
      const items = T.$$('.tia-ins-item', block);
      let groupHas = false;
      items.forEach((item) => {
        const name = (item.getAttribute('title') || '').toLowerCase();
        const tok = (T.$('.tia-ins-kind', item) || {}).textContent || '';
        const match = !q || name.indexOf(q) >= 0 || tok.toLowerCase().indexOf(q) >= 0;
        item.style.display = match ? '' : 'none';
        if (match) groupHas = true;
      });
      // When filtering, hide groups that have no visible items; otherwise show.
      block.style.display = (q && !groupHas) ? 'none' : '';
      if (groupHas) anyVisible = true;
    });

    const empty = T.$('.tia-ins-empty', list);
    if (empty) empty.style.display = anyVisible ? 'none' : '';
  }

  /* --------------------------------------------------------- SCL reference */
  // A compact syntax cheat-sheet shown in the instruction pane for SCL blocks
  // (SCL is typed, so there is nothing to drag onto a network).
  T.injectCSS('tia-ins-scl-css', `
    .tia-scl-ref { padding:8px 10px; font:12px/1.5 var(--tia-font, sans-serif); color:var(--tia-text); }
    .tia-scl-ref h4 { margin:10px 0 4px; font-size:11px; text-transform:uppercase;
      letter-spacing:.04em; color:var(--tia-muted); }
    .tia-scl-ref pre { margin:0 0 4px; padding:6px 8px; background:var(--tia-panel, #f4f7fa);
      border:1px solid var(--tia-border); border-radius:4px; overflow:auto;
      font:12px/1.45 ui-monospace, Consolas, monospace; white-space:pre; }
    .tia-scl-ref code { background:var(--tia-panel, #eef3f7); padding:0 3px; border-radius:3px;
      font:12px ui-monospace, Consolas, monospace; }
  `);
  function renderSclReference(host) {
    const ref = T.el('div', { class: 'tia-scl-ref' });
    const h = (t) => ref.appendChild(T.el('h4', {}, t));
    const pre = (t) => ref.appendChild(T.el('pre', {}, t));
    const p = (t) => ref.appendChild(T.el('div', {}, t));

    h('SCL reference');
    p('Assign tags & interface members with ":=". Statements end with ";".');
    h('Assignment & operators');
    pre('Motor := Start AND NOT Stop;\nSpeed := (Setpoint * 100) / 255;');
    p('Logic: AND OR XOR NOT · Math: + - * / MOD · Compare: = <> < > <= >=');
    h('IF / ELSIF / ELSE');
    pre('IF Level > 80 THEN\n    Pump := FALSE;\nELSIF Level < 20 THEN\n    Pump := TRUE;\nEND_IF;');
    h('CASE');
    pre('CASE Step OF\n    0:   Lamp := FALSE;\n    1..3: Lamp := TRUE;\n    ELSE Lamp := FALSE;\nEND_CASE;');
    h('Loops');
    pre('FOR i := 1 TO 10 BY 1 DO\n    Sum := Sum + i;\nEND_FOR;\n\nWHILE Run DO\n    // ...\nEND_WHILE;');
    h('Built-in functions');
    p('ABS, SQRT, MIN, MAX, LIMIT(min,in,max), TRUNC, ROUND, SIN, COS …');
    h('Comments');
    p('Line: // …    Block: (* … *)');
    host.appendChild(ref);
  }

  /* ====================================================================== */
  /*  PUBLIC API + EVENT WIRING                                              */
  /* ====================================================================== */
  T.editors = T.editors || {};
  T.editors.instructions = { render };

  // Re-render when the project loads or the active block changes (language may
  // differ between blocks → different available instruction set).
  T.bus.on('project:loaded', render);
  T.bus.on('block:activated', render);

  // Auto-render on load. If the host/DOM isn't ready yet, wait for it.
  if (document.getElementById('tia-instructions')) {
    render();
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render, { once: true });
  } else {
    render();
  }
})(window.TIA);
