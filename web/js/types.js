/* ============================================================================
 * types.js — PLC data types: parsing, S7 memory layout, typed buffers.
 *
 * TIA's data types beyond the five elementary ones the tag table offers:
 * every elementary type (SInt … LReal, Time, Date, TOD, Char), String[n], DTL,
 * Array[lo..hi(, lo..hi)] of T, Struct, PLC data types (UDTs, project.types),
 * FB instances (user FBs and system FBs like TON / TCON) and Variant.
 *
 * Interface members, instance DBs, global DBs and FC frames all live in byte
 * buffers laid out like an S7 data block with STANDARD (non-optimized) access,
 * so a struct sent with TSEND has exactly the bytes a TIA PLC would send:
 *   Bool                  next bit (consecutive Bools share a byte)
 *   Byte Char SInt USInt  next byte
 *   everything else       next EVEN byte (Word, Int, Real, Time, DTL, String,
 *                         Array, Struct, FB instance …)
 *   Struct / Array        size rounded up to an even number of bytes
 *   Array of Bool         packed bits, element i at byte i/8, bit i%8
 *   String[n]             [max n][current length][n chars] = n + 2 bytes
 * Multi-byte values are big-endian. components/plc_core/plc_types.c is the C
 * port: same rules, same results (test/parity checks the buffers byte by byte).
 *
 * Public API (window.TIA.types):
 *   parse(str, members?)       -> type   (throws Error with a message)
 *   memberType(member)         -> type   (member.dataType [+ member.members])
 *   blockType(blk)             -> instance/frame type of a code block or DB
 *   read(buf, off, bit, t) / write(buf, off, bit, t, v) — elementary values
 *   conv(v, t)                 -> v converted to t's value range
 *   init(buf, off, t)          -> start values
 * ==========================================================================*/
(function (T) {
  'use strict';

  /* ------------------------------------------------------- elementary types
   * cls: bool | int (signed/unsigned integers) | bits (Byte/Word/DWord) | real
   *      | time (signed ms) | date (days since 1990-01-01) | tod (ms) | char  */
  const EL = {};
  function el(name, size, cls, bits, signed) {
    EL[name.toUpperCase()] = { k: 'el', n: name, size, align: size === 1 || cls === 'bool' ? 1 : 2,
      cls, bits: bits || 0, signed: !!signed };
  }
  el('Bool', 0, 'bool', 1);
  el('Byte', 1, 'bits', 8); el('Word', 2, 'bits', 16); el('DWord', 4, 'bits', 32);
  el('SInt', 1, 'int', 8, true); el('USInt', 1, 'int', 8);
  el('Int', 2, 'int', 16, true); el('UInt', 2, 'int', 16);
  el('DInt', 4, 'int', 32, true); el('UDInt', 4, 'int', 32);
  el('Real', 4, 'real', 32); el('LReal', 8, 'real', 64);
  el('Time', 4, 'time', 32, true); el('Date', 2, 'date', 16); el('Time_Of_Day', 4, 'tod', 32);
  el('Char', 1, 'char', 8);
  const ALIAS = { TOD: 'TIME_OF_DAY', BOOLEAN: 'BOOL' };
  // hardware / connection identifiers are Words in TIA
  ['HW_ANY', 'HW_IO', 'HW_INTERFACE', 'HW_DEVICE', 'HW_SUBMODULE', 'HW_HSC', 'HW_PWM', 'HW_PTO',
   'CONN_OUC', 'CONN_ANY', 'CONN_PRG', 'PORT', 'RTM', 'PIP', 'OB_ANY', 'OB_CYCLIC', 'EVENT_ANY']
    .forEach((a) => { ALIAS[a] = 'WORD'; });

  const STRING_DEFAULT_LEN = 254;

  /* ------------------------------------------------------------- layout */
  // Lay out members [{name, t, ...}] as a struct: fills off/bit, returns size.
  function layoutFields(fields) {
    let byte = 0, bit = 0;
    for (const f of fields) {
      const t = f.t;
      if (t.k === 'variant') { f.off = byte; f.bit = 0; continue; }   // a reference: no storage
      if (t.k === 'el' && t.cls === 'bool') {
        f.off = byte; f.bit = bit;
        if (++bit === 8) { byte++; bit = 0; }
        continue;
      }
      if (bit) { byte++; bit = 0; }
      if (alignOf(t) === 2 && (byte & 1)) byte++;
      f.off = byte; f.bit = 0;
      byte += t.size;
    }
    if (bit) byte++;
    return (byte + 1) & ~1;
  }
  function alignOf(t) { return t.k === 'el' ? t.align : 2; }

  function mkStruct(fields, name) {
    const t = { k: 'struct', name: name || '', fields, map: Object.create(null), size: 0, align: 2 };
    fields.forEach((f) => { f.lname = f.name.toLowerCase(); if (!(f.lname in t.map)) t.map[f.lname] = f; });
    t.size = layoutFields(fields);
    return t;
  }
  function mkArray(dims, elt) {
    let count = 1;
    dims.forEach((d) => { count *= (d.hi - d.lo + 1); });
    const t = { k: 'arr', dims, count, el: elt, size: 0, stride: 0, align: 2 };
    if (elt.k === 'el' && elt.cls === 'bool') {
      t.stride = 0;
      t.size = ((count + 15) >> 4) << 1;              // bits, whole words
    } else {
      t.stride = alignOf(elt) === 2 ? (elt.size + 1) & ~1 : elt.size;
      t.size = (count * t.stride + 1) & ~1;
    }
    return t;
  }
  function mkString(n) { return { k: 'str', len: n, size: n + 2, align: 2 }; }

  /* -------------------------------------------- built-in structured types */
  function F(name, ty, sec, extra) { return Object.assign({ name, t: ty, section: sec || '' }, extra || {}); }
  const DTL = mkStruct([
    F('YEAR', EL.UINT), F('MONTH', EL.USINT), F('DAY', EL.USINT), F('WEEKDAY', EL.USINT),
    F('HOUR', EL.USINT), F('MINUTE', EL.USINT), F('SECOND', EL.USINT), F('NANOSECOND', EL.UDINT)], 'DTL');
  const IP_V4 = mkStruct([F('ADDR', mkArray([{ lo: 1, hi: 4 }], EL.BYTE))], 'IP_V4');
  const TCON_IP_V4 = mkStruct([
    F('InterfaceId', EL.WORD), F('ID', EL.WORD), F('ConnectionType', EL.BYTE),
    F('ActiveEstablished', EL.BOOL), F('RemoteAddress', IP_V4), F('RemotePort', EL.UINT),
    F('LocalPort', EL.UINT)], 'TCON_IP_v4');
  const STRUCTS = { DTL, IP_V4, TCON_IP_V4 };

  /* System function blocks: instance layout (fields; section in|out|inout|stat;
   * ref = passed by reference, no storage). sysfb.js supplies the behaviour. */
  const SYSFB = Object.create(null);
  function sysfb(names, fields) {
    const def = { name: names[0], fields: fields.map((f) => Object.assign({}, f, f.ref ? { reft: f.t } : null)) };
    def.t = mkStruct(def.fields, names[0]);
    def.t.k = 'fb'; def.t.sys = def;
    names.forEach((n) => { SYSFB[n.toUpperCase()] = def; });
    return def;
  }
  const VAR = { k: 'variant', size: 0, align: 2 };
  const timerFields = () => [F('IN', EL.BOOL, 'in'), F('PT', EL.TIME, 'in'), F('Q', EL.BOOL, 'out'),
    F('ET', EL.TIME, 'out'), F('_run', EL.BOOL, 'stat'), F('_prev', EL.BOOL, 'stat'), F('_t0', EL.LREAL, 'stat')];
  sysfb(['TON', 'TON_TIME'], timerFields()).kind = 'ton';
  sysfb(['TOF', 'TOF_TIME'], timerFields()).kind = 'tof';
  sysfb(['TP', 'TP_TIME'], timerFields()).kind = 'tp';
  sysfb(['IEC_TIMER'], timerFields()).kind = 'iec_timer';      // called as #t.TON(...) / .TOF / .TP
  sysfb(['R_TRIG'], [F('CLK', EL.BOOL, 'in'), F('Q', EL.BOOL, 'out'), F('_prev', EL.BOOL, 'stat')]).kind = 'r_trig';
  sysfb(['F_TRIG'], [F('CLK', EL.BOOL, 'in'), F('Q', EL.BOOL, 'out'), F('_prev', EL.BOOL, 'stat')]).kind = 'f_trig';
  [['', 'INT'], ['_SINT', 'SINT'], ['_INT', 'INT'], ['_DINT', 'DINT'], ['_USINT', 'USINT'], ['_UINT', 'UINT'], ['_UDINT', 'UDINT']]
    .forEach(([suf, ty]) => {
      const n = EL[ty];
      const a = sysfb(['CTU' + suf], [F('CU', EL.BOOL, 'in'), F('R', EL.BOOL, 'in'), F('PV', n, 'in'),
        F('Q', EL.BOOL, 'out'), F('CV', n, 'out'), F('_prev', EL.BOOL, 'stat')]);
      a.kind = 'ctu'; a.cv = n;
      const b = sysfb(['CTD' + suf], [F('CD', EL.BOOL, 'in'), F('LD', EL.BOOL, 'in'), F('PV', n, 'in'),
        F('Q', EL.BOOL, 'out'), F('CV', n, 'out'), F('_prev', EL.BOOL, 'stat')]);
      b.kind = 'ctd'; b.cv = n;
      const c = sysfb(['CTUD' + suf], [F('CU', EL.BOOL, 'in'), F('CD', EL.BOOL, 'in'), F('R', EL.BOOL, 'in'),
        F('LD', EL.BOOL, 'in'), F('PV', n, 'in'), F('QU', EL.BOOL, 'out'), F('QD', EL.BOOL, 'out'),
        F('CV', n, 'out'), F('_pu', EL.BOOL, 'stat'), F('_pd', EL.BOOL, 'stat')]);
      c.kind = 'ctud'; c.cv = n;
    });
  sysfb(['TCON'], [F('REQ', EL.BOOL, 'in'), F('ID', EL.WORD, 'in'), F('CONNECT', VAR, 'inout', { ref: true }),
    F('DONE', EL.BOOL, 'out'), F('BUSY', EL.BOOL, 'out'), F('ERROR', EL.BOOL, 'out'), F('STATUS', EL.WORD, 'out'),
    F('_prev', EL.BOOL, 'stat'), F('_job', EL.BOOL, 'stat')]).kind = 'tcon';
  sysfb(['TDISCON'], [F('REQ', EL.BOOL, 'in'), F('ID', EL.WORD, 'in'),
    F('DONE', EL.BOOL, 'out'), F('BUSY', EL.BOOL, 'out'), F('ERROR', EL.BOOL, 'out'), F('STATUS', EL.WORD, 'out'),
    F('_prev', EL.BOOL, 'stat')]).kind = 'tdiscon';
  sysfb(['TSEND'], [F('REQ', EL.BOOL, 'in'), F('ID', EL.WORD, 'in'), F('LEN', EL.UDINT, 'in'),
    F('DATA', VAR, 'inout', { ref: true }),
    F('DONE', EL.BOOL, 'out'), F('BUSY', EL.BOOL, 'out'), F('ERROR', EL.BOOL, 'out'), F('STATUS', EL.WORD, 'out'),
    F('_prev', EL.BOOL, 'stat'), F('_job', EL.BOOL, 'stat')]).kind = 'tsend';
  sysfb(['TRCV'], [F('EN_R', EL.BOOL, 'in'), F('ID', EL.WORD, 'in'), F('LEN', EL.UDINT, 'in'),
    F('ADHOC', EL.BOOL, 'in'), F('DATA', VAR, 'inout', { ref: true }),
    F('NDR', EL.BOOL, 'out'), F('BUSY', EL.BOOL, 'out'), F('ERROR', EL.BOOL, 'out'), F('STATUS', EL.WORD, 'out'),
    F('RCVD_LEN', EL.UDINT, 'out'), F('_busy', EL.BOOL, 'stat')]).kind = 'trcv';

  /* --------------------------------------------------------------- parse */
  // Type strings as TIA writes them: Int, "MyUdt", String[20], Array[0..3] of Real,
  // Array[1..2, 0..9] of "MyUdt", Struct (members on the member), TON_TIME, "MyFB".
  function err(msg) { throw new Error(msg); }
  function unq(s) { s = String(s).trim(); return s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1) : s; }

  let _ctx = null;           // { project, stack: [names being resolved] } during a parse
  function findUdt(name) {
    const p = _ctx && _ctx.project;
    const ln = name.toLowerCase();
    return p && (p.types || []).find((u) => u && String(u.name || '').toLowerCase() === ln);
  }
  function findFb(name) {
    const p = _ctx && _ctx.project;
    const ln = name.toLowerCase();
    return p && (p.blocks || []).find((b) => b && b.type === 'FB' && String(b.name || '').toLowerCase() === ln);
  }

  function parseType(str, members) {
    let s = String(str == null ? '' : str).trim();
    if (!s) err('missing data type');
    // Array[lo..hi, ...] of T
    let m = /^array\s*\[(.*?)\]\s*of\s+([\s\S]+)$/i.exec(s);
    if (m) {
      const dims = m[1].split(',').map((d) => {
        const r = /^\s*(-?\d+)\s*\.\.\s*(-?\d+)\s*$/.exec(d);
        if (!r) err('bad array bounds "' + d.trim() + '"');
        const lo = +r[1], hi = +r[2];
        if (hi < lo) err('array upper bound below lower bound');
        return { lo, hi };
      });
      if (dims.length > 6) err('too many array dimensions');
      let count = 1;
      dims.forEach((d) => { count *= d.hi - d.lo + 1; });
      if (count > 65535) err('array too large (more than 65535 elements)');
      const elt = parseType(m[2], members);
      if (elt.k === 'variant') err('Array of Variant is not allowed');
      const t = mkArray(dims, elt);
      if (t.size > 65534) err('array too large (' + t.size + ' bytes)');
      return t;
    }
    // String / String[n]
    m = /^string\s*(?:\[\s*(\d+)\s*\])?$/i.exec(s);
    if (m) {
      const n = m[1] != null ? +m[1] : STRING_DEFAULT_LEN;
      if (n < 1 || n > 254) err('String length must be 1..254');
      return mkString(n);
    }
    if (/^struct$/i.test(s)) return structOf(members || [], '');
    if (/^variant$/i.test(s)) return VAR;
    const name = unq(s);
    const up = name.toUpperCase();
    const alias = ALIAS[up] || up;
    if (EL[alias] && s[0] !== '"') return EL[alias];
    if (STRUCTS[up] && s[0] !== '"') return STRUCTS[up];
    if (SYSFB[up] && s[0] !== '"') return SYSFB[up].t;
    const udt = findUdt(name);
    if (udt) {
      if (_ctx.stack.indexOf('T:' + up) >= 0) err('data type "' + name + '" contains itself');
      _ctx.stack.push('T:' + up);
      try { return structOf(udt.members || [], udt.name); } finally { _ctx.stack.pop(); }
    }
    const fb = findFb(name);
    if (fb) {
      if (_ctx.stack.indexOf('B:' + up) >= 0) err('FB "' + name + '" contains an instance of itself');
      _ctx.stack.push('B:' + up);
      try { return fbType(fb); } finally { _ctx.stack.pop(); }
    }
    err('unknown data type "' + s + '"');
  }

  function memberFields(list) {
    const out = [];
    (list || []).forEach((m) => {
      if (!m || !String(m.name || '').trim()) return;
      let t;
      try { t = parseType(m.dataType, m.members); }
      catch (e) { err(String(m.name).trim() + ': ' + e.message); }
      out.push({ name: String(m.name).trim(), t, def: m.default, m });
    });
    return out;
  }
  function structOf(list, name) { return mkStruct(memberFields(list), name); }

  // Sections of a code block, in instance order. 'return' = an FC's RET_VAL.
  const SECTIONS = {
    FB: ['input', 'output', 'inout', 'static', 'temp', 'constant'],
    FC: ['return', 'input', 'output', 'inout', 'temp', 'constant'],
    OB: ['temp', 'constant'],
  };
  const SEC_SHORT = { input: 'in', output: 'out', inout: 'inout', static: 'stat', temp: 'temp', constant: 'const', return: 'ret' };
  // Complex in-out parameters and Variant parameters are references, not copies.
  function isRefParam(sec, t, blkType) {
    if (t.k === 'variant') return true;
    if (sec === 'inout' && t.k !== 'el') return true;
    if (blkType === 'FC' && (sec === 'input' || sec === 'output') && t.k !== 'el') return true;
    return false;
  }
  function blockFields(blk) {
    const iface = blk.iface || {};
    const fields = [];
    (SECTIONS[blk.type] || []).forEach((sec) => {
      memberFields(iface[sec]).forEach((f) => {
        f.section = SEC_SHORT[sec];
        if (isRefParam(sec, f.t, blk.type)) { f.ref = true; f.reft = f.t; f.t = VAR; }
        fields.push(f);
      });
    });
    return fields;
  }
  function fbType(blk) {
    const t = mkStruct(blockFields(blk), blk.name);
    t.k = 'fb'; t.block = blk;
    return t;
  }

  /* --------------------------------------------------- elementary access */
  const _dv = new DataView(new ArrayBuffer(8));
  function round7(f) { return f === 0 ? 0 : parseFloat(f.toPrecision(7)); }
  function read(buf, off, bit, t) {
    if (t.cls === 'bool') return !!((buf[off] >> bit) & 1);
    switch (t.size) {
      case 1: return t.signed ? ((buf[off] << 24) >> 24) : buf[off];
      case 2: { const v = (buf[off] << 8) | buf[off + 1]; return t.signed && v >= 0x8000 ? v - 0x10000 : v; }
      case 4: {
        if (t.cls === 'real') {
          for (let i = 0; i < 4; i++) _dv.setUint8(i, buf[off + i]);
          const f = _dv.getFloat32(0);
          return isFinite(f) ? round7(f) : f;
        }
        const u = ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
        return t.signed ? (u | 0) : u;
      }
      case 8: for (let i = 0; i < 8; i++) _dv.setUint8(i, buf[off + i]); return _dv.getFloat64(0);
    }
    return 0;
  }
  // write an ALREADY CONVERTED value (see conv)
  function write(buf, off, bit, t, v) {
    if (t.cls === 'bool') {
      if (v) buf[off] |= (1 << bit); else buf[off] &= ~(1 << bit) & 0xFF;
      return;
    }
    switch (t.size) {
      case 1: buf[off] = v & 0xFF; return;
      case 2: buf[off] = (v >>> 8) & 0xFF; buf[off + 1] = v & 0xFF; return;
      case 4:
        if (t.cls === 'real') {
          _dv.setFloat32(0, v);
          for (let i = 0; i < 4; i++) buf[off + i] = _dv.getUint8(i);
          return;
        }
        buf[off] = (v >>> 24) & 0xFF; buf[off + 1] = (v >>> 16) & 0xFF;
        buf[off + 2] = (v >>> 8) & 0xFF; buf[off + 3] = v & 0xFF;
        return;
      case 8:
        _dv.setFloat64(0, v);
        for (let i = 0; i < 8; i++) buf[off + i] = _dv.getUint8(i);
    }
  }

  /* ------------------------------------------------------- conversions */
  function num(v) { if (v === true) return 1; if (v === false) return 0; const n = +v; return isFinite(n) ? n : 0; }
  // round half to even (TIA ROUND / REAL_TO_INT)
  function rhe(x) {
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return (f % 2 === 0) ? f : f + 1;
  }
  // wrap an integral number into a two's-complement range
  function wrap(x, bits, signed) {
    const m = bits === 32 ? 4294967296 : bits === 16 ? 65536 : 256;
    let r = x - Math.floor(x / m) * m;
    if (signed && r >= m / 2) r -= m;
    return r + 0;                                      // no -0
  }
  function conv(v, t) {
    if (t.cls === 'bool') return typeof v === 'boolean' ? v : (num(v) !== 0);
    let x = num(v);
    if (t.cls === 'real') return t.bits === 32 ? Math.fround(x) : x;
    if (x !== Math.floor(x)) x = rhe(x);
    return wrap(x, t.bits, t.signed);
  }

  /* ---------------------------------------------------- literal parsing
   * Start values and default values: TRUE/FALSE, 12, -3.5, 1.0E3, 16#FF,
   * 2#1010, 8#17, INT#5, WORD#16#FF, T#1s / TIME#…, 'text'. Returns
   * {v} (number/boolean), {s} (string) or null. */
  function parseLiteral(text) {
    let s = String(text == null ? '' : text).trim();
    if (!s) return null;
    if (/^'.*'$/.test(s)) return { s: unescapeStr(s.slice(1, -1)) };
    if (/^true$/i.test(s)) return { v: true };
    if (/^false$/i.test(s)) return { v: false };
    let m = /^([A-Za-z_]+)#(.*)$/.exec(s);
    if (m) {
      const pre = m[1].toUpperCase();
      if (pre === 'T' || pre === 'TIME' || pre === 'S5T' || pre === 'S5TIME') {
        const ms = parseTimeLit(m[2]);
        return ms == null ? null : { v: ms };
      }
      if (pre === 'BOOL') return parseLiteral(m[2]);
      s = m[2];                                      // INT#5, WORD#16#FF, REAL#1.5
      if (/^[+-]?\d+#/.test(s)) return radix(s);
    }
    if (/^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(s)) return { v: parseFloat(s.replace(/_/g, '')) };
    return radix(s);
  }
  function radix(s) {
    const m = /^([+-]?)(2|8|16)#([0-9A-Fa-f_]+)$/.exec(s);
    if (!m) return null;
    const digits = m[3].replace(/_/g, '');
    const base = +m[2];
    let v = 0;
    for (let i = 0; i < digits.length; i++) {
      const d = parseInt(digits[i], 16);
      if (!(d < base)) return null;
      v = v * base + d;
    }
    return { v: m[1] === '-' ? -v : v };
  }
  // IEC time literal body "1h2m3s4ms", "1.5s", "-2s" -> ms (null when malformed)
  function parseTimeLit(body) {
    let s = String(body).trim().replace(/_/g, '');
    let sign = 1;
    if (s[0] === '-') { sign = -1; s = s.slice(1); } else if (s[0] === '+') s = s.slice(1);
    if (/^\d+(\.\d+)?$/.test(s)) return sign * Math.round(parseFloat(s));
    const re = /(\d+(?:\.\d+)?)(ms|d|h|m|s)/gi;
    let ms = 0, pos = 0, mm;
    while ((mm = re.exec(s))) {
      if (mm.index !== pos) return null;
      pos = re.lastIndex;
      const v = parseFloat(mm[1]);
      switch (mm[2].toLowerCase()) {
        case 'ms': ms += v; break;
        case 's': ms += v * 1000; break;
        case 'm': ms += v * 60000; break;
        case 'h': ms += v * 3600000; break;
        case 'd': ms += v * 86400000; break;
      }
    }
    if (pos !== s.length || !pos) return null;
    return sign * Math.round(ms);
  }
  function unescapeStr(s) {
    return s.replace(/\$(\$|'|L|N|R|T|P|[0-9A-Fa-f]{2})/gi, (all, c) => {
      switch (c.toUpperCase()) {
        case '$': return '$';
        case "'": return "'";
        case 'L': case 'N': return '\n';
        case 'R': return '\r';
        case 'T': return '\t';
        case 'P': return '\f';
        default: return String.fromCharCode(parseInt(c, 16));
      }
    });
  }

  /* --------------------------------------------------------- strings */
  function strRead(buf, off, t) {
    const n = Math.min(buf[off + 1], t.len);
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(buf[off + 2 + i]);
    return s;
  }
  function strWrite(buf, off, t, s) {
    s = String(s);
    const n = Math.min(s.length, t.len);
    buf[off] = t.len;
    buf[off + 1] = n;
    for (let i = 0; i < n; i++) { const c = s.charCodeAt(i); buf[off + 2 + i] = c < 256 ? c : 63; }
  }

  /* ---------------------------------------------------- start values */
  // Initialise a value of type t at buf[off] (bit for Bool) from its declared
  // default text; Strings get their max length; structs recurse into members.
  function initValue(buf, off, bit, t, def) {
    if (t.k === 'el') {
      const lit = def == null ? null : legacyDefault(def, t);
      if (lit != null) write(buf, off, bit, t, conv(lit, t));
      return;
    }
    if (t.k === 'str') {
      buf[off] = t.len;
      const lit = parseLiteral(def);
      if (lit && lit.s != null) strWrite(buf, off, t, lit.s);
      return;
    }
    if (t.k === 'struct' || t.k === 'fb') {
      t.fields.forEach((f) => { if (f.t.k !== 'variant') initValue(buf, off + f.off, f.bit, f.t, f.def); });
      return;
    }
    if (t.k === 'arr') {
      const vals = arrayDefaults(def, t.count);
      for (let i = 0; i < t.count; i++) {
        const d = vals ? vals[i] : null;
        if (t.el.k === 'el' && t.el.cls === 'bool') initValue(buf, off + (i >> 3), i & 7, t.el, d);
        else initValue(buf, off + i * t.stride, 0, t.el, d == null && t.el.k !== 'el' ? undefined : d);
      }
    }
  }
  // the member default as the existing IDE understood it (keeps old projects)
  function legacyDefault(def, t) {
    const d = String(def).trim();
    if (!d) return null;
    if (t.cls === 'bool') {
      if (/^(1|true|on|yes)$/i.test(d)) return true;
      const l = parseLiteral(d);
      return l && l.v != null ? l.v : false;
    }
    const l = parseLiteral(d);
    if (l && l.v != null) return l.v;
    if (t.cls === 'time') return T.parseTime ? T.parseTime(d) : 0;
    const f = parseFloat(d);
    return isNaN(f) ? null : f;
  }
  // "[1, 2, 3]", "1, 2", "16(0)", "[4(TRUE), 2(FALSE)]" -> per-element default texts
  function arrayDefaults(def, count) {
    if (def == null) return null;
    let s = String(def).trim();
    if (!s) return null;
    if (s[0] === '[' && s[s.length - 1] === ']') s = s.slice(1, -1);
    const parts = splitTop(s);
    if (parts.length === 1 && !/^\d+\s*\(/.test(parts[0])) {
      return new Array(count).fill(parts[0]);
    }
    const out = [];
    parts.forEach((p) => {
      const m = /^(\d+)\s*\(([\s\S]*)\)$/.exec(p.trim());
      if (m) for (let i = 0; i < +m[1]; i++) out.push(m[2].trim());
      else out.push(p.trim());
    });
    return out;
  }
  function splitTop(s) {
    const out = [];
    let depth = 0, q = false, cur = '';
    for (const c of s) {
      if (c === "'") q = !q;
      if (!q && (c === '(' || c === '[')) depth++;
      if (!q && (c === ')' || c === ']')) depth--;
      if (!q && depth === 0 && c === ',') { out.push(cur); cur = ''; continue; }
      cur += c;
    }
    if (cur.trim() || out.length) out.push(cur);
    return out;
  }

  /* --------------------------------------------- paths inside a type
   * "a.b[3].c" relative to type t -> {off, bit, t} with constant indices, or
   * null. Used for DB start values and LAD/FBD operands. */
  function pathParts(path) {
    const out = [];
    const re = /\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)|\[([^\]]*)\]|(\.))/gy;
    let m, pos = 0;
    const s = String(path);
    re.lastIndex = 0;
    while (pos < s.length && (m = re.exec(s))) {
      pos = re.lastIndex;
      if (m[4]) continue;
      if (m[3] != null) {
        const idx = m[3].split(',').map((x) => x.trim());
        if (!idx.every((x) => /^-?\d+$/.test(x))) return null;
        out.push({ idx: idx.map(Number) });
      } else out.push({ name: m[1] != null ? m[1] : m[2] });
    }
    if (s.slice(pos).trim()) return null;
    return out;
  }
  function locate(t, parts, off, bit) {
    off = off || 0; bit = bit || 0;
    for (const p of parts) {
      if (p.name != null) {
        if (t.k !== 'struct' && t.k !== 'fb') return null;
        const f = t.map[p.name.toLowerCase()];
        if (!f || f.t.k === 'variant') return null;
        off += f.off; bit = f.bit; t = f.t;
      } else {
        if (t.k !== 'arr' || p.idx.length !== t.dims.length) return null;
        let lin = 0;
        for (let i = 0; i < t.dims.length; i++) {
          const d = t.dims[i];
          if (p.idx[i] < d.lo || p.idx[i] > d.hi) return null;
          lin = lin * (d.hi - d.lo + 1) + (p.idx[i] - d.lo);
        }
        if (t.el.k === 'el' && t.el.cls === 'bool') { off += lin >> 3; bit = lin & 7; }
        else { off += lin * t.stride; bit = 0; }
        t = t.el;
      }
    }
    return { off, bit, t };
  }

  /* -------------------------------------------------- block layouts */
  const _cache = new Map();          // block id -> { gen, t } | { gen, error }
  let _gen = 1;
  function invalidate() { _gen++; _cache.clear(); }
  ['project:loaded', 'tree:changed', 'iface:changed', 'types:changed', 'tags:changed'].forEach((ev) => T.bus.on(ev, invalidate));

  function withCtx(fn) {
    const prev = _ctx;
    _ctx = { project: T.project, stack: [] };
    try { return fn(); } finally { _ctx = prev; }
  }
  // Instance / frame type of a code block (FB, FC, OB), or the content type of
  // a DB (global: its members or its UDT; instance DB: the FB's instance type).
  // Returns a type, or throws.
  function blockType(blk) {
    const c = _cache.get(blk.id);
    if (c && c.gen === _gen) { if (c.error) throw new Error(c.error); return c.t; }
    let t, error = null;
    try {
      t = withCtx(() => {
        if (blk.type === 'DB') {
          if (blk.instanceOf) {
            const fb = (T.project.blocks || []).find((b) => b.id === blk.instanceOf);
            if (!fb || fb.type !== 'FB') err('instance DB of a missing FB');
            _ctx.stack.push('B:' + String(fb.name).toUpperCase());
            return fbType(fb);
          }
          if (blk.dbType) return parseType('"' + unq(blk.dbType) + '"');
          return structOf(blk.members || [], blk.name);
        }
        _ctx.stack.push('B:' + String(blk.name).toUpperCase());
        const tt = mkStruct(blockFields(blk), blk.name);
        tt.k = blk.type === 'FB' ? 'fb' : 'struct';
        tt.block = blk;
        return tt;
      });
      if (t.size > 65534) err('instance data larger than 64 KB');
    } catch (e) { error = e.message; }
    _cache.set(blk.id, { gen: _gen, t, error });
    if (error) throw new Error(error);
    return t;
  }

  // structural signature: two layouts with the same signature share memory safely
  function signature(t) {
    switch (t.k) {
      case 'el': return t.n;
      case 'str': return 'S' + t.len;
      case 'variant': return 'V';
      case 'arr': return 'A' + t.dims.map((d) => d.lo + ':' + d.hi).join(',') + '(' + signature(t.el) + ')';
      default: return '{' + t.fields.map((f) => f.lname + '@' + f.off + '.' + f.bit + ':' + signature(f.t)).join(';') + '}';
    }
  }
  function typeName(t) {
    switch (t.k) {
      case 'el': return t.n;
      case 'str': return 'String[' + t.len + ']';
      case 'variant': return 'Variant';
      case 'arr': return 'Array[' + t.dims.map((d) => d.lo + '..' + d.hi).join(', ') + '] of ' + typeName(t.el);
      case 'fb': return t.sys ? t.sys.name : '"' + t.name + '"';
      default: return t.name ? (STRUCTS[t.name.toUpperCase()] ? t.name : '"' + t.name + '"') : 'Struct';
    }
  }
  // same layout = assignable as a whole (TIA demands the same type; structural is enough here)
  function sameLayout(a, b) { return a === b || signature(a) === signature(b); }

  /* ------------------------------------------------- DTL from epoch ms */
  function daysToCivil(z) {                     // days since 1970-01-01 -> [y, m, d]
    z += 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const y = yoe + era * 400;
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const m = mp < 10 ? mp + 3 : mp - 9;
    return [m <= 2 ? y + 1 : y, m, d];
  }
  function writeDtl(buf, off, ms) {
    ms = Math.floor(num(ms));
    const days = Math.floor(ms / 86400000);
    let rem = ms - days * 86400000;
    const ymd = daysToCivil(days);
    const wd = ((days % 7) + 7 + 4) % 7;        // 1970-01-01 was a Thursday; 0 = Sunday
    write(buf, off, 0, EL.UINT, ymd[0]);
    buf[off + 2] = ymd[1]; buf[off + 3] = ymd[2]; buf[off + 4] = wd + 1;
    buf[off + 5] = Math.floor(rem / 3600000); rem %= 3600000;
    buf[off + 6] = Math.floor(rem / 60000); rem %= 60000;
    buf[off + 7] = Math.floor(rem / 1000); rem %= 1000;
    write(buf, off + 8, 0, EL.UDINT, rem * 1000000);
  }

  /* ------------------------------------------------ instance memory
   * T.mem.dbs[key] = { key, buf, t, sig, refs } — refs: bound reference
   * parameters (complex in-outs, Variant) of the instance, set per call. */
  function sigOf(t) { return t._sig || (t._sig = signature(t)); }
  function sameView(a, b) { return a === b || (a.buffer === b.buffer && a.byteOffset === b.byteOffset && a.length === b.length); }
  function applyStartValues(d, blk) {
    const sv = blk && blk.startValues;
    if (!sv || typeof sv !== 'object') return;
    Object.keys(sv).forEach((path) => {
      const parts = pathParts(path);
      const L = parts && locate(d.t, parts);
      if (!L) return;
      if (L.t.k === 'el') {
        const lit = parseLiteral(sv[path]);
        if (lit && lit.v != null) write(d.buf, L.off, L.bit, L.t, conv(lit.v, L.t));
      } else if (L.t.k === 'str') {
        const lit = parseLiteral(sv[path]);
        if (lit && lit.s != null) strWrite(d.buf, L.off, L.t, lit.s);
      }
    });
  }
  T.inst = {
    // memory of one block instance / FC frame / DB: created with its start
    // values the first time, recreated when its layout changed. `view` = a
    // slice of the parent's buffer for a multi-instance (already initialised).
    get(key, t, view, blk) {
      const mem = T.mem;
      const sg = sigOf(t);
      let d = mem.dbs[key];
      if (d && d.sig === sg && (!view || sameView(d.buf, view))) return d;
      let buf = view;
      if (!buf) {
        buf = new Uint8Array(t.size);
        initValue(buf, 0, 0, t, undefined);
      }
      d = { key, buf, t, sig: sg, refs: Object.create(null) };
      mem.dbs[key] = d;
      if (!view) applyStartValues(d, blk);
      // top-level elementary members answer to the classic operand keys
      (t.fields || []).forEach((f) => {
        if (f.t.k === 'el') mem.locs[T.memberKey(key, f.name)] = { db: key, off: f.off, bit: f.bit, t: f.t };
      });
      return d;
    },
    forBlock(blk, key, view) { return this.get(key, blockType(blk), view, blk); },
    db(dbBlk) { return this.forBlock(dbBlk, dbBlk.id); },
  };

  /* LAD/FBD operands with a path: "#Motor.speed", "Data".values[3],
   * MyDb.rec.flag — a member of the executing instance or an element of a DB,
   * with constant indices. Returns {db, off, bit, t, key} or null. */
  function canonPath(parts) {
    return parts.map((p, i) => p.name != null ? (i ? '.' : '') + p.name.toUpperCase() : '[' + p.idx.join(',') + ']').join('');
  }
  function findDb(name) {
    const ln = String(name).toLowerCase();
    return T.project && (T.project.blocks || []).find((b) => b && b.type === 'DB' && String(b.name || '').toLowerCase() === ln);
  }
  T.resolvePath = function (raw) {
    let s = String(raw).trim();
    let local = false;
    if (s[0] === '#') { local = true; s = s.slice(1); }
    const parts = pathParts(s);
    if (!parts || !parts.length || parts[0].name == null) return null;
    const sc = T._scope && T._scope['\u0000'];
    if (sc) {
      const f = sc.t.map && sc.t.map[parts[0].name.toLowerCase()];
      if (f && !f.ref) {
        const L = locate(sc.t, parts);
        if (!L) return null;
        return { db: sc.key, off: L.off, bit: L.bit, t: L.t, key: '@' + String(sc.key).toUpperCase() + ':' + canonPath(parts) };
      }
      if (f) return null;                         // reference parameters: SCL only
    }
    if (local || parts.length < 2) return null;
    const db = findDb(parts[0].name);
    if (!db) return null;
    let d;
    try { d = T.inst.db(db); } catch (e) { return null; }
    const L = locate(d.t, parts.slice(1));
    if (!L) return null;
    return { db: db.id, off: L.off, bit: L.bit, t: L.t, key: '@' + String(db.id).toUpperCase() + ':' + canonPath(parts.slice(1)) };
  };

  T.types = {
    EL, STRUCTS, SYSFB, VAR, DTL, TCON_IP_V4,
    parse(str, members) { return withCtx(() => parseType(str, members)); },
    memberType(m) { return withCtx(() => parseType(m && m.dataType, m && m.members)); },
    blockType, invalidate, signature, typeName, sameLayout,
    isElementary: (t) => t && t.k === 'el',
    read, write, conv, num, rhe, wrap, round7,
    strRead, strWrite, initValue, parseLiteral, parseTimeLit, unescapeStr,
    pathParts, locate, writeDtl, daysToCivil,
    get gen() { return _gen; },
  };
})(window.TIA);
