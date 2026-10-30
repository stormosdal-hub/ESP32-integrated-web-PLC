/* ============================================================================
 * sysfb.js — system function blocks called from SCL: IEC timers (TON / TOF /
 * TP, *_TIME, IEC_TIMER), R_TRIG / F_TRIG, counters (CTU / CTD / CTUD and the
 * typed variants) and Open User Communication (TCON, TDISCON, TSEND, TRCV).
 *
 * Instance layouts are declared in types.js (T.types.SYSFB); here is the
 * behaviour. T.sysfb.exec(def, buf, base, refs) runs one call on the
 * instance at buf[base..], refs = the reference parameters of this call
 * (CONNECT, DATA) as {buf, off, bit, t} or {cell, bit, t}.
 *
 * OUC in the simulator: a VIRTUAL NETWORK inside the PLC (T.ouc) — an active
 * TCON reaches a passive TCON of the same program listening on its
 * RemotePort (any remote address). The ESP32 firmware and the PC emulator
 * use real TCP instead (plc_net_t); STATUS codes are the S7 ones:
 *   7000 idle  7001 job started  7002 job running  0000 done
 *   80A1 connection not established / broken   80A3 ID in use / unknown
 *   80A4 bad remote IP   80A7 TCON aborted by TDISCON   80B3 local port in use
 *   80B6 bad CONNECT / connection type   80B7 port 0   80C3 no free connection
 *   80C4 temporary error (receive buffer of the partner full)
 *   8086 ID out of range   8088 LEN larger than DATA (or 0 / > 8192)
 * components/plc_core/plc_sysfb.c is the C port.
 * ==========================================================================*/
(function (T) {
  'use strict';

  const TY = T.types;
  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());

  // instance field access by name
  function F(def, name) { return def.t.map[name.toLowerCase()]; }
  function rd(def, buf, base, name) { const f = F(def, name); return TY.read(buf, base + f.off, f.bit, f.t); }
  function wr(def, buf, base, name, v) { const f = F(def, name); TY.write(buf, base + f.off, f.bit, f.t, TY.conv(v, f.t)); }

  /* ------------------------------------------------------------ timers
   * same behaviour as the LAD/FBD timers in sim.js (evalTON/TOF/TP) */
  function timer(kind, def, buf, base) {
    const g = (n) => rd(def, buf, base, n), s = (n, v) => wr(def, buf, base, n, v);
    const inp = g('IN');
    const pt = Math.max(0, g('PT'));
    let run = g('_run'), t0 = g('_t0');
    const prev = g('_prev');
    const t = now();
    let q = false, elapsed = 0, et;
    if (kind === 'ton') {
      if (inp) { if (!run) { run = true; t0 = t; } elapsed = t - t0; }
      else { run = false; elapsed = 0; }
      q = run && elapsed >= pt;
      et = Math.round(Math.min(elapsed, pt));
    } else if (kind === 'tof') {
      if (inp) { run = false; q = true; elapsed = 0; }
      else {
        if (prev) { run = true; t0 = t; }
        if (run) {
          elapsed = t - t0;
          if (elapsed >= pt) { q = false; elapsed = pt; } else q = true;
        } else q = false;
      }
      et = Math.round(elapsed);
    } else {                                           // tp
      if (inp && !prev && !run) { run = true; t0 = t; }
      if (run) {
        elapsed = t - t0;
        if (elapsed < pt) q = true;
        else { q = false; elapsed = pt; if (!inp) run = false; }
      }
      et = Math.round(Math.min(elapsed, pt));
    }
    s('_run', run); s('_t0', t0); s('_prev', inp); s('Q', q); s('ET', et);
  }

  /* ---------------------------------------------------------- counters */
  function limits(t) {
    const m = Math.pow(2, t.bits);
    return t.signed ? [-m / 2, m / 2 - 1] : [0, m - 1];
  }
  function counter(def, buf, base) {
    const g = (n) => rd(def, buf, base, n), s = (n, v) => wr(def, buf, base, n, v);
    const [mn, mx] = limits(def.cv);
    let cv = g('CV');
    const pv = g('PV');
    if (def.kind === 'ctu') {
      const cu = g('CU');
      if (g('R')) cv = 0;
      else if (cu && !g('_prev') && cv < mx) cv++;
      s('_prev', cu); s('CV', cv); s('Q', cv >= pv);
    } else if (def.kind === 'ctd') {
      const cd = g('CD');
      if (g('LD')) cv = pv;
      else if (cd && !g('_prev') && cv > mn) cv--;
      s('_prev', cd); s('CV', cv); s('Q', cv <= 0);
    } else {
      const cu = g('CU'), cd = g('CD');
      const eu = cu && !g('_pu'), ed = cd && !g('_pd');
      if (g('R')) cv = 0;
      else if (g('LD')) cv = pv;
      else if (eu && !ed) { if (cv < mx) cv++; }
      else if (ed && !eu) { if (cv > mn) cv--; }
      s('_pu', cu); s('_pd', cd); s('CV', cv); s('QU', cv >= pv); s('QD', cv <= 0);
    }
  }

  /* ================================================ virtual OUC network */
  const MAX_CONNS = 8, RX_CAP = 16384, MAX_SEND = 8192;
  const CONNECTING = 0, CONNECTED = 1, CLOSED = 2;
  const ouc = {
    conns: new Map(),               // ID -> { id, active, lport, rport, rip, state, peer, rx }
    reset() {
      this.conns.forEach((c) => { c.peer = null; c.rx = []; });
      this.conns = new Map();
    },
    list() {
      const out = [];
      this.conns.forEach((c) => out.push({
        id: c.id, state: ['connecting', 'connected', 'closed'][c.state], active: c.active,
        localPort: c.lport, remoteAddress: c.rip.join('.'), remotePort: c.rport,
      }));
      return out.sort((a, b) => a.id - b.id);
    },
  };
  T.ouc = ouc;

  function closeConn(c) {
    if (c.peer) { c.peer.state = CLOSED; c.peer.peer = null; }
    c.peer = null;
    ouc.conns.delete(c.id);
  }
  // an active connection meets a passive one listening on its remote port
  function tryPair(c) {
    if (!c.active || c.state !== CONNECTING) return;
    ouc.conns.forEach((l) => {
      if (c.state !== CONNECTING || l === c || l.active || l.state !== CONNECTING || l.lport !== c.rport) return;
      c.state = l.state = CONNECTED;
      c.peer = l; l.peer = c;
    });
  }

  /* ---- reference parameters ---- */
  function refSize(r) {
    if (!r || !r.t) return -1;
    if (r.t.k === 'el') return r.t.cls === 'bool' ? 1 : (r.t.cls === 'num' ? 8 : r.t.size);
    return r.t.size;
  }
  function cellType(r) { return r.t.cls === 'num' ? TY.EL.LREAL : r.t; }
  function refBytes(r, len) {
    if (r.cell != null) {
      const t = cellType(r);
      const tmp = new Uint8Array(Math.max(1, refSize(r)));
      const v = r.bit ? T.mem.getBit(r.cell) : T.mem.getWord(r.cell);
      if (t.cls === 'bool') tmp[0] = v ? 1 : 0;
      else TY.write(tmp, 0, 0, t, TY.conv(v, t));
      return tmp.slice(0, len);
    }
    if (r.t.k === 'el' && r.t.cls === 'bool') return Uint8Array.of((r.buf[r.off] >> r.bit) & 1).slice(0, len);
    return r.buf.slice(r.off, r.off + len);
  }
  function refWrite(r, bytes) {
    if (r.cell != null) {
      const t = cellType(r);
      const tmp = new Uint8Array(Math.max(1, refSize(r)));
      tmp.set(bytes.slice(0, tmp.length));
      if (t.cls === 'bool') T.mem.setBit(r.cell, !!(tmp[0] & 1));
      else T.mem.setWord(r.cell, TY.read(tmp, 0, 0, t));
      return;
    }
    if (r.t.k === 'el' && r.t.cls === 'bool') {
      if (bytes[0] & 1) r.buf[r.off] |= (1 << r.bit); else r.buf[r.off] &= ~(1 << r.bit) & 0xFF;
      return;
    }
    r.buf.set(bytes, r.off);
  }

  /* ---- TCON ---- */
  function tcon(def, buf, base, refs) {
    const g = (n) => rd(def, buf, base, n), s = (n, v) => wr(def, buf, base, n, v);
    const req = g('REQ'), id = g('ID');
    const edge = req && !g('_prev');
    s('_prev', req); s('DONE', false); s('ERROR', false);
    const fail = (st) => { s('ERROR', true); s('BUSY', false); s('STATUS', st); };
    if (g('_job')) {
      const c = ouc.conns.get(id);
      if (!c) { s('_job', false); fail(0x80A7); return; }
      tryPair(c);
      if (c.state !== CONNECTING) { s('_job', false); s('BUSY', false); s('DONE', true); s('STATUS', 0); }
      else { s('BUSY', true); s('STATUS', 0x7002); }
      return;
    }
    if (!edge) { s('BUSY', false); s('STATUS', 0x7000); return; }
    if (id < 1 || id > 4095) { fail(0x8086); return; }
    const r = refs.CONNECT || refs.connect;
    if (!r || r.cell != null || !r.t || r.t.k === 'el' || r.t.size < 14) { fail(0x80B6); return; }
    const cb = r.buf, co = r.off;
    const cid = (cb[co + 2] << 8) | cb[co + 3];
    const type = cb[co + 4];
    const active = !!(cb[co + 5] & 1);
    const rip = [cb[co + 6], cb[co + 7], cb[co + 8], cb[co + 9]];
    const rport = (cb[co + 10] << 8) | cb[co + 11];
    const lport = (cb[co + 12] << 8) | cb[co + 13];
    if (cid !== id || type !== 11) { fail(0x80B6); return; }
    if (ouc.conns.has(id)) { fail(0x80A3); return; }
    if (ouc.conns.size >= MAX_CONNS) { fail(0x80C3); return; }
    if ((!active && lport === 0) || (active && rport === 0)) { fail(0x80B7); return; }
    const ipAll = rip.every((x) => x === 0) || rip.every((x) => x === 255);
    if (active && ipAll) { fail(0x80A4); return; }
    let used = false;
    ouc.conns.forEach((o) => { if (!o.active && !active && o.lport === lport) used = true; });
    if (used) { fail(0x80B3); return; }
    const c = { id, active, lport, rport, rip, state: CONNECTING, peer: null, rx: [] };
    ouc.conns.set(id, c);
    tryPair(c);
    s('_job', true); s('BUSY', true); s('STATUS', 0x7001);
  }

  /* ---- TDISCON ---- */
  function tdiscon(def, buf, base) {
    const g = (n) => rd(def, buf, base, n), s = (n, v) => wr(def, buf, base, n, v);
    const req = g('REQ');
    const edge = req && !g('_prev');
    s('_prev', req); s('DONE', false); s('ERROR', false); s('BUSY', false);
    if (!edge) { s('STATUS', 0x7000); return; }
    const c = ouc.conns.get(g('ID'));
    if (!c) { s('ERROR', true); s('STATUS', 0x80A3); return; }
    closeConn(c);
    s('DONE', true); s('STATUS', 0);
  }

  /* ---- TSEND ---- */
  function tsend(def, buf, base, refs) {
    const g = (n) => rd(def, buf, base, n), s = (n, v) => wr(def, buf, base, n, v);
    const req = g('REQ');
    const edge = req && !g('_prev');
    s('_prev', req); s('DONE', false); s('ERROR', false);
    const fail = (st) => { s('ERROR', true); s('BUSY', false); s('STATUS', st); };
    const c = ouc.conns.get(g('ID'));
    if (g('_job')) {
      s('_job', false);
      if (!c || c.state !== CONNECTED) { fail(0x80A1); return; }
      s('BUSY', false); s('DONE', true); s('STATUS', 0);
      return;
    }
    if (!edge) { s('BUSY', false); s('STATUS', 0x7000); return; }
    if (!c || c.state !== CONNECTED) { fail(0x80A1); return; }
    const r = refs.DATA || refs.data;
    const size = refSize(r);
    const len = g('LEN') === 0 ? size : g('LEN');
    if (size <= 0 || len <= 0 || len > size || len > MAX_SEND) { fail(0x8088); return; }
    const peer = c.peer;
    if (!peer) { fail(0x80A1); return; }
    if (peer.rx.length + len > RX_CAP) { fail(0x80C4); return; }
    const bytes = refBytes(r, len);
    for (let i = 0; i < bytes.length; i++) peer.rx.push(bytes[i]);
    s('_job', true); s('BUSY', true); s('STATUS', 0x7001);
  }

  /* ---- TRCV ---- */
  function trcv(def, buf, base, refs) {
    const g = (n) => rd(def, buf, base, n), s = (n, v) => wr(def, buf, base, n, v);
    s('NDR', false); s('ERROR', false); s('RCVD_LEN', 0);
    const fail = (st) => { s('ERROR', true); s('BUSY', false); s('STATUS', st); s('_busy', false); };
    if (!g('EN_R')) { s('BUSY', false); s('STATUS', 0x7000); s('_busy', false); return; }
    const c = ouc.conns.get(g('ID'));
    if (!c || c.state === CONNECTING) { fail(0x80A1); return; }
    const r = refs.DATA || refs.data;
    const size = refSize(r);
    const want = g('LEN') === 0 ? size : g('LEN');
    if (size <= 0 || want > size) { fail(0x8088); return; }
    const avail = c.rx.length;
    let n = 0;
    if (g('ADHOC')) n = Math.min(avail, size);
    else if (avail >= want) n = want;
    if (n > 0) {
      refWrite(r, Uint8Array.from(c.rx.splice(0, n)));
      s('NDR', true); s('RCVD_LEN', n); s('BUSY', false); s('STATUS', 0); s('_busy', false);
      return;
    }
    if (c.state === CLOSED) { fail(0x80A1); return; }
    s('BUSY', true); s('STATUS', g('_busy') ? 0x7002 : 0x7001); s('_busy', true);
  }

  T.sysfb = {
    exec(def, buf, base, refs) {
      switch (def.kind) {
        case 'ton': case 'tof': case 'tp': timer(def.kind, def, buf, base); break;
        case 'iec_timer': timer('ton', def, buf, base); break;
        case 'r_trig': { const clk = rd(def, buf, base, 'CLK'); wr(def, buf, base, 'Q', clk && !rd(def, buf, base, '_prev')); wr(def, buf, base, '_prev', clk); break; }
        case 'f_trig': { const clk = rd(def, buf, base, 'CLK'); wr(def, buf, base, 'Q', !clk && rd(def, buf, base, '_prev')); wr(def, buf, base, '_prev', clk); break; }
        case 'ctu': case 'ctd': case 'ctud': counter(def, buf, base); break;
        case 'tcon': tcon(def, buf, base, refs || {}); break;
        case 'tdiscon': tdiscon(def, buf, base); break;
        case 'tsend': tsend(def, buf, base, refs || {}); break;
        case 'trcv': trcv(def, buf, base, refs || {}); break;
      }
    },
  };
})(window.TIA);
