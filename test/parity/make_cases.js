/* Generate parity cases (test/parity/cases/*.json) with the IDE's own model
 * factories, so the projects have exactly the shapes the editors produce.
 *   node make_cases.js
 * A case = { name, project, steps:[{t?, dt?, set?, scans?}] }. */
'use strict';
const fs = require('fs');
const path = require('path');
const { load } = require('./tia_node');

const { T } = load(path.resolve(__dirname, '../../web'));
const M = T.model;
const outDir = path.join(__dirname, 'cases');
fs.mkdirSync(outDir, { recursive: true });

/* ------------------------------------------------------------ helpers */
function project(name) { const p = M.newProject(name); p.blocks = []; return p; }
function tag(p, n, dt, addr) { p.tags.push(M.newTag(n, dt, addr || '', '')); }
function el(kind, operand, params, args) {
  const e = M.newElement(kind, operand || '');
  if (params) e.params = Object.assign(e.params || {}, params);
  if (args) e.args = args;
  return e;
}
function stage(...branches) {
  return { id: T.uid('stg'), branches: branches.map((els) => ({ id: T.uid('br'), elements: els })) };
}
function lad(title, stages, outputs) {
  const n = M.newNetwork(title); n.stages = stages; n.outputs = outputs; return n;
}
function block(p, type, name, number, lang) {
  const b = M.newBlock(type, name, number, lang); b.networks = []; p.blocks.push(b); return b;
}
function box(kind, params, ops) {
  const b = M.newBox(kind, 10, 10);
  if (params) b.params = Object.assign(b.params || {}, params);
  (ops || []).forEach((o, i) => { if (o != null && b.inputs[i]) b.inputs[i].operand = o; });
  return b;
}
function addIn(b, name, operand) {
  const pin = { id: T.uid('pin'), name, inverted: false, operand: operand || '' };
  b.inputs.push(pin); return pin;
}
function wire(n, a, ai, b, bi) { n.wires.push(M.newWire(a.id, a.outputs[ai].id, b.id, b.inputs[bi].id)); }
function fbdNet(title, boxes) { const n = M.newNetwork(title); n.boxes = boxes; return n; }
function instDb(p, fb, name) {
  const db = { id: T.uid('blk'), type: 'DB', name, number: p.blocks.filter((b) => b.type === 'DB').length + 1,
    lang: 'DB', comment: '', instanceOf: fb.id, networks: [] };
  p.blocks.push(db); return db;
}
function callBox(target, db) {
  const b = M.newBox('call', 10, 10);
  b.params = { target: target.id };
  if (db) b.params.instanceDb = db.id;
  b.inputs = [{ id: T.uid('pin'), name: 'EN', inverted: false, operand: '' }]
    .concat(T.ifaceCallInputs(target).map((m) => ({ id: T.uid('pin'), name: m.name, inverted: false, operand: '' })));
  b.outputs = [{ id: T.uid('pin'), name: 'ENO' }]
    .concat(T.ifaceCallOutputs(target).map((m) => ({ id: T.uid('pin'), name: m.name })));
  return b;
}
function save(name, p, steps) {
  const kase = { name, project: JSON.parse(JSON.stringify(p)), steps };
  fs.writeFileSync(path.join(outDir, name + '.json'), JSON.stringify(kase, null, 1));
}
const pulse = (k, extra) => [{ set: Object.assign({ [k]: true }, extra || {}) }, { set: { [k]: false } }];

/* ------------------------------------------------- 1. the demo project */
(function demo() {
  const p = project('Conveyor_Demo');
  tag(p, 'Start_PB', 'Bool', 'I0.0'); tag(p, 'Stop_PB', 'Bool', 'I0.1'); tag(p, 'Part_Sensor', 'Bool', 'I0.2');
  tag(p, 'Motor', 'Bool', 'Q0.0'); tag(p, 'Run_Lamp', 'Bool', 'Q0.1'); tag(p, 'Count_Done', 'Bool', 'M0.0');
  tag(p, 'AND_Out', 'Bool', 'M0.2'); tag(p, 'Part_Count', 'Int', 'MW10'); tag(p, 'Conveyor_PWM', 'Real', 'MD20');
  const ob1 = block(p, 'OB', 'Main', 1, 'LAD');
  const fb1 = block(p, 'FB', 'Logic', 1, 'FBD');
  fb1.iface.input.push(M.newMember('In1', 'Bool', '', ''), M.newMember('In2', 'Bool', '', ''));
  fb1.iface.output.push(M.newMember('Out', 'Bool', '', ''));
  fb1.iface.static.push(M.newMember('runs', 'Int', '0', ''));
  const bAnd = box('fb_and', null, ['In1', 'In2']);
  const bAs = box('assign'); bAs.operand = 'Out';
  const fn = fbdNet('Out := In1 AND In2', [bAnd, bAs]); wire(fn, bAnd, 0, bAs, 0);
  fb1.networks = [fn];
  const db1 = instDb(p, fb1, 'Logic_DB');
  const ton = el('ton', '', { pt: 'T#3s', q: 'Run_Lamp' });
  const ctu = el('ctu', '', { pv: '5', cv: 'Part_Count', q: '' });
  const cmp = el('compare', '', { op: '>=', in1: 'Part_Count', in2: '5' });
  const norm = el('norm_x', '', { min: '0', val: 'Part_Count', max: '5', out: 'Conveyor_PWM' });
  const call = el('call', '', { target: fb1.id, instanceDb: db1.id }, { In1: 'Start_PB', In2: 'Part_Sensor', Out: 'AND_Out' });
  ob1.networks = [
    lad('seal-in', [stage([el('contact_no', 'Start_PB')], [el('contact_no', 'Motor')]), stage([el('contact_nc', 'Stop_PB')])],
      [el('coil', 'Motor')]),
    lad('lamp', [stage([el('contact_no', 'Motor')])], [ton]),
    lad('count', [stage([el('contact_no', 'Part_Sensor')])], [ctu]),
    lad('done', [stage([cmp])], [el('coil', 'Count_Done')]),
    lad('pwm', [], [norm]),
    lad('call', [], [call]),
  ];
  // an I/O map with shift-register chains: must not change any value, and gives
  // the fuzzer chain settings to corrupt
  p.shiftRegs = [{ id: 'SR1', type: '595', chips: 2, data: 4, clock: 5, latch: 6, enable: null },
    { id: 'SR2', type: '165', chips: 1, data: 7, clock: 8, latch: 9, enable: 10 }];
  p.i2c = { sda: 1, scl: 2, khz: 400, devices: [{ id: 'PCF1', type: 'pcf8574', addr: 0x20 },
    { id: 'MCP1', type: 'mcp23017', addr: 0x21 }, { id: 'ADS1', type: 'ads1115', addr: 0x48 }] };
  p.gpio = [{ tag: 'Start_PB', dir: 'in', sr: 'SR2', bit: 0, activeLow: true, debounce: 20 },
    { tag: 'Motor', dir: 'out', sr: 'SR1', bit: 9 }, { tag: 'Run_Lamp', dir: 'out', pin: 15 },
    { tag: 'Stop_PB', dir: 'in', i2c: 'PCF1', bit: 3, activeLow: true }, { tag: 'Count_Done', dir: 'out', i2c: 'MCP1', bit: 12 },
    { tag: 'Part_Count', dir: 'ain', i2c: 'ADS1', bit: 2, range: 2048, mode: 'raw' }];
  const steps = [{ t: 0, scans: 2 }, { set: { Start_PB: true }, scans: 1 }, { set: { Start_PB: false }, scans: 3 },
    { dt: 500, scans: 5 }, { dt: 500, scans: 2 }];
  for (let i = 0; i < 6; i++) steps.push({ set: { Part_Sensor: true }, scans: 1 }, { set: { Part_Sensor: false }, scans: 1 });
  steps.push({ set: { Start_PB: true, Part_Sensor: true }, scans: 1 }, { set: { Stop_PB: true }, scans: 2 },
    { set: { Stop_PB: false, Start_PB: false }, dt: 1000, scans: 4 });
  save('demo', p, steps);
})();

/* ------------------------------------------------- 2. LAD bit logic */
(function ladBits() {
  const p = project('LadBits');
  ['A', 'B', 'C'].forEach((n, i) => tag(p, n, 'Bool', 'I0.' + i));
  for (let i = 0; i < 14; i++) tag(p, 'Q' + i, 'Bool', 'Q' + (i >> 3) + '.' + (i & 7));
  tag(p, 'Latch', 'Bool', 'M0.0'); tag(p, 'SRQ', 'Bool', 'M0.1'); tag(p, 'RSQ', 'Bool', 'M0.2');
  tag(p, 'PT_Q', 'Bool', 'M0.3'); tag(p, 'NT_Q', 'Bool', 'M0.4'); tag(p, 'RT_Q', 'Bool', 'M0.5'); tag(p, 'FT_Q', 'Bool', 'M0.6');
  tag(p, 'SymBit', 'Bool'); tag(p, 'Num', 'Int', 'MW10'); tag(p, 'SymNum', 'Int');
  const ob = block(p, 'OB', 'Main', 1, 'LAD');
  ob.networks = [
    lad('and-not', [stage([el('contact_no', 'A'), el('contact_nc', 'B')])], [el('coil', 'Q0')]),
    lad('or-and', [stage([el('contact_no', 'A')], [el('contact_no', 'B')]), stage([el('contact_no', 'C')])],
      [el('coil', 'Q1'), el('coil_neg', 'Q2')]),
    lad('set on rising A', [stage([el('edge_p', 'A')])], [el('coil_set', 'Latch')]),
    lad('reset on falling B', [stage([el('edge_n', 'B')])], [el('coil_reset', 'Latch')]),
    lad('SR', [stage([el('contact_no', 'A')])], [el('sr', 'SRQ', { r: 'B' })]),
    lad('RS', [stage([el('contact_no', 'A')])], [el('rs', 'RSQ', { s: 'B' })]),
    lad('trig', [stage([el('contact_no', 'C')])], [el('p_trig', '', { q: 'PT_Q' }), el('n_trig', '', { q: 'NT_Q' })]),
    lad('trig2', [stage([el('contact_no', 'A')])], [el('r_trig', '', { q: 'RT_Q' }), el('f_trig', '', { q: 'FT_Q' })]),
    lad('open arm', [stage([el('contact_no', 'A')], [])], [el('coil', 'Q3')]),
    lad('bare wire stage', [stage([])], [el('coil', 'Q4')]),
    lad('no stages', [], [el('coil', 'Q5'), el('coil', 'SymBit')]),
    lad('word as contact', [stage([el('contact_no', 'Num')])], [el('coil', 'Q6')]),
    lad('compare', [stage([el('compare', '', { op: '>=', in1: 'Num', in2: '3' })])], [el('coil', 'Q7')]),
    lad('sym', [stage([el('contact_no', 'SymBit'), el('contact_no', 'C')])], [el('coil', 'Q8')]),
    lad('cmp <>', [stage([el('compare', '', { op: '<>', in1: 'SymNum', in2: '0' })])], [el('coil', 'Q9')]),
    lad('address operand', [stage([el('contact_no', '%I0.2')])], [el('coil', 'Q1.2')]),
    lad('lowercase tag', [stage([el('contact_no', 'a')])], [el('coil', 'q11')]),
  ];
  const steps = [{ t: 0, scans: 1 }].concat(pulse('A'), pulse('B'), [{ set: { A: true, B: true }, scans: 1 },
    { set: { B: false }, scans: 1 }, { set: { A: false }, scans: 1 }], pulse('C'), [{ set: { C: true }, scans: 3 },
    { set: { Num: 2 }, scans: 1 }, { set: { Num: 5 }, scans: 1 }, { set: { SymNum: 7 }, scans: 1 },
    { set: { A: true, C: true }, scans: 2 }, { set: { A: false }, scans: 2 }]);
  save('lad_bits', p, steps);
})();

/* ------------------------------------------------- 3. timers */
(function timers() {
  const p = project('Timers');
  tag(p, 'Start', 'Bool', 'I0.0'); tag(p, 'Go2', 'Bool', 'I0.1');
  tag(p, 'TON_Q', 'Bool', 'M0.0'); tag(p, 'TON_ET', 'Time', 'MD10');
  tag(p, 'TOF_Q', 'Bool', 'M0.1'); tag(p, 'TOF_ET', 'Int', 'MW20');
  tag(p, 'TP_Q', 'Bool', 'M0.2'); tag(p, 'TP_ET', 'Time');
  tag(p, 'PT_Tag', 'Time', 'MD30'); tag(p, 'TON2_Q', 'Bool', 'M0.3'); tag(p, 'TON2_ET', 'Time', 'MD34');
  const ob = block(p, 'OB', 'Main', 1, 'LAD');
  ob.networks = [
    lad('preset', [], [el('move', '', { in: '750', out: 'PT_Tag' })]),
    lad('TON', [stage([el('contact_no', 'Start')])], [el('ton', '', { pt: 'T#500ms', q: 'TON_Q', et: 'TON_ET' })]),
    lad('TOF', [stage([el('contact_no', 'Start')])], [el('tof', '', { pt: '300', q: 'TOF_Q', et: 'TOF_ET' })]),
    lad('TP', [stage([el('contact_no', 'Start')])], [el('tp', '', { pt: 'T#1s', q: 'TP_Q', et: 'TP_ET' })]),
    lad('TON tag preset', [stage([el('contact_no', 'Go2')])], [el('ton', '', { pt: 'PT_Tag', q: 'TON2_Q', et: 'TON2_ET' })]),
  ];
  const steps = [{ t: 0, scans: 1 }, { set: { Start: true }, dt: 100, scans: 3 }, { dt: 100, scans: 3 },
    { set: { Start: false }, dt: 100, scans: 2 }, { set: { Start: true }, dt: 50, scans: 2 },
    { set: { Start: false }, dt: 100, scans: 5 }, { set: { Go2: true }, dt: 125, scans: 5 }, { dt: 125, scans: 3 },
    { set: { Go2: false, Start: true }, dt: 333, scans: 4 }, { set: { Start: false }, dt: 77, scans: 9 }];
  save('timers', p, steps);
})();

/* ------------------------------------------------- 4. counters */
(function counters() {
  const p = project('Counters');
  tag(p, 'CU', 'Bool', 'I0.0'); tag(p, 'CD', 'Bool', 'I0.1'); tag(p, 'R', 'Bool', 'I0.2'); tag(p, 'LD', 'Bool', 'I0.3');
  tag(p, 'CTU_Q', 'Bool', 'M0.0'); tag(p, 'CTU_CV', 'Int', 'MW10');
  tag(p, 'CTD_Q', 'Bool', 'M0.1'); tag(p, 'CTD_CV', 'Int', 'MW12');
  tag(p, 'QU', 'Bool', 'M0.2'); tag(p, 'QD', 'Bool', 'M0.3'); tag(p, 'CTUD_CV', 'Int', 'MW14');
  const ob = block(p, 'OB', 'Main', 1, 'LAD');
  ob.networks = [
    lad('CTU', [stage([el('contact_no', 'CU')])], [el('ctu', '', { pv: '3', r: 'R', cv: 'CTU_CV', q: 'CTU_Q' })]),
    lad('CTD', [stage([el('contact_no', 'CD')])], [el('ctd', '', { pv: '2', r: 'LD', cv: 'CTD_CV', q: 'CTD_Q' })]),
    lad('CTUD', [stage([el('contact_no', 'CU')])],
      [el('ctud', '', { pv: '2', cd: 'CD', r: 'R', ld: 'LD', cv: 'CTUD_CV', qu: 'QU', qd: 'QD' })]),
  ];
  let steps = [{ t: 0, scans: 1 }];
  for (let i = 0; i < 4; i++) steps = steps.concat(pulse('CU'));
  steps = steps.concat(pulse('LD'), pulse('CD'), pulse('CD'), pulse('CD'), [{ set: { CU: true, CD: true }, scans: 1 },
    { set: { CU: false, CD: false }, scans: 1 }], pulse('R'), pulse('CD'));
  save('counters', p, steps);
})();

/* ------------------------------------------------- 5. math / memory model */
(function math() {
  const p = project('Math');
  tag(p, 'X', 'Int', 'MW0'); tag(p, 'Y', 'Int', 'MW2'); tag(p, 'Z', 'Int', 'MW4'); tag(p, 'Z2', 'Int', 'MW6');
  tag(p, 'Y2', 'Int', 'MW8'); tag(p, 'R1', 'Real', 'MD10'); tag(p, 'R2', 'Real', 'MD14'); tag(p, 'R3', 'Real', 'MD18');
  tag(p, 'T1', 'Time', 'MD22'); tag(p, 'R2b', 'Real', 'MD26'); tag(p, 'W1', 'Word', 'MW30');
  tag(p, 'ENO_ADD', 'Bool', 'M40.0'); tag(p, 'ENO_DIV', 'Bool', 'M40.1'); tag(p, 'ENO_N', 'Bool', 'M40.2');
  tag(p, 'BIG', 'Bool', 'M40.3'); tag(p, 'Off', 'Bool', 'M40.4'); tag(p, 'ENO_OFF', 'Bool', 'M40.5');
  tag(p, 'M0_3', 'Bool', 'M0.3'); tag(p, 'M1_0', 'Bool', 'M1.0'); tag(p, 'Byte1', 'Int', 'MB1');
  tag(p, 'SymR', 'Real'); tag(p, 'Wrap', 'Time', 'MD34');
  const ob = block(p, 'OB', 'Main', 1, 'LAD');
  ob.networks = [
    lad('move', [], [el('move', '', { in: '1234', out: 'X' })]),
    lad('add', [], [el('add', '', { in1: 'X', in2: '10', out: 'Y', eno: 'ENO_ADD' })]),
    lad('sub', [], [el('sub', '', { in1: 'Y', in2: '5000', out: 'Z' })]),
    lad('mul', [], [el('mul', '', { in1: 'X', in2: 'X', out: 'R1' })]),
    lad('div0', [], [el('div', '', { in1: 'X', in2: '0', out: 'R2', eno: 'ENO_DIV' })]),
    lad('div frac -> Time', [], [el('div', '', { in1: '7', in2: '2', out: 'T1' })]),
    lad('norm', [], [el('norm_x', '', { min: '0', val: 'X', max: '2000', out: 'R3' })]),
    lad('norm max=min', [], [el('norm_x', '', { min: '5', val: 'X', max: '5', out: 'SymR', eno: 'ENO_N' })]),
    lad('scale', [], [el('scale_x', '', { min: '0', val: 'R3', max: '100', out: 'Z2' })]),
    lad('cmp real', [stage([el('compare', '', { op: '>', in1: 'R1', in2: '1000' })])], [el('coil', 'BIG')]),
    lad('int wrap', [], [el('move', '', { in: '70000', out: 'Y2' })]),
    lad('real 0.1', [], [el('move', '', { in: '0.1', out: 'R2b' })]),
    lad('word', [], [el('move', '', { in: '-2', out: 'W1' })]),
    lad('EN off', [stage([el('contact_no', 'Off')])], [el('add', '', { in1: '1', in2: '1', out: 'Z', eno: 'ENO_OFF' })]),
    lad('dint wrap', [], [el('mul', '', { in1: '65536', in2: '65536', out: 'Wrap' })]),
  ];
  const steps = [{ t: 0, scans: 1 }, { scans: 1 }, { set: { M1_0: true }, scans: 0 }, { set: { Byte1: 255 }, scans: 0 },
    { set: { X: 3 }, scans: 0 }, { scans: 1 }, { set: { Off: true }, scans: 1 }];
  save('math', p, steps);
})();

/* ------------------------------------------------- 6. FBD */
(function fbd() {
  const p = project('Fbd');
  ['A', 'B', 'C'].forEach((n, i) => tag(p, n, 'Bool', 'I0.' + i));
  ['Q_and', 'Q_or', 'Q_xor', 'Q_not', 'CMP_OUT', 'TON_OUT', 'SRQ', 'RSQ', 'LATCH', 'PULSE', 'ENO1', 'Q_cmpET'].forEach((n, i) =>
    tag(p, n, 'Bool', 'Q' + (i >> 3) + '.' + (i & 7)));
  tag(p, 'N1', 'Int', 'MW10'); tag(p, 'N2', 'Int', 'MW12'); tag(p, 'SUM', 'Int', 'MW14'); tag(p, 'PROD', 'Int', 'MW16');
  tag(p, 'NORM', 'Real', 'MD20'); tag(p, 'MV', 'Int', 'MW24');
  const ob = block(p, 'OB', 'Main', 1, 'FBD');

  const and1 = box('fb_and', null, ['A', 'B']); and1.inputs[1].inverted = true;
  const as1 = box('assign'); as1.operand = 'Q_and';
  const n1 = fbdNet('and', [and1, as1]); wire(n1, and1, 0, as1, 0);

  const or1 = box('fb_or', null, ['A', 'B']); addIn(or1, 'in3', 'C');
  const as2 = box('assign'); as2.operand = 'Q_or';
  const n2 = fbdNet('or3', [as2, or1]); wire(n2, or1, 0, as2, 0);           // declared out of order on purpose

  const x1 = box('fb_xor', null, ['A', 'B']); const as3 = box('assign'); as3.operand = 'Q_xor';
  const not1 = box('fb_not', null, ['A']); const as4 = box('assign'); as4.operand = 'Q_not';
  const n3 = fbdNet('xor/not', [x1, as3, not1, as4]); wire(n3, x1, 0, as3, 0); wire(n3, not1, 0, as4, 0);

  const add = box('add', { in1: 'N1', in2: 'N2', out: 'SUM', eno: 'ENO1' }); addIn(add, 'in3', 'N1');
  const mul = box('mul', { in1: '2', in2: '3', out: 'PROD' }); addIn(mul, 'in3', '4');
  const n4 = fbdNet('math', [add, mul]);

  const ctu = box('ctu', { pv: '3', cv: '', q: '' }, ['A', 'B']);
  const cmp = box('compare', { op: '>=', in1: '0', in2: '2' });
  const as5 = box('assign'); as5.operand = 'CMP_OUT';
  const n5 = fbdNet('ctu cv pin', [ctu, cmp, as5]); wire(n5, ctu, 1, cmp, 0); wire(n5, cmp, 0, as5, 0);

  const mv = box('move', { in: '200', out: 'MV' });
  const ton = box('ton', { pt: 'T#9s', q: '', et: '' }, ['B']);
  const as6 = box('assign'); as6.operand = 'TON_OUT';
  const cmpEt = box('compare', { op: '>', in1: '0', in2: '100' });
  const as7 = box('assign'); as7.operand = 'Q_cmpET';
  const n6 = fbdNet('ton wired PT', [ton, mv, as6, cmpEt, as7]);
  wire(n6, mv, 0, ton, 1); wire(n6, ton, 0, as6, 0); wire(n6, ton, 1, cmpEt, 0); wire(n6, cmpEt, 0, as7, 0);

  const sr = box('sr', null, ['A', 'B']); sr.operand = 'SRQ';
  const rs = box('rs', null, ['B', 'C']); const as8 = box('assign'); as8.operand = 'RSQ';
  const n7 = fbdNet('latches', [sr, rs, as8]); wire(n7, rs, 0, as8, 0);

  const orL = box('fb_or', null, ['A', '']); const andL = box('fb_and', null, ['', 'B']); andL.inputs[1].inverted = true;
  const as9 = box('assign'); as9.operand = 'LATCH';
  const n8 = fbdNet('self-holding loop', [orL, andL, as9]);
  wire(n8, andL, 0, orL, 1); wire(n8, orL, 0, andL, 0); wire(n8, andL, 0, as9, 0);

  const tr = box('p_trig', { q: '' }, ['C']); const as10 = box('assign'); as10.operand = 'PULSE';
  const nx = box('norm_x', { min: '0', val: 'N1', max: '50', out: 'NORM' });
  const n9 = fbdNet('trig/norm', [tr, as10, nx]); wire(n9, tr, 0, as10, 0);

  ob.networks = [n1, n2, n3, n4, n5, n6, n7, n8, n9];
  const steps = [{ t: 0, set: { N1: 5, N2: 7 }, scans: 1 }].concat(pulse('A'), pulse('A'), pulse('A'), [
    { set: { B: true }, dt: 60, scans: 3 }, { dt: 60, scans: 2 }, { set: { B: false }, scans: 1 },
    { set: { C: true }, scans: 2 }, { set: { C: false, B: true }, scans: 1 }, { set: { B: false }, scans: 1 },
    { set: { A: true }, scans: 1 }, { set: { A: false }, scans: 2 }, { set: { B: true }, scans: 1 }, { set: { B: false }, scans: 1 }]);
  save('fbd', p, steps);
})();

/* ------------------------------------------------- 7. block calls */
(function calls() {
  const p = project('Calls');
  tag(p, 'X', 'Int', 'MW0'); tag(p, 'Y', 'Int', 'MW2'); tag(p, 'Y2', 'Int', 'MW4'); tag(p, 'Flag', 'Bool', 'M10.0');
  tag(p, 'Flag2', 'Bool', 'M10.1'); tag(p, 'EnFC', 'Bool', 'I0.0'); tag(p, 'P1', 'Bool', 'I0.1'); tag(p, 'P2', 'Bool', 'I0.2');
  tag(p, 'C1', 'Int', 'MW20'); tag(p, 'C2', 'Int', 'MW22'); tag(p, 'C3', 'Int', 'MW24'); tag(p, 'OrphanRan', 'Bool', 'M10.2');
  tag(p, 'SelfRan', 'Bool', 'M10.3'); tag(p, 'S1', 'Int', 'MW26'); tag(p, 'S2', 'Int', 'MW28');

  const fc = block(p, 'FC', 'Scale', 1, 'LAD');
  fc.iface.input.push(M.newMember('In', 'Int', '', ''), M.newMember('Gain', 'Int', '1', ''));
  fc.iface.output.push(M.newMember('Out', 'Int', '', ''), M.newMember('Big', 'Bool', '', ''));
  fc.networks = [lad('mul', [], [el('mul', '', { in1: 'In', in2: 'Gain', out: 'Out' })]),
    lad('big', [stage([el('compare', '', { op: '>', in1: 'Out', in2: '100' })])], [el('coil', 'Big')])];

  const fb = block(p, 'FB', 'Counter', 1, 'LAD');
  fb.iface.input.push(M.newMember('Pulse', 'Bool', '', ''));
  fb.iface.output.push(M.newMember('Count', 'Int', '', ''), M.newMember('Scans', 'Int', '', ''));
  fb.iface.static.push(M.newMember('Internal', 'Int', '10', ''));
  fb.networks = [lad('count', [stage([el('contact_no', 'Pulse')])], [el('ctu', '', { pv: '1000', cv: 'Count' })]),
    lad('static', [], [el('add', '', { in1: 'Internal', in2: '1', out: 'Internal' })]),
    lad('out', [], [el('move', '', { in: 'Internal', out: 'Scans' })])];
  const db1 = instDb(p, fb, 'Counter_DB1');
  const db2 = instDb(p, fb, 'Counter_DB2');

  const orphan = block(p, 'FC', 'Orphan', 2, 'LAD');
  orphan.networks = [lad('o', [], [el('coil', 'OrphanRan')])];
  const self = block(p, 'FC', 'SelfCall', 3, 'LAD');
  self.networks = [lad('s', [], [el('coil', 'SelfRan'), el('call', '', { target: self.id })])];

  const ob = block(p, 'OB', 'Main', 1, 'LAD');
  ob.networks = [
    lad('fc', [stage([el('contact_no', 'EnFC')])],
      [el('call', '', { target: fc.id }, { In: 'X', Gain: '3', Out: 'Y', Big: 'Flag' })]),
    lad('fb1', [], [el('call', '', { target: fb.id, instanceDb: db1.id }, { Pulse: 'P1', Count: 'C1', Scans: 'S1' })]),
    lad('fb2', [], [el('call', '', { target: fb.id, instanceDb: db2.id }, { Pulse: 'P2', Count: 'C2', Scans: 'S2' })]),
    lad('fb no db', [], [el('call', '', { target: fb.id }, { Pulse: 'P1', Count: 'C3' })]),
  ];
  const ob2 = block(p, 'OB', 'Main2', 2, 'FBD');
  const cb = callBox(fc); cb.inputs[1].operand = 'X'; cb.inputs[2].operand = '2';
  const mvb = box('move', { out: 'Y2' }); const asb = box('assign'); asb.operand = 'Flag2';
  const n = fbdNet('fbd call', [cb, mvb, asb]); wire(n, cb, 1, mvb, 0); wire(n, cb, 2, asb, 0);
  ob2.networks = [n];

  const steps = [{ t: 0, set: { X: 20 }, scans: 1 }, { set: { EnFC: true }, scans: 1 }, { set: { X: 60 }, scans: 1 },
    { set: { EnFC: false, X: 5 }, scans: 1 }].concat(pulse('P1'), pulse('P1'), pulse('P2'), [{ scans: 3 }]);
  save('calls', p, steps);
})();

/* ------------------------------------------------- 8. SCL */
(function scl() {
  const p = project('Scl');
  tag(p, 'A', 'Bool', 'I0.0'); tag(p, 'B', 'Bool', 'I0.1'); tag(p, 'Q1', 'Bool', 'Q0.0'); tag(p, 'Q2', 'Bool', 'Q0.1');
  tag(p, 'Sel', 'Int', 'MW0'); tag(p, 'Out', 'Int', 'MW2'); tag(p, 'Sum', 'Int', 'MW4'); tag(p, 'Cnt', 'Int', 'MW6');
  tag(p, 'R1', 'Real', 'MD10'); tag(p, 'R2', 'Real', 'MD14'); tag(p, 'R3', 'Real', 'MD18'); tag(p, 'R4', 'Real', 'MD22');
  tag(p, 'Bits', 'Bool', 'M30.0'); tag(p, 'T1', 'Time', 'MD26'); tag(p, 'TotalOut', 'Real', 'MD40');
  tag(p, 'Calls', 'Int', 'MW44'); tag(p, 'Nan', 'Real', 'MD48');
  const ob = block(p, 'OB', 'Main', 1, 'SCL');
  ob.code = [
    '// SCL parity test',
    'IF A AND NOT B THEN',
    '  Q1 := TRUE;',
    'ELSIF B THEN',
    '  Q1 := FALSE; Q2 := TRUE;',
    'ELSE',
    '  Q2 := FALSE;',
    'END_IF;',
    'CASE Sel OF',
    '  1: Out := 10;',
    '  2, 3: Out := 20;',
    '  4..6: Out := 30;',
    '  -2..-1: Out := -1;',
    'ELSE',
    '  Out := 0;',
    'END_CASE;',
    'Sum := 0;',
    'FOR i := 1 TO 10 BY 2 DO',
    '  IF i = 7 THEN EXIT; END_IF;',
    '  IF i = 3 THEN CONTINUE; END_IF;',
    '  Sum := Sum + i;',
    'END_FOR;',
    'Cnt := 0;',
    'WHILE Cnt < 5 DO Cnt := Cnt + 1; END_WHILE;',
    'REPEAT Cnt := Cnt - 2; UNTIL Cnt < 0 END_REPEAT;',
    '(* functions *)',
    'R1 := SQRT(16.0) + ABS(-3) + MIN(4, 2, 8) + MAX(1, 9) + LIMIT(0, 15, 10);',
    'R2 := ROUND(2.5) + TRUNC(-2.7) + (7 MOD 3) + (-7 MOD 3);',
    'R3 := 10 / 4;',
    'R4 := 5 / 0 + EXP(0) + SIN(0) + COS(0) + TAN(0) + LN(1) + REAL(2) + INT(3.9) + SQR(3);',
    'Nan := SQRT(-1) + 1;',
    'Bits := (A XOR B) OR (Sel > 3);',
    'T1 := T#1s500ms + TIME#2s;',
  ].join('\n');

  const fb = block(p, 'FB', 'Integrator', 1, 'SCL');
  fb.iface.input.push(M.newMember('In', 'Real', '', ''), M.newMember('Enable', 'Bool', '', ''));
  fb.iface.output.push(M.newMember('Total', 'Real', '', ''), M.newMember('N', 'Int', '', ''));
  fb.iface.static.push(M.newMember('Acc', 'Real', '0', ''), M.newMember('Count', 'Int', '100', ''));
  fb.iface.temp.push(M.newMember('tmp', 'Real', '', ''));
  fb.iface.constant.push(M.newMember('K', 'Real', '0.5', ''));
  fb.code = 'IF Enable THEN\n  tmp := In * K;\n  Acc := Acc + tmp;\nEND_IF;\nCount := Count + 1;\nTotal := Acc;\nN := Count;';
  const db = instDb(p, fb, 'Integrator_DB');
  const ob2 = block(p, 'OB', 'Cyclic', 2, 'LAD');
  ob2.networks = [lad('call', [], [el('call', '', { target: fb.id, instanceDb: db.id },
    { In: 'R1', Enable: 'A', Total: 'TotalOut', N: 'Calls' })])];
  const broken = block(p, 'FC', 'Broken', 1, 'SCL');
  broken.code = 'IF A THEN\n  Q1 := TRUE;\n';

  const steps = [{ t: 0, scans: 1 }, { set: { A: true }, scans: 1 }, { set: { B: true }, scans: 1 },
    { set: { A: false }, scans: 1 }, { set: { B: false }, scans: 1 }];
  [1, 2, 3, 5, 6, 7, -1, -2, -3, 0].forEach((v) => steps.push({ set: { Sel: v }, scans: 1 }));
  steps.push({ set: { A: true }, scans: 4 });
  save('scl', p, steps);
})();

/* ------------------------------------------- 9. typed SCL from source */
// Projects built the way a user builds them from TIA sources: generate the
// blocks with T.sources (the IDE's "Generate blocks from source").
function fromSource(p, text) {
  T.setProject(p);
  const r = T.sources.generate(text);
  if (r.errors.length) throw new Error(p.name + ': ' + JSON.stringify(r.errors));
  p.blocks.forEach((b) => { if (b.lang === 'SCL') { const c = T.scl.check(b); if (c.error) throw new Error(p.name + ' ' + b.name + ': ' + JSON.stringify(c.error)); } });
  return p;
}

(function sclTyped() {
  const p = project('SclTyped');
  ['I0.0 A', 'I0.1 B', 'I0.2 C'].forEach((x) => { const [a, n] = x.split(' '); tag(p, n, 'Bool', a); });
  tag(p, 'IntOut', 'Int', 'MW0'); tag(p, 'Div', 'Int', 'MW2'); tag(p, 'RealOut', 'Real', 'MD4');
  tag(p, 'Flag', 'Bool', 'M8.0'); tag(p, 'TimeOut', 'Time', 'MD12'); tag(p, 'Sym', 'Int', '');
  tag(p, 'LadBit', 'Bool', 'M20.0'); tag(p, 'LadNum', 'Int', 'MW22'); tag(p, 'RetOut', 'Int', 'MW24');
  fromSource(p, `
TYPE "Point"
VERSION : 0.1
   STRUCT
      x : Int := 3;
      y : Real := 1.5;
      tag : String[8] := 'pt';
      flags : Array[0..9] of Bool;
   END_STRUCT;
END_TYPE

FUNCTION "Sum" : DInt
VERSION : 0.1
   VAR_INPUT
      arr : Variant;
      n : Int;
   END_VAR
   VAR_IN_OUT
      p : "Point";
   END_VAR
   VAR_TEMP
      i : Int;
   END_VAR
BEGIN
   #Sum := UDINT_TO_DINT(CountOfElements(#arr)) * 100 + #n;
   #p.x := #p.x + 1;
   FOR #i := 0 TO 9 BY 3 DO
      #p.flags[#i] := NOT #p.flags[#i];
   END_FOR;
END_FUNCTION

FUNCTION_BLOCK "Inner"
VERSION : 0.1
   VAR_INPUT
      go : Bool;
   END_VAR
   VAR_OUTPUT
      n : UInt;
      edge : Bool;
   END_VAR
   VAR
      trig : R_TRIG;
      t : TON_TIME;
      it : IEC_TIMER;
   END_VAR
BEGIN
   #trig(CLK := #go);
   #edge := #trig.Q;
   IF #trig.Q THEN
      #n := #n + 1;
   END_IF;
   #t(IN := #go, PT := T#30ms);
   #it.TON(IN := #go, PT := T#50ms);
END_FUNCTION_BLOCK

FUNCTION_BLOCK "Worker"
{ S7_Optimized_Access := 'FALSE' }
VERSION : 0.1
   VAR_INPUT
      a : Bool;
      pt : "Point";
   END_VAR
   VAR_OUTPUT
      out : "Point";
      w : Word;
   END_VAR
   VAR
      seq : UInt := 65534;
      s8 : SInt := 125;
      b : Byte;
      arr : Array[1..4, 0..2] of Int;
      inner : "Inner";
      cnt : CTU_DINT;
      ts : DTL;
      txt : String[12] := 'Hello';
      t2 : String[4];
      r : LReal;
      stateNo : Int;
      idx : Int := 7;
      bad : Int;
   END_VAR
   VAR_TEMP
      i : Int;
      j : Int;
      tmp : DInt;
   END_VAR
   VAR CONSTANT
      ST_A : Int := 1;
      ST_B : Int := 2;
   END_VAR
BEGIN
   REGION arithmetic
      #seq := #seq + 1;                     // wraps 65535 -> 0
      #s8 := #s8 + 5;                       // SInt wrap
      "Div" := 7 / 2 + (-7) / 2 + 7 MOD -3;
      #b := 16#F0 OR BYTE#16#0F;
      #b := SHL(IN := #b, N := 2);
      #w := ROL(IN := WORD#16#8001, N := 1) XOR SHR(IN := WORD#16#FF00, N := 4);
      #w.%X15 := #a;
      #w.%B0 := 16#AB;
      #r := SQRT(2.0) * 10.0 ** 2;
      #tmp := TRUNC(-3.7) + ROUND(2.5) + ROUND(3.5) + CEIL(1.2) + FLOOR(-1.2);
      "IntOut" := DINT_TO_INT(#tmp) + INT#1 + LIMIT(MN := 0, IN := 50, MX := 9) + MIN(4, 2, 8) + SEL(G := #a, IN0 := 100, IN1 := 200);
      "RealOut" := NORM_X(MIN := 0, VALUE := 13824, MAX := 27648) + REAL#0.25 + INT_TO_REAL(3) / 2;
      "TimeOut" := T#1s500ms + T#2s - T#250ms;
   END_REGION
   REGION arrays
      FOR #i := 1 TO 4 DO
         FOR #j := 0 TO 2 DO
            #arr[#i, #j] := #i * 10 + #j;
         END_FOR;
      END_FOR;
      #bad := #arr[#idx, 0];                // out of range: reads 0
      #arr[#idx - 2, 1] := 99;            // out of range: ignored
   END_REGION
   REGION calls
      #out := #pt;
      #out.x := #out.x * 2;
      #out.tag := CONCAT_LIKE;
      "RetOut" := DINT_TO_INT("Sum"(arr := #arr, n := 7, p := #out));
      #inner(go := #a, n => "Sym");
      #cnt(CU := #inner.edge, R := "C", PV := 3);
      "Flag" := #cnt.Q AND #inner.t.Q;
      RD_SYS_T(OUT => #ts);
   END_REGION
   REGION strings
      #t2 := #txt;                          // truncated to 4
      IF #t2 = 'Hell' AND LEN(#txt) = 5 AND MAX_LEN(#t2) = 4 THEN
         #stateNo := #ST_B;
      END_IF;
      CASE #stateNo OF
         #ST_A: #stateNo := 10;
         #ST_B: #stateNo := #stateNo + 20;
         30..40: #stateNo := 0;
      ELSE
         #stateNo := -1;
      END_CASE;
   END_REGION
END_FUNCTION_BLOCK

DATA_BLOCK "Data"
{ S7_Optimized_Access := 'FALSE' }
VERSION : 0.1
NON_RETAIN
   VAR
      p : "Point";
      q : "Point";
      list : Array[0..3] of "Point";
      flags : Array[0..15] of Bool;
      total : DInt;
   END_VAR
BEGIN
   p.x := 42;
   list[2].tag := 'third';
   flags[3] := TRUE;
END_DATA_BLOCK

DATA_BLOCK "Worker_DB"
VERSION : 0.1
"Worker"
BEGIN
   seq := 65533;
END_DATA_BLOCK

ORGANIZATION_BLOCK "Cyclic"
BEGIN
   "Worker_DB"(a := "A", pt := "Data".p, out => "Data".q);
   "Data".total := "Data".total + "Data".q.x;
   "Data".list["Data".total MOD 4].x := 1;
   "Data".flags[0] := "Data".flags[3] XOR "B";
END_ORGANIZATION_BLOCK
`.replace('#out.tag := CONCAT_LIKE;', "#out.tag := 'copy';"));
  // a LAD network reading and writing DB elements by path
  const ob = block(p, 'OB', 'Ladder', 9, 'LAD');
  ob.networks = [
    lad('db path', [stage([el('contact_no', '"Data".flags[0]')])], [el('coil', 'LadBit')]),
    lad('move', [], [el('move', '', { in: '"Data".q.x', out: 'LadNum' })]),
  ];
  save('scl_typed', p, [{ t: 0, scans: 1 }, { set: { A: true }, scans: 1, dt: 20 }, { scans: 3, dt: 20 },
    { set: { A: false }, scans: 2 }, { set: { A: true, B: true }, scans: 2, dt: 40 }, { set: { C: true }, scans: 1 },
    { set: { A: false, C: false }, scans: 1 }, { set: { A: true }, scans: 5, dt: 15 }]);
})();

/* ------------------------------------------- 10. OUC over the virtual net */
(function ouc() {
  const p = project('Ouc');
  tag(p, 'Go', 'Bool', 'I0.0'); tag(p, 'Drop', 'Bool', 'I0.1'); tag(p, 'Send', 'Bool', 'I0.2');
  tag(p, 'Errors', 'Int', 'MW0'); tag(p, 'Got', 'Int', 'MW2');
  fromSource(p, `
FUNCTION_BLOCK "Peer"
VERSION : 0.1
   VAR_INPUT
      go : Bool;
      drop : Bool;
      send : Bool;
      active : Bool;
      id : Int;
      port : UInt;
      lenRx : UDInt;
      adhoc : Bool;
   END_VAR
   VAR_OUTPUT
      st : Array[0..3] of Word;
      got : Int;
      errs : Int;
      lastLen : UDInt;
   END_VAR
   VAR
      p : TCON_IP_v4;
      con : TCON;
      dis : TDISCON;
      snd : TSEND;
      rcv : TRCV;
      txb : Struct
         a : Int;
         b : Real;
         c : String[6];
      END_STRUCT;
      rxb : Array[0..15] of Byte;
      up : Bool;
      cnt : Int;
   END_VAR
BEGIN
   #p.ID := INT_TO_WORD(#id); #p.ConnectionType := 11; #p.ActiveEstablished := #active;
   #p.RemoteAddress.ADDR[1] := 127; #p.RemoteAddress.ADDR[4] := 1;
   IF #active THEN #p.RemotePort := #port; ELSE #p.LocalPort := #port; END_IF;
   #con(REQ := #go AND NOT #up, ID := INT_TO_WORD(#id), CONNECT := #p);
   IF #con.DONE THEN #up := TRUE; END_IF;
   #dis(REQ := #drop, ID := INT_TO_WORD(#id));
   IF #dis.DONE THEN #up := FALSE; END_IF;
   #cnt := #cnt + 1;
   #txb.a := #cnt; #txb.b := INT_TO_REAL(#cnt) / 4.0; #txb.c := 'abc';
   #snd(REQ := #send, ID := INT_TO_WORD(#id), LEN := 0, DATA := #txb);
   #rcv(EN_R := #up, ID := INT_TO_WORD(#id), LEN := #lenRx, ADHOC := #adhoc, DATA := #rxb);
   IF #rcv.NDR THEN #got := #got + 1; #lastLen := #rcv.RCVD_LEN; END_IF;
   IF #con.ERROR OR #dis.ERROR OR #snd.ERROR OR #rcv.ERROR THEN #errs := #errs + 1; END_IF;
   #st[0] := #con.STATUS; #st[1] := #dis.STATUS; #st[2] := #snd.STATUS; #st[3] := #rcv.STATUS;
END_FUNCTION_BLOCK

DATA_BLOCK "Server" VERSION : 0.1 "Peer" BEGIN END_DATA_BLOCK
DATA_BLOCK "Client" VERSION : 0.1 "Peer" BEGIN END_DATA_BLOCK
DATA_BLOCK "Clash" VERSION : 0.1 "Peer" BEGIN END_DATA_BLOCK
DATA_BLOCK "BadCon" VERSION : 0.1
   VAR
      p : TCON_IP_v4;
      c1 : TCON; c2 : TCON; c3 : TCON; c4 : TCON;
      s : Array[1..4] of Word;
      big : Array[0..9] of Byte;
      sx : TSEND;
   END_VAR
BEGIN END_DATA_BLOCK

ORGANIZATION_BLOCK "Net"
BEGIN
   "Server"(go := "Go", drop := FALSE, send := "Send", active := FALSE, id := 1, port := 2000, lenRx := 4, adhoc := FALSE);
   "Client"(go := "Go", drop := "Drop", send := "Send", active := TRUE, id := 2, port := 2000, lenRx := 0, adhoc := TRUE);
   // a second listener on the same port, an ID in use, ID 0, port 0, bad address
   "Clash"(go := "Go", drop := FALSE, send := FALSE, active := FALSE, id := 3, port := 2000, lenRx := 0, adhoc := FALSE);
   "BadCon".p.ID := 1; "BadCon".p.ConnectionType := 11;
   "BadCon".c1(REQ := "Go", ID := 1, CONNECT := "BadCon".p);
   "BadCon".c2(REQ := "Go", ID := 0, CONNECT := "BadCon".p);
   "BadCon".p.ID := 5;
   "BadCon".c3(REQ := "Go", ID := 5, CONNECT := "BadCon".p);
   "BadCon".p.ActiveEstablished := TRUE; "BadCon".p.RemotePort := 99; "BadCon".p.ID := 6;
   "BadCon".c4(REQ := "Go", ID := 6, CONNECT := "BadCon".p);
   "BadCon".s[1] := "BadCon".c1.STATUS; "BadCon".s[2] := "BadCon".c2.STATUS;
   "BadCon".s[3] := "BadCon".c3.STATUS; "BadCon".s[4] := "BadCon".c4.STATUS;
   "BadCon".sx(REQ := "Send", ID := 1, LEN := 11, DATA := "BadCon".big);
   "Errors" := "Server".errs + "Client".errs;
   "Got" := "Server".got * 100 + "Client".got;
END_ORGANIZATION_BLOCK
`);
  save('ouc', p, [{ t: 0, scans: 1 }, { set: { Go: true }, scans: 1 }, { scans: 2 }, { set: { Send: true }, scans: 1 },
    { set: { Send: false }, scans: 2 }, { set: { Send: true }, scans: 1 }, { set: { Send: false }, scans: 3 },
    { set: { Drop: true }, scans: 2 }, { set: { Drop: false, Go: false }, scans: 2 }, { set: { Go: true }, scans: 3 },
    { set: { Send: true }, scans: 1 }, { set: { Send: false }, scans: 2 }]);
})();

/* --------------- 10b. OUC boxes from the instruction pane, in LAD and FBD */
(function oucBoxes() {
  const p = project('OucBoxes');
  tag(p, 'Go', 'Bool', 'I0.0'); tag(p, 'Send', 'Bool', 'I0.1'); tag(p, 'Drop', 'Bool', 'I0.2');
  tag(p, 'Done1', 'Bool', 'M0.0'); tag(p, 'Done2', 'Bool', 'M0.1'); tag(p, 'SDone', 'Bool', 'M0.2');
  tag(p, 'Ndr', 'Bool', 'M0.3'); tag(p, 'DDone', 'Bool', 'M0.4'); tag(p, 'Err', 'Bool', 'M0.5');
  tag(p, 'St1', 'Word', 'MW2'); tag(p, 'St2', 'Word', 'MW4'); tag(p, 'SSt', 'Word', 'MW6'); tag(p, 'RSt', 'Word', 'MW8');
  tag(p, 'RLen', 'Int', 'MW10'); tag(p, 'TxWord', 'Int', 'MW12'); tag(p, 'RxWord', 'Int', 'MW14');
  tag(p, 'FDone', 'Bool', 'M1.0'); tag(p, 'FSt', 'Word', 'MW16'); tag(p, 'FNdr', 'Bool', 'M1.1'); tag(p, 'FNdr2', 'Bool', 'M1.2');
  tag(p, 'CNdr', 'Bool', 'M1.3'); tag(p, 'S4', 'Word', 'MW18');
  fromSource(p, `
DATA_BLOCK "Conn"
VERSION : 0.1
   VAR
      srv : TCON_IP_v4;
      cli : TCON_IP_v4;
      cli2 : TCON_IP_v4;
      tx : Array[0..7] of Byte;
      rx : Array[0..7] of Byte;
   END_VAR
BEGIN
   srv.ID := 1; srv.ConnectionType := 11; srv.LocalPort := 2000;
   cli.ID := 2; cli.ConnectionType := 11; cli.ActiveEstablished := TRUE;
   cli.RemoteAddress.ADDR[1] := 127; cli.RemoteAddress.ADDR[4] := 1; cli.RemotePort := 2000;
   cli2.ID := 4; cli2.ConnectionType := 11; cli2.ActiveEstablished := TRUE;
   cli2.RemoteAddress.ADDR[1] := 127; cli2.RemoteAddress.ADDR[4] := 1; cli2.RemotePort := 2001;
   tx[0] := 16#11; tx[1] := 16#22; tx[7] := 16#77;
END_DATA_BLOCK

DATA_BLOCK "Buf"
VERSION : 0.1
   VAR
      a : Int;
      b : Int;
   END_VAR
BEGIN
   a := 1234; b := -5;
END_DATA_BLOCK
`);
  // LAD: REQ / EN_R = rung power, the other pins are operands in params
  const ob = block(p, 'OB', 'Main', 1, 'LAD');
  ob.networks = [
    lad('listen', [stage([el('contact_no', 'Go')])], [el('tcon', '', { id: '1', connect: '"Conn".srv', done: 'Done1', status: 'St1' })]),
    lad('connect', [stage([el('contact_no', 'Go')])], [el('tcon', '', { id: '2', connect: 'Conn.cli', done: 'Done2', status: 'St2', error: 'Err' })]),
    lad('send', [stage([el('contact_no', 'Send')])], [el('tsend', '', { id: '2', len: '8', data: '"Conn".tx', done: 'SDone', status: 'SSt' })]),
    lad('receive', [], [el('trcv', '', { id: '1', len: '8', data: '"Conn".rx', ndr: 'Ndr', status: 'RSt', rcvd_len: 'RLen' })]),
    lad('send a tag', [stage([el('contact_no', 'Send')])], [el('tsend', '', { id: '1', len: '0', data: 'TxWord' })]),
    lad('receive a tag', [], [el('trcv', '', { id: '2', len: '2', data: 'RxWord', ndr: 'CNdr' })]),
    lad('connect 2', [stage([el('contact_no', 'Go')])], [el('tcon', '', { id: '4', connect: '"Conn".cli2', status: 'S4' })]),
    lad('send a DB', [stage([el('contact_no', 'Send')])], [el('tsend', '', { id: '4', len: '0', data: 'Buf' })]),
    lad('no data', [stage([el('contact_no', 'Send')])], [el('tsend', '', { id: '4', len: '4', data: '"Conn".nothing' })]),
    lad('drop', [stage([el('contact_no', 'Drop')])], [el('tdiscon', '', { id: '2', done: 'DDone' })]),
  ];
  // FBD in an FB: CONNECT / DATA are its own members, ID wired, outputs wired on
  const fb = block(p, 'FB', 'Link', 1, 'FBD');
  fb.iface.static.push(M.newMember('p', 'TCON_IP_v4', '', ''), M.newMember('rx', 'Array[0..3] of Byte', '', ''));
  const mv1 = box('move', { in: '3', out: '#p.ID' }), mv2 = box('move', { in: '11', out: '#p.ConnectionType' });
  const mv3 = box('move', { in: '2001', out: '#p.LocalPort' }), mvId = box('move', { in: '3', out: '' });
  const con = box('tcon', { id: '9', connect: '#p', done: 'FDone' }, ['Go']);
  const stm = box('move', { out: 'FSt' });
  const rcv = box('trcv', { id: '3', len: '0', data: '#rx', ndr: 'FNdr' }, ['Go']);
  const asg = box('assign'); asg.operand = 'FNdr2';
  const fn = fbdNet('link', [mv1, mv2, mv3, mvId, con, stm, rcv, asg]);
  wire(fn, mvId, 0, con, 1);          // ID from a wire (the param says 9)
  wire(fn, con, 3, stm, 0);           // STATUS -> MOVE
  wire(fn, rcv, 0, asg, 0);           // NDR -> assignment
  fb.networks = [fn];
  const db = instDb(p, fb, 'Link_DB');
  const ob2 = block(p, 'OB', 'Cyclic', 2, 'FBD');
  ob2.networks = [fbdNet('call', [callBox(fb, db)])];
  save('ouc_boxes', p, [{ t: 0, scans: 1 }, { set: { Go: true, TxWord: 4660 }, scans: 3 }, { scans: 2 },
    { set: { Send: true }, scans: 1 }, { set: { Send: false }, scans: 3 }, { set: { Send: true, TxWord: -2 }, scans: 1 },
    { set: { Send: false }, scans: 3 }, { set: { Drop: true }, scans: 2 }, { set: { Drop: false, Go: false }, scans: 2 },
    { set: { Go: true }, scans: 3 }]);
})();

/* ------------------------------------- 11. the TcpLink example, end to end */
(function tcplink() {
  const p = project('TcpLink');
  tag(p, 'Motor', 'Bool', 'Q0.0'); tag(p, 'Run_Lamp', 'Bool', 'Q0.1');
  tag(p, 'Part_Count', 'Int', 'MW10'); tag(p, 'Conveyor_PWM', 'Real', 'MD20');
  tag(p, 'ClientOn', 'Bool', 'M30.0'); tag(p, 'LinkUp', 'Bool', 'M30.1'); tag(p, 'RxSet', 'Int', 'MW32');
  const ex = path.join(__dirname, '..', '..', 'examples', 'tcplink');
  T.setProject(p);
  ['TcpLinkTxDigital.udt', 'TcpLinkTxAnalog.udt', 'TcpLinkRx.udt', 'TcpLinkNames.udt', 'TcpLink.scl', 'TcpLinkDemo.db'].forEach((f) => {
    const r = T.sources.generate(fs.readFileSync(path.join(ex, f), 'utf8'));
    if (r.errors.length) throw new Error(f + ': ' + JSON.stringify(r.errors));
  });
  fromSource(p, `
FUNCTION_BLOCK "TestClient"
VERSION : 0.1
   VAR_INPUT
      on : Bool;
   END_VAR
   VAR_OUTPUT
      msgs : UDInt;
      names : UDInt;
      bytes : UDInt;
   END_VAR
   VAR
      p : TCON_IP_v4;
      con : TCON;
      dis : TDISCON;
      rcv : TRCV;
      snd : TSEND;
      up : Bool;
      buf : Array[0..4095] of Byte;
      cmd : Struct
         magic : Byte; ver : Byte; len : UInt; seq : UInt; flags : Byte; spare : Byte;
         layout : Array[0..5] of Byte;
         data : "TcpLinkRx";
      END_STRUCT;
      sendReq : Bool;
   END_VAR
   VAR_TEMP
      i : Int;
      len : Int;
   END_VAR
BEGIN
   #p.ID := 7; #p.ConnectionType := 11; #p.ActiveEstablished := TRUE;
   #p.RemoteAddress.ADDR[1] := 127; #p.RemoteAddress.ADDR[4] := 1; #p.RemotePort := 2000;
   #con(REQ := #on AND NOT #up, ID := 7, CONNECT := #p);
   IF #con.DONE THEN #up := TRUE; END_IF;
   #dis(REQ := NOT #on AND #up, ID := 7);
   IF #dis.DONE OR #dis.ERROR THEN #up := FALSE; END_IF;
   #rcv(EN_R := #up, ID := 7, ADHOC := TRUE, DATA := #buf);
   IF #rcv.NDR THEN
      #bytes := #bytes + #rcv.RCVD_LEN;
      #i := 0;
      WHILE #i + 8 <= UDINT_TO_INT(#rcv.RCVD_LEN) DO
         #len := WORD_TO_INT(SHL(IN := BYTE_TO_WORD(#buf[#i + 2]), N := 8) OR BYTE_TO_WORD(#buf[#i + 3]));
         IF #buf[#i + 7] = 1 THEN #names := #names + 1; ELSE #msgs := #msgs + 1; END_IF;
         IF #len <= 0 THEN EXIT; END_IF;
         #i := #i + #len;
      END_WHILE;
   END_IF;
   #sendReq := #up AND #msgs > 0 AND NOT #snd.BUSY AND #cmd.seq < 3;
   IF #sendReq THEN
      #cmd.magic := 16#5A; #cmd.ver := 3; #cmd.len := 80; #cmd.seq := #cmd.seq + 1;
      #cmd.layout[0] := 2; #cmd.layout[1] := 4; #cmd.layout[3] := 12; #cmd.layout[4] := 4; #cmd.layout[5] := 4;
      #cmd.data.bits[0] := NOT #cmd.data.bits[0]; #cmd.data.ints[0] := 1000 + UINT_TO_INT(#cmd.seq); #cmd.data.reals[3] := 2.5;
   END_IF;
   #snd(REQ := #sendReq, ID := 7, LEN := 80, DATA := #cmd);
END_FUNCTION_BLOCK

DATA_BLOCK "TestClient_DB" VERSION : 0.1 "TestClient" BEGIN END_DATA_BLOCK

ORGANIZATION_BLOCK "ClientOB"
BEGIN
   "TestClient_DB"(on := "ClientOn");
   "LinkUp" := "LinkData".status.connected;
   "RxSet" := "LinkData".rx.ints[0];
END_ORGANIZATION_BLOCK
`);
  const steps = [{ t: 0, scans: 2, dt: 50 }, { set: { ClientOn: true, Motor: true, Part_Count: 5, Conveyor_PWM: 0.5 }, scans: 6, dt: 50 },
    { scans: 10, dt: 100 }, { set: { Part_Count: 6 }, scans: 3, dt: 50 }, { set: { Conveyor_PWM: 0.9 }, scans: 3, dt: 60 },
    { scans: 25, dt: 100 }, { set: { ClientOn: false }, scans: 5, dt: 50 }, { scans: 30, dt: 100 },
    { set: { ClientOn: true }, scans: 10, dt: 100 }, { set: { Run_Lamp: true }, scans: 4, dt: 50 }];
  save('tcplink', p, steps);
})();

console.log('cases written to', outDir);
