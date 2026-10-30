/* Load the IDE's own core.js + scl.js + sim.js into Node (no browser) so the
 * simulator can serve as the reference implementation in parity tests.
 * A minimal fake DOM satisfies the modules' load-time CSS injection; the
 * simulator's performance.now() is replaced by a controllable clock. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fakeEl() {
  return {
    style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute() {}, getAttribute() { return null; }, appendChild(c) { return c; }, removeChild() {}, remove() {},
    addEventListener() {}, removeEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
    insertBefore() {}, firstChild: null, textContent: '', innerHTML: '',
  };
}

function load(webDir) {
  global.window = global;
  global.document = {
    getElementById: () => null, createElement: fakeEl, createElementNS: fakeEl, createTextNode: () => ({}),
    head: fakeEl(), body: fakeEl(), addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [], readyState: 'complete', activeElement: null,
  };
  global.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const clock = { now: 0 };
  Object.defineProperty(globalThis, 'performance', {
    value: { now: () => clock.now }, configurable: true, writable: true,
  });
  const log = console.log;
  console.log = () => {};                      // modules announce themselves on load
  try {
    for (const f of ['core.js', 'types.js', 'scl.js', 'sysfb.js', 'sources.js', 'sim.js']) {
      vm.runInThisContext(fs.readFileSync(path.join(webDir, 'js', f), 'utf8'), { filename: f });
    }
  } finally {
    console.log = log;
  }
  return { T: global.TIA, clock };
}

module.exports = { load };
