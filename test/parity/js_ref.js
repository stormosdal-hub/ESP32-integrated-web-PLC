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
  return { mem, live, power, pins };
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
