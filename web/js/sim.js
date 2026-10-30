/* ===========================================================================
 * TIA-like Browser PLC IDE  —  sim.js
 * The SIMULATION ENGINE + live I/O simulation (watch/force) table.
 *
 * Public API (exposed on window.TIA):
 *   T.sim = {
 *     running:false,
 *     start(), stop(), toggle(), scanOnce(), reset(),
 *     renderTable(hostEl)
 *   }
 *
 * The engine reads T.project + T.mem and uses core helpers:
 *   T.readBit / T.writeBit / T.readNum / T.writeNum / T.resolve / T.parseTime.
 *
 * It executes one PLC scan per scanOnce():
 *   - OB blocks ascending by number, then FC blocks ascending by number.
 *   - Each block's networks evaluated IN ORDER, dispatched by block.lang.
 *   - LAD: classic series/parallel power-flow + outputs.
 *   - FBD: pin-value resolution over boxes ordered topologically by wires.
 *
 * Per-instance state (edges, timers, counters) is kept in a Map keyed by the
 * model element/box id. Timing uses performance.now() (milliseconds).
 *
 * After a full scan it emits 'sim:tick' exactly once so editors refresh their
 * energized (green) highlighting via element._live / box._live / pin._val.
 * ==========================================================================*/
(function (T) {
  'use strict';

  /* high-resolution clock (ms). performance.now is allowed in the browser. */
  const now = () => (typeof performance !== 'undefined' && performance.now
    ? performance.now() : Date.now());

  /* Per-element/box instance state, keyed by model id.
   * Shapes (created lazily):
   *   edge:    { prev:bool }
   *   timer:   { t0:number|null, prevIn:bool }
   *   counter: { count:number, prevCU:bool }
   *   fbd pin cache: see _pinCache below
   */
  let _state = new Map();
  let _timer = null;                 // setInterval handle
  const SCAN_MS = 80;

  // FBD cross-scan pin-value cache (for cyclic/latch wires): key = box.id+':'+pin.id
  let _pinCache = Object.create(null);

  // Structural caches — rebuilding these EVERY scan (walking every element for
  // called ids, re-running the topo sort per FBD network) burned scan budget on
  // large projects. Invalidated on any model change (tree:changed / load).
  let _calledCache = null;              // Set of block ids referenced by a call
  const _netCache = new Map();          // net.id -> { ordered:[boxes], wireIdx }

  // Per-scan execution context (set up at the top of scanOnce):
  //   stack     : block ids currently on the execution stack (cycle guard — a block
  //               may run many times per scan for different instances, but never
  //               re-enter itself)
  //   calledIds : Set of block ids referenced by any kind:'call' element/box
  //   instId    : id of the instance currently executing (instance DB / call site /
  //               block id), so per-element state is per-instance, not global
  // Reset every scan so call-gated execution never leaks across scans.
  let _scanCtx = { stack: [], calledIds: new Set(), instId: '@main' };

  // Per-element state keyed by (executing instance, element id): an FB containing
  // a timer/counter/edge must NOT share that state between its instances.
  function inst(id) {
    const key = (_scanCtx.instId || '@main') + ':' + id;
    let s = _state.get(key);
    if (!s) { s = {}; _state.set(key, s); }
    return s;
  }

  /* ----------------------------------------------------------------- helpers */
  function num(v) { const n = +v; return isFinite(n) ? n : 0; }
  function notEmpty(s) { return s != null && String(s).trim() !== ''; }

  // numeric comparison by operator string
  function cmp(op, a, b) {
    switch (op) {
      case '==': return a === b;
      case '<>': return a !== b;
      case '>':  return a > b;
      case '<':  return a < b;
      case '>=': return a >= b;
      case '<=': return a <= b;
      default:   return false;
    }
  }

  /* =========================================================================
   *  LAD evaluation
   * ======================================================================= */

  // inline value of a single contact-area element; also sets el._live.
  function inlineValue(el) {
    let v = false;
    switch (el.kind) {
      case 'contact_no':
        v = T.readBit(el.operand);
        break;
      case 'contact_nc':
        v = !T.readBit(el.operand);
        break;
      case 'edge_p': {
        const cur = T.readBit(el.operand);
        const s = inst(el.id);
        v = (cur && !s.prev);          // true only on the 0->1 scan
        s.prev = cur;
        break;
      }
      case 'edge_n': {
        const cur = T.readBit(el.operand);
        const s = inst(el.id);
        v = (!cur && s.prev);          // true only on the 1->0 scan
        s.prev = cur;
        break;
      }
      case 'compare': {
        const p = el.params || {};
        v = cmp(p.op || '==', num(T.readNum(p.in1)), num(T.readNum(p.in2)));
        break;
      }
      default:
        v = false;
    }
    el._live = v;
    return v;
  }

  // AND over a branch's series elements
  function branchValue(branch) {
    const els = (branch && branch.elements) || [];
    let v = true;
    for (let i = 0; i < els.length; i++) {
      // evaluate every element (so each gets its _live), even after a false
      if (!inlineValue(els[i])) v = false;
    }
    return v;
  }

  // OR over a stage's branches
  function stageValue(stage) {
    const brs = (stage && stage.branches) || [];
    if (!brs.length) return true;      // a stage with no branches passes power
    // An empty branch is a bare wire only while the whole stage is empty (a fresh
    // stage). Alongside a populated branch it is an unfinished parallel arm and
    // must not short the OR to true (matches TIA).
    const hasEls = brs.some((b) => b.elements && b.elements.length);
    let v = false;
    for (let i = 0; i < brs.length; i++) {
      const conducts = branchValue(brs[i]);   // always evaluate: stamps el._live
      if (conducts && (!hasEls || (brs[i].elements && brs[i].elements.length))) v = true;
    }
    return v;
  }

  // AND over the network's stages => rung power
  function rungPower(net) {
    const stages = net.stages || [];
    if (!stages.length) return true;   // direct rail connection
    let v = true;
    for (let i = 0; i < stages.length; i++) {
      if (!stageValue(stages[i])) v = false;
    }
    return v;
  }

  // Apply a single output-area element with the given rung power p.
  function applyOutput(el, p) {
    const k = el.kind;
    const par = el.params || {};
    switch (k) {
      case 'coil':
        T.writeBit(el.operand, p);
        el._live = p;
        break;
      case 'coil_neg':
        T.writeBit(el.operand, !p);
        el._live = p;
        break;
      case 'coil_set':
        if (p) T.writeBit(el.operand, true);
        el._live = T.readBit(el.operand);
        break;
      case 'coil_reset':
        if (p) T.writeBit(el.operand, false);
        el._live = p;
        break;

      /* ---- timers ---- (still evaluate Q/ET; colour the box by EN so it matches
         its energized incoming wires rather than flipping on the delayed Q) ---- */
      case 'ton': evalTON(el.id, p, par); el._live = p; break;
      case 'tof': evalTOF(el.id, p, par); el._live = p; break;
      case 'tp':  evalTP(el.id, p, par);  el._live = p; break;

      /* ---- counters ---- */
      case 'ctu': evalCTU(el.id, p, par); el._live = p; break;
      case 'ctd': evalCTD(el.id, p, par); el._live = p; break;
      case 'ctud': evalCTUD(el.id, p, T.readBit(par.cd), par); el._live = p; break;

      /* ---- move / math (ENO = EN && no numeric error) ---- */
      case 'move':
        if (p) T.writeNum(par.out, T.readNum(par.in));
        el._live = p;
        break;
      case 'add': case 'sub': case 'mul': case 'div': {
        const b = num(T.readNum(par.in2));
        const r = mathOp(k, T.readNum(par.in1), b);
        if (p) T.writeNum(par.out, r);
        if (notEmpty(par.eno)) T.writeBit(par.eno, p && !(k === 'div' && b === 0) && isFinite(r));
        el._live = p;
        break;
      }

      /* ---- conversion / scaling ---- */
      case 'norm_x': {
        const mn = num(T.readNum(par.min)), mx = num(T.readNum(par.max));
        const r = normX(mn, T.readNum(par.val), mx);
        if (p) T.writeNum(par.out, r);
        if (notEmpty(par.eno)) T.writeBit(par.eno, p && mx !== mn && isFinite(r));
        el._live = p;
        break;
      }
      case 'scale_x': {
        const r = scaleX(T.readNum(par.min), T.readNum(par.val), T.readNum(par.max));
        if (p) T.writeNum(par.out, r);
        if (notEmpty(par.eno)) T.writeBit(par.eno, p && isFinite(r));
        el._live = p;
        break;
      }

      /* ---- latches (S = rung power; the other input is a referenced bit) ---- */
      case 'sr': {                      // reset dominant
        let q = T.readBit(el.operand);
        if (T.readBit(par.r)) q = false; else if (p) q = true;
        T.writeBit(el.operand, q); el._live = q;
        break;
      }
      case 'rs': {                      // set dominant  (R = rung power, S1 = referenced bit)
        let q = T.readBit(el.operand);
        if (T.readBit(par.s)) q = true; else if (p) q = false;
        T.writeBit(el.operand, q); el._live = q;
        break;
      }

      /* ---- edge triggers (CLK = rung power; Q pulses one scan on the edge) ---- */
      case 'p_trig': case 'r_trig': {
        const st = inst(el.id);
        const q = p && !st.prevClk; st.prevClk = p;
        if (notEmpty(par.q)) T.writeBit(par.q, q); el._live = q;
        break;
      }
      case 'n_trig': case 'f_trig': {
        const st = inst(el.id);
        const q = !p && st.prevClk; st.prevClk = p;
        if (notEmpty(par.q)) T.writeBit(par.q, q); el._live = q;
        break;
      }

      /* ---- block call ---- */
      case 'call':
        // EN = rung power. When enabled, execute the target block, copying the
        // wired arguments (el.args) into/out of its interface parameters.
        el._live = !!p;
        if (p && el.params && notEmpty(el.params.target)) {
          executeBlock(el.params.target, {
            instanceId: notEmpty(el.params.instanceDb) ? el.params.instanceDb : el.id,
            getArg: (m) => {
              const op = el.args && el.args[m.name];
              if (!notEmpty(op)) return undefined;
              return m.dataType === 'Bool' ? T.readBit(op) : T.readNum(op);
            },
            setArg: (m, v) => {
              const op = el.args && el.args[m.name];
              if (!notEmpty(op)) return;
              if (m.dataType === 'Bool') T.writeBit(op, v); else T.writeNum(op, v);
            },
          });
        }
        break;

      default:
        el._live = p;
    }
  }

  function mathOp(k, a, b) {
    a = num(a); b = num(b);
    switch (k) {
      case 'add': return a + b;
      case 'sub': return a - b;
      case 'mul': return a * b;
      case 'div': return b === 0 ? 0 : a / b;   // guard divide-by-zero
      default:    return 0;
    }
  }

  /* ----- conversion / scaling (IEC NORM_X / SCALE_X) -------------------- */
  // NORM_X: OUT = (VALUE-MIN)/(MAX-MIN); 0 if MAX==MIN. Not clamped (matches TIA).
  function normX(min, val, max) {
    min = num(min); val = num(val); max = num(max);
    const den = max - min;
    return den === 0 ? 0 : (val - min) / den;
  }
  // SCALE_X: OUT = VALUE*(MAX-MIN)+MIN.
  function scaleX(min, val, max) {
    min = num(min); val = num(val); max = num(max);
    return val * (max - min) + min;
  }

  /* ----- IEC timers (shared by LAD outputs & FBD boxes) ----------------- */
  // PT accepts a T# literal / plain ms number, or an OPERAND (tag / interface
  // member) whose value is milliseconds. parseTime alone turns a tag name into 0.
  function resolvePT(raw) {
    const s = raw == null ? '' : String(raw).trim();
    if (s === '') return 0;
    const ms = (T.TIME_LIT.test(s) || /^-?\d+(\.\d+)?$/.test(s)) ? T.parseTime(s) : num(T.readNum(s));
    return Math.max(0, ms);
  }

  // TON: on-delay. While IN true, ET ramps; Q after ET>=PT. IN false resets.
  // extPT (FBD): the already-resolved PT pin value in ms (wired or literal).
  function evalTON(id, p, par, extPT) {
    const s = inst(id);
    const PT = (extPT != null) ? Math.max(0, num(extPT)) : resolvePT(par.pt);
    let elapsed = 0;
    if (p) {
      if (s.t0 == null) s.t0 = now();
      elapsed = now() - s.t0;
    } else {
      s.t0 = null;
      elapsed = 0;
    }
    const q = (s.t0 != null && elapsed >= PT);
    // ET in whole ms (IEC TIME): a fraction written to a DInt/Time MD tag used
    // to land as float32 bits and read back as garbage. s.et feeds the FBD ET pin.
    s.et = Math.round(Math.min(elapsed, PT));
    if (notEmpty(par.q)) T.writeBit(par.q, q);
    if (notEmpty(par.et)) T.writeNum(par.et, s.et);
    return q;
  }

  // TOF: off-delay. Q true while IN true; after falling edge stays true PT.
  function evalTOF(id, p, par, extPT) {
    const s = inst(id);
    const PT = (extPT != null) ? Math.max(0, num(extPT)) : resolvePT(par.pt);
    let q;
    let elapsed = 0;
    if (p) {
      s.t0 = null;
      q = true;
      elapsed = 0;
    } else {
      if (s.prevIn) s.t0 = now();        // falling edge => start delay
      if (s.t0 != null) {
        elapsed = now() - s.t0;
        if (elapsed >= PT) { q = false; elapsed = PT; }
        else q = true;
      } else {
        q = false;
      }
    }
    s.prevIn = p;
    s.et = Math.round(elapsed);
    if (notEmpty(par.q)) T.writeBit(par.q, q);
    if (notEmpty(par.et)) T.writeNum(par.et, s.et);
    return q;
  }

  // TP: pulse. Rising edge starts a fixed-length pulse; Q true for PT regardless
  // of the input. The timer re-arms only once the pulse has finished AND the
  // input has returned low (IEC behaviour).
  function evalTP(id, p, par, extPT) {
    const s = inst(id);
    const PT = (extPT != null) ? Math.max(0, num(extPT)) : resolvePT(par.pt);
    // rising edge while idle starts a pulse
    if (p && !s.prevIn && s.t0 == null) s.t0 = now();
    let q = false, elapsed = 0;
    if (s.t0 != null) {
      elapsed = now() - s.t0;
      if (elapsed < PT) {
        q = true;                       // pulse active
      } else {
        q = false; elapsed = PT;        // pulse expired
        if (!p) s.t0 = null;            // re-arm only after input returns low
      }
    }
    s.prevIn = p;
    s.et = Math.round(Math.min(elapsed, PT));
    if (notEmpty(par.q)) T.writeBit(par.q, q);
    if (notEmpty(par.et)) T.writeNum(par.et, s.et);
    return q;
  }

  /* ----- IEC counters --------------------------------------------------- */
  const CMAX = 32767;

  // CTU: count up on rising CU; reset on R; Q when count>=PV.
  // extR / extPV (FBD): already-resolved R pin and PV pin values.
  function evalCTU(id, cu, par, extR, extPV) {
    const s = inst(id);
    if (s.count == null) s.count = 0;
    const reset = (extR != null) ? !!extR : T.readBit(par.r);
    if (reset) {
      s.count = 0;
    } else if (cu && !s.prevCU) {
      s.count = Math.min(s.count + 1, CMAX);
    }
    s.prevCU = cu;
    const PV = (extPV != null) ? num(extPV) : num(T.readNum(par.pv));
    const q = s.count >= PV;
    if (notEmpty(par.cv)) T.writeNum(par.cv, s.count);
    if (notEmpty(par.q)) T.writeBit(par.q, q);
    return q;
  }

  // CTD: count down on rising CD; load PV on LD; Q when count<=0.
  // IEC/S7: CV starts at 0 (Q true) until LD loads PV.
  function evalCTD(id, cd, par, extLD, extPV) {
    const s = inst(id);
    const PV = (extPV != null) ? num(extPV) : num(T.readNum(par.pv));
    if (s.count == null) s.count = 0;
    const load = (extLD != null) ? !!extLD : T.readBit(par.r);   // LD operand stored in params.r (same slot as CTU reset)
    if (load) {
      s.count = PV;
    } else if (cd && !s.prevCD) {
      s.count = Math.max(s.count - 1, -CMAX);
    }
    s.prevCD = cd;
    const q = s.count <= 0;
    if (notEmpty(par.cv)) T.writeNum(par.cv, s.count);
    if (notEmpty(par.q)) T.writeBit(par.q, q);
    return q;
  }

  // CTUD: count up on rising CU, down on rising CD; R (dominant) clears, LD
  // loads PV; simultaneous edges cancel. QU = CV>=PV, QD = CV<=0.
  function evalCTUD(id, cu, cd, par, extR, extLD, extPV) {
    const s = inst(id);
    if (s.count == null) s.count = 0;
    const reset = (extR != null) ? !!extR : T.readBit(par.r);
    const load = (extLD != null) ? !!extLD : T.readBit(par.ld);
    const PV = (extPV != null) ? num(extPV) : num(T.readNum(par.pv));
    const eu = cu && !s.prevCU, ed = cd && !s.prevCD;
    if (reset) s.count = 0;
    else if (load) s.count = PV;
    else if (eu && !ed) s.count = Math.min(s.count + 1, CMAX);
    else if (ed && !eu) s.count = Math.max(s.count - 1, -CMAX);
    s.prevCU = cu; s.prevCD = cd;
    const qu = s.count >= PV, qd = s.count <= 0;
    if (notEmpty(par.cv)) T.writeNum(par.cv, s.count);
    if (notEmpty(par.qu)) T.writeBit(par.qu, qu);
    if (notEmpty(par.qd)) T.writeBit(par.qd, qd);
    return { qu, qd, cv: s.count };
  }

  // Evaluate one LAD network: compute rung power, drive each output.
  function evalLadNetwork(net) {
    const p = rungPower(net);
    net._power = p;                 // authoritative rung power for the editor's wire colouring
    const outs = net.outputs || [];
    for (let i = 0; i < outs.length; i++) applyOutput(outs[i], p);
  }

  /* =========================================================================
   *  FBD evaluation
   *  Boxes are connected by wires (from out-pin -> to in-pin). We resolve each
   *  box in dependency order; cyclic wires fall back to the last-scan cached
   *  pin value (latch behaviour). Pin values are cached across scans.
   * ======================================================================= */

  // map a box pin NAME -> params key (mirrors fbd.js inputParamMap/outputParamMap)
  function inParamKey(kind, pinName) {
    switch (kind) {
      case 'compare': if (pinName === 'in1') return 'in1'; if (pinName === 'in2') return 'in2'; break;
      case 'ton': case 'tof': case 'tp': if (pinName === 'PT') return 'pt'; break;
      case 'ctu': case 'ctd': case 'ctud': if (pinName === 'PV') return 'pv'; break;
      case 'move': if (pinName === 'IN') return 'in'; break;
      case 'add': case 'sub': case 'mul': case 'div':
        if (pinName === 'in1') return 'in1'; if (pinName === 'in2') return 'in2'; break;
      case 'norm_x': case 'scale_x':
        if (pinName === 'MIN') return 'min';
        if (pinName === 'VALUE') return 'val';
        if (pinName === 'MAX') return 'max';
        break;
    }
    return null;
  }

  // Pin cache keys are instance-scoped too: cyclic-wire latch values inside an
  // FB must not leak between its instances across scans.
  function pinKey(boxId, pinId) { return (_scanCtx.instId || '@main') + ':' + boxId + ':' + pinId; }

  // Cached per-network structure: topological box order + an input-pin -> wire
  // source index (replaces a linear net.wires scan per pin per scan).
  function netStructure(net) {
    let c = _netCache.get(net.id);
    if (!c) {
      const wireIdx = Object.create(null);
      (net.wires || []).forEach((w) => {
        if (w && w.to) wireIdx[w.to.box + ':' + w.to.pin] = w.from || null;
      });
      c = { ordered: orderBoxes(net), wireIdx };
      _netCache.set(net.id, c);
    }
    return c;
  }

  function findBox(net, id) {
    return (net.boxes || []).find((b) => b.id === id) || null;
  }

  // Boolean-ness of a box kind (logic gates / contacts produce bits).
  function isBoolBox(kind) {
    return kind === 'fb_and' || kind === 'fb_or' || kind === 'fb_xor'
        || kind === 'fb_not' || kind === 'assign';
  }

  // Resolve the value arriving at an input pin (already computed source this scan,
  // else cached last-scan value, else the pin's own operand/param literal).
  // `computed` is a Set of box ids fully evaluated this scan; `cache` is the
  // working per-scan pin-value store. Applies pin.inverted for booleans.
  function inputPinValue(net, box, pin, cache, computed, wireIdx) {
    const src = wireIdx[box.id + ':' + pin.id] || null;
    let val;
    if (src) {
      const k = pinKey(src.box, src.pin);
      if (k in cache) {
        val = cache[k];
      } else {
        // source not yet computed this scan (cycle): use last-scan cache
        val = (k in _pinCache) ? _pinCache[k] : false;
      }
    } else {
      // unwired: read operand or mapped param literal
      const pk = inParamKey(box.kind, pin.name);
      if (pk) {
        // numeric/param input (PT, PV, in1, in2, IN of move/compare/math)
        val = T.readNum((box.params || {})[pk]);
      } else if (notEmpty(pin.operand)) {
        // read with the operand's own type: a numeric tag/literal on a call-box
        // pin must arrive as its value, not as 0/1 (Bool operands stay bits)
        const r = T.resolve(pin.operand, 'bit');
        val = r.type === 'const' ? r.value
            : (r.type === 'word' || r.type === 'time') ? T.readNum(pin.operand)
            : T.readBit(pin.operand);
      } else if (box.kind === 'call' && pin.name === 'EN') {
        val = true;               // TIA: an open EN executes the block unconditionally
      } else {
        val = false;
      }
    }
    // inversion only meaningful for boolean values
    if (pin.inverted && (typeof val === 'boolean' || val === 0 || val === 1)) {
      val = !val;
    }
    return val;
  }

  // Compute all output-pin values of a box and write side effects to memory.
  function evalBox(net, box, cache, computed, wireIdx) {
    const k = box.kind;
    const ins = box.inputs || [];
    const outs = box.outputs || [];
    const par = box.params || (box.params = {});

    // read each input pin value, and record it on the pin so the editor can
    // colour input stubs/dots/operands green (high) / blue (low) during simulation.
    const inVals = ins.map((p) => {
      const v = inputPinValue(net, box, p, cache, computed, wireIdx);
      p._val = !!v;
      return v;
    });

    let outVal = false;          // primary boolean/numeric result
    let live = false;
    let outMap = null;           // optional per-OUTPUT-pin values, keyed by pin NAME

    switch (k) {
      case 'fb_and':
        outVal = inVals.length ? inVals.every((v) => !!v) : false;
        live = outVal;
        break;
      case 'fb_or':
        outVal = inVals.some((v) => !!v);
        live = outVal;
        break;
      case 'fb_xor':
        outVal = inVals.reduce((acc, v) => acc ^ (v ? 1 : 0), 0) === 1;
        live = outVal;
        break;
      case 'fb_not':
        outVal = !inVals[0];
        live = outVal;
        break;
      case 'assign': {
        const v = !!inVals[0];
        if (notEmpty(box.operand)) T.writeBit(box.operand, v);
        outVal = v;
        live = v;
        break;
      }
      case 'compare': {
        const a = num(unwiredNum(net, box, 'in1', inVals, ins));
        const b = num(unwiredNum(net, box, 'in2', inVals, ins));
        outVal = cmp(par.op || '==', a, b);
        live = outVal;
        break;
      }

      /* latches — S/R (or R/S1) are the two input pins; operand stores Q.
         Operand-less latch state lives in inst() (per instance, cleared on
         sim reset — never persisted on the model). */
      case 'sr': {                      // reset dominant: in pins [S, R1]
        const st = inst(box.id);
        let q = notEmpty(box.operand) ? T.readBit(box.operand) : !!st.q;
        if (!!inVals[1]) q = false; else if (!!inVals[0]) q = true;
        if (notEmpty(box.operand)) T.writeBit(box.operand, q);
        st.q = q; outVal = q; live = q;
        break;
      }
      case 'rs': {                      // set dominant: in pins [R, S1]
        const st = inst(box.id);
        let q = notEmpty(box.operand) ? T.readBit(box.operand) : !!st.q;
        if (!!inVals[1]) q = true; else if (!!inVals[0]) q = false;
        if (notEmpty(box.operand)) T.writeBit(box.operand, q);
        st.q = q; outVal = q; live = q;
        break;
      }

      /* edge triggers — CLK = first input pin; Q pulses one scan on the edge */
      case 'p_trig': case 'r_trig': {
        const st = inst(box.id);
        outVal = !!inVals[0] && !st.prevClk; st.prevClk = !!inVals[0];
        if (notEmpty(par.q)) T.writeBit(par.q, outVal); live = outVal;
        break;
      }
      case 'n_trig': case 'f_trig': {
        const st = inst(box.id);
        outVal = !inVals[0] && st.prevClk; st.prevClk = !!inVals[0];
        if (notEmpty(par.q)) T.writeBit(par.q, outVal); live = outVal;
        break;
      }

      /* timers/counters — first input pin (IN/CU/CD) acts as enable RLO.
         PT/PV and R/LD come from their pins (wired value or literal), so a
         wired preset / reset condition actually takes effect. */
      case 'ton': case 'tof': case 'tp': {
        const pt = num(unwiredNum(net, box, 'pt', inVals, ins, 'PT'));
        const f = k === 'ton' ? evalTON : k === 'tof' ? evalTOF : evalTP;
        outVal = f(box.id, !!inVals[0], par, pt); live = outVal;
        break;
      }
      case 'ctu': case 'ctd': {
        const pv = num(unwiredNum(net, box, 'pv', inVals, ins, 'PV'));
        outVal = (k === 'ctu' ? evalCTU : evalCTD)(box.id, !!inVals[0], par, !!inVals[1], pv);
        live = outVal;
        break;
      }
      case 'ctud': {
        // pins [CU, CD, R, LD, PV]
        const pv = num(unwiredNum(net, box, 'pv', inVals, ins, 'PV'));
        const r = evalCTUD(box.id, !!inVals[0], !!inVals[1], par, !!inVals[2], !!inVals[3], pv);
        outVal = r.qu;
        outMap = { QU: r.qu, QD: r.qd, CV: r.cv };
        live = r.qu;
        break;
      }

      case 'move': {
        // MOVE in FBD has a single IN pin (the value); it moves unconditionally.
        const v = num(unwiredNum(net, box, 'in', inVals, ins, 'IN'));
        if (notEmpty(par.out)) T.writeNum(par.out, v);
        outVal = v;
        live = true;
        break;
      }
      case 'add': case 'sub': case 'mul': case 'div': {
        const a = num(unwiredNum(net, box, 'in1', inVals, ins));
        const b = num(unwiredNum(net, box, 'in2', inVals, ins));
        let r = mathOp(k, a, b);
        // expandable ADD / MUL: fold in the extra input pins (in3, in4 ...)
        if (k === 'add' || k === 'mul') {
          const i1 = ins.findIndex((pp) => pp.name === 'in1');
          const i2 = ins.findIndex((pp) => pp.name === 'in2');
          for (let i = 0; i < ins.length; i++) {
            if (i === i1 || i === i2) continue;
            r = (k === 'add') ? r + num(inVals[i]) : r * num(inVals[i]);
          }
        }
        if (notEmpty(par.out)) T.writeNum(par.out, r);
        const eno = !(k === 'div' && b === 0) && isFinite(r);   // no EN pin in FBD
        if (notEmpty(par.eno)) T.writeBit(par.eno, eno);
        outVal = r;
        outMap = { ENO: eno };
        live = true;
        break;
      }

      case 'norm_x': case 'scale_x': {
        // pins MIN/VALUE/MAX (wired value preferred, else params min/val/max literal)
        const mn = num(unwiredNum(net, box, 'min', inVals, ins, 'MIN'));
        const vl = num(unwiredNum(net, box, 'val', inVals, ins, 'VALUE'));
        const mx = num(unwiredNum(net, box, 'max', inVals, ins, 'MAX'));
        const r = (k === 'norm_x') ? normX(mn, vl, mx) : scaleX(mn, vl, mx);
        if (notEmpty(par.out)) T.writeNum(par.out, r);
        const eno = (k !== 'norm_x' || mx !== mn) && isFinite(r);
        if (notEmpty(par.eno)) T.writeBit(par.eno, eno);
        outVal = r;
        outMap = { ENO: eno };
        live = true;
        break;
      }

      case 'call': {
        // EN = first input pin RLO. Member input pins (after EN) feed the callee's
        // inputs; member output pins (after ENO) receive its outputs via box._callOut.
        const en = !!inVals[0];
        const tgt = notEmpty(par.target) ? T.findBlock(par.target) : null;
        const instId = notEmpty(par.instanceDb) ? par.instanceDb : box.id;
        box._callOut = {};
        if (en && tgt) {
          executeBlock(tgt.id, {
            instanceId: instId,
            getArg: (m) => {
              const idx = (box.inputs || []).findIndex((pp) => pp.name === m.name);
              if (idx < 0) return undefined;
              return m.dataType === 'Bool' ? !!inVals[idx] : num(inVals[idx]);
            },
            setArg: (m, v) => { box._callOut[m.name] = v; },
          });
        }
        // Output pins always reflect the instance's output members (held when EN=false).
        if (tgt) {
          T.ensureInterface(tgt);
          T.ifaceCallOutputs(tgt).forEach((m) => {
            if (!(m.name in box._callOut)) {
              const key = T.memberKey(instId, m.name);
              box._callOut[m.name] = (m.dataType === 'Bool') ? T.mem.getBit(key) : T.mem.getWord(key);
            }
          });
        }
        outVal = en;          // ENO
        live = en;
        break;
      }

      default:
        outVal = inVals[0];
        live = !!outVal;
    }

    // store output pin values into the working cache + cross-scan cache
    for (let i = 0; i < outs.length; i++) {
      const op = outs[i];
      let pv = outVal;
      // timers/counters expose Q (bool) on first out pin and ET/CV (num) on 2nd
      if (outMap && Object.prototype.hasOwnProperty.call(outMap, op.name)) {
        pv = outMap[op.name];
      } else if ((k === 'ton' || k === 'tof' || k === 'tp')) {
        // the timer's own ET — also when no ET operand is assigned
        if (op.name === 'ET') pv = inst(box.id).et || 0;
        else pv = outVal;        // Q
      } else if (k === 'ctu' || k === 'ctd') {
        if (op.name === 'CV') pv = inst(box.id).count || 0;
        else pv = outVal;        // Q
      } else if (k === 'move' || k === 'add' || k === 'sub' || k === 'mul' || k === 'div'
              || k === 'norm_x' || k === 'scale_x') {
        pv = outVal;             // numeric OUT
      } else if (k === 'call') {
        // ENO follows EN; each member output pin takes its callee result
        pv = (op.name === 'ENO') ? outVal
           : (box._callOut && (op.name in box._callOut) ? box._callOut[op.name] : false);
      }
      const ck = pinKey(box.id, op.id);
      cache[ck] = pv;
      op._val = pv;
    }

    box._live = live;
    computed.add(box.id);
  }

  // For a box param input (in1/in2/in/IN): prefer a wired value if the pin is
  // wired, else use the params literal. inVals carries the already-resolved
  // per-pin value (wired or literal), so we can use it directly by pin position.
  function unwiredNum(net, box, paramKey, inVals, ins, pinNameOverride) {
    const wantName = pinNameOverride
      || (paramKey === 'in' ? 'IN' : paramKey);
    for (let i = 0; i < ins.length; i++) {
      const pn = ins[i].name;
      if (pn === wantName || pn === paramKey) return num(inVals[i]);
    }
    // fall back to the params literal directly
    return num(T.readNum((box.params || {})[paramKey]));
  }

  // Topologically order boxes by their wire dependencies (best-effort).
  function orderBoxes(net) {
    const boxes = (net.boxes || []).slice();
    const ws = net.wires || [];
    const incoming = new Map();   // boxId -> set of source boxIds it depends on
    boxes.forEach((b) => incoming.set(b.id, new Set()));
    ws.forEach((w) => {
      if (w.from && w.to && incoming.has(w.to.box) && incoming.has(w.from.box)
          && w.from.box !== w.to.box) {
        incoming.get(w.to.box).add(w.from.box);
      }
    });

    const ordered = [];
    const done = new Set();
    let guard = boxes.length * boxes.length + boxes.length + 1;
    while (ordered.length < boxes.length && guard-- > 0) {
      let progressed = false;
      for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (done.has(b.id)) continue;
        const deps = incoming.get(b.id);
        let ready = true;
        deps.forEach((d) => { if (!done.has(d)) ready = false; });
        if (ready) { ordered.push(b); done.add(b.id); progressed = true; }
      }
      if (!progressed) {
        // cycle remains: emit the rest in declaration order (cached values used)
        for (let i = 0; i < boxes.length; i++) {
          if (!done.has(boxes[i].id)) { ordered.push(boxes[i]); done.add(boxes[i].id); }
        }
        break;
      }
    }
    return ordered;
  }

  function evalFbdNetwork(net) {
    const cache = Object.create(null);   // per-scan working pin values
    const computed = new Set();
    const st = netStructure(net);        // cached order + wire index
    for (let i = 0; i < st.ordered.length; i++) {
      evalBox(net, st.ordered[i], cache, computed, st.wireIdx);
    }
    // persist this scan's pin values for next-scan cyclic reads
    for (const k in cache) _pinCache[k] = cache[k];
  }

  /* =========================================================================
   *  BLOCK CALLS
   *  A kind:'call' element (LAD output) or box (FBD) references another block by
   *  id in params.target. When its EN / rung power is true during evaluation we
   *  execute the target block's networks inline at that point. Execution is
   *  guarded so each block runs at most once per scan (self/cyclic calls ignored).
   * ======================================================================= */

  // Gather all block ids referenced by any kind:'call' element/box, across every
  // block. Used so orphan FC/FB blocks (never called) still simulate as before.
  function collectCalledIds() {
    const set = new Set();
    const p = T.project;
    if (!p || !Array.isArray(p.blocks)) return set;
    p.blocks.forEach((blk) => {
      (blk.networks || []).forEach((net) => {
        if (!net) return;
        // LAD: call elements live in network.outputs
        (net.outputs || []).forEach((el) => {
          if (el && el.kind === 'call' && el.params && notEmpty(el.params.target)) {
            set.add(el.params.target);
          }
        });
        // FBD: call boxes live in network.boxes
        (net.boxes || []).forEach((bx) => {
          if (bx && bx.kind === 'call' && bx.params && notEmpty(bx.params.target)) {
            set.add(bx.params.target);
          }
        });
      });
    });
    return set;
  }

  /* ---- block-local interface storage helpers ---- */
  function memIsBit(m) { return m.dataType === 'Bool'; }
  function boolDefault(d) { return /^(1|true|on|yes)$/i.test(String(d == null ? '' : d).trim()); }
  function numDefault(m) {
    if (m.dataType === 'Time') return T.parseTime(m.default);
    const n = parseFloat(m.default); return isNaN(n) ? 0 : n;
  }
  function writeMember(instanceId, m, v) {
    const key = T.memberKey(instanceId, m.name);
    if (memIsBit(m)) T.mem.setBit(key, !!v); else T.mem.setWord(key, num(v));
  }
  function readMember(instanceId, m) {
    const key = T.memberKey(instanceId, m.name);
    return memIsBit(m) ? T.mem.getBit(key) : T.mem.getWord(key);
  }
  // Build the name->storage scope for a block instance and lazily initialise each
  // member's storage to its declared default the first time the instance is seen.
  function buildScope(blk, instanceId) {
    const scope = Object.create(null);
    T.ifaceMembers(blk).forEach((entry) => {
      const m = entry.member;
      if (!notEmpty(m.name)) return;
      const key = T.memberKey(instanceId, m.name);
      const bit = memIsBit(m);
      scope[String(m.name).toLowerCase()] = { addr: key, bit: bit };
      if (bit) { if (!(key in T.mem.bits)) T.mem.setBit(key, boolDefault(m.default)); }
      else { if (!(key in T.mem.words)) T.mem.setWord(key, numDefault(m)); }
    });
    return scope;
  }

  // Execute a block's networks under its own local interface scope, optionally
  // passing call parameters. opts = { instanceId, getArg(member)->value|undefined,
  // setArg(member, value) }. Cyclic re-entry is blocked; a block may otherwise run
  // multiple times per scan (once per instance/call site). DB blocks hold no logic.
  function executeBlock(blockId, opts) {
    if (!notEmpty(blockId)) return;
    const blk = T.findBlock(blockId);
    if (!blk || blk.type === 'DB') return;
    if (_scanCtx.stack.indexOf(blk.id) >= 0) return;   // cycle guard
    opts = opts || {};
    const instanceId = opts.instanceId || blk.id;
    const getArg = opts.getArg, setArg = opts.setArg;

    T.ensureInterface(blk);
    // 1) sample input/inout arguments in the CALLER's scope (before we switch)
    const inParams = T.ifaceCallInputs(blk);
    const inVals = getArg ? inParams.map((m) => getArg(m)) : null;

    // 2) switch to the callee's local scope (members shadow global tags)
    const scope = buildScope(blk, instanceId);
    const prevScope = T.setScope(scope);
    const prevInst = _scanCtx.instId;
    _scanCtx.instId = instanceId;        // per-instance element state (see inst())
    _scanCtx.stack.push(blk.id);
    try {
      // copy inputs into the instance's member storage
      if (inVals) inParams.forEach((m, i) => {
        if (inVals[i] === undefined || inVals[i] === null) return;  // unconnected -> keep default
        writeMember(instanceId, m, inVals[i]);
      });
      // run the body — SCL is one text program; LAD/FBD are graphical networks
      if (blk.lang === 'SCL') {
        if (T.scl) { try { T.scl.exec(blk); } catch (e) { console.error('[sim] scl eval error', e); } }
      } else {
        const nets = blk.networks || [];
        for (let ni = 0; ni < nets.length; ni++) {
          const net = nets[ni];
          if (!net) continue;
          try { (blk.lang === 'FBD' ? evalFbdNetwork : evalLadNetwork)(net); }
          catch (e) { console.error('[sim] network eval error', e); }
        }
      }
    } finally {
      _scanCtx.stack.pop();
      _scanCtx.instId = prevInst;
      T.setScope(prevScope);   // restore caller scope
    }

    // 3) copy output/inout results back to the caller's operands (caller scope active)
    if (setArg) T.ifaceCallOutputs(blk).forEach((m) => setArg(m, readMember(instanceId, m)));
  }

  /* =========================================================================
   *  SCAN DRIVER
   * ======================================================================= */
  function blockOrder() {
    const p = T.project;
    if (!p || !Array.isArray(p.blocks)) return [];
    // Execute every program block that holds logic. In a real PLC, FC/FB run only
    // when called from an OB; for a practice simulator we run them all so anything
    // you author actually simulates. Order: OB, then FC, then FB (by number). DB has no logic.
    const byNum = (type) => p.blocks.filter((b) => b.type === type)
      .sort((a, b) => (a.number || 0) - (b.number || 0));
    return byNum('OB').concat(byNum('FC')).concat(byNum('FB'));
  }

  function scanOnce() {
    const p = T.project;
    if (!p || !Array.isArray(p.blocks)) return;

    // Fresh per-scan context: which blocks are referenced by a call, and which
    // have already executed this scan (recursion guard). calledIds only changes
    // when the model changes (invalidated via tree:changed / project:loaded).
    if (!_calledCache) _calledCache = collectCalledIds();
    _scanCtx = { stack: [], calledIds: _calledCache, instId: '@main' };

    const byNum = (type) => p.blocks.filter((b) => b.type === type)
      .sort((a, b) => (a.number || 0) - (b.number || 0));

    // 1) Run every OB (ascending number). Enabled call elements/boxes inside them
    //    execute their target block inline via executeBlock (recursion-guarded).
    byNum('OB').forEach((blk) => executeBlock(blk.id));

    // 2) Run any FC/FB that is NOT referenced by a call (orphans) — preserves the
    //    "anything you author still simulates" behavior. Called blocks already ran
    //    (or will only run when their caller is enabled).
    byNum('FC').concat(byNum('FB')).forEach((blk) => {
      if (!_scanCtx.calledIds.has(blk.id)) executeBlock(blk.id);
    });

    // one refresh signal per scan for editors' green highlighting
    T.bus.emit('sim:tick');
  }

  /* clear all _live / _val flags so the editor stops showing green on stop */
  function clearLiveFlags() {
    const p = T.project;
    if (!p || !Array.isArray(p.blocks)) return;
    p.blocks.forEach((blk) => {
      (blk.networks || []).forEach((net) => {
        (net.stages || []).forEach((st) =>
          (st.branches || []).forEach((br) =>
            (br.elements || []).forEach((el) => { el._live = false; })));
        (net.outputs || []).forEach((el) => { el._live = false; });
        (net.boxes || []).forEach((bx) => {
          bx._live = false;
          (bx.outputs || []).forEach((op) => { op._val = false; });
        });
      });
    });
  }

  /* =========================================================================
   *  PUBLIC API
   * ======================================================================= */
  T.sim = {
    running: false,

    reset() {
      _state = new Map();
      _pinCache = Object.create(null);
      _scanCtx = { stack: [], calledIds: new Set(), instId: '@main' };
      clearLiveFlags();
      // T.mem values are intentionally kept (inputs the user set persist).
    },

    start() {
      if (this.running) return;
      this.reset();
      this.running = true;
      if (_timer) clearInterval(_timer);
      // honour the project's scan cycle, but clamp to a browser-friendly minimum
      // (the ESP32 runtime can scan much faster than the in-app visualiser).
      const want = (T.project && +T.project.scanMs) || SCAN_MS;
      const ms = Math.max(20, Math.min(2000, want));
      _timer = setInterval(() => {
        try { this.scanOnce(); } catch (e) { console.error('[sim] scan', e); }
      }, ms);
      T.bus.emit('sim:state', { running: true });
      T.status('Simulation running', 'ok');
    },

    stop() {
      if (_timer) { clearInterval(_timer); _timer = null; }
      this.running = false;
      clearLiveFlags();
      T.bus.emit('sim:state', { running: false });
      // one tick so editors clear their green highlight
      T.bus.emit('sim:tick');
      T.status('Simulation stopped');
    },

    toggle() { this.running ? this.stop() : this.start(); },

    scanOnce() { scanOnce(); },

    renderTable(hostEl) { renderTable(hostEl); }
  };

  /* =========================================================================
   *  SIMULATION TABLE (watch / force)
   * ======================================================================= */
  T.injectCSS('tia-sim-css', `
    .sim-wrap { font-size: 12px; }
    .sim-empty { padding: 18px; color: var(--tia-text-soft); font-style: italic; text-align:center; }
    table.sim-table { border-collapse: collapse; width: 100%; }
    table.sim-table th { background: var(--tia-panel-head); color:#fff; font-weight:600;
      text-align:left; padding:3px 7px; position:sticky; top:0; z-index:1; }
    table.sim-table td { border:1px solid var(--tia-border-soft); padding:2px 6px; vertical-align:middle; }
    table.sim-table tr:nth-child(even) td { background: var(--tia-row-alt); }
    .sim-grp td { background: var(--tia-toolbar) !important; color: var(--tia-petrol-deep);
      font-weight:700; letter-spacing:.3px; padding:3px 7px; }
    .sim-addr { font-family: var(--tia-mono); color: var(--tia-text-soft); }
    .sim-name { font-weight:500; }
    .sim-type { color: var(--tia-text-soft); }
    .sim-dot { cursor:pointer; font-size:15px; line-height:1; display:inline-flex;
      align-items:center; gap:5px; user-select:none; }
    .sim-dot .glyph { font-size:15px; }
    .sim-dot.on  .glyph { color: var(--tia-live); }
    .sim-dot.off .glyph { color: #9aa3a9; }
    .sim-dot:hover { color: var(--tia-petrol); }
    .sim-dot .lbl { font-size:11px; color: var(--tia-text-soft); }
    .sim-num { width: 90px; font-family: var(--tia-mono); padding:1px 4px;
      border:1px solid var(--tia-border); border-radius:2px; background:#fff; color:var(--tia-text); }
    .sim-num:focus { outline:none; border-color:var(--tia-petrol); box-shadow:0 0 0 2px rgba(0,153,153,.18); }
    .sim-ro { font-family: var(--tia-mono); color: var(--tia-text-soft); }
    .sim-mono { font-family: var(--tia-mono); }
    /* momentary push-button (hold to invert, release reverts) */
    .sim-momentary { display:inline-flex; align-items:center; justify-content:center;
      width:17px; height:17px; margin-left:10px; border-radius:50%; vertical-align:middle;
      border:1px solid var(--tia-border); background:linear-gradient(#fdfdfd,#dfe3e6);
      color:#8b949b; font-size:9px; cursor:pointer; box-shadow:0 1px 0 rgba(0,0,0,.18);
      user-select:none; }
    .sim-momentary:hover { border-color: var(--tia-petrol); color: var(--tia-petrol); }
    .sim-momentary.pressed { background: var(--tia-live); color:#fff; border-color:var(--tia-petrol-dark);
      box-shadow: inset 0 1px 3px rgba(0,0,0,.45); }
  `);

  let _tableHost = null;
  let _rowKeys = null;      // Set of keys currently rendered (cheap rebuild check)
  let _nodeCache = null;    // cached node lists so a tick doesn't re-query the DOM

  // Build the list of watch rows from project tags + any live mem keys in use.
  function collectRows() {
    const rows = [];                  // { name, key, type, bit:bool }
    const seen = Object.create(null);
    const add = (name, key, type, isBit) => {
      const K = String(key).toUpperCase();
      if (seen[K]) return;
      seen[K] = true;
      rows.push({ name, key: K, type, bit: isBit });
    };

    const p = T.project;
    if (p && Array.isArray(p.tags)) {
      p.tags.forEach((t) => {
        const r = T.resolve(t.address && t.address.trim() ? t.address : t.name,
          t.dataType === 'Bool' ? 'bit' : 'word');
        const isBit = t.dataType === 'Bool';
        const key = r.addr || (isBit ? '@' + (t.name || '').toUpperCase()
          : '@' + (t.name || '').toUpperCase());
        add(t.name || t.address || key, key, t.dataType || (isBit ? 'Bool' : 'Int'), isBit);
      });
    }

    // include any extra memory keys touched by the running program / forces
    Object.keys(T.mem.bits).forEach((k) => add('', k, 'Bool', true));
    Object.keys(T.mem.words).forEach((k) => add('', k, 'Word', false));
    T.mem.areaKeys().forEach((k) => add('', k, k.indexOf('.') >= 0 ? 'Bool' : 'Word', k.indexOf('.') >= 0));

    return rows;
  }

  // group rows by area for display
  function groupRows(rows) {
    const groups = [
      { title: 'Inputs (I)', test: (k) => /^I/.test(k), rows: [] },
      { title: 'Outputs (Q)', test: (k) => /^Q/.test(k), rows: [] },
      { title: 'Memory / Bits (M & symbolic)', test: (k, r) => r.bit, rows: [] },
      { title: 'Words / Analog', test: (k, r) => !r.bit, rows: [] },
    ];
    rows.forEach((r) => {
      for (let i = 0; i < groups.length; i++) {
        if (groups[i].test(r.key, r)) { groups[i].rows.push(r); return; }
      }
    });
    return groups.filter((g) => g.rows.length);
  }

  // Create the clickable bool indicator cell.
  // Route a modify/force: to the ESP32 PLC when monitoring online, else local memory.
  // `release` = a momentary button let go: on a GPIO-mapped tag that releases
  // the force, so the input follows its real pin again.
  function writeBitRow(row, v, release) {
    if (T.online && T.online.monitoring) {
      const key = row.name || row.key;
      T.online.force(key, (release && T.online.isMapped && T.online.isMapped(key)) ? null : !!v);
    }
    else { T.mem.setBit(row.key, !!v); if (!T.sim.running) T.bus.emit('sim:tick'); }
  }
  function writeWordRow(row, v) {
    if (T.online && T.online.monitoring) { T.online.force(row.name || row.key, +v || 0); }
    else { T.mem.setWord(row.key, +v || 0); if (!T.sim.running) T.bus.emit('sim:tick'); }
  }

  function boolCell(row) {
    const val = T.mem.getBit(row.key);
    const dot = T.el('span', {
      class: 'sim-dot ' + (val ? 'on' : 'off'),
      title: 'Click to toggle ' + (row.name || row.key),
      'data-bitkey': row.key,
      onclick: () => {
        const nv = !T.mem.getBit(row.key);
        writeBitRow(row, nv);
        // optimistic visual feedback
        dot.className = 'sim-dot ' + (nv ? 'on' : 'off');
        dot.querySelector('.glyph').textContent = nv ? '●' : '○';
        dot.querySelector('.lbl').textContent = nv ? 'TRUE' : 'FALSE';
      }
    },
      T.el('span', { class: 'glyph' }, val ? '●' : '○'),
      T.el('span', { class: 'lbl' }, val ? 'TRUE' : 'FALSE')
    );
    return dot;
  }

  // Momentary push-button: while held the bit is inverted; on release it reverts.
  function momentaryButton(row) {
    let prev = null;
    const btn = T.el('span', {
      class: 'sim-momentary',
      title: 'Momentary — hold to invert ' + row.key + ', release to revert',
    }, '◉');
    function release() {
      if (prev === null) return;
      writeBitRow(row, prev, true);
      prev = null;
      btn.classList.remove('pressed');
      refreshValues();
      document.removeEventListener('mouseup', release, true);
    }
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (prev !== null) return;
      prev = T.mem.getBit(row.key);
      writeBitRow(row, !prev);
      btn.classList.add('pressed');
      refreshValues();
      document.addEventListener('mouseup', release, true);   // release anywhere reverts
    });
    return btn;
  }

  // Create the editable numeric cell.
  function numCell(row) {
    const inp = T.el('input', {
      class: 'sim-num', type: 'number', value: String(T.mem.getWord(row.key)),
      'data-wordkey': row.key,
      onchange: (e) => { writeWordRow(row, +e.target.value || 0); },
      onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); }
    });
    return inp;
  }

  function renderTable(hostEl) {
    if (hostEl) _tableHost = hostEl;
    const host = _tableHost;
    if (!host) return;
    T.clear(host);

    if (!T.project) {
      host.appendChild(T.el('div', { class: 'sim-empty' },
        'No project loaded. Open or create a project to use the simulation table.'));
      return;
    }

    const rows = collectRows();
    _rowKeys = new Set(rows.map((r) => r.key));
    _nodeCache = null;                    // rebuilt lazily on the next tick
    const wrap = T.el('div', { class: 'sim-wrap' });

    if (!rows.length) {
      wrap.appendChild(T.el('div', { class: 'sim-empty' },
        'No tags yet. Add PLC tags or run the simulation to populate addresses.'));
      host.appendChild(wrap);
      return;
    }

    const table = T.el('table', { class: 'sim-table' });
    table.appendChild(T.el('thead', {}, T.el('tr', {},
      T.el('th', {}, 'Name'),
      T.el('th', {}, 'Address / Key'),
      T.el('th', {}, 'Data type'),
      T.el('th', {}, 'Monitor value'),
      T.el('th', {}, 'Modify')
    )));
    const tbody = T.el('tbody', {});

    groupRows(rows).forEach((grp) => {
      tbody.appendChild(T.el('tr', { class: 'sim-grp' },
        T.el('td', { colspan: '5' }, grp.title)));
      grp.rows.forEach((r) => {
        const monitorCell = T.el('td', {});
        const modifyCell = T.el('td', {});
        if (r.bit) {
          // read-only monitor mirror + interactive toggle in the Modify column
          monitorCell.appendChild(T.el('span', { class: 'sim-ro', 'data-monbit': r.key },
            T.mem.getBit(r.key) ? 'TRUE' : 'FALSE'));
          modifyCell.appendChild(boolCell(r));            // latching toggle
          modifyCell.appendChild(momentaryButton(r));     // momentary push-button
        } else {
          monitorCell.appendChild(T.el('span', { class: 'sim-ro', 'data-monword': r.key },
            String(T.mem.getWord(r.key))));
          modifyCell.appendChild(numCell(r));
        }
        tbody.appendChild(T.el('tr', { 'data-row': r.name || r.key },   // online.js marks forced rows
          T.el('td', { class: 'sim-name' }, r.name || ''),
          T.el('td', { class: 'sim-addr' }, r.key),
          T.el('td', { class: 'sim-type' }, r.type),
          monitorCell,
          modifyCell
        ));
      });
    });

    table.appendChild(tbody);
    wrap.appendChild(table);
    host.appendChild(wrap);
  }

  // Lightweight in-place value update on each tick (keeps editing focus intact).
  // Node lists are cached per render — at 20 ms scans, re-querying the DOM four
  // times per tick dominated the tick cost with a few hundred rows.
  function refreshValues() {
    const host = _tableHost;
    if (!host) return;
    if (!_nodeCache) {
      _nodeCache = {
        monbit: T.$$('[data-monbit]', host),
        bitkey: T.$$('[data-bitkey]', host),
        monword: T.$$('[data-monword]', host),
        wordkey: T.$$('[data-wordkey]', host),
      };
    }
    _nodeCache.monbit.forEach((sp) => {
      sp.textContent = T.mem.getBit(sp.getAttribute('data-monbit')) ? 'TRUE' : 'FALSE';
    });
    _nodeCache.bitkey.forEach((dot) => {
      const v = T.mem.getBit(dot.getAttribute('data-bitkey'));
      dot.className = 'sim-dot ' + (v ? 'on' : 'off');
      const g = dot.querySelector('.glyph'); if (g) g.textContent = v ? '●' : '○';
      const l = dot.querySelector('.lbl'); if (l) l.textContent = v ? 'TRUE' : 'FALSE';
    });
    _nodeCache.monword.forEach((sp) => {
      sp.textContent = String(T.mem.getWord(sp.getAttribute('data-monword')));
    });
    _nodeCache.wordkey.forEach((inp) => {
      if (document.activeElement === inp) return;   // skip the one being edited
      const v = String(T.mem.getWord(inp.getAttribute('data-wordkey')));
      if (inp.value !== v) inp.value = v;
    });
  }

  // Decide whether a structural re-render is needed: a memory key appeared that
  // has no row yet. Mem keys only ever accumulate mid-run; tag edits re-render
  // via tags:changed, so comparing against the rendered-key set is sufficient.
  function needsRebuild() {
    if (!_tableHost) return false;
    if (!_rowKeys) return true;
    for (const k in T.mem.bits) if (!_rowKeys.has(k)) return true;
    for (const k in T.mem.words) if (!_rowKeys.has(k)) return true;
    const ak = T.mem.areaKeys();
    for (let i = 0; i < ak.length; i++) if (!_rowKeys.has(ak[i])) return true;
    return false;
  }

  /* ----- structural caches invalidate on any model change ---------------- */
  ['tree:changed', 'project:loaded', 'iface:changed'].forEach((ev) =>
    T.bus.on(ev, () => { _calledCache = null; _netCache.clear(); }));

  /* ----- table reacts to sim ticks and model changes -------------------- */
  T.bus.on('sim:tick', () => {
    if (!_tableHost) return;
    if (needsRebuild()) renderTable();   // new memory keys appeared mid-run
    else refreshValues();
  });
  T.bus.on('tags:changed', () => { if (_tableHost) renderTable(); });
  T.bus.on('project:loaded', () => { if (_tableHost) renderTable(); });

  console.log('[TIA] sim loaded.');
})(window.TIA);
