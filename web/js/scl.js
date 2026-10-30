/* =========================================================================
 *  js/scl.js — Structured Control Language (SCL): interpreter + text editor
 *
 *  TIA Portal's third programming language alongside LAD and FBD. An SCL block
 *  is a single Pascal-like TEXT body (stored on `block.code`) rather than a list
 *  of graphical networks. This module provides three things:
 *
 *    T.scl.exec(block)        — parse (cached) + run the block body in the sim.
 *    T.editors.scl.open(host,block) — a code editor (textarea + line gutter +
 *                              live parse-error strip), wired like lad/fbd.
 *
 *  Everything rides on the existing operand layer (T.resolve / T.readBit /
 *  T.writeBit / T.readNum / T.writeNum), so plain tags AND block-interface
 *  members resolve correctly — including per-instance FB scope, because the
 *  simulator sets T._scope around executeBlock before calling us.
 * ====================================================================== */
(function (T) {
  'use strict';

  /* ===================================================================== *
   *  TOKENIZER                                                            *
   * ===================================================================== */
  // case-insensitive keyword set
  const KW = new Set([
    'IF', 'THEN', 'ELSIF', 'ELSE', 'END_IF',
    'CASE', 'OF', 'END_CASE',
    'FOR', 'TO', 'BY', 'DO', 'END_FOR',
    'WHILE', 'END_WHILE',
    'REPEAT', 'UNTIL', 'END_REPEAT',
    'EXIT', 'CONTINUE', 'RETURN',
    'AND', 'OR', 'XOR', 'NOT', 'MOD',
    'TRUE', 'FALSE',
  ]);

  function tokenize(src) {
    const toks = [];
    let i = 0, line = 1, col = 1;
    const n = src.length;
    function err(msg) { const e = new Error(msg); e.line = line; e.col = col; throw e; }
    function adv(k) { // advance k chars tracking line/col
      for (let j = 0; j < k; j++) {
        if (src[i] === '\n') { line++; col = 1; } else { col++; }
        i++;
      }
    }
    while (i < n) {
      const c = src[i];
      // whitespace
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { adv(1); continue; }
      // line comment  // ...
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') adv(1); continue; }
      // block comment (* ... *)
      if (c === '(' && src[i + 1] === '*') {
        adv(2);
        while (i < n && !(src[i] === '*' && src[i + 1] === ')')) adv(1);
        if (i >= n) err('Unterminated (* comment *)');
        adv(2);
        continue;
      }
      const startLine = line, startCol = col;
      // number (optionally with a fractional part); 1..5 ranges keep the dots out
      if (c >= '0' && c <= '9') {
        let s = '';
        while (i < n && src[i] >= '0' && src[i] <= '9') { s += src[i]; adv(1); }
        if (src[i] === '.' && src[i + 1] >= '0' && src[i + 1] <= '9') {
          s += '.'; adv(1);
          while (i < n && src[i] >= '0' && src[i] <= '9') { s += src[i]; adv(1); }
        }
        toks.push({ t: 'num', v: parseFloat(s), line: startLine, col: startCol });
        continue;
      }
      // identifier / keyword — may be a typed literal  PREFIX#rest  (T#5s, INT#3 …)
      if (/[A-Za-z_]/.test(c)) {
        let s = '';
        while (i < n && /[A-Za-z0-9_]/.test(src[i])) { s += src[i]; adv(1); }
        if (src[i] === '#') {                       // typed literal
          let rest = ''; adv(1);
          while (i < n && /[A-Za-z0-9_.]/.test(src[i])) { rest += src[i]; adv(1); }
          const up = s.toUpperCase();
          let val;
          if (up === 'T' || up === 'TIME' || up === 'S5T' || up === 'S5TIME') {
            val = (T.parseTime ? T.parseTime('T#' + rest) : parseFloat(rest)) || 0;
          } else val = parseFloat(rest) || 0;
          toks.push({ t: 'num', v: val, line: startLine, col: startCol });
          continue;
        }
        const up = s.toUpperCase();
        if (KW.has(up)) toks.push({ t: 'kw', v: up, raw: s, line: startLine, col: startCol });
        else toks.push({ t: 'id', v: s, line: startLine, col: startCol });
        continue;
      }
      // multi-char operators first
      const two = src.substr(i, 2);
      if (two === ':=' || two === '<=' || two === '>=' || two === '<>' || two === '..') {
        toks.push({ t: 'op', v: two, line: startLine, col: startCol }); adv(2); continue;
      }
      if ('+-*/()<>=;:,.'.indexOf(c) >= 0) {
        toks.push({ t: 'op', v: c, line: startLine, col: startCol }); adv(1); continue;
      }
      err('Unexpected character "' + c + '"');
    }
    toks.push({ t: 'eof', v: '<eof>', line: line, col: col });
    return toks;
  }

  /* ===================================================================== *
   *  PARSER  (recursive descent -> AST)                                   *
   * ===================================================================== */
  // AST nodes (by `n`):
  //   assign{name,expr} if{arms:[{cond,body}],els} case{expr,arms:[{labels,body}],els}
  //   for{var,from,to,by,body} while{cond,body} repeat{body,cond} exit return
  //   bin{op,a,b} un{op,a} num{v} bool{v} var{name} call{name,args}
  function parse(src) {
    const toks = tokenize(src);
    let p = 0;
    const peek = () => toks[p];
    const next = () => toks[p++];
    function err(msg, tk) {
      tk = tk || peek();
      const e = new Error(msg + ' near "' + tk.v + '"');
      e.line = tk.line; e.col = tk.col; throw e;
    }
    function isOp(v) { const t = peek(); return t.t === 'op' && t.v === v; }
    function isKw(v) { const t = peek(); return t.t === 'kw' && t.v === v; }
    function eatOp(v) { if (!isOp(v)) err('Expected "' + v + '"'); return next(); }
    function eatKw(v) { if (!isKw(v)) err('Expected ' + v); return next(); }
    function acceptOp(v) { if (isOp(v)) { next(); return true; } return false; }

    function parseProgram() {
      const body = parseStmts(() => peek().t === 'eof');
      if (peek().t !== 'eof') err('Unexpected token');
      return { n: 'block', body: body };
    }
    // parse statements until `stop()` is true (a terminator keyword / eof)
    function parseStmts(stop) {
      const out = [];
      while (!stop()) {
        if (peek().t === 'eof') break;
        if (acceptOp(';')) continue;               // stray / empty statement
        out.push(parseStmt());
      }
      return out;
    }
    function parseStmt() {
      const t = peek();
      if (t.t === 'kw') {
        switch (t.v) {
          case 'IF': return parseIf();
          case 'CASE': return parseCase();
          case 'FOR': return parseFor();
          case 'WHILE': return parseWhile();
          case 'REPEAT': return parseRepeat();
          case 'EXIT': next(); acceptOp(';'); return { n: 'exit' };
          case 'CONTINUE': next(); acceptOp(';'); return { n: 'continue' };
          case 'RETURN': next(); acceptOp(';'); return { n: 'return' };
        }
      }
      // otherwise: an assignment  lvalue := expr ;
      if (t.t === 'id') {
        const name = parseLValue();
        eatOp(':=');
        const e = parseExpr();
        acceptOp(';');
        return { n: 'assign', name: name, expr: e };
      }
      err('Unexpected statement');
    }
    // dotted identifier -> single operand string ("Motor.Run")
    function parseLValue() {
      let name = next().v;
      while (isOp('.')) { next(); if (peek().t !== 'id') err('Expected member name'); name += '.' + next().v; }
      return name;
    }
    function parseIf() {
      eatKw('IF');
      const arms = [];
      let cond = parseExpr(); eatKw('THEN');
      let body = parseStmts(() => isKw('ELSIF') || isKw('ELSE') || isKw('END_IF'));
      arms.push({ cond: cond, body: body });
      while (isKw('ELSIF')) {
        next(); cond = parseExpr(); eatKw('THEN');
        body = parseStmts(() => isKw('ELSIF') || isKw('ELSE') || isKw('END_IF'));
        arms.push({ cond: cond, body: body });
      }
      let els = null;
      if (isKw('ELSE')) { next(); els = parseStmts(() => isKw('END_IF')); }
      eatKw('END_IF'); acceptOp(';');
      return { n: 'if', arms: arms, els: els };
    }
    function parseCase() {
      eatKw('CASE');
      const sel = parseExpr(); eatKw('OF');
      const arms = [];
      let els = null;
      while (!isKw('END_CASE') && !isKw('ELSE')) {
        const labels = [parseCaseLabel()];
        while (acceptOp(',')) labels.push(parseCaseLabel());
        eatOp(':');
        const body = parseStmts(() => isCaseBoundary());
        arms.push({ labels: labels, body: body });
      }
      if (isKw('ELSE')) { next(); els = parseStmts(() => isKw('END_CASE')); }
      eatKw('END_CASE'); acceptOp(';');
      return { n: 'case', expr: sel, arms: arms, els: els };
    }
    // a new case arm begins when, after some statements, we hit  <num>[..num] ':'
    // detecting that generically is awkward, so we treat the boundary as: the
    // next token is a number AND the token after the label list is ':'.
    function isCaseBoundary() {
      if (isKw('END_CASE') || isKw('ELSE')) return true;
      if (peek().t !== 'num' && !(peek().t === 'op' && peek().v === '-')) return false;
      // look ahead: num [.. num] (',' num [..num])* ':'
      let q = p;
      function skipLabel() {
        if (toks[q].t === 'op' && toks[q].v === '-') q++;
        if (toks[q].t !== 'num') return false; q++;
        if (toks[q].t === 'op' && toks[q].v === '..') { q++; if (toks[q].t === 'op' && toks[q].v === '-') q++; if (toks[q].t !== 'num') return false; q++; }
        return true;
      }
      if (!skipLabel()) return false;
      while (toks[q].t === 'op' && toks[q].v === ',') { q++; if (!skipLabel()) return false; }
      return toks[q].t === 'op' && toks[q].v === ':';
    }
    function parseCaseLabel() {
      const lo = parseSignedInt();
      if (isOp('..')) { next(); const hi = parseSignedInt(); return { lo: lo, hi: hi }; }
      return { lo: lo, hi: lo };
    }
    function parseSignedInt() {
      let sign = 1;
      if (isOp('-')) { next(); sign = -1; }
      if (peek().t !== 'num') err('Expected number in CASE label');
      return sign * next().v;
    }
    function parseFor() {
      eatKw('FOR');
      if (peek().t !== 'id') err('Expected loop variable');
      const v = parseLValue();
      eatOp(':=');
      const from = parseExpr(); eatKw('TO'); const to = parseExpr();
      let by = null; if (isKw('BY')) { next(); by = parseExpr(); }
      eatKw('DO');
      const body = parseStmts(() => isKw('END_FOR'));
      eatKw('END_FOR'); acceptOp(';');
      return { n: 'for', var: v, from: from, to: to, by: by, body: body };
    }
    function parseWhile() {
      eatKw('WHILE');
      const cond = parseExpr(); eatKw('DO');
      const body = parseStmts(() => isKw('END_WHILE'));
      eatKw('END_WHILE'); acceptOp(';');
      return { n: 'while', cond: cond, body: body };
    }
    function parseRepeat() {
      eatKw('REPEAT');
      const body = parseStmts(() => isKw('UNTIL'));
      eatKw('UNTIL'); const cond = parseExpr(); eatKw('END_REPEAT'); acceptOp(';');
      return { n: 'repeat', body: body, cond: cond };
    }

    /* ---- expressions (precedence climbing) ---- */
    function parseExpr() { return parseOr(); }
    function parseOr() { let a = parseXor(); while (isKw('OR')) { next(); a = { n: 'bin', op: 'OR', a: a, b: parseXor() }; } return a; }
    function parseXor() { let a = parseAnd(); while (isKw('XOR')) { next(); a = { n: 'bin', op: 'XOR', a: a, b: parseAnd() }; } return a; }
    function parseAnd() { let a = parseCmp(); while (isKw('AND') || isOp('&')) { next(); a = { n: 'bin', op: 'AND', a: a, b: parseCmp() }; } return a; }
    function parseCmp() {
      let a = parseAdd();
      while (isOp('=') || isOp('<>') || isOp('<') || isOp('>') || isOp('<=') || isOp('>=')) {
        const op = next().v; a = { n: 'bin', op: op, a: a, b: parseAdd() };
      }
      return a;
    }
    function parseAdd() { let a = parseMul(); while (isOp('+') || isOp('-')) { const op = next().v; a = { n: 'bin', op: op, a: a, b: parseMul() }; } return a; }
    function parseMul() {
      let a = parseUnary();
      while (isOp('*') || isOp('/') || isKw('MOD')) { const op = next().v; a = { n: 'bin', op: op, a: a, b: parseUnary() }; }
      return a;
    }
    function parseUnary() {
      // NOT binds at factor level (IEC 61131-3): "NOT a = b" is "(NOT a) = b"
      if (isKw('NOT')) { next(); return { n: 'un', op: 'NOT', a: parseUnary() }; }
      if (isOp('-')) { next(); return { n: 'un', op: '-', a: parseUnary() }; }
      if (isOp('+')) { next(); return parseUnary(); }
      return parsePrimary();
    }
    function parsePrimary() {
      const t = peek();
      if (t.t === 'num') { next(); return { n: 'num', v: t.v }; }
      if (t.t === 'kw' && (t.v === 'TRUE' || t.v === 'FALSE')) { next(); return { n: 'bool', v: t.v === 'TRUE' }; }
      if (isOp('(')) { next(); const e = parseExpr(); eatOp(')'); return e; }
      if (t.t === 'id') {
        const name = parseLValue();
        if (isOp('(')) {                           // function call  NAME(args)
          next();
          const args = [];
          if (!isOp(')')) { args.push(parseExpr()); while (acceptOp(',')) args.push(parseExpr()); }
          eatOp(')');
          return { n: 'call', name: name, args: args };
        }
        return { n: 'var', name: name };
      }
      err('Unexpected token in expression');
    }

    return parseProgram();
  }

  /* ===================================================================== *
   *  EVALUATOR                                                            *
   * ===================================================================== */
  const MAX_ITER = 200000;                          // loop guard (don't freeze the tab)
  const EXIT = { sig: 'exit' }, CONT = { sig: 'continue' }, RET = { sig: 'return' };

  function toNum(v) { if (v === true) return 1; if (v === false) return 0; const n = +v; return isFinite(n) ? n : 0; }
  function toBool(v) { if (typeof v === 'boolean') return v; return toNum(v) !== 0; }

  // built-in functions: name -> (args[]) => value
  const FUNCS = {
    ABS: (a) => Math.abs(toNum(a[0])),
    SQRT: (a) => Math.sqrt(toNum(a[0])),
    SQR: (a) => { const x = toNum(a[0]); return x * x; },
    MIN: (a) => Math.min.apply(null, a.map(toNum)),
    MAX: (a) => Math.max.apply(null, a.map(toNum)),
    LIMIT: (a) => Math.max(toNum(a[0]), Math.min(toNum(a[1]), toNum(a[2]))), // LIMIT(min,in,max)
    TRUNC: (a) => Math.trunc(toNum(a[0])),
    ROUND: (a) => Math.round(toNum(a[0])),
    INT: (a) => Math.trunc(toNum(a[0])),
    REAL: (a) => toNum(a[0]),
    LN: (a) => Math.log(toNum(a[0])),
    EXP: (a) => Math.exp(toNum(a[0])),
    SIN: (a) => Math.sin(toNum(a[0])),
    COS: (a) => Math.cos(toNum(a[0])),
    TAN: (a) => Math.tan(toNum(a[0])),
  };

  // Classify an operand's storage class CONSISTENTLY for both read and write.
  // Resolving with expect:'word' keeps Bool tags / bit addresses / bit scope
  // members as 'bit', while undeclared symbols (e.g. a FOR counter `i`) map to
  // 'word' — the same class on read and write, so they don't land in the bit map
  // on write and read back 0 from the word map (or vice-versa).
  function opIsBit(name) { return T.resolve(name, 'word').type === 'bit'; }
  function readVar(name) {
    return opIsBit(name) ? T.readBit(name) : T.readNum(name);
  }
  function writeVar(name, value) {
    if (opIsBit(name)) T.writeBit(name, toBool(value));
    else T.writeNum(name, toNum(value));
  }

  function evalExpr(node) {
    switch (node.n) {
      case 'num': return node.v;
      case 'bool': return node.v;
      case 'var': return readVar(node.name);
      case 'call': {
        const fn = FUNCS[node.name.toUpperCase()];
        if (!fn) return 0;                           // unknown call -> 0 (lenient)
        return fn(node.args.map(evalExpr));
      }
      case 'un':
        if (node.op === 'NOT') return !toBool(evalExpr(node.a));
        return -toNum(evalExpr(node.a));             // unary minus
      case 'bin': {
        const op = node.op;
        // boolean operators short-circuit
        if (op === 'AND') return toBool(evalExpr(node.a)) && toBool(evalExpr(node.b));
        if (op === 'OR') return toBool(evalExpr(node.a)) || toBool(evalExpr(node.b));
        if (op === 'XOR') return toBool(evalExpr(node.a)) !== toBool(evalExpr(node.b));
        const a = evalExpr(node.a), b = evalExpr(node.b);
        switch (op) {
          case '+': return toNum(a) + toNum(b);
          case '-': return toNum(a) - toNum(b);
          case '*': return toNum(a) * toNum(b);
          case '/': { const d = toNum(b); return d === 0 ? 0 : toNum(a) / d; }
          case 'MOD': { const d = toNum(b); return d === 0 ? 0 : toNum(a) % d; }
          case '=': return toNum(a) === toNum(b);
          case '<>': return toNum(a) !== toNum(b);
          case '<': return toNum(a) < toNum(b);
          case '>': return toNum(a) > toNum(b);
          case '<=': return toNum(a) <= toNum(b);
          case '>=': return toNum(a) >= toNum(b);
        }
        return 0;
      }
    }
    return 0;
  }

  // run a list of statements; returns a control signal (EXIT/CONT/RET) or null
  function runStmts(list) {
    for (let i = 0; i < list.length; i++) {
      const sig = runStmt(list[i]);
      if (sig) return sig;
    }
    return null;
  }
  function runStmt(s) {
    switch (s.n) {
      case 'assign': writeVar(s.name, evalExpr(s.expr)); return null;
      case 'if': {
        for (let i = 0; i < s.arms.length; i++) {
          if (toBool(evalExpr(s.arms[i].cond))) return runStmts(s.arms[i].body);
        }
        if (s.els) return runStmts(s.els);
        return null;
      }
      case 'case': {
        const v = toNum(evalExpr(s.expr));
        for (let i = 0; i < s.arms.length; i++) {
          const arm = s.arms[i];
          for (let j = 0; j < arm.labels.length; j++) {
            const L = arm.labels[j];
            if (v >= L.lo && v <= L.hi) return runStmts(arm.body);
          }
        }
        if (s.els) return runStmts(s.els);
        return null;
      }
      case 'for': {
        let i = toNum(evalExpr(s.from));
        const to = toNum(evalExpr(s.to));
        const by = s.by ? toNum(evalExpr(s.by)) : 1;
        let guard = 0;
        if (by === 0) return null;
        for (; (by > 0 ? i <= to : i >= to); i += by) {
          if (++guard > MAX_ITER) break;
          writeVar(s.var, i);
          const sig = runStmts(s.body);
          if (sig === EXIT) break;
          if (sig === RET) return RET;
          // CONT falls through to next iteration
        }
        return null;
      }
      case 'while': {
        let guard = 0;
        while (toBool(evalExpr(s.cond))) {
          if (++guard > MAX_ITER) break;
          const sig = runStmts(s.body);
          if (sig === EXIT) break;
          if (sig === RET) return RET;
        }
        return null;
      }
      case 'repeat': {
        let guard = 0;
        do {
          if (++guard > MAX_ITER) break;
          const sig = runStmts(s.body);
          if (sig === EXIT) break;
          if (sig === RET) return RET;
        } while (!toBool(evalExpr(s.cond)));
        return null;
      }
      case 'exit': return EXIT;
      case 'continue': return CONT;
      case 'return': return RET;
    }
    return null;
  }

  /* ===================================================================== *
   *  COMPILE CACHE + PUBLIC EXEC                                          *
   * ===================================================================== */
  // Keep parsed ASTs out of the saved project JSON: cache by block id here.
  const _cache = new Map();                          // id -> { src, program, error }
  function compile(blk) {
    const src = (blk && blk.code) || '';
    const c = _cache.get(blk.id);
    if (c && c.src === src) return c;
    let entry;
    try { entry = { src: src, program: parse(src), error: null }; }
    catch (e) { entry = { src: src, program: null, error: { msg: e.message, line: e.line || 0, col: e.col || 0 } }; }
    _cache.set(blk.id, entry);
    return entry;
  }

  T.scl = {
    // run a block body once (called by the simulator's executeBlock)
    exec(blk) {
      if (!blk || !blk.code) return;
      const c = compile(blk);
      if (!c.program) return;                        // parse error -> skip (editor shows it)
      try { runStmts(c.program.body); }
      catch (e) { console.error('[scl] runtime error in ' + (blk.name || blk.id), e); }
    },
    // compile-only (used by the editor to surface parse errors)
    check(blk) { return compile(blk); },
    // invalidate one block's cache (editor calls this after an edit)
    invalidate(id) { _cache.delete(id); },
    parse: parse,                                    // exposed for tests
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
