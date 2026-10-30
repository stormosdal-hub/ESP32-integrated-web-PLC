/* ===========================================================================
 * TIA-like Browser PLC IDE  —  extsrc.js
 * The "External source files" folder (TIA: Add new external file / Generate
 * blocks from source / Generate source from blocks) around sources.js:
 *
 *   project.sources = [{ id, name, text }]
 *
 *   addFiles()            pick .scl / .udt / .db files and add them
 *   generate(src)         generate blocks, PLC data types and DBs from a source
 *                         (asks before overwriting what already exists)
 *   fromBlocks(list)      a new source file from blocks / data types
 *   fromBlocksDialog()    ... choosing them in a dialog
 *   exportFile(src)       save a source as a file
 *   remove(src)
 *   T.editors.source.open(host, src)   the source tab: text + Generate button
 *
 * Sources stay in the project (saved with it) but are not downloaded to the
 * PLC: online.js leaves them out, like TIA.
 * Emits 'tree:changed', 'sources:changed', 'types:changed', 'iface:changed'.
 * =========================================================================*/
(function (T) {
  'use strict';

  T.injectCSS('tia-extsrc-css', `
    .tia-src { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--tia-canvas); }
    .tia-src-bar { flex: 0 0 auto; display: flex; align-items: center; gap: 8px; padding: 5px 8px;
      background: var(--tia-toolbar); border-bottom: 1px solid var(--tia-border); font-size: 12px; }
    .tia-src-bar .tia-src-name { font-weight: 700; color: var(--tia-petrol-deep); margin-right: auto; }
    .tia-src-bar button { height: 24px; padding: 0 10px; border-radius: 3px; cursor: pointer;
      border: 1px solid var(--tia-border); background: #fbfcfc; color: var(--tia-text); font-size: 12px; }
    .tia-src-bar button:hover { background: var(--tia-hover); border-color: var(--tia-petrol); }
    .tia-src-bar button.primary { background: var(--tia-petrol); color: #fff; border-color: var(--tia-petrol-dark); }
    .tia-src-bar button.primary:hover { background: var(--tia-petrol-dark); }
    .tia-src-text { flex: 1 1 auto; min-height: 0; resize: none; border: 0; outline: none; padding: 8px 10px;
      font-family: var(--tia-mono); font-size: 12.5px; line-height: 1.45; tab-size: 3; white-space: pre;
      background: #fff; color: var(--tia-text); }
    .tia-src-out { flex: 0 0 auto; max-height: 30%; overflow: auto; padding: 5px 10px; font-size: 12px;
      border-top: 1px solid var(--tia-border); background: var(--tia-panel); }
    .tia-src-out .ok { color: var(--tia-live); }
    .tia-src-out .err { color: #c0392b; cursor: pointer; }
    .tia-src-out .err:hover { text-decoration: underline; }
    .tia-src-pick { max-height: 260px; overflow: auto; border: 1px solid var(--tia-border-soft);
      padding: 4px 6px; background: #fff; }
    .tia-src-pick label { display: flex; gap: 6px; align-items: center; padding: 1px 0; color: var(--tia-text); }
    .tia-src-pick .grp { font-weight: 700; color: var(--tia-petrol-deep); margin-top: 4px; }
  `);

  const X = {};
  T.extsrc = X;
  const lc = (s) => String(s || '').toLowerCase();

  function list() { return T.project.sources || (T.project.sources = []); }
  function uniqueName(name) {
    const taken = (n) => list().some((s) => lc(s.name) === lc(n));
    if (!taken(name)) return name;
    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    let i = 1;
    while (taken(stem + '_' + i + ext)) i++;
    return stem + '_' + i + ext;
  }
  function changed() {
    T.bus.emit('sources:changed');
    T.bus.emit('tree:changed');
  }

  /* TIA exports UTF-8 (with a BOM); older files can be Windows-1252 */
  function readText(file) {
    const read = (enc) => new Promise((ok, fail) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result || ''));
      r.onerror = () => fail(r.error);
      r.readAsText(file, enc);
    });
    return read('utf-8').then((t) => (t.indexOf('�') >= 0 ? read('windows-1252') : t))
      .then((t) => t.replace(/^﻿/, ''));
  }

  X.addFiles = function () {
    if (!T.project) return;
    const inp = T.el('input', { type: 'file', multiple: true, accept: '.scl,.udt,.db,.txt' });
    inp.addEventListener('change', () => {
      const files = Array.from(inp.files || []);
      if (!files.length) return;
      Promise.all(files.map(readText)).then((texts) => {
        let last = null;
        files.forEach((f, i) => {
          last = { id: T.uid('src'), name: uniqueName(f.name), text: texts[i] };
          list().push(last);
        });
        changed();
        if (files.length === 1) T.bus.emit('open:source', last);
        T.status('Added ' + files.length + ' external source file(s) — right-click one → Generate blocks from source', 'ok');
      }).catch((e) => T.status('Could not read the file: ' + e.message, 'err'));
    });
    inp.click();
  };

  X.remove = function (src) {
    if (!window.confirm('Delete the external source file "' + src.name + '"?\n\nBlocks generated from it stay in the project.')) return;
    const i = list().indexOf(src);
    if (i >= 0) list().splice(i, 1);
    changed();
  };

  X.exportFile = function (src) {
    // the text as TIA writes it: UTF-8 with a BOM, CRLF line ends
    const text = '﻿' + String(src.text || '').replace(/\r?\n/g, '\r\n');
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = T.el('a', { href: url, download: src.name });
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
  };

  /* ------------------------------------------------- generate blocks */
  const KIND = { TYPE: 'PLC data type', FUNCTION: 'FC', FUNCTION_BLOCK: 'FB', ORGANIZATION_BLOCK: 'OB', DATA_BLOCK: 'DB' };
  // what generating `text` would overwrite
  function overwrites(units) {
    const p = T.project;
    return units.filter((u) => (u.kind === 'TYPE'
      ? (p.types || []).some((x) => lc(x.name) === lc(u.name))
      : (p.blocks || []).some((x) => lc(x.name) === lc(u.name))))
      .map((u) => '"' + u.name + '" (' + KIND[u.kind] + ')');
  }

  // returns the generate() result (null: cancelled / nothing in it)
  X.generate = function (src) {
    const text = String(src.text || '');
    const pre = T.sources.parse(text);
    if (!pre.units.length) {
      const why = pre.errors.length ? 'line ' + pre.errors[0].line + ': ' + pre.errors[0].msg : 'no TYPE / FUNCTION / FUNCTION_BLOCK / DATA_BLOCK / ORGANIZATION_BLOCK in it';
      T.status('Nothing generated from "' + src.name + '" — ' + why, 'err');
      showResult(src, { created: [], updated: [], errors: pre.errors.length ? pre.errors : [{ line: 1, msg: why }] });
      return null;
    }
    const over = overwrites(pre.units);
    if (over.length && !window.confirm('Generating blocks from "' + src.name + '" overwrites:\n\n  ' + over.join('\n  ') +
      '\n\nContinue?')) return null;
    const res = T.sources.generate(text);
    T.bus.emit('types:changed');
    T.bus.emit('iface:changed');
    changed();
    if (T.app && T.app.refreshTab) T.app.refreshTab();
    const n = res.created.length + res.updated.length;
    if (res.errors.length) T.status('Generated ' + n + ' object(s) from "' + src.name + '" with ' + res.errors.length + ' error(s)', 'warn');
    else T.status('Generated ' + n + ' object(s) from "' + src.name + '"', 'ok');
    showResult(src, res);
    return res;
  };

  /* ------------------------------------------------- source from blocks */
  function sourceName(objs) {
    const one = objs.length === 1 ? objs[0] : null;
    const ext = one && !one.type ? '.udt' : one && one.type === 'DB' ? '.db' : '.scl';
    return uniqueName((one ? one.name : (T.project.name || 'Program')) + ext);
  }
  X.fromBlocks = function (objs) {
    let text;
    try { text = T.sources.fromBlocks(objs); } catch (e) { T.status(e.message, 'err'); return null; }
    const src = { id: T.uid('src'), name: sourceName(objs), text };
    list().push(src);
    changed();
    T.bus.emit('open:source', src);
    T.status('Generated "' + src.name + '" from ' + objs.length + ' object(s)', 'ok');
    return src;
  };

  X.fromBlocksDialog = function () {
    if (!T.project || !T.editors.tree || !T.editors.tree.buildModal) return;
    const p = T.project;
    const pick = T.el('div', { class: 'tia-src-pick' });
    const boxes = [];
    const group = (title, items, label) => {
      if (!items.length) return;
      pick.appendChild(T.el('div', { class: 'grp' }, title));
      items.forEach((x) => {
        const cb = T.el('input', { type: 'checkbox' });
        boxes.push({ cb, x });
        pick.appendChild(T.el('label', null, cb, label(x)));
      });
    };
    // dependencies first, as TIA orders a source: data types, FCs/FBs, DBs, OBs
    group('PLC data types', p.types || [], (x) => '"' + x.name + '"');
    const scl = (t) => (p.blocks || []).filter((b) => b.type === t && b.lang === 'SCL');
    group('Functions / function blocks (SCL)', scl('FC').concat(scl('FB')), (b) => b.name + ' [' + b.type + b.number + ']');
    group('Data blocks', (p.blocks || []).filter((b) => b.type === 'DB'), (b) => b.name + ' [DB' + b.number + ']');
    group('Organization blocks (SCL)', scl('OB'), (b) => b.name + ' [OB' + b.number + ']');
    if (!boxes.length) { T.status('No SCL blocks, data types or DBs to write as source', 'warn'); return; }
    const all = T.el('input', { type: 'checkbox', onchange: (e) => boxes.forEach((b) => { b.cb.checked = e.target.checked; }) });
    T.editors.tree.buildModal({
      title: 'Generate source from blocks',
      rows: [{ label: 'All', field: all }, { label: '', field: pick }],
      onOk(showErr) {
        const chosen = boxes.filter((b) => b.cb.checked).map((b) => b.x);
        if (!chosen.length) { showErr('Choose at least one object.'); return false; }
        return X.fromBlocks(chosen) ? undefined : false;
      },
    });
  };

  /* ------------------------------------------------- the source tab */
  let host = null, cur = null, lastResult = null;
  function showResult(src, res) {
    lastResult = { src, res };
    renderOut();
  }
  function renderOut() {
    if (!host || !host.isConnected) return;
    const out = host.querySelector('.tia-src-out');
    if (!out) return;
    T.clear(out);
    const r = lastResult && lastResult.src === cur ? lastResult.res : null;
    out.style.display = r ? '' : 'none';
    if (!r) return;
    r.created.forEach((s) => out.appendChild(T.el('div', { class: 'ok' }, '✔ created ' + s)));
    r.updated.forEach((s) => out.appendChild(T.el('div', { class: 'ok' }, '✔ updated ' + s)));
    r.errors.forEach((e) => out.appendChild(T.el('div', {
      class: 'err', title: 'Go to line ' + e.line, onclick: () => gotoLine(e.line),
    }, '✖ line ' + e.line + ': ' + e.msg)));
  }
  function gotoLine(line) {
    const ta = host && host.querySelector('.tia-src-text');
    if (!ta) return;
    const lines = ta.value.split('\n');
    let pos = 0;
    for (let i = 0; i < Math.min(line - 1, lines.length); i++) pos += lines[i].length + 1;
    ta.focus();
    ta.setSelectionRange(pos, pos + (lines[line - 1] || '').length);
    // scroll the line into view (line height from the computed style)
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 18;
    ta.scrollTop = Math.max(0, (line - 4) * lh);
  }

  function open(hostEl, src) {
    host = hostEl;
    cur = src;
    T.clear(hostEl);
    if (!src) return;
    const ta = T.el('textarea', {
      class: 'tia-src-text', spellcheck: 'false', wrap: 'off',
      oninput: (e) => { src.text = e.target.value; T.bus.emit('sources:changed'); },
      onkeydown: (e) => {
        if (e.key !== 'Tab') return;           // Tab indents instead of leaving the editor
        e.preventDefault();
        const a = e.target.selectionStart, b = e.target.selectionEnd;
        e.target.setRangeText('   ', a, b, 'end');
        src.text = e.target.value;
        T.bus.emit('sources:changed');
      },
    });
    ta.value = String(src.text || '');
    hostEl.appendChild(T.el('div', { class: 'tia-src' },
      T.el('div', { class: 'tia-src-bar' },
        T.el('span', { class: 'tia-src-name' }, src.name),
        T.el('button', { class: 'primary', title: 'Create / update the blocks, PLC data types and DBs in this source',
          onclick: () => X.generate(src) }, 'Generate blocks from source'),
        T.el('button', { title: 'Save this source as a file', onclick: () => X.exportFile(src) }, 'Export file')),
      ta,
      T.el('div', { class: 'tia-src-out', style: { display: 'none' } })));
    renderOut();
  }

  T.editors = T.editors || {};
  T.editors.source = { open };

})(window.TIA);
