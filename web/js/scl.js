/* =========================================================================
 *  js/scl.js — Structured Control Language (SCL): typed compiler,
 *  interpreter and text editor.
 *
 *  TIA Portal's text language. An SCL block is one TEXT body (block.code).
 *    T.scl.exec(block, inst)  — compile (cached) + run the body for one
 *                               instance (inst = T.mem.dbs record, sim.js)
 *    T.scl.check(block)       — compile only: {error:{msg,line,col}} or ok
 *    T.editors.scl.open(host, block) — the code editor
 *
 *  The dialect is TIA's: #local, "Global", %MW10 / .%X3 slices, arrays,
 *  structs, PLC data types, String, DTL, typed literals (16#FF, INT#5,
 *  T#1s), FB calls (#inst(IN := x, Q => y)), FC calls with return value,
 *  system FBs (TON, R_TRIG, CTU, TCON, TSEND …: sysfb.js) and functions
 *  (conversions, MIN/MAX/LIMIT, SHL…, CountOfElements, RD_SYS_T …).
 *  Expressions are typed like TIA: Int / Int divides as integers, results
 *  wrap to their type (UInt 65535 + 1 = 0). Names without # still resolve
 *  the old way (member, tag, else an untyped symbol), so blocks written for
 *  the earlier untyped SCL keep working.
 *
 *  components/plc_core/plc_scl.c is the C port: same grammar, typing rules,
 *  results and error messages.
 * ====================================================================== */
(function (T) {
  'use strict';

  const TY = T.types;
  const EL = TY.EL;
  // pseudo types of expressions
  const ANYINT = { k: 'el', n: 'ANY_INT', cls: 'int', bits: 0, signed: true, any: true, size: 0 };
  const ANYREAL = { k: 'el', n: 'ANY_REAL', cls: 'real', bits: 64, any: true, size: 0 };
  const NUM = { k: 'el', n: 'NUM', cls: 'num', bits: 0, size: 0 };       // the old untyped number
  const STRV = { k: 'strv', n: 'String' };                                  // a string value
  const VOID = { k: 'void', n: 'Void' };

  /* ===================================================================== *
   *  TOKENIZER                                                            *
   * ===================================================================== */
  const KW = new Set([
    'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF', 'CASE', 'OF', 'END_CASE',
    'FOR', 'TO', 'BY', 'DO', 'END_FOR', 'WHILE', 'END_WHILE', 'REPEAT', 'UNTIL', 'END_REPEAT',
    'EXIT', 'CONTINUE', 'RETURN', 'AND', 'OR', 'XOR', 'NOT', 'MOD', 'TRUE', 'FALSE',
    'REGION', 'END_REGION', 'GOTO',
  ]);
  const ADDR_RE = /%(?:([IQM])X?(\d+)\.(\d+)|([IQM])([BWD])(\d+)|([XBWD])(\d+))/iy;

  function cerr(msg, line, col) { const e = new Error(msg); e.line = line || 0; e.col = col || 0; return e; }

  function tokenize(src) {
    const toks = [];
    let i = 0, line = 1, col = 1;
    const n = src.length;
    function adv(k) {
      for (let j = 0; j < k; j++) {
        if (src[i] === '\n') { line++; col = 1; } else col++;
        i++;
      }
    }
    const isId0 = (c) => /[A-Za-z_]/.test(c);
    const isId = (c) => /[A-Za-z0-9_]/.test(c);
    while (i < n) {
      const c = src[i];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { adv(1); continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') adv(1); continue; }
      if (c === '(' && src[i + 1] === '*') {
        adv(2);
        while (i < n && !(src[i] === '*' && src[i + 1] === ')')) adv(1);
        if (i >= n) throw cerr('Unterminated (* comment *)', line, col);
        adv(2); continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        adv(2);
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) adv(1);
        if (i >= n) throw cerr('Unterminated /* comment */', line, col);
        adv(2); continue;
      }
      if (c === '{') {                                   // attribute / pragma: ignored
        while (i < n && src[i] !== '}') adv(1);
        if (i >= n) throw cerr('Unterminated { attribute }', line, col);
        adv(1); continue;
      }
      const L = line, C = col;
      // numbers: 12, 1_000, 1.5, 2.0E-3, 16#FF, 2#1010
      if (c >= '0' && c <= '9') {
        let s = '';
        while (i < n && /[0-9_]/.test(src[i])) { s += src[i]; adv(1); }
        if (src[i] === '#' && /^(2|8|16)$/.test(s)) {
          adv(1);
          let r = '';
          while (i < n && /[0-9A-Fa-f_]/.test(src[i])) { r += src[i]; adv(1); }
          const lit = TY.parseLiteral(s + '#' + r);
          if (!lit) throw cerr('Bad number ' + s + '#' + r, L, C);
          toks.push({ t: 'num', v: lit.v, lit: 'int', line: L, col: C });
          continue;
        }
        let real = false;
        if (src[i] === '.' && src[i + 1] >= '0' && src[i + 1] <= '9') {
          real = true; s += '.'; adv(1);
          while (i < n && /[0-9_]/.test(src[i])) { s += src[i]; adv(1); }
        }
        if ((src[i] === 'e' || src[i] === 'E') && /[0-9]/.test(src[i + 1] === '+' || src[i + 1] === '-' ? src[i + 2] : src[i + 1])) {
          real = true; s += 'e'; adv(1);
          if (src[i] === '+' || src[i] === '-') { s += src[i]; adv(1); }
          while (i < n && /[0-9]/.test(src[i])) { s += src[i]; adv(1); }
        }
        toks.push({ t: 'num', v: parseFloat(s.replace(/_/g, '')), lit: real ? 'real' : 'int', line: L, col: C });
        continue;
      }
      // identifiers, keywords, typed literals PREFIX#value
      if (isId0(c)) {
        let s = '';
        while (i < n && isId(src[i])) { s += src[i]; adv(1); }
        const up = s.toUpperCase();
        if (src[i] === '#') {
          adv(1);
          toks.push(typedLiteral(up, L, C));
          continue;
        }
        if (up === 'REGION') {                           // REGION <name text>: the rest of the line is its name
          while (i < n && src[i] !== '\n') adv(1);
          toks.push({ t: 'kw', v: 'REGION', line: L, col: C });
          continue;
        }
        if (KW.has(up)) toks.push({ t: 'kw', v: up, line: L, col: C });
        else toks.push({ t: 'id', v: s, line: L, col: C });
        continue;
      }
      if (c === '#') {
        adv(1);
        if (!(i < n && isId0(src[i]))) throw cerr('Expected a name after #', L, C);
        let s = '';
        while (i < n && isId(src[i])) { s += src[i]; adv(1); }
        toks.push({ t: 'lid', v: s, line: L, col: C });
        continue;
      }
      if (c === '"') {
        adv(1);
        let s = '';
        while (i < n && src[i] !== '"' && src[i] !== '\n') { s += src[i]; adv(1); }
        if (src[i] !== '"') throw cerr('Unterminated "name"', L, C);
        adv(1);
        if (!s.trim()) throw cerr('Empty "name"', L, C);
        toks.push({ t: 'qid', v: s, line: L, col: C });
        continue;
      }
      if (c === "'") {
        adv(1);
        let s = '';
        while (i < n && src[i] !== "'" && src[i] !== '\n') {
          if (src[i] === '$' && i + 1 < n) { s += src[i]; adv(1); }
          s += src[i]; adv(1);
        }
        if (src[i] !== "'") throw cerr("Unterminated 'string'", L, C);
        adv(1);
        toks.push({ t: 'str', v: TY.unescapeStr(s), line: L, col: C });
        continue;
      }
      if (c === '%') {
        ADDR_RE.lastIndex = i;
        const m = ADDR_RE.exec(src);
        if (!m) throw cerr('Bad address after %', L, C);
        const len = m[0].length;
        let v;
        if (m[1]) v = m[1].toUpperCase() + m[2] + '.' + m[3];
        else if (m[4]) v = (m[4] + m[5]).toUpperCase() + m[6];
        else v = m[7].toUpperCase() + m[8];
        adv(len);
        toks.push({ t: 'addr', v, slice: !!m[7], line: L, col: C });
        continue;
      }
      const two = src.substr(i, 2);
      if ([':=', '=>', '<=', '>=', '<>', '..', '**', '+=', '-=', '*=', '/='].indexOf(two) >= 0) {
        toks.push({ t: 'op', v: two, line: L, col: C }); adv(2); continue;
      }
      if ('+-*/()<>=;:,.[]&'.indexOf(c) >= 0) { toks.push({ t: 'op', v: c, line: L, col: C }); adv(1); continue; }
      throw cerr('Unexpected character "' + c + '"', L, C);
    }
    toks.push({ t: 'eof', v: '<eof>', line, col });
    return toks;

    function typedLiteral(pre, L, C) {
      let rest = '';
      if (pre === 'T' || pre === 'TIME' || pre === 'S5T' || pre === 'S5TIME' || pre === 'LT' || pre === 'LTIME') {
        if (src[i] === '-' || src[i] === '+') { rest += src[i]; adv(1); }
        while (i < n && /[A-Za-z0-9_.]/.test(src[i])) { rest += src[i]; adv(1); }
        const ms = TY.parseTimeLit(rest);
        if (ms == null) throw cerr('Bad time literal ' + pre + '#' + rest, L, C);
        return { t: 'num', v: ms, lit: 'typed', ty: EL.TIME, line: L, col: C };
      }
      if (pre === 'D' || pre === 'DATE') {
        while (i < n && /[0-9-]/.test(src[i])) { rest += src[i]; adv(1); }
        const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(rest);
        if (!m) throw cerr('Bad date literal ' + pre + '#' + rest, L, C);
        const days = Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) - 7305;   // since 1990-01-01
        return { t: 'num', v: days, lit: 'typed', ty: EL.DATE, line: L, col: C };
      }
      if (pre === 'TOD' || pre === 'TIME_OF_DAY') {
        while (i < n && /[0-9:.]/.test(src[i])) { rest += src[i]; adv(1); }
        const m = /^(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,3}))?)?$/.exec(rest);
        if (!m) throw cerr('Bad time-of-day literal ' + pre + '#' + rest, L, C);
        const ms = ((+m[1] * 60 + +m[2]) * 60 + +(m[3] || 0)) * 1000 + +((m[4] || '0') + '00').slice(0, 3);
        return { t: 'num', v: ms, lit: 'typed', ty: EL.TIME_OF_DAY, line: L, col: C };
      }
      const ty = EL[pre];
      if (src[i] === '-' || src[i] === '+') { rest += src[i]; adv(1); }
      while (i < n && /[A-Za-z0-9_.#]/.test(src[i])) { rest += src[i]; adv(1); }
      if (ty && ty.cls === 'bool') {
        if (/^(true|1)$/i.test(rest)) return { t: 'num', v: true, lit: 'typed', ty, line: L, col: C };
        if (/^(false|0)$/i.test(rest)) return { t: 'num', v: false, lit: 'typed', ty, line: L, col: C };
        throw cerr('Bad Bool literal ' + pre + '#' + rest, L, C);
      }
      const lit = TY.parseLiteral(rest);
      if (!lit || lit.v == null || typeof lit.v !== 'number') throw cerr('Bad literal ' + pre + '#' + rest, L, C);
      if (!ty) return { t: 'num', v: lit.v, lit: /[.eE]/.test(rest) && !/#/.test(rest) ? 'real' : 'int', line: L, col: C };
      return { t: 'num', v: lit.v, lit: 'typed', ty, line: L, col: C };
    }
  }

  /* ===================================================================== *
   *  PARSER  (recursive descent -> AST)                                   *
   * ===================================================================== */
  // AST expressions: num{v,lit,ty} str{v} bool{v} name{v,local,quoted} addr{v}
  //   mem{a,name} slice{a,k,i} idx{a,idx[]} call{f,args[{name,out,e}]} un{op,a} bin{op,a,b}
  // statements: assign{lhs,op,rhs} call{c} if case for while repeat exit continue return region
  const MAX_EXPR_DEPTH = 32, MAX_STMT_DEPTH = 24;

  function parse(src) {
    const toks = tokenize(src);
    let p = 0, edepth = 0, sdepth = 0;
    const peek = () => toks[p];
    const next = () => { const t = toks[p]; if (t.t !== 'eof') p++; return t; };
    function err(msg, tk) {
      tk = tk || peek();
      return cerr(msg + ' near "' + (tk.t === 'qid' ? '"' + tk.v + '"' : tk.t === 'lid' ? '#' + tk.v : tk.t === 'str' ? "'" + tk.v + "'" : tk.v) + '"', tk.line, tk.col);
    }
    const isOp = (v) => peek().t === 'op' && peek().v === v;
    const isKw = (v) => peek().t === 'kw' && peek().v === v;
    function eatOp(v) { if (!isOp(v)) throw err('Expected "' + v + '"'); return next(); }
    function eatKw(v) { if (!isKw(v)) throw err('Expected ' + v); return next(); }
    function acceptOp(v) { if (isOp(v)) { next(); return true; } return false; }
    const at = (tk) => ({ line: tk.line, col: tk.col });

    function stmts(stop) {
      const out = [];
      while (!stop()) {
        if (peek().t === 'eof') break;
        if (acceptOp(';')) continue;
        out.push(stmt());
      }
      return out;
    }
    function stmt() {
      if (++sdepth > MAX_STMT_DEPTH) throw err('Statements nested too deeply');
      try { return stmt1(); } finally { sdepth--; }
    }
    function stmt1() {
      const t = peek();
      if (t.t === 'kw') {
        switch (t.v) {
          case 'IF': return parseIf();
          case 'CASE': return parseCase();
          case 'FOR': return parseFor();
          case 'WHILE': return parseWhile();
          case 'REPEAT': return parseRepeat();
          case 'EXIT': next(); acceptOp(';'); return Object.assign({ n: 'exit' }, at(t));
          case 'CONTINUE': next(); acceptOp(';'); return Object.assign({ n: 'continue' }, at(t));
          case 'RETURN': next(); acceptOp(';'); return Object.assign({ n: 'return' }, at(t));
          case 'REGION': {
            next();
            const body = stmts(() => isKw('END_REGION'));
            eatKw('END_REGION'); acceptOp(';');
            return Object.assign({ n: 'region', body }, at(t));
          }
          case 'GOTO': throw err('GOTO is not supported');
        }
      }
      if (t.t === 'id' || t.t === 'lid' || t.t === 'qid' || t.t === 'addr') {
        const lhs = postfix();
        const o = peek();
        if (o.t === 'op' && (o.v === ':=' || o.v === '+=' || o.v === '-=' || o.v === '*=' || o.v === '/=')) {
          next();
          const rhs = expr();
          acceptOp(';');
          return Object.assign({ n: 'assign', lhs, op: o.v, rhs }, at(t));
        }
        if (lhs.n === 'call') { acceptOp(';'); return Object.assign({ n: 'callst', c: lhs }, at(t)); }
        throw err('Expected ":="');
      }
      throw err('Unexpected statement');
    }
    function parseIf() {
      const t = eatKw('IF');
      const arms = [];
      let cond = expr(); eatKw('THEN');
      let body = stmts(() => isKw('ELSIF') || isKw('ELSE') || isKw('END_IF'));
      arms.push({ cond, body });
      while (isKw('ELSIF')) {
        next(); cond = expr(); eatKw('THEN');
        body = stmts(() => isKw('ELSIF') || isKw('ELSE') || isKw('END_IF'));
        arms.push({ cond, body });
      }
      let els = null;
      if (isKw('ELSE')) { next(); els = stmts(() => isKw('END_IF')); }
      eatKw('END_IF'); acceptOp(';');
      return Object.assign({ n: 'if', arms, els }, at(t));
    }
    // CASE labels: integer literals (also 16#.., INT#..), ranges a..b, or #CONSTANTS
    function labelLen(q) {
      const tk = toks[q];
      if (tk.t === 'op' && tk.v === '-') return toks[q + 1].t === 'num' ? 2 : 0;
      if (tk.t === 'num' || tk.t === 'lid') return 1;
      return 0;
    }
    function isCaseBoundary() {
      if (isKw('END_CASE') || isKw('ELSE')) return true;
      let q = p;
      const skip = () => {
        const a = labelLen(q); if (!a) return false; q += a;
        if (toks[q].t === 'op' && toks[q].v === '..') { q++; const b = labelLen(q); if (!b) return false; q += b; }
        return true;
      };
      if (!skip()) return false;
      while (toks[q].t === 'op' && toks[q].v === ',') { q++; if (!skip()) return false; }
      return toks[q].t === 'op' && toks[q].v === ':';
    }
    function caseValue() {
      const tk = peek();
      if (tk.t === 'lid') { next(); return { c: tk.v, line: tk.line, col: tk.col }; }
      let sign = 1;
      if (isOp('-')) { next(); sign = -1; }
      const nt = peek();
      if (nt.t !== 'num' || typeof nt.v !== 'number' || nt.lit === 'real' || nt.v !== Math.floor(nt.v)) throw err('Expected an integer in the CASE label');
      next();
      return { v: sign * nt.v };
    }
    function parseCase() {
      const t = eatKw('CASE');
      const sel = expr(); eatKw('OF');
      const arms = [];
      let els = null;
      while (!isKw('END_CASE') && !isKw('ELSE')) {
        if (peek().t === 'eof') throw err('Expected END_CASE');
        const labels = [];
        do {
          const lo = caseValue();
          let hi = lo;
          if (acceptOp('..')) hi = caseValue();
          labels.push({ lo, hi });
        } while (acceptOp(','));
        eatOp(':');
        arms.push({ labels, body: stmts(isCaseBoundary) });
      }
      if (isKw('ELSE')) { next(); acceptOp(':'); els = stmts(() => isKw('END_CASE')); }
      eatKw('END_CASE'); acceptOp(';');
      return Object.assign({ n: 'case', sel, arms, els }, at(t));
    }
    function parseFor() {
      const t = eatKw('FOR');
      const v = postfix();
      eatOp(':=');
      const from = expr(); eatKw('TO'); const to = expr();
      let by = null;
      if (isKw('BY')) { next(); by = expr(); }
      eatKw('DO');
      const body = stmts(() => isKw('END_FOR'));
      eatKw('END_FOR'); acceptOp(';');
      return Object.assign({ n: 'for', v, from, to, by, body }, at(t));
    }
    function parseWhile() {
      const t = eatKw('WHILE');
      const cond = expr(); eatKw('DO');
      const body = stmts(() => isKw('END_WHILE'));
      eatKw('END_WHILE'); acceptOp(';');
      return Object.assign({ n: 'while', cond, body }, at(t));
    }
    function parseRepeat() {
      const t = eatKw('REPEAT');
      const body = stmts(() => isKw('UNTIL'));
      eatKw('UNTIL'); const cond = expr(); eatKw('END_REPEAT'); acceptOp(';');
      return Object.assign({ n: 'repeat', body, cond }, at(t));
    }

    /* ---- expressions: OR < XOR < AND < = <> < < > <= >= < + - < * / MOD < unary < ** < postfix */
    function expr() {
      if (++edepth > MAX_EXPR_DEPTH) throw err('Expression nested too deeply');
      try { return parseOr(); } finally { edepth--; }
    }
    function bin(op, a, b, tk) { return { n: 'bin', op, a, b, line: tk.line, col: tk.col }; }
    function parseOr() { let a = parseXor(); while (isKw('OR')) { const t = next(); a = bin('OR', a, parseXor(), t); } return a; }
    function parseXor() { let a = parseAnd(); while (isKw('XOR')) { const t = next(); a = bin('XOR', a, parseAnd(), t); } return a; }
    function parseAnd() { let a = parseEq(); while (isKw('AND') || isOp('&')) { const t = next(); a = bin('AND', a, parseEq(), t); } return a; }
    function parseEq() { let a = parseRel(); while (isOp('=') || isOp('<>')) { const t = next(); a = bin(t.v, a, parseRel(), t); } return a; }
    function parseRel() {
      let a = parseAdd();
      while (isOp('<') || isOp('>') || isOp('<=') || isOp('>=')) { const t = next(); a = bin(t.v, a, parseAdd(), t); }
      return a;
    }
    function parseAdd() { let a = parseMul(); while (isOp('+') || isOp('-')) { const t = next(); a = bin(t.v, a, parseMul(), t); } return a; }
    function parseMul() {
      let a = parseUnary();
      while (isOp('*') || isOp('/') || isKw('MOD')) { const t = next(); a = bin(t.v, a, parseUnary(), t); }
      return a;
    }
    function parseUnary() {
      const t = peek();
      if (isKw('NOT')) { next(); return { n: 'un', op: 'NOT', a: unaryOperand(), line: t.line, col: t.col }; }
      if (isOp('-')) { next(); return { n: 'un', op: '-', a: unaryOperand(), line: t.line, col: t.col }; }
      if (isOp('+')) { next(); return unaryOperand(); }
      return parsePow();
    }
    function unaryOperand() {
      if (++edepth > MAX_EXPR_DEPTH) throw err('Expression nested too deeply');
      try { return parseUnary(); } finally { edepth--; }
    }
    function parsePow() {
      let a = primary();
      while (isOp('**')) { const t = next(); a = bin('**', a, unaryOperand(), t); }
      return a;
    }
    function primary() {
      const t = peek();
      if (t.t === 'num') { next(); return { n: 'num', v: t.v, lit: t.lit, ty: t.ty, line: t.line, col: t.col }; }
      if (t.t === 'str') { next(); return { n: 'str', v: t.v, line: t.line, col: t.col }; }
      if (t.t === 'kw' && (t.v === 'TRUE' || t.v === 'FALSE')) { next(); return { n: 'bool', v: t.v === 'TRUE', line: t.line, col: t.col }; }
      if (isOp('(')) { next(); const e = expr(); eatOp(')'); return e; }
      if (t.t === 'id' || t.t === 'lid' || t.t === 'qid' || t.t === 'addr') return postfix();
      throw err('Unexpected token in expression');
    }
    // name ( .member | .%X3 | [i, j] | (args) )*
    function postfix() {
      const t = next();
      let a;
      if (t.t === 'addr') {
        if (t.slice) throw err('A slice (%X0) needs a variable in front of it', t);
        a = { n: 'addr', v: t.v, line: t.line, col: t.col };
      } else a = { n: 'name', v: t.v, local: t.t === 'lid', quoted: t.t === 'qid', line: t.line, col: t.col };
      for (;;) {
        if (isOp('.')) {
          next();
          const m = peek();
          if (m.t === 'id' || m.t === 'qid') { next(); a = { n: 'mem', a, name: m.v, line: m.line, col: m.col }; continue; }
          if (m.t === 'kw') { next(); a = { n: 'mem', a, name: m.v, line: m.line, col: m.col }; continue; }
          if (m.t === 'addr' && m.slice) {
            next();
            a = { n: 'slice', a, k: m.v[0], i: +m.v.slice(1), line: m.line, col: m.col };
            continue;
          }
          throw err('Expected member name');
        }
        if (isOp('[')) {
          const b = next();
          const idx = [expr()];
          while (acceptOp(',')) idx.push(expr());
          eatOp(']');
          a = { n: 'idx', a, idx, line: b.line, col: b.col };
          continue;
        }
        if (isOp('(')) {
          if (a.n === 'call') throw err('Unexpected "("');
          const b = next();
          const args = [];
          if (!isOp(')')) {
            do {
              const k = peek(), k2 = toks[p + 1];
              if ((k.t === 'id' || k.t === 'kw') && k2.t === 'op' && (k2.v === ':=' || k2.v === '=>')) {
                next(); next();
                args.push({ name: k.v, out: k2.v === '=>', e: k2.v === '=>' ? postfix() : expr(), line: k.line, col: k.col });
              } else args.push({ name: null, out: false, e: expr(), line: k.line, col: k.col });
            } while (acceptOp(','));
          }
          eatOp(')');
          a = { n: 'call', f: a, args, line: b.line, col: b.col };
          continue;
        }
        return a;
      }
    }

    const body = stmts(() => peek().t === 'eof');
    if (peek().t !== 'eof') throw err('Unexpected token');
    return { n: 'block', body };
  }

  /* ===================================================================== *
   *  COMPILER  (AST -> typed IR)                                          *
   * ===================================================================== */
  const num = TY.num;
  const toBool = (v) => (typeof v === 'boolean' ? v : num(v) !== 0);
  function isBool(t) { return t.k === 'el' && t.cls === 'bool'; }
  function isNum(t) { return t.k === 'el' && t.cls === 'num'; }
  function isReal(t) { return t.k === 'el' && t.cls === 'real'; }
  function isIntLike(t) { return t.k === 'el' && (t.cls === 'int' || t.cls === 'bits' || t.cls === 'time' || t.cls === 'date' || t.cls === 'tod' || t.cls === 'char'); }
  function isValue(t) { return t.k === 'el' || t.k === 'strv'; }
  function tname(t) { return t.k === 'strv' ? 'String' : t === VOID ? 'Void' : t.any || t === NUM ? (t === NUM ? 'number' : t.n) : TY.typeName(t); }
  const INT_OF = { 8: [EL.USINT, EL.SINT], 16: [EL.UINT, EL.INT], 32: [EL.UDINT, EL.DINT] };

  // result type of an integer operation on a and b (both int-like)
  function intResult(a, b) {
    if (a.any && b.any) return ANYINT;
    if (a.any) return b;
    if (b.any) return a;
    if (a.cls === 'time' || b.cls === 'time') return EL.TIME;
    if (a.bits !== b.bits) return a.bits > b.bits ? a : b;
    if (a.n === b.n) return a;
    if (a.cls === 'bits' || a.cls === 'char' || a.cls === 'date' || a.cls === 'tod') return b;
    if (b.cls === 'bits' || b.cls === 'char' || b.cls === 'date' || b.cls === 'tod') return a;
    return a.bits >= 32 ? EL.DINT : INT_OF[a.bits * 2][1];       // signed/unsigned mix: next wider signed
  }
  // common type of two numeric operands (arithmetic / MIN / MAX / LIMIT / SEL)
  function numResult(a, b) {
    if (isNum(a) || isNum(b) || isBool(a) || isBool(b)) return NUM;
    if (isReal(a) || isReal(b)) {
      if ((isReal(a) && a.bits === 64 && !a.any) || (isReal(b) && b.bits === 64 && !b.any)) return EL.LREAL;
      if ((isReal(a) && !a.any) || (isReal(b) && !b.any)) return EL.REAL;
      return ANYREAL;
    }
    return intResult(a, b);
  }

  function compile(blk) {
    const cx = { blk, errors: [], calls: 0 };
    cx.t = TY.blockType(blk);                          // throws on an interface type error
    cx.fcRet = blk.type === 'FC' && cx.t.map.ret_val ? String(blk.name).toLowerCase() : null;
    const ast = parse(blk.code || '');
    return { body: blockC(cx, ast.body), ncalls: cx.calls };
  }

  function blockC(cx, list) { return list.map((s) => stmtC(cx, s)); }
  function E(msg, node) { return cerr(msg, node && node.line, node && node.col); }

  /* ------------------------------------------------------------ places
   * cell : a classic operand (tag, address, undeclared symbol): {key, bit, ty}
   * loc  : bytes in a buffer: base self|ref|db + steps (field offsets, indices)
   * slice: bits/bytes/words of an elementary place
   * whole: a reference parameter as a whole (Variant pass-through) */
  function placeOf(cx, n) {
    switch (n.n) {
      case 'name': return namePlace(cx, n);
      case 'addr': return addrPlace(cx, n);
      case 'mem': {
        // legacy dotted symbol: Motor.Run where Motor is nothing known
        const legacy = dottedLegacy(cx, n);
        if (legacy) return legacy;
        const b = placeOf(cx, n.a);
        const t = b.ty;
        if (t.k !== 'struct' && t.k !== 'fb') throw E('"' + n.name + '": ' + tname(t) + ' has no members', n);
        const f = t.map[n.name.toLowerCase()];
        if (!f) throw E('Unknown member "' + n.name + '" in ' + tname(t), n);
        if (f.t.k === 'variant') throw E('"' + n.name + '" is a reference parameter of ' + tname(t), n);
        return stepField(b, f, n);
      }
      case 'idx': {
        const b = placeOf(cx, n.a);
        const t = b.ty;
        if (t.k !== 'arr') throw E('Not an array: ' + tname(t), n);
        if (n.idx.length !== t.dims.length) throw E('Array needs ' + t.dims.length + ' index(es)', n);
        const idx = n.idx.map((e) => {
          const x = exprC(cx, e);
          if (!isIntLike(x.ty) && !isNum(x.ty)) throw E('Array index must be an integer, not ' + tname(x.ty), e);
          return x;
        });
        if (b.pk !== 'loc') throw E('Cannot index this', n);
        const constIdx = idx.every((x) => x.op === 'k');
        const steps = b.steps.slice();
        if (constIdx) {
          const L = TY.locate(t, [{ idx: idx.map((x) => x.v) }]);
          if (!L) throw E('Array index out of range', n);
          steps.push({ k: 'f', off: L.off, bit: L.bit });
        } else steps.push({ k: 'i', t, idx });
        return Object.assign({}, b, { steps, ty: t.el, dyn: b.dyn || !constIdx });
      }
      case 'slice': {
        const b = placeOf(cx, n.a);
        if (!(isIntLike(b.ty) || (b.pk === 'cell' && isNum(b.ty)))) throw E('Slices need a bit string or integer, not ' + tname(b.ty), n);
        const width = b.ty.bits || 32;
        const per = { X: 1, B: 8, W: 16, D: 32 }[n.k];
        if (per > width || n.i < 0 || (n.i + 1) * per > width) throw E('Slice %' + n.k + n.i + ' is outside ' + tname(b.ty), n);
        return { pk: 'slice', base: b, k: n.k, i: n.i, ty: n.k === 'X' ? EL.BOOL : n.k === 'B' ? EL.BYTE : n.k === 'W' ? EL.WORD : EL.DWORD, width };
      }
      case 'call': throw E('A call result cannot be assigned or indexed', n);
    }
    throw E('Not a variable', n);
  }
  function stepField(b, f, n) {
    if (b.pk !== 'loc') throw E('Cannot access members here', n);
    const steps = b.steps.slice();
    const last = steps[steps.length - 1];
    if (last && last.k === 'f') steps[steps.length - 1] = { k: 'f', off: last.off + f.off, bit: f.bit };
    else steps.push({ k: 'f', off: f.off, bit: f.bit });
    return Object.assign({}, b, { steps, ty: f.t, isConst: b.isConst || f.section === 'const', field: f });
  }
  function selfField(cx, f, n) {
    if (f.ref) return { pk: 'loc', base: 'ref', ref: f.lname, steps: [], ty: f.reft, field: f, variant: f.reft.k === 'variant' };
    return { pk: 'loc', base: 'self', steps: [{ k: 'f', off: f.off, bit: f.bit }], ty: f.t, isConst: f.section === 'const', field: f };
  }
  function localField(cx, name) {
    const ln = name.toLowerCase();
    if (cx.fcRet && ln === cx.fcRet) return cx.t.map.ret_val;
    return cx.t.map[ln] || null;
  }
  function namePlace(cx, n) {
    if (n.local) {
      const f = localField(cx, n.v);
      if (!f) throw E('Unknown local variable #' + n.v, n);
      return selfField(cx, f, n);
    }
    if (n.quoted) {
      const g = globalPlace(cx, n.v);
      if (g) return g;
      throw E('Unknown global "' + n.v + '" (no tag or data block of that name)', n);
    }
    const f = localField(cx, n.v);
    if (f) return selfField(cx, f, n);
    const g = globalPlace(cx, n.v);
    if (g) return g;
    // an undeclared symbol: the old untyped SCL's auto cell
    const r = T.resolve(n.v, 'word');
    return { pk: 'cell', key: r.addr, bit: r.type === 'bit', ty: NUM };
  }
  function tagType(tag) {
    try { const t = TY.parse(tag.dataType || 'Int'); return t.k === 'el' ? t : NUM; } catch (e) { return NUM; }
  }
  function globalPlace(cx, name) {
    const p = T.project;
    const tag = T.tagByName(name) || (p.tags || []).find((t) => t.name && t.name.toLowerCase() === name.toLowerCase());
    if (tag) {
      const r = T.resolve(tag.name, tag.dataType === 'Bool' ? 'bit' : 'word');
      return { pk: 'cell', key: r.addr, bit: r.type === 'bit', ty: tagType(tag) };
    }
    const db = (p.blocks || []).find((b) => b.type === 'DB' && String(b.name || '').toLowerCase() === name.toLowerCase());
    if (db) {
      let t;
      try { t = TY.blockType(db); } catch (e) { throw E('Data block "' + db.name + '": ' + e.message, null); }
      return { pk: 'loc', base: 'db', db: db, steps: [], ty: t };
    }
    return null;
  }
  function dottedLegacy(cx, n) {
    // only for a pure a.b.c chain whose head is not a local, tag or DB
    const names = [];
    let x = n;
    while (x.n === 'mem') { names.unshift(x.name); x = x.a; }
    if (x.n !== 'name' || x.local || x.quoted) return null;
    if (localField(cx, x.v) || globalPlace(cx, x.v)) return null;
    const key = [x.v].concat(names).join('.');
    const r = T.resolve(key, 'word');
    if (r.type !== 'bit' && r.type !== 'word') return null;
    return { pk: 'cell', key: r.addr, bit: r.type === 'bit', ty: NUM };
  }
  function addrPlace(cx, n) {
    const r = T.resolve(n.v, 'word');
    if (r.type !== 'bit' && r.type !== 'word') throw E('Bad address %' + n.v, n);
    let ty = EL.BOOL;
    if (r.type === 'word') ty = /^[IQM]B/.test(n.v) ? EL.BYTE : /^[IQM]W/.test(n.v) ? EL.WORD : EL.DWORD;
    return { pk: 'cell', key: r.addr, bit: r.type === 'bit', ty };
  }

  /* ------------------------------------------------------- expressions */
  function K(v, ty) { return { op: 'k', v, ty }; }
  function exprC(cx, n) {
    switch (n.n) {
      case 'num':
        if (n.ty) return K(n.ty.cls === 'bool' ? !!n.v : n.ty.cls === 'real' ? n.v : TY.conv(n.v, n.ty), n.ty);
        return K(n.v, n.lit === 'real' ? ANYREAL : ANYINT);
      case 'bool': return K(n.v, EL.BOOL);
      case 'str': return K(n.v, STRV);
      case 'un': {
        const a = exprC(cx, n.a);
        if (!isValue(a.ty) || a.ty.k === 'strv') throw E('Operator ' + n.op + ' needs a value, not ' + tname(a.ty), n);
        if (n.op === 'NOT') {
          if (isIntLike(a.ty)) return fold({ op: 'bnot', a, ty: a.ty });
          return fold({ op: 'not', a, ty: EL.BOOL });
        }
        return fold({ op: 'neg', a, ty: isBool(a.ty) ? NUM : a.ty });
      }
      case 'bin': return binC(cx, n);
      case 'call': {
        const c = callC(cx, n, true);
        return c;
      }
      default: {
        const pl = placeOf(cx, n);
        if (pl.ty.k === 'str') return { op: 'rds', p: pl, ty: STRV };
        if (pl.ty.k !== 'el') throw E(tname(pl.ty) + ' cannot be used as a value here', n);
        return { op: 'rd', p: pl, ty: pl.ty };
      }
    }
  }
  function binC(cx, n) {
    const a = exprC(cx, n.a), b = exprC(cx, n.b);
    const op = n.op;
    const bad = (x) => { throw E('Operator ' + op + ' cannot take ' + tname(x.ty), n); };
    if (!isValue(a.ty)) bad(a);
    if (!isValue(b.ty)) bad(b);
    if (op === '=' || op === '<>' || op === '<' || op === '>' || op === '<=' || op === '>=') {
      const sa = a.ty.k === 'strv', sb = b.ty.k === 'strv';
      if (sa !== sb) throw E('Cannot compare ' + tname(a.ty) + ' with ' + tname(b.ty), n);
      return fold({ op: 'cmp', o: op, a, b, str: sa, ty: EL.BOOL });
    }
    if (a.ty.k === 'strv') bad(a);
    if (b.ty.k === 'strv') bad(b);
    if (op === 'AND' || op === 'OR' || op === 'XOR') {
      if (isIntLike(a.ty) && isIntLike(b.ty)) {
        const ty = intResult(a.ty, b.ty);
        return fold({ op: 'bit', o: op, a, b, ty });
      }
      return fold({ op: op === 'AND' ? 'and' : op === 'OR' ? 'or' : 'xor', a, b, ty: EL.BOOL });
    }
    // arithmetic
    if (op === '**') return fold({ op: 'ar', o: op, a, b, ty: EL.LREAL, mode: 'flt' });
    let ty = numResult(a.ty, b.ty);
    let mode = isNum(ty) ? 'num' : isReal(ty) ? 'flt' : 'int';
    if (mode === 'int' && ty.cls === 'time' && op === '/' && a.ty.cls === 'time' && b.ty.cls === 'time') ty = EL.DINT;
    return fold({ op: 'ar', o: op, a, b, ty, mode });
  }
  // constant folding keeps CASE labels, array indices and offsets static
  function fold(x) {
    const kids = [x.a, x.b].filter(Boolean);
    if (!kids.every((k) => k.op === 'k')) return x;
    try { return K(evalE(x, null), x.ty); } catch (e) { return x; }
  }

  /* -------------------------------------------------------- calls */
  // builtin functions: name -> { p: [param names] | null (variadic), c(cx, args, node) -> IR }
  const BUILTIN = Object.create(null);
  function defFn(names, params, c) { names.split(' ').forEach((nm) => { BUILTIN[nm] = { p: params, c }; }); }
  function valArg(x, node, what) {
    if (!x || !isValue(x.ty) || x.ty.k === 'strv') throw E((what || 'Argument') + ' must be a number or Bool', node);
    return x;
  }
  function realOf(t) { return isReal(t) && !t.any ? t : EL.LREAL; }
  defFn('ABS', ['IN'], (cx, a, n) => ({ op: 'fn', f: 'ABS', args: [valArg(a[0], n)], ty: isBool(a[0].ty) ? NUM : a[0].ty }));
  'SQRT LN LOG EXP SIN COS TAN ASIN ACOS ATAN'.split(' ').forEach((nm) =>
    defFn(nm, ['IN'], (cx, a, n) => ({ op: 'fn', f: nm, args: [valArg(a[0], n)], ty: realOf(a[0].ty) })));
  defFn('SQR', ['IN'], (cx, a, n) => ({ op: 'fn', f: 'SQR', args: [valArg(a[0], n)], ty: realOf(a[0].ty) }));
  defFn('EXPT', ['IN1', 'IN2'], (cx, a, n) => ({ op: 'ar', o: '**', a: valArg(a[0], n), b: valArg(a[1], n), ty: EL.LREAL, mode: 'flt' }));
  defFn('TRUNC ROUND CEIL FLOOR', ['IN'], null);
  ['TRUNC', 'ROUND', 'CEIL', 'FLOOR'].forEach((nm) => {
    BUILTIN[nm].c = (cx, a, n) => ({ op: 'fn', f: nm, args: [valArg(a[0], n)], ty: EL.DINT });
  });
  defFn('INT', ['IN'], (cx, a, n) => ({ op: 'fn', f: 'TRUNC', args: [valArg(a[0], n)], ty: EL.DINT }));   // old SCL
  defFn('REAL', ['IN'], (cx, a, n) => ({ op: 'fn', f: 'REAL', args: [valArg(a[0], n)], ty: EL.LREAL }));  // old SCL
  defFn('MIN MAX', null, null);
  ['MIN', 'MAX'].forEach((nm) => {
    BUILTIN[nm].c = (cx, a, n) => {
      if (a.length < 1) throw E(nm + ' needs arguments', n);
      a.forEach((x) => valArg(x, n));
      let ty = a[0].ty;
      for (let i = 1; i < a.length; i++) ty = numResult(ty, a[i].ty);
      if (a.length === 1 && isBool(ty)) ty = NUM;
      return { op: 'fn', f: nm, args: a, ty };
    };
  });
  defFn('LIMIT', ['MN', 'IN', 'MX'], (cx, a, n) => {
    a.forEach((x) => valArg(x, n));
    return { op: 'fn', f: 'LIMIT', args: a, ty: numResult(numResult(a[0].ty, a[1].ty), a[2].ty) };
  });
  defFn('SEL', ['G', 'IN0', 'IN1'], (cx, a, n) => {
    a.forEach((x) => valArg(x, n));
    return { op: 'fn', f: 'SEL', args: a, ty: numResult(a[1].ty, a[2].ty) };
  });
  defFn('SHL SHR ROL ROR', ['IN', 'N'], null);
  ['SHL', 'SHR', 'ROL', 'ROR'].forEach((nm) => {
    BUILTIN[nm].c = (cx, a, n) => {
      valArg(a[0], n); valArg(a[1], n);
      if (!isIntLike(a[0].ty)) throw E(nm + ' needs a bit string or integer', n);
      return { op: 'fn', f: nm, args: a, ty: a[0].ty.any ? EL.DWORD : a[0].ty };
    };
  });
  defFn('NORM_X', ['MIN', 'VALUE', 'MAX'], (cx, a, n) => {
    a.forEach((x) => valArg(x, n));
    return { op: 'fn', f: 'NORM_X', args: a, ty: EL.REAL };
  });
  defFn('SCALE_X', ['MIN', 'VALUE', 'MAX'], (cx, a, n) => {
    a.forEach((x) => valArg(x, n));
    let ty = numResult(a[0].ty, a[2].ty);
    if (ty.any || isNum(ty)) ty = ANYREAL;
    return { op: 'fn', f: 'SCALE_X', args: a, ty };
  });

  // CONVERSIONS: <SRC>_TO_<DST>
  const CONV_RE = /^([A-Z]+(?:_OF_DAY)?)_TO_([A-Z]+(?:_OF_DAY)?)$/;
  function convFn(name) {
    const m = CONV_RE.exec(name);
    if (!m) return null;
    const src = EL[m[1] === 'TOD' ? 'TIME_OF_DAY' : m[1]], dst = EL[m[2] === 'TOD' ? 'TIME_OF_DAY' : m[2]];
    if (!src || !dst) return null;
    return dst;
  }

  function argList(cx, n, params, fname) {
    // positional or named; returns IR per param slot
    const out = new Array(params ? params.length : n.args.length).fill(null);
    n.args.forEach((ar, i) => {
      if (ar.out) throw E(fname + ': output "' + ar.name + '" is not a parameter of this function', ar);
      let slot = i;
      if (ar.name != null) {
        if (!params) throw E(fname + ' takes positional arguments', ar);
        slot = params.findIndex((p) => p.toLowerCase() === String(ar.name).toLowerCase());
        if (slot < 0) throw E(fname + ' has no parameter ' + ar.name, ar);
      } else if (params && i >= params.length) throw E('Too many arguments for ' + fname, ar);
      out[slot] = exprC(cx, ar.e);
    });
    if (params) out.forEach((x, i) => { if (!x) throw E(fname + ': missing parameter ' + params[i], n); });
    return out;
  }

  // the place an argument refers to (for references / outputs)
  function argPlace(cx, ar, what) {
    const e = ar.e;
    if (e.n === 'num' || e.n === 'str' || e.n === 'bool' || e.n === 'bin' || e.n === 'un' || e.n === 'call')
      throw E(what + ' needs a variable', ar);
    return placeOf(cx, e);
  }

  function callC(cx, n, asExpr) {
    // what is being called?
    const f = n.f;
    let fname = null, inst = null, blk = null, sysdef = null, method = null;
    const lf = f.n === 'name' && !f.local && !f.quoted ? localField(cx, f.v) : null;
    if (f.n === 'name' && !f.local && !(lf && lf.t.k === 'fb')) {
      fname = f.v;
      const up = fname.toUpperCase();
      const blkByName = (T.project.blocks || []).find((b) => String(b.name || '').toLowerCase() === fname.toLowerCase());
      if (f.quoted || (blkByName && !BUILTIN[up] && !convFn(up) && !SPECIAL[up])) {
        if (!blkByName) throw E('Unknown block "' + fname + '"', f);
        if (blkByName.type === 'FC') blk = blkByName;
        else if (blkByName.type === 'DB' && blkByName.instanceOf) {
          blk = (T.project.blocks || []).find((b) => b.id === blkByName.instanceOf);
          if (!blk || blk.type !== 'FB') throw E('"' + fname + '" is an instance DB of a missing FB', f);
          inst = { pk: 'loc', base: 'db', db: blkByName, steps: [], ty: TY.blockType(blkByName) };
        } else if (blkByName.type === 'FB') throw E('FB "' + fname + '" must be called through an instance (#inst(...) or "InstanceDB"(...))', f);
        else throw E('"' + fname + '" cannot be called', f);
      } else if (SPECIAL[up]) return SPECIAL[up](cx, n, asExpr);
      else if (BUILTIN[up]) {
        const B = BUILTIN[up];
        const args = argList(cx, n, B.p, up);
        return B.c(cx, args, n);
      } else {
        const dst = convFn(up);
        if (dst) {
          const args = argList(cx, n, ['IN'], up);
          valArg(args[0], n);
          return fold({ op: 'conv', a: args[0], ty: dst, frombool: isBool(args[0].ty) });
        }
        throw E('Unknown function ' + fname, f);
      }
    } else {
      // #inst(...), #inst.TON(...), "DB".x(...) …
      let target = f;
      if (f.n === 'mem') {
        const head = placeOf(cx, f.a);
        if (head.ty.k === 'fb' && head.ty.sys && head.ty.sys.kind === 'iec_timer' && /^(TON|TOF|TP)$/i.test(f.name)) {
          method = f.name.toUpperCase();
          target = f.a;
        }
      }
      inst = placeOf(cx, target);
      if (inst.ty.k !== 'fb') throw E('Not a function block instance: ' + tname(inst.ty), f);
      if (inst.ty.sys) sysdef = inst.ty.sys;
      else {
        blk = inst.ty.block;
        if (inst.dyn) throw E('Arrays of FB instances need a constant index', f);
      }
      if (inst.pk !== 'loc' || inst.base === 'ref') throw E('This FB instance cannot be called', f);
    }

    const call = { op: 'call', id: cx.calls++, blk, sys: sysdef, method, inst, binds: [], ty: VOID, en: null, eno: null };
    const fields = sysdef ? TY.SYSFB[method || sysdef.name.toUpperCase()].t.fields
      : TY.blockType(blk).fields;
    if (method) call.sys = TY.SYSFB[method];
    const params = fields.filter((x) => x.section === 'in' || x.section === 'out' || x.section === 'inout');
    const used = new Set();
    let pos = 0;
    n.args.forEach((ar) => {
      if (ar.name != null && /^EN$/i.test(ar.name) && !ar.out) { call.en = exprC(cx, ar.e); return; }
      if (ar.name != null && /^ENO$/i.test(ar.name) && ar.out) {
        call.eno = argPlace(cx, ar, 'ENO');
        if (!isBool(call.eno.ty)) throw E('ENO needs a Bool', ar);
        return;
      }
      let fp;
      if (ar.name == null) {
        if (blk && blk.type === 'FC') fp = params[pos++];
        if (!fp) throw E('Parameters must be named (NAME := value)', ar);
      } else {
        fp = params.find((x) => x.lname === String(ar.name).toLowerCase());
        if (!fp) throw E((blk ? '"' + blk.name + '"' : (method || sysdef.name)) + ' has no parameter ' + ar.name, ar);
      }
      if (used.has(fp.lname)) throw E('Parameter ' + fp.name + ' given twice', ar);
      used.add(fp.lname);
      if (fp.section === 'out' && !ar.out && ar.name != null) throw E('Output ' + fp.name + ' is assigned with =>', ar);
      if (fp.section !== 'out' && ar.out) throw E(fp.name + ' is an input: use :=', ar);
      call.binds.push(bindC(cx, fp, ar));
    });
    if (blk && blk.type === 'FC') {
      const rv = fields.find((x) => x.section === 'ret');
      if (rv) { call.ret = rv; call.ty = rv.t.k === 'el' ? rv.t : rv.t.k === 'str' ? STRV : VOID; if (rv.t.k === 'str') call.retStr = true; }
      if (fields.some((x) => x.section === 'ret' && x.t.k !== 'el' && x.t.k !== 'str')) throw E('FC return types must be elementary or String', n);
    }
    if (asExpr && call.ty === VOID) throw E((blk ? '"' + blk.name + '"' : 'This call') + ' returns no value', n);
    return call;
  }
  // one actual parameter
  function bindC(cx, fp, ar) {
    const ft = fp.ref ? fp.reft : fp.t;
    if (fp.ref) {
      const pl = argPlace(cx, ar, fp.name);
      if (ft.k !== 'variant' && !TY.sameLayout(pl.ty, ft)) throw E(fp.name + ' needs ' + tname(ft) + ', not ' + tname(pl.ty), ar);
      if (pl.pk === 'slice') throw E(fp.name + ': a slice cannot be passed by reference', ar);
      return { f: fp, mode: 'ref', p: pl };
    }
    if (fp.section === 'in') {
      if (ft.k === 'el') {
        const x = exprC(cx, ar.e);
        if (!isValue(x.ty) || x.ty.k === 'strv') throw E(fp.name + ' needs ' + tname(ft) + ', not ' + tname(x.ty), ar);
        return { f: fp, mode: 'in', e: x };
      }
      if (ft.k === 'str') {
        const x = exprC(cx, ar.e);
        if (x.ty.k !== 'strv') throw E(fp.name + ' needs a String', ar);
        return { f: fp, mode: 'ins', e: x };
      }
      const pl = argPlace(cx, ar, fp.name);
      if (!TY.sameLayout(pl.ty, ft)) throw E(fp.name + ' needs ' + tname(ft) + ', not ' + tname(pl.ty), ar);
      return { f: fp, mode: 'incopy', p: pl };
    }
    const pl = argPlace(cx, ar, fp.name);
    if (pl.isConst) throw E(fp.name + ': cannot write to a constant', ar);
    if (ft.k === 'el') {
      if (pl.ty.k !== 'el') throw E(fp.name + ' needs ' + tname(ft) + ', not ' + tname(pl.ty), ar);
      return { f: fp, mode: fp.section === 'out' ? 'out' : 'inout', p: pl };
    }
    if (!TY.sameLayout(pl.ty, ft)) throw E(fp.name + ' needs ' + tname(ft) + ', not ' + tname(pl.ty), ar);
    return { f: fp, mode: fp.section === 'out' ? 'outcopy' : 'inoutcopy', p: pl };
  }

  // functions with references / outputs
  const SPECIAL = Object.create(null);
  SPECIAL.COUNTOFELEMENTS = (cx, n) => {
    if (n.args.length !== 1 || n.args[0].out) throw E('CountOfElements takes one array', n);
    const pl = argPlace(cx, n.args[0], 'CountOfElements');
    if (pl.variant) return { op: 'cnt', p: pl, ty: EL.UDINT };
    return K(pl.ty.k === 'arr' ? pl.ty.count : 0, EL.UDINT);
  };
  SPECIAL.MAX_LEN = (cx, n) => {
    if (n.args.length !== 1 || n.args[0].out) throw E('MAX_LEN takes one String', n);
    const pl = argPlace(cx, n.args[0], 'MAX_LEN');
    if (pl.ty.k !== 'str') throw E('MAX_LEN needs a String', n);
    return K(pl.ty.len, EL.DINT);
  };
  SPECIAL.LEN = (cx, n) => {
    if (n.args.length !== 1 || n.args[0].out) throw E('LEN takes one String', n);
    const x = exprC(cx, n.args[0].e);
    if (x.ty.k !== 'strv') throw E('LEN needs a String', n);
    return fold({ op: 'fn', f: 'LEN', args: [x], ty: EL.INT });
  };
  function rdTime(local) {
    return (cx, n) => {
      if (n.args.length !== 1) throw E('RD_' + (local ? 'LOC' : 'SYS') + '_T needs OUT => a DTL', n);
      const ar = n.args[0];
      if (ar.name != null && !/^OUT$/i.test(ar.name)) throw E('Unknown parameter ' + ar.name, ar);
      const pl = argPlace(cx, ar, 'OUT');
      if (!TY.sameLayout(pl.ty, TY.DTL)) throw E('OUT must be a DTL', ar);
      return { op: 'rdt', p: pl, local, ty: EL.INT };
    };
  }
  SPECIAL.RD_SYS_T = rdTime(false);
  SPECIAL.RD_LOC_T = rdTime(true);

  /* ------------------------------------------------------- statements */
  function stmtC(cx, s) {
    switch (s.n) {
      case 'assign': {
        const lhs = placeOf(cx, s.lhs);
        if (lhs.isConst) throw E('Cannot assign to the constant ' + (lhs.field ? lhs.field.name : ''), s);
        if (s.op !== ':=') {
          if (lhs.ty.k !== 'el') throw E(s.op + ' needs a number', s);
          const rhs = binC(cx, { n: 'bin', op: s.op[0], a: s.lhs, b: s.rhs, line: s.line, col: s.col });
          return { s: 'set', p: lhs, e: rhs };
        }
        if (lhs.ty.k === 'el') {
          const e = exprC(cx, s.rhs);
          if (!isValue(e.ty) || e.ty.k === 'strv') throw E('Cannot assign ' + tname(e.ty) + ' to ' + tname(lhs.ty), s);
          return { s: 'set', p: lhs, e };
        }
        if (lhs.ty.k === 'str') {
          const e = exprC(cx, s.rhs);
          if (e.ty.k !== 'strv') throw E('Cannot assign ' + tname(e.ty) + ' to a String', s);
          return { s: 'sets', p: lhs, e };
        }
        if (lhs.ty.k === 'variant') throw E('Cannot assign to a Variant', s);
        const rhs = s.rhs;
        if (rhs.n === 'num' || rhs.n === 'bool' || rhs.n === 'str' || rhs.n === 'bin' || rhs.n === 'un' || rhs.n === 'call')
          throw E('Cannot assign a value to ' + tname(lhs.ty), s);
        const src = placeOf(cx, rhs);
        if (!TY.sameLayout(src.ty, lhs.ty)) throw E('Cannot assign ' + tname(src.ty) + ' to ' + tname(lhs.ty), s);
        return { s: 'copy', p: lhs, src, size: lhs.ty.size };
      }
      case 'callst': {
        const c = callC(cx, s.c, false);
        // a function as a statement (RD_SYS_T(OUT => #t);): evaluate, drop the value
        return c.op === 'call' ? { s: 'call', c } : { s: 'set', p: null, e: c };
      }
      case 'if': return { s: 'if', arms: s.arms.map((a) => ({ c: condC(cx, a.cond), body: blockC(cx, a.body) })), els: s.els ? blockC(cx, s.els) : null };
      case 'case': {
        const sel = exprC(cx, s.sel);
        if (!isValue(sel.ty) || sel.ty.k === 'strv') throw E('CASE needs an integer', s);
        const lab = (L) => {
          if (L.c == null) return L.v;
          const f = localField(cx, L.c);
          if (!f || f.section !== 'const' || f.t.k !== 'el') throw E('CASE label #' + L.c + ' is not a constant', L);
          const lit = TY.parseLiteral(f.def);
          return lit && typeof lit.v === 'number' ? lit.v : 0;
        };
        return { s: 'case', e: sel, arms: s.arms.map((a) => ({ labels: a.labels.map((l) => ({ lo: lab(l.lo), hi: lab(l.hi) })), body: blockC(cx, a.body) })), els: s.els ? blockC(cx, s.els) : null };
      }
      case 'for': {
        const v = placeOf(cx, s.v);
        if (!(isIntLike(v.ty) || isNum(v.ty))) throw E('FOR needs an integer variable', s);
        return { s: 'for', p: v, from: numE(cx, s.from), to: numE(cx, s.to), by: s.by ? numE(cx, s.by) : null, body: blockC(cx, s.body) };
      }
      case 'while': return { s: 'while', c: condC(cx, s.cond), body: blockC(cx, s.body) };
      case 'repeat': return { s: 'repeat', c: condC(cx, s.cond), body: blockC(cx, s.body) };
      case 'region': return { s: 'block', body: blockC(cx, s.body) };
      case 'exit': return { s: 'exit' };
      case 'continue': return { s: 'continue' };
      case 'return': return { s: 'return' };
    }
    throw E('Unexpected statement', s);
  }
  function condC(cx, n) {
    const x = exprC(cx, n);
    if (!isValue(x.ty) || x.ty.k === 'strv') throw E('Condition must be Bool', n);
    return x;
  }
  function numE(cx, n) {
    const x = exprC(cx, n);
    if (!isValue(x.ty) || x.ty.k === 'strv') throw E('Expected a number', n);
    return x;
  }

  /* ===================================================================== *
   *  EVALUATOR                                                            *
   * ===================================================================== */
  const MAX_ITER = 200000;
  const EXIT = 1, CONT = 2, RET = 3;
  let _err = null;                                    // last runtime error (diagnostics)
  function rtErr(msg) { _err = msg; if (T.sim && T.sim.onError) T.sim.onError(msg); }

  // a location {buf, off, bit} for a loc place, or null (out of range / unbound)
  function locOf(p, ctx) {
    let buf, off = 0, bit = 0;
    if (p.base === 'self') buf = ctx.d.buf;
    else if (p.base === 'db') {
      let d;
      try { d = T.inst.db(p.db); } catch (e) { return null; }
      buf = d.buf;
    } else {
      const r = ctx.d.refs[p.ref];
      if (!r || !r.buf) return null;
      buf = r.buf; off = r.off; bit = r.bit;
    }
    const st = p.steps;
    for (let i = 0; i < st.length; i++) {
      const s = st[i];
      if (s.k === 'f') { off += s.off; bit = s.bit; continue; }
      const t = s.t;
      let lin = 0;
      for (let j = 0; j < t.dims.length; j++) {
        const d = t.dims[j];
        const x = num(evalE(s.idx[j], ctx));
        if (x !== Math.floor(x) || x < d.lo || x > d.hi) { rtErr('array index ' + x + ' out of range ' + d.lo + '..' + d.hi); return null; }
        lin = lin * (d.hi - d.lo + 1) + (x - d.lo);
      }
      if (t.el.k === 'el' && t.el.cls === 'bool') { off += lin >> 3; bit = lin & 7; }
      else { off += lin * t.stride; bit = 0; }
    }
    return { buf, off, bit };
  }
  function zero(t) { return t.cls === 'bool' ? false : 0; }
  function coerceRead(v, t) {
    if (t.cls === 'num') return v;
    if (t.cls === 'bool') return toBool(v);
    if (t.cls === 'real') return num(v);
    return TY.conv(v, t);
  }
  function readP(p, ctx) {
    if (p.pk === 'cell') return coerceRead(p.bit ? T.mem.getBit(p.key) : T.mem.getWord(p.key), p.ty);
    if (p.pk === 'loc') {
      const L = locOf(p, ctx);
      return L ? TY.read(L.buf, L.off, L.bit, p.ty) : zero(p.ty);
    }
    // slice
    const u = unsignedOf(readP(p.base, ctx), p.width);
    const per = p.k === 'X' ? 1 : p.k === 'B' ? 8 : p.k === 'W' ? 16 : 32;
    if (per === 32) return u;
    const v = Math.floor(u / Math.pow(2, p.i * per)) % Math.pow(2, per);
    return per === 1 ? v === 1 : v;
  }
  function unsignedOf(v, width) {
    const x = Math.floor(num(v));
    const m = Math.pow(2, width);
    return x - Math.floor(x / m) * m;
  }
  function writeP(p, ctx, v) {
    if (p.pk === 'cell') {
      if (p.ty.cls === 'num') {
        if (p.bit) T.mem.setBit(p.key, toBool(v)); else T.mem.setWord(p.key, num(v));
      } else if (p.bit) T.mem.setBit(p.key, toBool(v));
      else T.mem.setWord(p.key, TY.conv(v, p.ty));
      return;
    }
    if (p.pk === 'loc') {
      const L = locOf(p, ctx);
      if (L) TY.write(L.buf, L.off, L.bit, p.ty, TY.conv(v, p.ty));
      return;
    }
    const per = p.k === 'X' ? 1 : p.k === 'B' ? 8 : p.k === 'W' ? 16 : 32;
    const u = unsignedOf(readP(p.base, ctx), p.width);
    const scale = Math.pow(2, p.i * per), m = Math.pow(2, per);
    const old = Math.floor(u / scale) % m;
    const nv = per === 1 ? (toBool(v) ? 1 : 0) : unsignedOf(TY.conv(v, p.ty), per);
    writeP(p.base, ctx, u + (nv - old) * scale);
  }
  // bytes of a place (string / aggregate copies)
  function bytesOf(p, ctx, size) {
    const L = locOf(p, ctx);
    return L ? { buf: L.buf, off: L.off } : null;
  }
  function readStr(p, ctx) {
    const L = locOf(p, ctx);
    return L ? TY.strRead(L.buf, L.off, p.ty) : '';
  }

  function intOp(o, a, b) {
    switch (o) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b === 0 ? 0 : Math.trunc(a / b);
      case 'MOD': return b === 0 ? 0 : a % b;
    }
    return 0;
  }
  function fltOp(o, a, b) {
    switch (o) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/': return b === 0 ? 0 : a / b;
      case 'MOD': return b === 0 ? 0 : a % b;
      case '**': return Math.pow(a, b);
    }
    return 0;
  }
  function wrapTo(x, ty) { return ty.any || !ty.bits || ty.cls === 'real' || ty.cls === 'num' ? x : TY.wrap(x, ty.bits, ty.signed); }

  function evalE(x, ctx) {
    switch (x.op) {
      case 'k': return x.v;
      case 'rd': return readP(x.p, ctx);
      case 'rds': return readStr(x.p, ctx);
      case 'not': return !toBool(evalE(x.a, ctx));
      case 'bnot': {
        const v = num(evalE(x.a, ctx));
        if (x.ty.any) return -v - 1;
        return TY.wrap(-v - 1, x.ty.bits, x.ty.signed);
      }
      case 'neg': return wrapTo(-num(evalE(x.a, ctx)), x.ty);
      case 'and': return toBool(evalE(x.a, ctx)) && toBool(evalE(x.b, ctx));
      case 'or': return toBool(evalE(x.a, ctx)) || toBool(evalE(x.b, ctx));
      case 'xor': return toBool(evalE(x.a, ctx)) !== toBool(evalE(x.b, ctx));
      case 'bit': {
        const a = TY.wrap(Math.floor(num(evalE(x.a, ctx))), 32, false), b = TY.wrap(Math.floor(num(evalE(x.b, ctx))), 32, false);
        let r = x.o === 'AND' ? (a & b) : x.o === 'OR' ? (a | b) : (a ^ b);
        r = r >>> 0;
        return x.ty.any ? r : TY.wrap(r, x.ty.bits, x.ty.signed);
      }
      case 'cmp': {
        let a = evalE(x.a, ctx), b = evalE(x.b, ctx);
        if (!x.str) { a = num(a); b = num(b); }
        switch (x.o) {
          case '=': return a === b;
          case '<>': return a !== b;
          case '<': return a < b;
          case '>': return a > b;
          case '<=': return a <= b;
          case '>=': return a >= b;
        }
        return false;
      }
      case 'ar': {
        const a = num(evalE(x.a, ctx)), b = num(evalE(x.b, ctx));
        if (x.mode === 'int') return wrapTo(intOp(x.o, a, b), x.ty);
        return fltOp(x.o, a, b);
      }
      case 'conv': {
        const v = evalE(x.a, ctx);
        const t = x.ty;
        if (t.cls === 'bool') return x.frombool ? toBool(v) : (Math.floor(num(v)) % 2 !== 0);
        if (t.cls === 'real') return num(v);
        return TY.conv(v, t);
      }
      case 'fn': return evalFn(x, ctx);
      case 'cnt': {
        const r = ctx.d.refs[x.p.ref];
        return r && r.t && r.t.k === 'arr' ? r.t.count : 0;
      }
      case 'rdt': {
        const L = locOf(x.p, ctx);
        if (L) TY.writeDtl(L.buf, L.off, T.sim.wallMs(x.local));
        return 0;
      }
      case 'call': return runCall(x, ctx);
    }
    return 0;
  }

  function evalFn(x, ctx) {
    const a = x.args.map((e) => evalE(e, ctx));
    const n0 = num(a[0]);
    switch (x.f) {
      case 'ABS': return wrapTo(Math.abs(n0), x.ty);
      case 'SQRT': return Math.sqrt(n0);
      case 'SQR': return n0 * n0;
      case 'LN': return Math.log(n0);
      case 'LOG': return Math.log(n0) / Math.LN10;
      case 'EXP': return Math.exp(n0);
      case 'SIN': return Math.sin(n0);
      case 'COS': return Math.cos(n0);
      case 'TAN': return Math.tan(n0);
      case 'ASIN': return Math.asin(n0);
      case 'ACOS': return Math.acos(n0);
      case 'ATAN': return Math.atan(n0);
      case 'TRUNC': return TY.wrap(Math.trunc(n0), 32, true);
      case 'ROUND': return TY.wrap(TY.rhe(n0), 32, true);
      case 'CEIL': return TY.wrap(Math.ceil(n0), 32, true);
      case 'FLOOR': return TY.wrap(Math.floor(n0), 32, true);
      case 'REAL': return n0;
      case 'MIN': { let r = n0; for (let i = 1; i < a.length; i++) r = Math.min(r, num(a[i])); return r; }
      case 'MAX': { let r = n0; for (let i = 1; i < a.length; i++) r = Math.max(r, num(a[i])); return r; }
      case 'LIMIT': return Math.max(n0, Math.min(num(a[1]), num(a[2])));
      case 'SEL': return toBool(a[0]) ? num(a[2]) : num(a[1]);
      case 'NORM_X': { const den = num(a[2]) - n0; return den === 0 ? 0 : (num(a[1]) - n0) / den; }
      case 'SCALE_X': return num(a[1]) * (num(a[2]) - n0) + n0;
      case 'LEN': return String(a[0]).length;
      case 'SHL': case 'SHR': case 'ROL': case 'ROR': {
        const t = x.ty, w = t.bits;
        let u = unsignedOf(n0, w);
        const sh = Math.max(0, Math.floor(num(a[1])));
        const m = Math.pow(2, w);
        let r;
        if (x.f === 'SHL') r = sh >= w ? 0 : (u * Math.pow(2, sh)) % m;
        else if (x.f === 'SHR') {
          if (t.signed && u >= m / 2) {                  // arithmetic shift keeps the sign
            const s = u - m;
            r = sh >= w ? (s < 0 ? -1 : 0) : Math.floor(s / Math.pow(2, sh));
          } else r = sh >= w ? 0 : Math.floor(u / Math.pow(2, sh));
        } else {
          const k = sh % w;
          if (x.f === 'ROL') r = ((u * Math.pow(2, k)) % m) + Math.floor(u / Math.pow(2, w - k));
          else r = Math.floor(u / Math.pow(2, k)) + ((u * Math.pow(2, w - k)) % m);
          if (k === 0) r = u;
        }
        return TY.wrap(r, w, t.signed);
      }
    }
    return 0;
  }

  /* ---- calls ---- */
  function runCall(c, ctx) {
    if (c.en && !toBool(evalE(c.en, ctx))) { if (c.eno) writeP(c.eno, ctx, false); return c.ty.cls === 'bool' ? false : 0; }
    let d, view = null, key, base = null;
    if (c.sys) {
      const L = locOf(c.inst, ctx);
      if (!L) return 0;
      d = { buf: L.buf, base: L.off, refs: Object.create(null) };
      base = L.off;
    } else if (c.inst) {
      if (c.inst.base === 'db') { key = c.inst.db.id; d = T.inst.db(c.inst.db); }
      else {
        const L = locOf(c.inst, ctx);
        if (!L) return 0;
        const t = c.inst.ty;
        view = L.buf.subarray(L.off, L.off + t.size);
        key = ctx.d.key + '+' + L.off;
        d = T.inst.forBlock(c.blk, key, view);
      }
    } else {
      key = ctx.d.key + '/' + c.id;
      d = T.inst.forBlock(c.blk, key);
    }
    const off0 = base || 0;
    // inputs (evaluated in the caller), references
    const binds = c.binds;
    for (let i = 0; i < binds.length; i++) {
      const b = binds[i], f = b.f;
      switch (b.mode) {
        case 'in': TY.write(d.buf, off0 + f.off, f.bit, f.t, TY.conv(evalE(b.e, ctx), f.t)); break;
        case 'inout': TY.write(d.buf, off0 + f.off, f.bit, f.t, TY.conv(readP(b.p, ctx), f.t)); break;
        case 'ins': TY.strWrite(d.buf, off0 + f.off, f.t, evalE(b.e, ctx)); break;
        case 'incopy': case 'inoutcopy': {
          const s = locOf(b.p, ctx);
          if (s) d.buf.set(s.buf.subarray(s.off, s.off + f.t.size), off0 + f.off);
          break;
        }
        case 'ref': d.refs[f.lname] = refOf(b.p, ctx); break;
      }
    }
    if (c.blk && !c.inst) {
      // an FC: references it was not given read as zero
      d.t.fields.forEach((f) => { if (f.ref && !binds.some((b) => b.f === f)) d.refs[f.lname] = null; });
    }
    // run
    if (c.sys) T.sysfb.exec(c.sys, d.buf, off0, d.refs);
    else T.sim.execute(c.blk.id, { instanceId: key, view });
    // outputs
    for (let i = 0; i < binds.length; i++) {
      const b = binds[i], f = b.f;
      switch (b.mode) {
        case 'out': case 'inout': writeP(b.p, ctx, TY.read(d.buf, off0 + f.off, f.bit, f.t)); break;
        case 'outcopy': case 'inoutcopy': {
          const t = locOf(b.p, ctx);
          if (t) t.buf.set(d.buf.subarray(off0 + f.off, off0 + f.off + f.t.size), t.off);
          break;
        }
      }
    }
    if (c.eno) writeP(c.eno, ctx, true);
    if (c.ret) return c.retStr ? TY.strRead(d.buf, c.ret.off, c.ret.t) : TY.read(d.buf, c.ret.off, c.ret.bit, c.ret.t);
    return 0;
  }
  // a reference to a place, for reference parameters (Variant, complex in-out)
  function refOf(p, ctx) {
    if (p.variant) return ctx.d.refs[p.ref] || null;          // Variant passed on
    if (p.pk === 'cell') return { cell: p.key, bit: p.bit, t: p.ty };
    const L = locOf(p, ctx);
    return L ? { buf: L.buf, off: L.off, bit: L.bit, t: p.ty } : null;
  }

  function runList(list, ctx) {
    for (let i = 0; i < list.length; i++) {
      const sig = runS(list[i], ctx);
      if (sig) return sig;
    }
    return 0;
  }
  function runS(s, ctx) {
    switch (s.s) {
      case 'set': { const v = evalE(s.e, ctx); if (s.p) writeP(s.p, ctx, v); return 0; }
      case 'sets': {
        const L = locOf(s.p, ctx);
        if (L) TY.strWrite(L.buf, L.off, s.p.ty, evalE(s.e, ctx));
        return 0;
      }
      case 'copy': {
        const src = locOf(s.src, ctx), dst = locOf(s.p, ctx);
        if (src && dst) dst.buf.set(src.buf.slice(src.off, src.off + s.size), dst.off);
        return 0;
      }
      case 'call': runCall(s.c, ctx); return 0;
      case 'if':
        for (let i = 0; i < s.arms.length; i++) if (toBool(evalE(s.arms[i].c, ctx))) return runList(s.arms[i].body, ctx);
        return s.els ? runList(s.els, ctx) : 0;
      case 'case': {
        const v = num(evalE(s.e, ctx));
        for (let i = 0; i < s.arms.length; i++) {
          const arm = s.arms[i];
          for (let j = 0; j < arm.labels.length; j++) {
            if (v >= arm.labels[j].lo && v <= arm.labels[j].hi) return runList(arm.body, ctx);
          }
        }
        return s.els ? runList(s.els, ctx) : 0;
      }
      case 'for': {
        let i = num(evalE(s.from, ctx));
        const to = num(evalE(s.to, ctx));
        const by = s.by ? num(evalE(s.by, ctx)) : 1;
        if (by === 0) return 0;
        let guard = 0;
        for (; by > 0 ? i <= to : i >= to; i += by) {
          if (++guard > MAX_ITER) { rtErr('FOR loop stopped after ' + MAX_ITER + ' iterations'); break; }
          writeP(s.p, ctx, i);
          const sig = runList(s.body, ctx);
          if (sig === EXIT) break;
          if (sig === RET) return RET;
        }
        return 0;
      }
      case 'while': {
        let guard = 0;
        while (toBool(evalE(s.c, ctx))) {
          if (++guard > MAX_ITER) { rtErr('WHILE loop stopped after ' + MAX_ITER + ' iterations'); break; }
          const sig = runList(s.body, ctx);
          if (sig === EXIT) break;
          if (sig === RET) return RET;
        }
        return 0;
      }
      case 'repeat': {
        let guard = 0;
        do {
          if (++guard > MAX_ITER) { rtErr('REPEAT loop stopped after ' + MAX_ITER + ' iterations'); break; }
          const sig = runList(s.body, ctx);
          if (sig === EXIT) break;
          if (sig === RET) return RET;
        } while (!toBool(evalE(s.c, ctx)));
        return 0;
      }
      case 'block': return runList(s.body, ctx);
      case 'exit': return EXIT;
      case 'continue': return CONT;
      case 'return': return RET;
    }
    return 0;
  }

  /* ===================================================================== *
   *  COMPILE CACHE + PUBLIC EXEC                                          *
   * ===================================================================== */
  // Keep compiled programs out of the saved project JSON: cache by block id.
  const _cache = new Map();                          // id -> { src, gen, program, error }
  function compiled(blk) {
    const src = (blk && blk.code) || '';
    const gen = TY.gen;
    const c = _cache.get(blk.id);
    if (c && c.src === src && c.gen === gen) return c;
    let entry;
    try { entry = { src, gen, program: compile(blk), error: null }; }
    catch (e) { entry = { src, gen, program: null, error: { msg: e.message, line: e.line || 0, col: e.col || 0 } }; }
    _cache.set(blk.id, entry);
    return entry;
  }

  // Names a block's code calls: "FC"(...), "InstanceDB"(...), FC(...). Syntax
  // only (a block with errors calls nothing) — the scan uses it to tell called
  // blocks from orphans, like the C engine.
  function calledNames(code) {
    const out = new Set();
    let ast;
    try { ast = parse(code || ''); } catch (e) { return out; }
    (function walk(x) {
      if (!x || typeof x !== 'object') return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      if (x.n === 'call' && x.f && x.f.n === 'name' && !x.f.local) out.add(String(x.f.v).toLowerCase());
      for (const k in x) if (k !== 'line' && k !== 'col') walk(x[k]);
    })(ast);
    return out;
  }

  T.scl = {
    calledNames,
    // run a block body once for one instance (called by the simulator's executeBlock)
    exec(blk, d) {
      if (!blk || !blk.code || !d) return;
      const c = compiled(blk);
      if (!c.program) return;                        // compile error -> skip (editor shows it)
      runList(c.program.body, { d, blk });
    },
    check(blk) { return compiled(blk); },
    invalidate(id) { _cache.delete(id); },
    parse,
    get lastError() { return _err; },
  };

  /* ===================================================================== *
   *  EDITOR                                                               *
   * ===================================================================== */
  T.injectCSS('tia-scl-css', `
    .scl-editor { display:flex; flex-direction:column; height:100%; min-height:0;
      background:var(--tia-canvas, #fbfdff); }
    .scl-toolbar { display:flex; align-items:center; gap:10px; padding:4px 10px;
      border-bottom:1px solid var(--tia-border); font:600 11px/1.6 var(--tia-font, sans-serif);
      color:var(--tia-muted); background:var(--tia-panel, #fff); flex:0 0 auto; }
    .scl-toolbar .scl-lang { color:var(--tia-accent, #1b9e9e); }
    .scl-body { position:relative; display:flex; flex:1 1 auto; min-height:0; overflow:hidden; }
    .scl-gutter { flex:0 0 auto; padding:8px 6px 8px 8px; text-align:right;
      font:13px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace;
      color:var(--tia-muted); background:var(--tia-panel, #f4f7fa);
      border-right:1px solid var(--tia-border); user-select:none; overflow:hidden;
      white-space:pre; min-width:34px; box-sizing:border-box; }
    .scl-gutter .err { color:#d23; font-weight:700; }
    .scl-code { flex:1 1 auto; border:0; outline:0; resize:none; padding:8px 10px;
      font:13px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace;
      color:var(--tia-text, #123); background:transparent; tab-size:4; -moz-tab-size:4;
      white-space:pre; overflow:auto; box-sizing:border-box; }
    .scl-status { flex:0 0 auto; padding:3px 10px; font:12px/1.5 var(--tia-font, sans-serif);
      border-top:1px solid var(--tia-border); background:var(--tia-panel, #fff); }
    .scl-status.ok  { color:#178a4c; }
    .scl-status.bad { color:#c0392b; }
  `);

  let host = null, block = null, api = null;
  let taArea = null, gutter = null, statusEl = null, compileTimer = null;

  const STARTER =
    '// Structured Control Language\n' +
    '// Example — assign tags / interface members with :=\n' +
    '//   IF Start AND NOT Stop THEN\n' +
    '//       Motor := TRUE;\n' +
    '//   END_IF;\n';

  function lineCount(s) { let n = 1; for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++; return n; }

  function renderGutter(errLine) {
    if (!gutter || !taArea) return;
    const total = lineCount(taArea.value);
    const rows = [];
    for (let i = 1; i <= total; i++) rows.push(i === errLine ? '<span class="err">' + i + '</span>' : String(i));
    gutter.innerHTML = rows.join('\n');
    gutter.scrollTop = taArea.scrollTop;
  }

  function recompile() {
    if (!block) return;
    T.scl.invalidate(block.id);
    const c = T.scl.check(block);
    if (c.error) {
      statusEl.className = 'scl-status bad';
      statusEl.textContent = '✕ Line ' + c.error.line + ': ' + c.error.msg;
      renderGutter(c.error.line);
    } else {
      statusEl.className = 'scl-status ok';
      statusEl.textContent = block.code.trim() ? '✓ Compiled — no errors' : 'Empty block';
      renderGutter(0);
    }
  }

  function onInput() {
    block.code = taArea.value;
    renderGutter(0);                                 // keep numbers in sync immediately
    if (compileTimer) clearTimeout(compileTimer);
    compileTimer = setTimeout(() => {
      recompile();
      T.bus.emit('iface:changed');                   // debounced autosave signal — a
      // per-keystroke emit would re-render the outline/details/iface panels on
      // every character typed
    }, 250);
  }

  function onKeyDown(e) {
    if (e.key === 'Tab') {                            // insert 4 spaces, never tab out
      e.preventDefault();
      const s = taArea.selectionStart, en = taArea.selectionEnd;
      taArea.value = taArea.value.slice(0, s) + '    ' + taArea.value.slice(en);
      taArea.selectionStart = taArea.selectionEnd = s + 4;
      onInput();
    }
  }

  function open(hostEl, blk) {
    host = hostEl; block = blk;
    if (block.code == null) block.code = '';
    T.clear(host);

    const wrap = T.el('div', { class: 'scl-editor' });
    const bar = T.el('div', { class: 'scl-toolbar' },
      T.el('span', { class: 'scl-lang' }, 'SCL'),
      T.el('span', {}, (blk.type + blk.number) + '  ·  ' + (blk.name || '')),
      T.el('span', { class: 'tia-muted' }, '— Structured Control Language'));
    const body = T.el('div', { class: 'scl-body' });
    gutter = T.el('div', { class: 'scl-gutter' });
    taArea = T.el('textarea', {
      class: 'scl-code', spellcheck: 'false', wrap: 'off',
      placeholder: STARTER,
    });
    taArea.value = block.code;
    body.appendChild(gutter); body.appendChild(taArea);
    statusEl = T.el('div', { class: 'scl-status' });
    wrap.appendChild(bar); wrap.appendChild(body); wrap.appendChild(statusEl);
    host.appendChild(wrap);

    taArea.addEventListener('input', onInput);
    taArea.addEventListener('keydown', onKeyDown);
    taArea.addEventListener('scroll', () => { gutter.scrollTop = taArea.scrollTop; });

    renderGutter(0);
    recompile();

    api = {
      lang: 'SCL',
      block: blk,
      // SCL has a single text body — these toolbar hooks are intentional no-ops.
      insert() {},
      deleteSelection() {},
      addNetwork() { T.status('SCL blocks have one code body — no networks to add.', 'warn'); },
      refresh() { if (taArea) { taArea.value = block.code || ''; renderGutter(0); recompile(); } },
      highlight() {},
    };
    T.activeEditor = api;
    return api;
  }

  T.editors = T.editors || {};
  T.editors.scl = { open: open };
})(window.TIA);
