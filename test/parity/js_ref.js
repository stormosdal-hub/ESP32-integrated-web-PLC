/* Reference run: execute a parity case with the IDE's JS simulator.
 *   node js_ref.js <case.json>   ->  {"steps":[{mem,live,power,pins}, ...]} on stdout
 * Each step: optional clock jump (t), one-shot writes (set), then `scans`
 * scan cycles with the clock advancing `dt` ms after each one. */
'use strict';
const fs = require('fs');
const path = require('path');
const { load } = require('./tia_node');

const { T, clock } = load(path.resolve(__dirname, '../../web'));
const kase = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const project = kase.project;

T.setProject(project);
T.mem.reset();
T.sim.reset();
// the same deterministic wall clock as plc_cli.c (RD_SYS_T / RD_LOC_T)
T.sim.wallMs = (local) => 1700000000000 + clock.now + (local ? 3600000 : 0);
const hex = (buf) => Array.from(buf, (x) => (x < 16 ? '0' : '') + x.toString(16)).join('');

function record() {
  const mem = {};
  for (const t of project.tags) {
    if (!t.name) continue;
    mem[t.name] = t.dataType === 'Bool' ? T.readBit(t.name) : T.readNum(t.name);
  }
  const live = {}, power = {}, pins = {};
  for (const b of project.blocks) {
    for (const n of (b.networks || [])) {
      if (!n) continue;
      if (n._power !== undefined) power[n.id] = !!n._power;
      for (const s of n.stages || []) for (const br of s.branches || []) {
        for (const e of br.elements || []) if (e._live !== undefined) live[e.id] = !!e._live;
      }
      for (const e of n.outputs || []) if (e._live !== undefined) live[e.id] = !!e._live;
      for (const bx of n.boxes || []) {
        if (bx._live !== undefined) live[bx.id] = !!bx._live;
        for (const p of (bx.inputs || []).concat(bx.outputs || [])) if (p._val !== undefined) pins[p.id] = !!p._val;
      }
    }
  }
  // every data block, byte for byte (types.js layout = plc_types.c layout)
  const dbs = {};
  for (const b of project.blocks) {
    if (b.type !== 'DB' || !b.name) continue;
    try { dbs[b.name] = hex(T.inst.db(b).buf); } catch (e) { /* type error: the C engine has no memory either */ }
  }
  return { mem, live, power, pins, dbs, conns: T.ouc.list() };
}

const out = { steps: [] };
for (const st of kase.steps) {
  if (typeof st.t === 'number') clock.now = st.t;
  const dt = typeof st.dt === 'number' ? st.dt : 10;
  for (const k of Object.keys(st.set || {})) {
    const v = st.set[k];
    if (typeof v === 'boolean') T.writeBit(k, v); else T.writeNum(k, v);
  }
  const n = st.scans == null ? 1 : st.scans;
  for (let i = 0; i < n; i++) { T.sim.scanOnce(); clock.now += dt; }
  out.steps.push(record());
}
process.stdout.write(JSON.stringify(out));
