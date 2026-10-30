/* ===========================================================================
 * TIA-like Browser PLC IDE  —  outline.js
 * The LEFT-dock "Tags / Outline" panel.
 *
 * Renders into #tia-outline (a .tia-panel-body container that the integrator
 * adds to index.html). Two stacked sections:
 *
 *   1. A live name/address filter box.
 *   2. "PLC tags"        — project tags grouped by memory area:
 *                            Inputs (^I) / Outputs (^Q) / Memory (^M) / Other.
 *   3. "Block interface" — the active code block's iface members, grouped by
 *                          T.ifaceSections(block.type). Only when the active
 *                          block is an OB/FC/FB.
 *
 * Every tag row AND interface-member row is DRAGGABLE. dragstart writes the
 * drop payload as MIME 'text/tia-tag' = the tag/member NAME (or address if the
 * tag has no name).
 *
 * Public API:  T.editors.outline = { render() }
 * Listens   : 'project:loaded', 'tags:changed', 'block:activated',
 *             'iface:changed', 'tree:changed'
 *
 * Uses ONLY window.TIA.* helpers. IIFE — no globals beyond T.editors.outline.
 * ==========================================================================*/
(function (T) {
  'use strict';

  /* ------------------------------------------------------------ component CSS
   * Mirrors the tree's row/twisty conventions. Colours come exclusively from
   * the --tia-* theme variables (no hard-coded greys). */
  T.injectCSS('tia-outline-css', `
    #tia-outline { padding: 0 0 6px; user-select: none; }

    /* filter box pinned to the top of the panel body */
    .tia-ol-filter { position: sticky; top: 0; z-index: 2; padding: 5px 6px;
      background: var(--tia-panel); border-bottom: 1px solid var(--tia-border-soft); }
    .tia-ol-filter .tia-input { width: 100%; }

    /* section / group / member rows reuse the tree look */
    .tia-ol-row { display: flex; align-items: center; gap: 5px; padding: 2px 6px;
      white-space: nowrap; cursor: pointer; }
    .tia-ol-row:hover { background: var(--tia-hover); }
    .tia-ol-row .tia-twisty { width: 12px; display: inline-flex; justify-content: center;
      color: var(--tia-text-soft); transition: transform .1s; }
    .tia-ol-row .tia-twisty.open { transform: rotate(90deg); }
    .tia-ol-row .tia-twisty svg { width: 12px; height: 12px; }
    .tia-ol-row .tia-tree-icon { width: 16px; height: 16px;
      color: var(--tia-petrol-dark); display: inline-flex; }

    .tia-ol-section { font-weight: 600; }
    .tia-ol-group { color: var(--tia-text); }
    .tia-ol-count { color: var(--tia-text-soft); margin-left: 4px; font-weight: 400; }

    /* draggable leaf rows (tags + interface members) */
    .tia-ol-item { cursor: grab; }
    .tia-ol-item:hover { background: var(--tia-hover); outline: 1px solid var(--tia-select-bd); }
    .tia-ol-item:active { cursor: grabbing; }
    .tia-ol-name { font-weight: 600; flex: 0 1 auto; overflow: hidden;
      text-overflow: ellipsis; }
    .tia-ol-addr { font-family: var(--tia-mono); color: var(--tia-text-soft);
      flex: 0 0 auto; }
    .tia-ol-type { color: var(--tia-text-soft); margin-left: auto; flex: 0 0 auto;
      padding-left: 8px; font-style: italic; }

    .tia-ol-subhead { color: var(--tia-text-soft); font-weight: 600; font-size: 11px;
      text-transform: uppercase; letter-spacing: .3px; }
  `);

  /* ----------------------------------------------------------------- state
   * `collapsed` holds the keys of CLOSED sections/groups so that open is the
   * default. `filterText` survives re-renders. */
  const collapsed = new Set();
  let filterText = '';

  const isOpen = (key) => !collapsed.has(key);
  function toggle(key) {
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    render();
  }

  /* ----------------------------------------------------------- small helpers */
  function icon(name) {
    return T.el('span', { class: 'tia-tree-icon', html: T.icons[name] || '' });
  }
  function twisty(open) {
    return T.el('span', { class: 'tia-twisty' + (open ? ' open' : ''), html: T.icons.chevron });
  }

  /* A collapsible header row (section or group). */
  function headerRow(opts) {
    const row = T.el('div', {
      class: 'tia-ol-row ' + (opts.cls || ''),
      style: { paddingLeft: (4 + (opts.depth || 0) * 14) + 'px' },
      onclick: () => toggle(opts.key),
    });
    const tw = twisty(opts.open);
    row.appendChild(tw);
    if (opts.iconName) row.appendChild(icon(opts.iconName));
    const label = T.el('span', null, opts.label);
    row.appendChild(label);
    if (opts.count != null) row.appendChild(T.el('span', { class: 'tia-ol-count' }, '(' + opts.count + ')'));
    return row;
  }

  /* A non-collapsible sub-header (interface section name). */
  function subHead(label, depth) {
    return T.el('div', {
      class: 'tia-ol-row tia-ol-subhead',
      style: { paddingLeft: (4 + depth * 14) + 'px', cursor: 'default' },
    }, label);
  }

  /* A draggable tag row. */
  function tagRow(tag, depth) {
    const payload = (tag.name && tag.name.trim()) ? tag.name : (tag.address || '');
    const row = T.el('div', {
      class: 'tia-ol-row tia-ol-item',
      style: { paddingLeft: (4 + depth * 14) + 'px' },
      title: (tag.name || '') + ' ' + (tag.address || '') + ' — ' + (tag.comment || ''),
      draggable: true,
      ondragstart: (e) => {
        e.stopPropagation();
        e.dataTransfer.setData('text/tia-tag', payload);
        e.dataTransfer.effectAllowed = 'copy';
      },
    });
    row.appendChild(icon('tag'));
    row.appendChild(T.el('span', { class: 'tia-ol-name' }, tag.name || '(unnamed)'));
    if (tag.address) row.appendChild(T.el('span', { class: 'tia-ol-addr' }, tag.address));
    if (tag.dataType) row.appendChild(T.el('span', { class: 'tia-ol-type' }, tag.dataType));
    return row;
  }

  /* A draggable interface-member row. */
  function memberRow(member, depth) {
    const row = T.el('div', {
      class: 'tia-ol-row tia-ol-item',
      style: { paddingLeft: (4 + depth * 14) + 'px' },
      title: (member.name || '') + ' — ' + (member.comment || ''),
      draggable: true,
      ondragstart: (e) => {
        e.stopPropagation();
        e.dataTransfer.setData('text/tia-tag', member.name || '');
        e.dataTransfer.effectAllowed = 'copy';
      },
    });
    row.appendChild(icon('tag'));
    row.appendChild(T.el('span', { class: 'tia-ol-name' }, member.name || '(unnamed)'));
    if (member.dataType) row.appendChild(T.el('span', { class: 'tia-ol-type' }, member.dataType));
    return row;
  }

  /* ----------------------------------------------------------- filtering */
  function matches(text) {
    const f = filterText.trim().toLowerCase();
    if (!f) return true;
    return String(text || '').toLowerCase().indexOf(f) >= 0;
  }
  function tagMatches(tag) {
    if (!filterText.trim()) return true;
    return matches(tag.name) || matches(tag.address);
  }
  function memberMatches(m) {
    if (!filterText.trim()) return true;
    return matches(m.name) || matches(m.dataType);
  }

  /* Bucket the tags by memory area (after filtering). */
  function bucketTags(tags) {
    const g = { Inputs: [], Outputs: [], Memory: [], Other: [] };
    tags.forEach((t) => {
      if (!tagMatches(t)) return;
      const a = t.address || '';
      if (/^I/i.test(a)) g.Inputs.push(t);
      else if (/^Q/i.test(a)) g.Outputs.push(t);
      else if (/^M/i.test(a)) g.Memory.push(t);
      else g.Other.push(t);
    });
    return g;
  }

  /* Section labels under PLC tags (Inputs & Outputs always shown). */
  const TAG_GROUPS = ['Inputs', 'Outputs', 'Memory', 'Other'];
  const ALWAYS_SHOWN = { Inputs: true, Outputs: true };

  /* Display labels for interface section keys. */
  const IFACE_LABELS = {
    input: 'Input', output: 'Output', inout: 'InOut',
    static: 'Static', temp: 'Temp', constant: 'Constant',
  };

  /* ====================================================================== */
  /*  RENDER                                                                 */
  /* ====================================================================== */
  function render() {
    const host = document.getElementById('tia-outline');
    if (!host) return;
    T.clear(host);

    /* --- filter box (always present, even with no project) --- */
    const input = T.el('input', {
      class: 'tia-input', type: 'text', placeholder: 'Filter tags…', value: filterText,
      oninput: (e) => {
        filterText = e.target.value;
        render();   // rebuilds the panel INCLUDING this input — refocus the new one
        const nh = document.getElementById('tia-outline');
        const ni = nh && nh.querySelector('.tia-ol-filter input');
        if (ni) {
          ni.focus();
          const L = ni.value.length;
          try { ni.setSelectionRange(L, L); } catch (err) { /* no-op */ }
        }
      },
    });
    host.appendChild(T.el('div', { class: 'tia-ol-filter' }, input));

    const p = T.project;
    if (!p) {
      host.appendChild(T.el('div', { class: 'tia-empty' }, 'No project loaded'));
      return;
    }

    /* --- PLC tags --- */
    const tags = Array.isArray(p.tags) ? p.tags : [];
    host.appendChild(headerRow({
      key: 'plctags', depth: 0, iconName: 'folder', cls: 'tia-ol-section',
      label: 'PLC tags', open: isOpen('plctags'),
    }));

    if (isOpen('plctags')) {
      const groups = bucketTags(tags);
      TAG_GROUPS.forEach((gName) => {
        const list = groups[gName];
        if (list.length === 0 && !ALWAYS_SHOWN[gName]) return;
        const gKey = 'plctags:' + gName;
        host.appendChild(headerRow({
          key: gKey, depth: 1, iconName: 'folder', cls: 'tia-ol-group',
          label: gName, count: list.length, open: isOpen(gKey),
        }));
        if (isOpen(gKey)) list.forEach((t) => host.appendChild(tagRow(t, 2)));
      });
    }

    /* --- Block interface (active code block only) --- */
    const block = T.getActiveBlock();
    if (block && block.type !== 'DB' && (block.type === 'OB' || block.type === 'FC' || block.type === 'FB')) {
      T.ensureInterface(block);
      if (block.iface) {
        host.appendChild(headerRow({
          key: 'iface', depth: 0, iconName: 'block', cls: 'tia-ol-section',
          label: 'Block interface — ' + (block.name || ''), open: isOpen('iface'),
        }));
        if (isOpen('iface')) {
          T.ifaceSections(block.type).forEach((sec) => {
            const members = (block.iface[sec] || []).filter(memberMatches);
            if (members.length === 0) return;
            host.appendChild(subHead(IFACE_LABELS[sec] || sec, 1));
            members.forEach((m) => host.appendChild(memberRow(m, 2)));
          });
        }
      }
    }
  }

  /* ====================================================================== */
  /*  PUBLIC API + EVENT WIRING                                              */
  /* ====================================================================== */
  T.editors = T.editors || {};
  T.editors.outline = { render };

  T.bus.on('project:loaded', render);
  T.bus.on('tags:changed', render);
  T.bus.on('block:activated', render);
  T.bus.on('iface:changed', render);
  T.bus.on('tree:changed', render);

  // Auto-render on load once the host exists.
  if (document.getElementById('tia-outline')) {
    render();
  } else if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render, { once: true });
  } else {
    render();
  }

})(window.TIA);
