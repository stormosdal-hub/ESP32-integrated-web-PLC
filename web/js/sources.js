/* ============================================================================
 * sources.js — TIA "External source files": generate blocks from source,
 * generate source from blocks.
 *
 * A source file (.scl / .udt / .db) holds any number of
 *   TYPE "Name" … STRUCT … END_STRUCT; END_TYPE                 -> project.types
 *   FUNCTION "Name" : Int | Void … END_FUNCTION                 -> FC (SCL)
 *   FUNCTION_BLOCK "Name" … END_FUNCTION_BLOCK                  -> FB (SCL)
 *   ORGANIZATION_BLOCK "Name" … END_ORGANIZATION_BLOCK          -> OB (SCL)
 *   DATA_BLOCK "Name" (VAR…END_VAR | STRUCT…END_STRUCT | "UDT" | "FB")
 *     BEGIN path := value; … END_DATA_BLOCK                      -> DB
 * with VAR_INPUT / VAR_OUTPUT / VAR_IN_OUT / VAR (static) / VAR_TEMP /
 * VAR CONSTANT sections, { attributes } (kept out), VERSION / TITLE / AUTHOR
 * lines, and the code after BEGIN (BEGIN may be left out: the code then starts
 * after the last END_VAR). RETAIN / NON_RETAIN are accepted and ignored —
 * the ESP32 has no retentive memory.
 *
 * Project model:
 *   project.sources = [{ id, name, text }]
 *   project.types   = [{ id, name, comment, version, members:[Member] }]
 *   Member          = { id, name, dataType, default, comment, members? }  (Struct)
 *   FC              : iface.return = [] | [{ name:'RET_VAL', dataType }]
 *   global DB       : { type:'DB', lang:'DB', members | dbType, startValues }
 *   instance DB     : { type:'DB', instanceOf: fbId, startValues }
 *
 * Public API: T.sources.parse(text) -> { units, errors }
 *             T.sources.generate(text) -> { created, updated, errors, units }
 *             T.sources.fromBlocks(list) -> source text
 * ==========================================================================*/
(function (T) {
  'use strict';

  /* ------------------------------------------------------------ scanner */
  // tokens: {t:'id'|'q'|'str'|'num'|'p'|'cmt', v, s (start), e (end), line, nl (comment starts its line)}
  function scan(text) {
    const toks = [];
    let i = 0, line = 1;
    const n = text.length;
    let lineStart = true;
    while (i < n) {
      const c = text[i];
      if (c === '\n') { line++; i++; lineStart = true; continue; }
      if (c === ' ' || c === '\t' || c === '\r' || c === '﻿') { i++; continue; }
      const s = i, L = line, first = lineStart;
      lineStart = false;
      if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++;
        toks.push({ t: 'cmt', v: text.slice(s + 2, i).replace(/\r$/, ''), s, e: i, line: L, nl: first });
        continue;
      }
      if ((c === '(' && text[i + 1] === '*') || (c === '/' && text[i + 1] === '*')) {
        const close = c === '(' ? '*)' : '*/';
        const j = text.indexOf(close, i + 2);
        const end = j < 0 ? n : j + 2;
        for (let k = i; k < end; k++) if (text[k] === '\n') line++;
        toks.push({ t: 'cmt', v: text.slice(s + 2, j < 0 ? n : j), s, e: end, line: L, nl: first, block: true });
        i = end;
        continue;
      }
      if (c === '{') {
        let depth = 0;
        while (i < n) {
          if (text[i] === "'") { i++; while (i < n && text[i] !== "'") i++; }
          else if (text[i] === '{') depth++;
          else if (text[i] === '}') { depth--; if (!depth) { i++; break; } }
          else if (text[i] === '\n') line++;
          i++;
        }
        toks.push({ t: 'attr', v: text.slice(s, i), s, e: i, line: L });
        continue;
      }
      if (c === '"') {
        i++;
        while (i < n && text[i] !== '"' && text[i] !== '\n') i++;
        toks.push({ t: 'q', v: text.slice(s + 1, i), s, e: i + 1, line: L });
        i++;
        continue;
      }
      if (c === "'") {
        i++;
        while (i < n && text[i] !== "'" && text[i] !== '\n') { if (text[i] === '$') i++; i++; }
        i++;
        toks.push({ t: 'str', v: text.slice(s, i), s, e: i, line: L });
        continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        while (i < n && /[A-Za-z0-9_]/.test(text[i])) i++;
        if (text[i] === '#') { i++; while (i < n && /[A-Za-z0-9_.:+\-#]/.test(text[i])) i++; toks.push({ t: 'num', v: text.slice(s, i), s, e: i, line: L }); continue; }
        toks.push({ t: 'id', v: text.slice(s, i), s, e: i, line: L });
        continue;
      }
      if (/[0-9]/.test(c)) {
        while (i < n && /[0-9A-Fa-f_#.eE]/.test(text[i]) && !(text[i] === '.' && text[i + 1] === '.')) i++;
        toks.push({ t: 'num', v: text.slice(s, i), s, e: i, line: L });
        continue;
      }
      const two = text.substr(i, 2);
      if (two === ':=' || two === '..' || two === '=>' || two === '<>' || two === '<=' || two === '>=') {
        toks.push({ t: 'p', v: two, s, e: i + 2, line: L }); i += 2; continue;
      }
      toks.push({ t: 'p', v: c, s, e: i + 1, line: L });
      i++;
    }
    return toks;
  }

  const UNIT_KW = { TYPE: 'END_TYPE', FUNCTION: 'END_FUNCTION', FUNCTION_BLOCK: 'END_FUNCTION_BLOCK',
    ORGANIZATION_BLOCK: 'END_ORGANIZATION_BLOCK', DATA_BLOCK: 'END_DATA_BLOCK' };
  const SECTION_KW = { VAR_INPUT: 'input', VAR_OUTPUT: 'output', VAR_IN_OUT: 'inout', VAR_TEMP: 'temp', VAR: 'static' };

  function perr(msg, tk) { const e = new Error(msg); e.line = tk ? tk.line : 0; return e; }

  /* ------------------------------------------------------------- parser */
  function parse(text) {
    text = String(text == null ? '' : text);
    const all = scan(text);
    const units = [], errors = [];
    let i = 0;
    const up = (t) => (t && t.t === 'id' ? t.v.toUpperCase() : '');
    while (i < all.length) {
      const t = all[i];
      if (t.t === 'cmt' || t.t === 'attr') { i++; continue; }
      const kw = up(t);
      if (!UNIT_KW[kw]) { errors.push({ line: t.line, msg: 'Expected TYPE, FUNCTION, FUNCTION_BLOCK, ORGANIZATION_BLOCK or DATA_BLOCK, found "' + t.v + '"' }); i = skipTo(all, i, null); continue; }
      const endKw = UNIT_KW[kw];
      let j = i + 1;
      while (j < all.length && up(all[j]) !== endKw) j++;
      const toks = all.slice(i, Math.min(j + 1, all.length));
      try {
        if (j >= all.length) throw perr(kw + ' without ' + endKw, t);
        units.push(parseUnit(kw, toks, text));
      } catch (e) {
        const nm = toks[1] && (toks[1].t === 'q' || toks[1].t === 'id') ? toks[1].v : '?';
        errors.push({ line: e.line || t.line, msg: kw + ' "' + nm + '": ' + e.message });
      }
      i = j + 1;
    }
    return { units, errors };
  }
  function skipTo(all, i) {
    for (let k = i + 1; k < all.length; k++) if (all[k].t === 'id' && UNIT_KW[all[k].v.toUpperCase()]) return k;
    return all.length;
  }

  function parseUnit(kw, toks, text) {
    let p = 1;
    const peek = () => toks[p];
    const up = (t) => (t && (t.t === 'id') ? t.v.toUpperCase() : '');
    const nameTok = toks[p++];
    if (!nameTok || (nameTok.t !== 'q' && nameTok.t !== 'id')) throw perr('missing name', toks[0]);
    const unit = { kind: kw, name: nameTok.v, line: toks[0].line, comment: '', version: '', attrs: [] };
    if (kw === 'FUNCTION') {
      unit.ret = 'Void';
      if (peek() && peek().t === 'p' && peek().v === ':') {
        p++;
        const s = p;
        while (p < toks.length && toks[p].line === toks[s].line && toks[p].t !== 'cmt' && toks[p].t !== 'attr') p++;
        unit.ret = textOf(text, toks[s], toks[p - 1]).trim();
      }
    }
    if (kw === 'DATA_BLOCK') return parseDb(unit, toks, p, text);
    // header lines: TITLE, VERSION, AUTHOR, FAMILY, NAME, attributes, comments, KNOW_HOW_PROTECT
    const comments = [];
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.t === 'attr') { unit.attrs.push(t.v); p++; continue; }
      if (t.t === 'cmt') { comments.push(t.v.replace(/^ ?/, '')); p++; continue; }
      const u = up(t);
      if (u === 'TITLE' || u === 'VERSION' || u === 'AUTHOR' || u === 'FAMILY' || u === 'NAME') {
        p++;
        const ln = t.line;
        if (peek() && peek().t === 'p' && (peek().v === ':' || peek().v === '=')) p++;
        const s = p;
        if (u === 'VERSION') { if (p < toks.length && toks[p].line === ln && toks[p].t === 'num') p++; }
        else while (p < toks.length && toks[p].line === ln && toks[p].t !== 'cmt') p++;
        const v = s < p ? textOf(text, toks[s], toks[p - 1]).trim() : '';
        if (u === 'VERSION') unit.version = v;
        if (u === 'TITLE') unit.title = v;
        continue;
      }
      if (u === 'KNOW_HOW_PROTECT' || u === 'NON_RETAIN' || u === 'RETAIN' || u === 'UNLINKED' || u === 'READ_ONLY') { p++; continue; }
      break;
    }
    unit.comment = comments.join('\n').replace(/\s+$/, '');
    if (kw === 'TYPE') {
      if (up(peek()) !== 'STRUCT') throw perr('expected STRUCT', peek());
      p++;
      const r = members(toks, p, text, 'END_STRUCT');
      unit.members = r.list;
      p = r.p + 1;
      return unit;
    }
    // declaration sections
    unit.iface = { input: [], output: [], inout: [], static: [], temp: [], constant: [] };
    let lastDecl = p;
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.t === 'cmt' || t.t === 'attr') { p++; continue; }
      const u = up(t);
      if (SECTION_KW[u] != null) {
        p++;
        let sec = SECTION_KW[u];
        while (peek() && (up(peek()) === 'CONSTANT' || up(peek()) === 'RETAIN' || up(peek()) === 'NON_RETAIN' || up(peek()) === 'DB_SPECIFIC')) {
          if (up(peek()) === 'CONSTANT') sec = 'constant';
          p++;
        }
        if (sec === 'static' && kw !== 'FUNCTION_BLOCK') throw perr('VAR (static) is only allowed in a FUNCTION_BLOCK', t);
        const r = members(toks, p, text, 'END_VAR');
        unit.iface[sec] = unit.iface[sec].concat(r.list);
        p = r.p + 1;
        if (peek() && peek().t === 'p' && peek().v === ';') p++;
        lastDecl = p;
        continue;
      }
      break;
    }
    // code: after BEGIN, or straight after the declarations
    const endTok = toks[toks.length - 1];
    const codeStart = up(peek()) === 'BEGIN' ? peek().e : toks[lastDecl - 1].e;
    unit.code = dedent(text.slice(codeStart, endTok.s));
    return unit;
  }

  function parseDb(unit, toks, p, text) {
    const up = (t) => (t && t.t === 'id' ? t.v.toUpperCase() : '');
    const comments = [];
    for (;;) {
      const t = toks[p];
      if (!t) break;
      if (t.t === 'attr') { unit.attrs.push(t.v); p++; continue; }
      if (t.t === 'cmt') { comments.push(t.v.replace(/^ ?/, '')); p++; continue; }
      const u = up(t);
      if (u === 'TITLE' || u === 'VERSION' || u === 'AUTHOR' || u === 'FAMILY' || u === 'NAME') {
        p++;
        const ln = t.line;
        if (toks[p] && toks[p].t === 'p' && (toks[p].v === ':' || toks[p].v === '=')) p++;
        const s = p;
        if (u === 'VERSION') { if (p < toks.length && toks[p].line === ln && toks[p].t === 'num') p++; }
        else while (p < toks.length && toks[p].line === ln && toks[p].t !== 'cmt') p++;
        if (u === 'VERSION' && s < p) unit.version = textOf(text, toks[s], toks[p - 1]).trim();
        continue;
      }
      if (u === 'NON_RETAIN' || u === 'RETAIN' || u === 'UNLINKED' || u === 'READ_ONLY' || u === 'KNOW_HOW_PROTECT') { p++; continue; }
      break;
    }
    unit.comment = comments.join('\n').replace(/\s+$/, '');
    const t = toks[p];
    if (up(t) === 'STRUCT' || up(t) === 'VAR') {
      const end = up(t) === 'STRUCT' ? 'END_STRUCT' : 'END_VAR';
      p++;
      while (toks[p] && (up(toks[p]) === 'RETAIN' || up(toks[p]) === 'NON_RETAIN' || up(toks[p]) === 'DB_SPECIFIC')) p++;
      const r = members(toks, p, text, end);
      unit.members = r.list;
      p = r.p + 1;
      if (toks[p] && toks[p].t === 'p' && toks[p].v === ';') p++;
    } else if (t && (t.t === 'q' || t.t === 'id') && up(t) !== 'BEGIN') {
      unit.of = t.v;                                 // "UDT" or "FB" (instance DB)
      p++;
    } else throw perr('expected VAR, STRUCT, a data type or an FB name', t);
    while (toks[p] && toks[p].t === 'cmt') p++;
    unit.startValues = {};
    if (up(toks[p]) === 'BEGIN') {
      p++;
      while (p < toks.length - 1) {
        const s = p;
        if (toks[p].t === 'cmt') { p++; continue; }
        while (p < toks.length - 1 && !(toks[p].t === 'p' && toks[p].v === ':=')) p++;
        if (p >= toks.length - 1) break;
        const path = textOf(text, toks[s], toks[p - 1]).replace(/\s+/g, '');
        p++;
        const v0 = p;
        let depth = 0;
        while (p < toks.length - 1 && !(depth === 0 && toks[p].t === 'p' && toks[p].v === ';')) {
          if (toks[p].t === 'p' && (toks[p].v === '[' || toks[p].v === '(')) depth++;
          if (toks[p].t === 'p' && (toks[p].v === ']' || toks[p].v === ')')) depth--;
          p++;
        }
        if (v0 < p) unit.startValues[path] = textOf(text, toks[v0], toks[p - 1]).trim();
        p++;
      }
    }
    return unit;
  }

  // member declarations up to the end keyword; returns {list, p (index of the end keyword)}
  function members(toks, p, text, endKw) {
    const list = [];
    const up = (t) => (t && t.t === 'id' ? t.v.toUpperCase() : '');
    let pending = [];
    for (;;) {
      const t = toks[p];
      if (!t) throw perr('missing ' + endKw, toks[toks.length - 1]);
      if (up(t) === endKw) return { list, p };
      if (t.t === 'cmt') { if (t.nl) pending.push(t.v.trim()); p++; continue; }
      if (t.t === 'attr') { p++; continue; }
      if (t.t !== 'id' && t.t !== 'q') throw perr('expected a member name, found "' + t.v + '"', t);
      const m = { id: T.uid('mem'), name: t.v, dataType: '', default: '', comment: '' };
      p++;
      while (toks[p] && toks[p].t === 'attr') p++;
      if (!(toks[p] && toks[p].t === 'p' && toks[p].v === ':')) throw perr('expected ":" after ' + m.name, toks[p] || t);
      p++;
      // type text up to := or ; (depth 0), or the end of a line ending in Struct
      const ts = p;
      let depth = 0;
      while (p < toks.length) {
        const k = toks[p];
        if (k.t === 'p' && k.v === '[') depth++;
        if (k.t === 'p' && k.v === ']') depth--;
        if (depth === 0 && k.t === 'p' && (k.v === ':=' || k.v === ';')) break;
        if (depth === 0 && up(k) === 'STRUCT') break;            // Struct / Array[..] of Struct
        if (k.t === 'cmt' || up(k) === endKw) break;
        p++;
      }
      let ty = ts < p ? textOf(text, toks[ts], toks[p - 1]) : '';
      if (toks[p] && up(toks[p]) === 'STRUCT') {
        ty = (ty + ' Struct').trim();
        p++;
        const r = members(toks, p, text, 'END_STRUCT');
        m.members = r.list;
        p = r.p + 1;
      }
      m.dataType = normType(ty);
      if (!m.dataType) throw perr('missing data type for ' + m.name, t);
      if (toks[p] && toks[p].t === 'p' && toks[p].v === ':=') {
        p++;
        const vs = p;
        let d = 0;
        while (p < toks.length && !(d === 0 && toks[p].t === 'p' && toks[p].v === ';') && up(toks[p]) !== endKw && toks[p].t !== 'cmt') {
          if (toks[p].t === 'p' && (toks[p].v === '[' || toks[p].v === '(')) d++;
          if (toks[p].t === 'p' && (toks[p].v === ']' || toks[p].v === ')')) d--;
          p++;
        }
        m.default = vs < p ? textOf(text, toks[vs], toks[p - 1]).trim() : '';
      }
      if (toks[p] && toks[p].t === 'p' && toks[p].v === ';') p++;
      // a comment on the same line belongs to the member
      if (toks[p] && toks[p].t === 'cmt' && !toks[p].nl) { m.comment = toks[p].v.trim(); p++; }
      else if (pending.length) m.comment = pending.join(' ').replace(/\s+/g, ' ').trim();
      pending = [];
      list.push(m);
    }
  }

  function normType(s) {
    s = String(s || '').replace(/\s+/g, ' ').trim();
    s = s.replace(/\s*\[\s*/g, '[').replace(/\s*\]\s*/g, '] ').replace(/\s*,\s*/g, ', ').replace(/\s*\.\.\s*/g, '..').trim();
    s = s.replace(/\]\s+of\b/i, '] of').replace(/\s+$/, '');
    s = s.replace(/^array\b/i, 'Array').replace(/\bof\b/i, 'of').replace(/\bstruct$/i, 'Struct').replace(/^string\b/i, 'String');
    return s;
  }
  function textOf(text, a, b) { return text.slice(a.s, b.e); }
  function lineStartOf(text, pos) { while (pos > 0 && text[pos - 1] !== '\n') pos--; return pos; }
  function dedent(s) {
    const lines = s.replace(/\r/g, '').split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    let ind = Infinity;
    lines.forEach((l) => { if (l.trim()) ind = Math.min(ind, /^[ \t]*/.exec(l)[0].length); });
    if (!isFinite(ind)) ind = 0;
    return lines.map((l) => l.slice(ind).replace(/\s+$/, '')).join('\n');
  }

  /* ------------------------------------------------------- generation */
  const KIND_TYPE = { FUNCTION: 'FC', FUNCTION_BLOCK: 'FB', ORGANIZATION_BLOCK: 'OB', DATA_BLOCK: 'DB' };
  function lc(s) { return String(s || '').toLowerCase(); }

  // Generate blocks / data types from one source text into T.project.
  // Existing types / blocks of the same name are replaced in place (same id,
  // number, instance DBs keep pointing at them), like TIA asks to overwrite.
  function generate(text, opts) {
    opts = opts || {};
    const proj = T.project;
    const res = parse(text);
    const out = { created: [], updated: [], errors: res.errors.slice(), units: res.units };
    proj.types = proj.types || [];
    const order = { TYPE: 0, FUNCTION: 1, FUNCTION_BLOCK: 1, DATA_BLOCK: 2, ORGANIZATION_BLOCK: 3 };
    const units = res.units.slice().sort((a, b) => order[a.kind] - order[b.kind]);
    units.forEach((u) => {
      try {
        if (u.kind === 'TYPE') {
          let ty = proj.types.find((x) => lc(x.name) === lc(u.name));
          const fresh = { name: u.name, comment: u.comment, version: u.version, members: u.members };
          if (ty) { Object.assign(ty, fresh); out.updated.push('"' + u.name + '" (PLC data type)'); }
          else { ty = Object.assign({ id: T.uid('udt') }, fresh); proj.types.push(ty); out.created.push('"' + u.name + '" (PLC data type)'); }
          return;
        }
        const type = KIND_TYPE[u.kind];
        let b = proj.blocks.find((x) => lc(x.name) === lc(u.name));
        if (b && b.type !== type) throw new Error('a ' + b.type + ' named "' + u.name + '" already exists');
        const isNew = !b;
        if (!b) {
          b = T.model.newBlock(type, u.name, T.nextBlockNumber(type), type === 'DB' ? 'DB' : 'SCL');
          if (type === 'DB') { delete b.iface; b.networks = []; }
          proj.blocks.push(b);
        }
        b.comment = u.comment || b.comment || '';
        if (u.version) b.version = u.version;
        if (type === 'DB') {
          delete b.members; delete b.dbType; delete b.instanceOf;
          b.lang = 'DB';
          if (u.members) b.members = u.members;
          else {
            const fb = proj.blocks.find((x) => x.type === 'FB' && lc(x.name) === lc(u.of));
            if (fb) b.instanceOf = fb.id;
            else if (proj.types.find((x) => lc(x.name) === lc(u.of))) b.dbType = u.of;
            else throw new Error('"' + u.of + '" is neither a PLC data type nor an FB');
          }
          b.startValues = u.startValues || {};
        } else {
          b.lang = 'SCL';
          b.networks = [];
          b.code = u.code;
          const ifc = T.model.newInterface(type);
          T.ifaceSections(type).forEach((s) => { if (u.iface[s]) ifc[s] = u.iface[s]; });
          if (type === 'OB') { ifc.temp = u.iface.temp; ifc.constant = u.iface.constant; }
          if (type === 'FC') ifc.return = u.ret && !/^void$/i.test(u.ret) ? [T.model.newMember('RET_VAL', u.ret, '', '')] : [];
          b.iface = ifc;
          ['input', 'output', 'inout', 'static'].forEach((s) => {
            if (!(T.ifaceSections(type).indexOf(s) >= 0) && u.iface[s] && u.iface[s].length)
              out.errors.push({ line: u.line, msg: u.kind + ' "' + u.name + '": a ' + type + ' cannot have ' + s + ' members (ignored)' });
          });
        }
        (isNew ? out.created : out.updated).push('"' + u.name + '" [' + type + b.number + ']');
      } catch (e) {
        out.errors.push({ line: u.line, msg: u.kind + ' "' + u.name + '": ' + e.message });
      }
    });
    if (T.types) T.types.invalidate();
    // compile what was generated, like TIA does after generating
    units.forEach((u) => {
      if (u.kind === 'TYPE' || u.kind === 'DATA_BLOCK') {
        const b = u.kind === 'DATA_BLOCK' && proj.blocks.find((x) => lc(x.name) === lc(u.name));
        try {
          if (u.kind === 'TYPE') T.types.parse('"' + u.name + '"');
          else if (b) T.types.blockType(b);
        } catch (e) { out.errors.push({ line: u.line, msg: '"' + u.name + '": ' + e.message }); }
        return;
      }
      const b = proj.blocks.find((x) => lc(x.name) === lc(u.name));
      if (!b || !T.scl) return;
      T.scl.invalidate(b.id);
      const c = T.scl.check(b);
      if (c.error) out.errors.push({ line: u.line, msg: '"' + u.name + '" line ' + c.error.line + ': ' + c.error.msg });
    });
    return out;
  }

  /* -------------------------------------------- source from blocks */
  function q(name) { return '"' + name + '"'; }
  function memberLines(list, ind) {
    const out = [];
    (list || []).forEach((m) => {
      if (!m || !String(m.name || '').trim()) return;
      const cm = m.comment ? '   // ' + String(m.comment).replace(/\n/g, ' ') : '';
      if (/struct$/i.test(String(m.dataType || '').trim())) {
        out.push(ind + m.name + ' : ' + m.dataType + cm);
        out.push(...memberLines(m.members, ind + '   '));
        out.push(ind + 'END_STRUCT;');
      } else {
        out.push(ind + m.name + ' : ' + (m.dataType || 'Bool') + (String(m.default || '').trim() ? ' := ' + String(m.default).trim() : '') + ';' + cm);
      }
    });
    return out;
  }
  function commentLines(c) {
    return c ? String(c).split('\n').map((l) => '// ' + l) : [];
  }
  function fromBlocks(list) {
    const out = [];
    (list || []).forEach((x) => {
      if (!x) return;
      if (x.members && !x.type) {                       // a PLC data type
        out.push('TYPE ' + q(x.name));
        out.push('VERSION : ' + (x.version || '0.1'));
        out.push(...commentLines(x.comment).map((l) => '   ' + l));
        out.push('   STRUCT');
        out.push(...memberLines(x.members, '      '));
        out.push('   END_STRUCT;');
        out.push('END_TYPE', '', '');
        return;
      }
      if (x.type === 'DB') {
        out.push('DATA_BLOCK ' + q(x.name));
        out.push("{ S7_Optimized_Access := 'FALSE' }");
        out.push('VERSION : ' + (x.version || '0.1'));
        out.push(...commentLines(x.comment));
        out.push('NON_RETAIN');
        if (x.instanceOf) { const fb = T.findBlock(x.instanceOf); out.push(q(fb ? fb.name : '?')); }
        else if (x.dbType) out.push(q(String(x.dbType).replace(/"/g, '')));
        else { out.push('   VAR'); out.push(...memberLines(x.members, '      ')); out.push('   END_VAR'); }
        out.push('', 'BEGIN');
        Object.keys(x.startValues || {}).forEach((k) => out.push('   ' + k + ' := ' + x.startValues[k] + ';'));
        out.push('', 'END_DATA_BLOCK', '', '');
        return;
      }
      if (x.lang !== 'SCL') throw new Error('"' + x.name + '" is ' + x.lang + ': only SCL blocks, data types and DBs can be written as source');
      const kw = x.type === 'FC' ? 'FUNCTION' : x.type === 'FB' ? 'FUNCTION_BLOCK' : 'ORGANIZATION_BLOCK';
      const ifc = x.iface || {};
      let head = kw + ' ' + q(x.name);
      if (x.type === 'FC') head += ' : ' + ((ifc.return && ifc.return[0] && ifc.return[0].dataType) || 'Void');
      out.push(head);
      out.push("{ S7_Optimized_Access := 'FALSE' }");
      out.push('VERSION : ' + (x.version || '0.1'));
      out.push(...commentLines(x.comment));
      const secs = [['input', 'VAR_INPUT'], ['output', 'VAR_OUTPUT'], ['inout', 'VAR_IN_OUT'], ['static', 'VAR'], ['temp', 'VAR_TEMP'], ['constant', 'VAR CONSTANT']];
      secs.forEach(([k, kwd]) => {
        if (!(ifc[k] && ifc[k].length)) return;
        out.push('   ' + kwd);
        out.push(...memberLines(ifc[k], '      '));
        out.push('   END_VAR', '');
      });
      out.push('BEGIN');
      out.push(...String(x.code || '').split('\n').map((l) => (l ? '   ' + l : l)));
      out.push('END_' + kw, '', '');
    });
    return out.join('\n');
  }

  T.sources = { parse, generate, fromBlocks, dedent };
})(window.TIA);
