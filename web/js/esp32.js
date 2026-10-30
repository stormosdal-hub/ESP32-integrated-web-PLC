/* ============================================================================
 * esp32.js — the "ESP32" view (replaces the Raspberry Pi export view).
 *
 *   Runtime        scan cycle time
 *   I/O modules    map tags to GPIO pins: digital in / digital out / PWM out /
 *                  analog in (ADC). Stored in T.project.gpio as
 *                  { tag, pin, dir:'in'|'out'|'pwm'|'ain', pull, debounce,
 *                    activeLow, freq, mode, smooth } and downloaded with the program.
 *   Board          dev-board header with the assigned tags (ESP32-S3-DevKitC-1
 *                  or ESP32-DevKitC, by the PLC's chip)
 *   Device         (online) CPU / program / cycle / Wi-Fi status, upload,
 *                  erase, restart, Wi-Fi setup
 *
 * Pin knowledge comes from the PLC itself (/api/pins: chip, reserved flash /
 * PSRAM / console / status-LED pins). The last answer is kept in
 * localStorage for editing offline; before any connection an ESP32-S3 default
 * is used.
 * ==========================================================================*/
(function (T) {
  'use strict';

  /* ------------------------------------------------------- pin knowledge */
  const WARN = {
    0: 'BOOT button + strapping pin: must not be held low at reset (fine as a button input)',
    3: 'strapping pin (JTAG select): don\'t drive it during reset',
    45: 'strapping pin (flash voltage): must be low at reset',
    46: 'strapping pin (boot mode): keep low at reset',
    19: 'USB D- : the native USB port stops working',
    20: 'USB D+ : the native USB port stops working',
  };
  function defaultPins() {
    const pins = [];
    for (let g = 0; g <= 48; g++) {
      if (g >= 22 && g <= 25) continue;                 // not bonded out on the S3
      const p = { gpio: g, adc: (g >= 1 && g <= 10) ? 'ADC1_CH' + (g - 1) : null, output: true, reserved: null, warn: null };
      if (g >= 26 && g <= 32) p.reserved = 'SPI flash/PSRAM bus';
      else if (g >= 33 && g <= 37) p.warn = 'wired to PSRAM on octal (N8R8/N16R8) modules';
      else if (g === 43) p.reserved = 'UART0 TX (console / USB-UART port)';
      else if (g === 44) p.reserved = 'UART0 RX (console / USB-UART port)';
      else if (g === 48) p.reserved = 'status LED (firmware default)';
      else if (g >= 39 && g <= 42) p.warn = 'JTAG pin: free unless you debug over external JTAG';
      if (!p.reserved && WARN[g]) p.warn = WARN[g];
      p.pulls = true;
      pins.push(p);
    }
    return { board: { chip: 'ESP32-S3', psramReserved: null, psramPins: 'GPIO33-37', adcPins: 'GPIO1-10', statusLed: 48,
      pwmChannels: 8, pwmFrequencies: 4, pwmMinHz: 5, pwmMaxHz: 40000 }, pins, live: false };
  }
  const CACHE_KEY = 'tia-esp32-board';
  function cachedPins() {
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (c && c.board && Array.isArray(c.pins)) return { board: c.board, pins: c.pins, live: false, cached: true };
    } catch (e) { /* no storage (file://, private mode): use the default */ }
    return null;
  }
  let PIN = cachedPins() || defaultPins();
  const pinInfo = (g) => PIN.pins.find((p) => p.gpio === g) || null;
  const chipName = () => PIN.board.chip || 'ESP32-S3';
  const bootPin = () => (PIN.board.bootPin != null ? PIN.board.bootPin : 0);
  const adcText = () => PIN.board.adcPins || PIN.pins.filter((p) => p.adc && !p.reserved)
    .map((p) => 'GPIO' + p.gpio).join(', ');

  function fetchPins() {
    if (!(T.online && T.online.connected)) return Promise.resolve(false);
    return T.online.api('/api/pins').then((r) => {
      if (r && Array.isArray(r.pins)) {
        PIN = { board: r.board || PIN.board, pins: r.pins, live: true };
        try { localStorage.setItem(CACHE_KEY, JSON.stringify({ board: PIN.board, pins: PIN.pins })); } catch (e) { /* ignore */ }
        return true;
      }
      return false;
    }).catch(() => false);
  }

  /* ------------------------------------------------------- gpio entries */
  function ensureGpio() { if (!Array.isArray(T.project.gpio)) T.project.gpio = []; return T.project.gpio; }
  function gpioEntry(tag) { return ensureGpio().find((e) => e && e.tag === tag) || null; }
  function setGpio(tag, patch) {
    const arr = ensureGpio();
    let e = arr.find((x) => x && x.tag === tag);
    if (!e) { e = { tag }; arr.push(e); }
    Object.assign(e, patch);
    T.bus.emit('tags:changed');           // autosave + sim table
  }
  const isNumeric = (t) => ['Int', 'Real', 'Word', 'DInt', 'UInt'].indexOf(t.dataType) >= 0;
  const isPinMapped = (g) => g && g.pin != null && g.pin !== '' && !isNaN(+g.pin) && !!g.dir;
  const isSrMapped = (g) => g && !!g.sr && g.bit != null && g.bit !== '' && !isNaN(+g.bit) && !!g.dir;
  const isXMapped = (g) => g && !!g.i2c && g.bit != null && g.bit !== '' && !isNaN(+g.bit) && !!g.dir;
  const isMapped = (g) => isPinMapped(g) || isSrMapped(g) || isXMapped(g);
  function defaultDir(t) {
    const a = (t.address || '').trim().toUpperCase();
    if (isNumeric(t)) return a.charAt(0) === 'I' ? 'ain' : 'pwm';
    return a.charAt(0) === 'I' ? 'in' : 'out';
  }

  /* ------------------------------------------------------- shift registers */
  // T.project.shiftRegs: [{ id:'SR1', type:'595'|'165', chips:1..8, data, clock, latch, enable }]
  // A tag on a chain is a gpio entry { tag, dir, sr:'SR1', bit:n } without a pin.
  // Channel n = chip n/8 (chip 1 is wired to the ESP32), pin QA..QH / A..H = n%8.
  const SR_ROLES = {   // [key, chip pin, help, ESP32 drives it]
    595: [['data', 'SER', 'serial data into chip 1 (pin 14)', true], ['clock', 'SRCLK', 'shift clock (pin 11)', true],
      ['latch', 'RCLK', 'latch / storage clock (pin 12)', true],
      ['enable', '/OE', 'output enable (pin 13) - optional: or tie /OE to GND', true]],
    165: [['data', 'QH', 'serial data out of chip 1 (pin 9)', false], ['clock', 'CLK', 'clock (pin 2)', true],
      ['latch', 'SH/LD', 'shift / load (pin 1)', true],
      ['enable', 'CLK INH', 'clock inhibit (pin 15) - optional: or tie it to GND', true]],
  };
  function ensureSrs() { if (!Array.isArray(T.project.shiftRegs)) T.project.shiftRegs = []; return T.project.shiftRegs; }
  const srById = (id) => ensureSrs().find((s) => s && s.id === id) || null;
  const srType = (s) => (String(s.type) === '165' ? '165' : '595');
  const srDir = (s) => (srType(s) === '165' ? 'in' : 'out');
  const srChips = (s) => Math.max(1, Math.min(8, parseInt(s.chips, 10) || 1));
  const chName = (s, bit) => (srDir(s) === 'in' ? 'I' : 'Q') + bit;
  const chPin = (s, bit) => 'chip ' + (Math.floor(bit / 8) + 1) + ', ' + (srDir(s) === 'in' ? 'input ' : 'Q') + 'ABCDEFGH'[bit % 8];
  const srPinSet = (v) => v != null && v !== '' && !isNaN(+v);
  // who uses which GPIO: tags and chain pins (skip: a tag name, or [chain, key])
  /* ------------------------------------------------------- I2C modules */
  // T.project.i2c = { sda, scl, khz: 100|400, devices: [{ id:'PCF1', type:'pcf8574'|'mcp23017'|'ads1115', addr }] }
  // A tag on a module is a gpio entry { tag, dir, i2c:'PCF1', bit:n } (ADS1115 also: range in mV).
  const hex = (a) => '0x' + (+a).toString(16).toUpperCase().padStart(2, '0');
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const I2C_TYPES = {
    pcf8574: { label: 'PCF8574', prefix: 'PCF', n: 8, kind: 'dio', ch: (b) => 'P' + b,
      addrs: range(0x20, 0x27).concat(range(0x38, 0x3F)), what: '8 digital I/O',
      addrHelp: 'A0-A2 jumpers: PCF8574 0x20-0x27, PCF8574A 0x38-0x3F' },
    mcp23017: { label: 'MCP23017', prefix: 'MCP', n: 16, kind: 'dio', ch: (b) => (b < 8 ? 'A' : 'B') + (b % 8),
      addrs: range(0x20, 0x27), what: '16 digital I/O', addrHelp: 'A0-A2 pins: 0x20-0x27' },
    ads1115: { label: 'ADS1115', prefix: 'ADS', n: 4, kind: 'ain', ch: (b) => 'AIN' + b,
      addrs: range(0x48, 0x4B), what: '4 analog inputs, 16 bit',
      addrHelp: 'ADDR pin to GND 0x48, VDD 0x49, SDA 0x4A, SCL 0x4B' },
  };
  const ADS_RANGES = [[6144, '±6.144 V'], [4096, '±4.096 V'], [2048, '±2.048 V'], [1024, '±1.024 V'], [512, '±0.512 V'], [256, '±0.256 V']];
  function ensureI2c() {
    const p = T.project;
    if (!p.i2c || typeof p.i2c !== 'object') p.i2c = { sda: null, scl: null, khz: 100, devices: [] };
    if (!Array.isArray(p.i2c.devices)) p.i2c.devices = [];
    return p.i2c;
  }
  const xById = (id) => ensureI2c().devices.find((d) => d && d.id === id) || null;
  const xType = (d) => I2C_TYPES[String(d.type).toLowerCase()] || null;
  // which tag functions a module's channels serve
  const xServes = (d, dir) => { const ty = xType(d); return !!ty && (ty.kind === 'ain' ? dir === 'ain' : dir === 'in' || dir === 'out'); };

  function pinOwners(skipTag, skipSr) {
    const o = {};
    ensureGpio().forEach((g) => { if (isPinMapped(g) && g.tag !== skipTag) o[+g.pin] = g.tag; });
    ensureSrs().forEach((s) => SR_ROLES[srType(s)].forEach(([k, role]) => {
      if (srPinSet(s[k]) && !(skipSr && skipSr[0] === s && skipSr[1] === k)) o[+s[k]] = s.id + ' ' + role;
    }));
    const bus = ensureI2c();
    ['sda', 'scl'].forEach((k) => {
      if (srPinSet(bus[k]) && !(skipSr && skipSr[0] === bus && skipSr[1] === k)) o[+bus[k]] = 'I2C ' + k.toUpperCase();
    });
    return o;
  }

  /* Check the whole map against the board. Returns { errors:[], warnings:[], byTag:{tag:{err,warn}} } */
  function validate() {
    const res = { errors: [], warnings: [], byTag: {}, bySr: {} };
    const owner = {}, srUsed = {};
    let pwm = 0;
    const freqs = new Set();
    const tags = T.project.tags || [];
    // the chains' own pins first (the PLC checks them the same way)
    ensureSrs().forEach((s) => {
      const note = (res.bySr[s.id] = { errs: [], warns: [] });
      const err = (m) => { res.errors.push(s.id + ' ' + m); note.errs.push(m); };
      SR_ROLES[srType(s)].forEach(([key, role, , out]) => {
        if (!srPinSet(s[key])) { if (key !== 'enable') err(role + ': choose a GPIO'); return; }
        const pin = +s[key], info = pinInfo(pin);
        if (!info) { err(role + ': GPIO' + pin + ' does not exist on the ' + chipName()); return; }
        if (info.reserved) { err(role + ': GPIO' + pin + ' is reserved (' + info.reserved + ')'); return; }
        if (owner[pin]) { err(role + ': GPIO' + pin + ' is also used by ' + owner[pin]); return; }
        owner[pin] = s.id + ' ' + role;
        if (out && info.output === false) { err(role + ': GPIO' + pin + ' is input-only'); return; }
        if (info.warn) { note.warns.push(role + ' (GPIO' + pin + '): ' + info.warn); res.warnings.push(s.id + ' ' + role + ': ' + info.warn); }
      });
    });
    // the I2C bus and its modules
    const bus = ensureI2c();
    res.byX = {};
    const xUsed = {};
    if (bus.devices.length) {
      const bnote = (res.byX._bus = { errs: [], warns: [] });
      ['sda', 'scl'].forEach((k) => {
        const role = k.toUpperCase(), err = (m) => { res.errors.push('I2C ' + m); bnote.errs.push(m); };
        if (!srPinSet(bus[k])) { err(role + ': choose a GPIO'); return; }
        const pin = +bus[k], info = pinInfo(pin);
        if (!info) { err(role + ': GPIO' + pin + ' does not exist on the ' + chipName()); return; }
        if (info.reserved) { err(role + ': GPIO' + pin + ' is reserved (' + info.reserved + ')'); return; }
        if (owner[pin]) { err(role + ': GPIO' + pin + ' is also used by ' + owner[pin]); return; }
        owner[pin] = 'I2C ' + role;
        if (info.output === false) { err(role + ': GPIO' + pin + ' is input-only'); return; }
        if (info.warn) { bnote.warns.push(role + ' (GPIO' + pin + '): ' + info.warn); res.warnings.push('I2C ' + role + ': ' + info.warn); }
      });
      const seen = {};
      bus.devices.forEach((d) => {
        const note = (res.byX[d.id] = { errs: [] }), ty = xType(d);
        const err = (m) => { res.errors.push(d.id + ': ' + m); note.errs.push(m); };
        if (!ty) { err('unknown module type'); return; }
        if (ty.addrs.indexOf(+d.addr) < 0) { err(hex(d.addr) + ' is not a ' + ty.label + ' address (' + ty.addrHelp + ')'); return; }
        if (seen[+d.addr]) err('address ' + hex(d.addr) + ' is also used by ' + seen[+d.addr]);
        seen[+d.addr] = d.id;
      });
    }
    ensureGpio().forEach((g) => {
      if (!isMapped(g)) return;
      const t = tags.find((x) => x.name === g.tag);
      const note = (res.byTag[g.tag] = res.byTag[g.tag] || {});
      const err = (m) => { res.errors.push(g.tag + ': ' + m); note.err = m; };
      if (!t) { err('tag no longer exists'); return; }
      if (isSrMapped(g)) {
        const s = srById(g.sr), bit = +g.bit;
        if (!s) { err('shift register ' + g.sr + ' no longer exists'); return; }
        if (g.dir !== srDir(s)) { err(s.id + ' is a 74HC' + srType(s) + ': its channels are digital ' + (srDir(s) === 'in' ? 'inputs' : 'outputs') + ' only'); return; }
        if (bit < 0 || bit >= srChips(s) * 8) { err(s.id + ' has no ' + chName(s, bit) + ' (' + srChips(s) * 8 + ' channels)'); return; }
        const k = s.id + ':' + bit;
        if (srUsed[k]) { err(s.id + ' ' + chName(s, bit) + ' is also used by ' + srUsed[k]); return; }
        srUsed[k] = g.tag;
        return;
      }
      if (isXMapped(g)) {
        const d = xById(g.i2c), bit = +g.bit, ty = d && xType(d);
        if (!d || !ty) { err('I2C module ' + g.i2c + ' no longer exists'); return; }
        if (!xServes(d, g.dir)) { err(d.id + ' (' + ty.label + ') has ' + (ty.kind === 'ain' ? 'analog inputs only' : 'digital inputs / outputs only')); return; }
        if (bit < 0 || bit >= ty.n) { err(d.id + ' has no channel ' + bit); return; }
        const k = d.id + ':' + bit;
        if (xUsed[k]) { err(d.id + ' ' + ty.ch(bit) + ' is also used by ' + xUsed[k]); return; }
        xUsed[k] = g.tag;
        if (String(d.type) === 'mcp23017' && g.dir === 'in' && g.pull === 'down') {
          note.warn = 'the MCP23017 has pull-ups only — fit an external pull-down, or choose "no pull"';
          res.warnings.push(g.tag + ': ' + note.warn);
        }
        return;
      }
      const pin = +g.pin, info = pinInfo(pin);
      if (!info) { err('GPIO' + pin + ' does not exist on the ' + chipName()); return; }
      if (info.reserved) { err('GPIO' + pin + ' is reserved (' + info.reserved + ')'); return; }
      if (owner[pin]) { err('GPIO' + pin + ' is also used by ' + owner[pin]); return; }
      owner[pin] = g.tag;
      if ((g.dir === 'out' || g.dir === 'pwm') && info.output === false) { err('GPIO' + pin + ' is input-only'); return; }
      if (g.dir === 'ain' && !info.adc) { err('analog inputs need an ADC pin (' + adcText() + ')'); return; }
      if (g.dir === 'pwm') {
        pwm++;
        const f = +g.freq || 1000;
        if (f < PIN.board.pwmMinHz || f > PIN.board.pwmMaxHz) err('PWM frequency must be ' + PIN.board.pwmMinHz + '..' + PIN.board.pwmMaxHz + ' Hz');
        freqs.add(f);
      }
      const warn = (m) => { note.warn = note.warn ? note.warn + ' · ' + m : m; res.warnings.push(g.tag + ' (GPIO' + pin + '): ' + m); };
      // the BOOT button's pin as an input is exactly its job: no warning there
      if (info.warn && !(pin === bootPin() && g.dir === 'in')) warn(info.warn);
      if (g.dir === 'in' && info.pulls === false && (g.pull || 'down') !== 'none')
        warn('no internal pull resistor on this pin — fit an external one, then choose "no pull"');
    });
    if (pwm > PIN.board.pwmChannels) res.errors.push('Too many PWM outputs (' + pwm + ', the ' + chipName() + ' has ' + PIN.board.pwmChannels + ')');
    if (freqs.size > PIN.board.pwmFrequencies) res.errors.push('PWM outputs use ' + freqs.size + ' different frequencies (max ' + PIN.board.pwmFrequencies + ')');
    return res;
  }

  /* ------------------------------------------------------- styles */
  T.injectCSS('tia-esp32-css', `
    .esp-root { padding: 8px 12px 24px; max-width: 1180px; }
    .esp-intro { color: var(--tia-text-soft); margin: 2px 0 8px; line-height: 1.5; max-width: 900px; }
    .esp-intro code, .esp-mono { font-family: var(--tia-mono); }
    .esp-intro code { background: var(--tia-row-alt); padding: 0 3px; border-radius: 2px; }
    .esp-sec { font-weight: 700; color: var(--tia-petrol-deep); margin: 14px 0 6px; font-size: 13px;
      border-bottom: 1px solid var(--tia-border-soft); padding-bottom: 3px; }
    .esp-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 4px 0; }
    .esp-cols { display: flex; gap: 18px; align-items: flex-start; flex-wrap: wrap; }
    .esp-banner { padding: 6px 10px; border-radius: 4px; margin: 6px 0; font-size: 12px; }
    .esp-banner.warn { background: #fff4d6; border: 1px solid #e0b84c; color: #6d5310; }
    .esp-banner.err { background: #fbe3e1; border: 1px solid #d9776c; color: #8a2318; }
    .esp-banner.info { background: #e3f1f2; border: 1px solid #8fc3c6; color: #1f5558; }
    table.esp-io td { vertical-align: middle; white-space: nowrap; }
    table.esp-io .tia-input { font-size: 12px; }
    table.esp-io select.tia-input { max-width: 190px; }
    .esp-num { width: 62px; }
    .esp-opt { display: inline-flex; align-items: center; gap: 5px; flex-wrap: nowrap; }
    .esp-note { font-size: 11.5px; white-space: normal !important; min-width: 160px; }
    .esp-note .e { color: #b0281a; font-weight: 600; }
    .esp-note .w { color: #946c0b; }
    .esp-badge { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10.5px; font-weight: 700; color: #fff; }
    .esp-in { background: #2e8b57; } .esp-out { background: #d07a16; } .esp-pwm { background: #7b52ab; } .esp-ain { background: #2f6fb3; }
    .esp-sr { background: #1f8a8a; } .esp-i2c { background: #8a5a1f; }
    .esp-srbox { border: 1px solid var(--tia-border-soft); border-radius: 4px; padding: 6px 8px; margin: 6px 0; max-width: 900px; }
    .esp-role { display: inline-block; min-width: 58px; font-weight: 600; }
    .esp-chans { display: flex; flex-wrap: wrap; gap: 3px; margin: 6px 0 4px; }
    .esp-ch { display: flex; flex-direction: column; align-items: center; min-width: 54px; max-width: 90px; padding: 1px 4px;
      border: 1px solid var(--tia-border-soft); border-radius: 3px; font-size: 11px; }
    .esp-ch .n { font-family: var(--tia-mono); color: var(--tia-text-soft); }
    .esp-ch .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 86px; }
    .esp-ch.on { color: #fff; border-color: transparent; } .esp-ch.on .n { color: #e8eef0; }
    .esp-wire { font-family: var(--tia-mono); font-size: 11.5px; background: var(--tia-row-alt); padding: 6px 8px; margin: 4px 0;
      white-space: pre; overflow-x: auto; }
    .esp-sum { font-size: 12px; color: var(--tia-text-soft); }
    /* DevKitC-1 header diagram */
    .esp-board { display: inline-flex; gap: 8px; border: 2px solid #3c4a52; border-radius: 6px; background: #1d2b33;
      padding: 10px 8px; color: #e8eef0; font-size: 11px; position: relative; }
    .esp-board .col { display: flex; flex-direction: column; gap: 2px; }
    .esp-board .hdr { display: flex; flex-direction: column; align-items: center; gap: 4px; }
    .esp-board .hname { color: #9fb4bd; font-size: 10px; }
    .esp-board .cols { display: flex; gap: 6px; }
    .esp-pin .tag.other { color: #9fb4bd; font-style: italic; }
    .esp-board .mid { width: 92px; display: flex; flex-direction: column; align-items: center; justify-content: space-between;
      padding: 4px 0; color: #9fb4bd; font-size: 10px; text-align: center; }
    .esp-board .mod { width: 70px; height: 92px; border: 1px solid #6f8791; border-radius: 3px; background: #2a3c45;
      display: flex; align-items: center; justify-content: center; text-align: center; line-height: 1.25; }
    .esp-pin { display: flex; align-items: center; gap: 4px; height: 17px; }
    .esp-pin.l { flex-direction: row-reverse; }
    .esp-pin .num { width: 30px; text-align: center; border-radius: 3px; background: #33454f; font-family: var(--tia-mono); }
    .esp-pin.res .num { background: #4b2b2b; color: #d7a6a6; }
    .esp-pin.wrn .num { box-shadow: inset 0 0 0 1px #d6a43c; }
    .esp-pin.pwr .num { background: #59481f; color: #f4dc9a; }
    .esp-pin .tag { width: 118px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #e8eef0; }
    .esp-pin.l .tag { text-align: right; }
    .esp-pin .dot { width: 8px; height: 8px; border-radius: 50%; flex: 0 0 8px; }
    .esp-legend { font-size: 11.5px; color: var(--tia-text-soft); line-height: 1.8; }
    .esp-legend .esp-badge { margin-right: 4px; }
    /* device */
    table.esp-kv { border-collapse: collapse; font-size: 12px; min-width: 300px; }
    table.esp-kv td { padding: 2px 8px 2px 0; vertical-align: top; }
    table.esp-kv td:first-child { color: var(--tia-text-soft); white-space: nowrap; }
    .esp-pill { display: inline-block; padding: 0 8px; border-radius: 9px; color: #fff; font-weight: 700; font-size: 11px; }
    .esp-pill.run { background: var(--tia-live); } .esp-pill.stop { background: #c27c0e; } .esp-pill.none { background: #6b7a80; }
  `);

  /* ------------------------------------------------------- small builders */
  function sel(options, value, onchange, attrs) {
    const s = T.el('select', Object.assign({ class: 'tia-input', onchange: (e) => onchange(e.target.value) }, attrs || {}));
    options.forEach((o) => {
      const [v, label, extra] = Array.isArray(o) ? o : [o, o];
      s.appendChild(T.el('option', Object.assign({ value: v, selected: String(v) === String(value) }, extra || {}), label));
    });
    return s;
  }
  function num(value, min, max, def, onchange, title) {
    return T.el('input', {
      class: 'tia-input esp-num', type: 'number', min, max, value: value != null ? value : def, title,
      onchange: (e) => {
        const v = Math.max(min, Math.min(max, parseInt(e.target.value, 10)));
        e.target.value = isNaN(v) ? def : v;
        onchange(isNaN(v) ? def : v);
      },
    });
  }
  function btn(label, onclick, cls, title) {
    return T.el('button', { class: 'tia-tb-btn' + (cls ? ' ' + cls : ''), onclick, title: title || label }, label);
  }

  /* ------------------------------------------------------- I/O table */
  function pinOptions(dir, current, tagName) {
    const used = pinOwners(tagName);
    const opts = [['', '—']];
    PIN.pins.forEach((p) => {
      if (dir === 'ain' && !p.adc) return;   // the PLC lists only ADC pins it can use
      if ((dir === 'out' || dir === 'pwm') && p.output === false) return;
      let label = 'GPIO' + p.gpio;
      if (p.adc && dir === 'ain') label += '  (' + p.adc + ')';
      if (dir === 'in' && p.pulls === false && !p.reserved) label += '  (no internal pull)';
      const extra = {};
      if (p.reserved) { label += '  – reserved'; extra.disabled = true; extra.title = p.reserved; }
      else if (used[p.gpio]) { label += '  – used by ' + used[p.gpio]; extra.title = 'already assigned'; }
      else if (p.warn) { label += '  ⚠'; extra.title = p.warn; }
      if (String(p.gpio) === String(current)) delete extra.disabled;
      opts.push([String(p.gpio), label, extra]);
    });
    return opts;
  }

  // the chains' channels as extra choices in a tag's pin list
  function srOptions(dir, current, tagName) {
    const used = {};
    ensureGpio().forEach((g) => { if (isSrMapped(g) && g.tag !== tagName) used[g.sr + ':' + (+g.bit)] = g.tag; });
    return ensureSrs().filter((s) => srDir(s) === dir).map((s) =>
      T.el('optgroup', { label: s.id + ' · 74HC' + srType(s) + (dir === 'in' ? ' inputs' : ' outputs') },
        Array.from({ length: srChips(s) * 8 }, (_, b) => {
          const v = 'sr:' + s.id + ':' + b, u = used[s.id + ':' + b];
          return T.el('option', { value: v, selected: v === current, title: chPin(s, b) },
            s.id + ' · ' + chName(s, b) + (u ? '  – used by ' + u : ''));
        })));
  }

  // the I2C modules' channels as extra choices in a tag's pin list
  function xOptions(dir, current, tagName) {
    const used = {};
    ensureGpio().forEach((g) => { if (isXMapped(g) && g.tag !== tagName) used[g.i2c + ':' + (+g.bit)] = g.tag; });
    return ensureI2c().devices.filter((d) => xServes(d, dir)).map((d) => {
      const ty = xType(d);
      return T.el('optgroup', { label: d.id + ' · ' + ty.label + ' at ' + hex(d.addr) },
        Array.from({ length: ty.n }, (_, b) => {
          const v = 'x:' + d.id + ':' + b, u = used[d.id + ':' + b];
          return T.el('option', { value: v, selected: v === current }, d.id + ' · ' + ty.ch(b) + (u ? '  – used by ' + u : ''));
        }));
    });
  }

  function buildIoTable(refresh) {
    const tags = (T.project.tags || []).filter((t) => t.name && (t.dataType === 'Bool' || isNumeric(t)));
    const v = validate();
    const table = T.el('table', { class: 'tia-table esp-io' });
    table.appendChild(T.el('tr', {}, ['Tag', 'Address', 'Type', 'Function', 'Pin', 'Options', 'Notes'].map((h) => T.el('th', {}, h))));
    if (!tags.length) {
      table.appendChild(T.el('tr', {}, T.el('td', { colspan: 7, class: 'tia-muted' }, 'No Bool or numeric tags yet — add some in PLC tags.')));
      return table;
    }
    tags.forEach((t) => {
      const g = gpioEntry(t.name) || {};
      const mapped = isMapped(g);              // function AND pin chosen
      const dir = g.dir || '';                 // chosen function (the pin may still be missing)
      const numeric = isNumeric(t);
      const fnOpts = numeric
        ? [['', '— memory only'], ['ain', 'Analog input (ADC)'], ['pwm', 'PWM output']]
        : [['', '— memory only'], ['in', 'Digital input'], ['out', 'Digital output']];
      const onSr = isSrMapped(g), onX = isXMapped(g);
      const xd = onX ? xById(g.i2c) : null;
      const fnSel = sel(fnOpts, dir, (val) => {
        if (!val) setGpio(t.name, { dir: '', pin: null, sr: undefined, i2c: undefined, bit: undefined });
        else if (onX) {
          // a module channel stays only if the module serves that function
          setGpio(t.name, xd && xServes(xd, val) ? { dir: val } : { dir: val, i2c: undefined, bit: undefined });
        } else if (onSr) {
          // a chain channel stays only if the chain has that direction
          const s = srById(g.sr);
          setGpio(t.name, s && srDir(s) === val ? { dir: val } : { dir: val, sr: undefined, bit: undefined });
        } else {
          // keep the pin if it suits the new function
          const info = pinInfo(+g.pin);
          const ok = mapped && info && !(val === 'ain' && !info.adc);
          setGpio(t.name, { dir: val, pin: ok ? +g.pin : null });
        }
        refresh();
      });
      const cur = onSr ? 'sr:' + g.sr + ':' + (+g.bit) : onX ? 'x:' + g.i2c + ':' + (+g.bit) : (isPinMapped(g) ? String(g.pin) : '');
      const fdir = dir || defaultDir(t);
      const pinSel = sel(pinOptions(fdir, cur, t.name), cur, (val) => {
        // '' keeps the function: unmapped until a pin is chosen
        const none = { pin: null, sr: undefined, i2c: undefined, bit: undefined };
        if (val === '') setGpio(t.name, none);
        else if (val.indexOf('sr:') === 0) {
          const parts = val.split(':');
          setGpio(t.name, Object.assign(none, { sr: parts[1], bit: parseInt(parts[2], 10), dir: fdir }));
        } else if (val.indexOf('x:') === 0) {
          const parts = val.split(':');
          setGpio(t.name, Object.assign(none, { i2c: parts[1], bit: parseInt(parts[2], 10), dir: fdir }));
        } else setGpio(t.name, Object.assign(none, { pin: parseInt(val, 10), dir: fdir }));
        refresh();
      });
      if (fdir === 'in' || fdir === 'out') srOptions(fdir, cur, t.name).forEach((og) => pinSel.appendChild(og));
      xOptions(fdir, cur, t.name).forEach((og) => pinSel.appendChild(og));
      const xType_ = xd ? String(xd.type) : '';

      let opt = T.el('span', { class: 'tia-muted' }, '—');
      if (dir === 'in') {
        // pulls: GPIO up/down; MCP23017 up only; PCF8574 / 165 none (weak-high / external)
        const pull = onSr || xType_ === 'pcf8574' ? null
          : xType_ === 'mcp23017'
            ? sel([['up', 'pull-up (100 k)'], ['none', 'no pull']], g.pull === 'none' ? 'none' : 'up',
              (val) => { setGpio(t.name, { pull: val }); refresh(); }, { title: "The MCP23017's internal pull-up" })
            : sel([['down', 'pull-down'], ['up', 'pull-up'], ['none', 'no pull']], g.pull || 'down',
              (val) => { setGpio(t.name, { pull: val }); refresh(); }, { title: 'Internal pull resistor' });
        opt = T.el('span', { class: 'esp-opt' },
          pull,
          num(g.debounce, 0, 1000, 0, (val) => { setGpio(t.name, { debounce: val }); }, 'Debounce (ms): filters switch bounce, 0 = off'),
          T.el('span', { class: 'tia-muted' }, 'ms'),
          T.el('label', { title: 'Active-low: pin LOW = TRUE (button to GND with pull-up)' },
            T.el('input', { type: 'checkbox', checked: !!g.activeLow, onchange: (e) => { setGpio(t.name, { activeLow: e.target.checked }); } }),
            ' inv'));
      } else if (dir === 'out') {
        opt = T.el('label', { title: 'Active-low: TRUE drives the pin LOW (e.g. relay boards)' },
          T.el('input', { type: 'checkbox', checked: !!g.activeLow, onchange: (e) => { setGpio(t.name, { activeLow: e.target.checked }); } }),
          ' active-low');
      } else if (dir === 'pwm') {
        opt = T.el('span', { class: 'esp-opt' },
          num(g.freq != null ? g.freq : 1000, PIN.board.pwmMinHz, PIN.board.pwmMaxHz, 1000,
            (val) => { setGpio(t.name, { freq: val }); refresh(); }, 'PWM frequency (Hz)'),
          T.el('span', { class: 'tia-muted' }, 'Hz · duty = value 0.0–1.0'));
      } else if (dir === 'ain') {
        const ads = xType_ === 'ads1115';
        opt = T.el('span', { class: 'esp-opt' },
          ads ? sel(ADS_RANGES.map(([v, l]) => [String(v), l]), String(g.range || 4096),
            (val) => { setGpio(t.name, { range: parseInt(val, 10) }); refresh(); },
            { title: 'ADS1115 full-scale range. Never above the supply voltage at the input, whatever the range' }) : null,
          sel([['s7', ads ? '0–27648 = 0–range (S7)' : '0–27648 (S7)'], ['raw', ads ? '±32767 raw' : '0–4095 raw'], ['mv', 'millivolts']], g.mode || 's7',
            (val) => { setGpio(t.name, { mode: val }); }, { title: 'Value written to the tag each scan' }),
          sel([['0', 'no smoothing'], ['1', 'weak (4)'], ['2', 'medium (16)'], ['3', 'strong (32)']], String(g.smooth || 0),
            (val) => { setGpio(t.name, { smooth: parseInt(val, 10) }); }, { title: 'Smoothing over N scans, like an S7 analog module' }));
      }

      const note = v.byTag[t.name] || {};
      const noteCell = T.el('td', { class: 'esp-note' });
      if (note.err) noteCell.appendChild(T.el('div', { class: 'e' }, '✖ ' + note.err));
      if (note.warn) noteCell.appendChild(T.el('div', { class: 'w' }, '⚠ ' + note.warn));
      if (xType_ === 'pcf8574' && dir === 'out' && !note.err && !note.warn)
        noteCell.appendChild(T.el('div', { class: 'tia-muted' }, 'PCF8574 pins only sink current: wire the load from 3V3 and tick active-low'));
      const badge = mapped ? T.el('span', { class: 'esp-badge esp-' + dir, style: { marginRight: '4px' } },
        { in: 'DI', out: 'DQ', pwm: 'PWM', ain: 'AI' }[dir]) : null;
      table.appendChild(T.el('tr', {},
        T.el('td', {}, badge, t.name),
        T.el('td', { class: 'esp-mono' }, t.address || ''),
        T.el('td', {}, t.dataType),
        T.el('td', {}, fnSel),
        T.el('td', {}, pinSel),
        T.el('td', {}, opt),
        noteCell));
    });
    return table;
  }

  function summary() {
    const n = { in: 0, out: 0, pwm: 0, ain: 0 };
    let sr = 0, x = 0;
    ensureGpio().forEach((g) => { if (isMapped(g) && n[g.dir] != null) { n[g.dir]++; if (isSrMapped(g)) sr++; if (isXMapped(g)) x++; } });
    const ext = [sr ? sr + ' on shift registers' : '', x ? x + ' on I2C modules' : ''].filter(Boolean).join(', ');
    return n.in + ' digital in · ' + n.out + ' digital out · ' + n.pwm + ' PWM · ' + n.ain + ' analog in' + (ext ? ' (' + ext + ')' : '');
  }

  /* ------------------------------------------------------- I2C section */
  function addX(type, refresh) {
    const ty = I2C_TYPES[type], bus = ensureI2c();
    let n = 1;
    while (xById(ty.prefix + n)) n++;
    const taken = bus.devices.map((d) => +d.addr);
    const addr = ty.addrs.find((a) => taken.indexOf(a) < 0);
    bus.devices.push({ id: ty.prefix + n, type, addr: addr != null ? addr : ty.addrs[0] });
    T.bus.emit('tags:changed');
    refresh();
  }
  function removeX(d, refresh) {
    const tags = ensureGpio().filter((g) => g && g.i2c === d.id).map((g) => g.tag);
    if (!confirm('Remove ' + d.id + '?' + (tags.length ? '\n' + tags.join(', ') + ' will be unmapped.' : ''))) return;
    ensureGpio().forEach((g) => { if (g && g.i2c === d.id) { g.i2c = undefined; g.bit = undefined; g.pin = null; } });
    ensureI2c().devices = ensureI2c().devices.filter((x) => x !== d);
    T.bus.emit('tags:changed');
    refresh();
  }
  const X_WIRING = {
    pcf8574: 'PCF8574 module: VCC -> 3V3, GND, SDA, SCL (shared bus)\n' +
      '  address: A0-A2 jumpers (PCF8574 0x20-0x27, PCF8574A 0x38-0x3F)\n' +
      '  P0-P7: a pin can only SINK current (pulled high weakly when off):\n' +
      '    output: load from 3V3 to the pin (LED + resistor, relay module IN), tick active-low\n' +
      '    input : button / contact from the pin to GND, tick inv',
    mcp23017: 'MCP23017 module: VDD -> 3V3, VSS -> GND, SDA, SCL (shared bus)\n' +
      '  /RESET -> 3V3 (it must not float!), A0-A2 -> GND/3V3 for the address 0x20-0x27\n' +
      '  A0-A7 = GPA0-7, B0-B7 = GPB0-7: push-pull outputs, or inputs with an optional\n' +
      '  100 k pull-up (button to GND + pull-up + inv)',
    ads1115: 'ADS1115 module: VDD -> 3V3, GND, SDA, SCL (shared bus)\n' +
      '  ADDR -> GND 0x48, VDD 0x49, SDA 0x4A, SCL 0x4B\n' +
      '  AIN0-AIN3 against GND: 0 .. 3.3 V only (never above VDD, whatever the range);\n' +
      '  the range sets the full scale: ±4.096 V suits 0-3.3 V signals',
  };
  // a module's live state; renderDevice() updates the pills on every status poll
  function xPill(id, st) {
    const el = T.el('span', { class: 'esp-pill none', dataset: { xid: id } }, '—');
    paintPill(el, st);
    return el;
  }
  function paintPill(el, st) {
    el.className = 'esp-pill ' + (!st ? 'none' : st.online ? 'run' : 'stop');
    el.textContent = !st ? 'not connected' : st.online ? 'online' : 'not responding';
    el.title = st ? (st.type + ' at ' + hex(st.addr) + (st.errors ? ' · ' + st.errors + ' failed transfers' : '')) : 'state unknown — the PLC is not connected or runs another program';
  }
  function updateXStatus(info) {
    const by = {};
    ((info && info.i2c) || []).forEach((s) => { by[s.id] = s; });
    T.$$('[data-xid]').forEach((el) => paintPill(el, by[el.dataset.xid]));
  }

  function buildI2cSection(refresh, info) {
    const v = validate(), bus = ensureI2c();
    const box = T.el('div');
    box.appendChild(T.el('div', { class: 'esp-intro' },
      'I/O modules on one I2C bus (two GPIOs for all of them): ', T.el('b', {}, 'PCF8574'), ' (8 digital I/O), ',
      T.el('b', {}, 'MCP23017'), ' (16 digital I/O) and ', T.el('b', {}, 'ADS1115'), ' (4 analog inputs, 16 bit). ',
      'Their channels appear in the tags\' pin lists above. The PLC talks to them in the background, so they never slow ',
      'the scan; a module that stops answering reads 0 and is retried until it is back.'));
    const status = {};
    ((info && info.i2c) || []).forEach((s) => { status[s.id] = s; });
    if (bus.devices.length) {
      const bn = v.byX._bus || { errs: [], warns: [] };
      const pinSel = (k) => {
        const used = pinOwners(null, [bus, k]);
        const opts = [['', '—']];
        PIN.pins.forEach((p) => {
          if (p.output === false) return;
          let label = 'GPIO' + p.gpio;
          const extra = {};
          if (p.reserved) { label += '  – reserved'; extra.disabled = true; extra.title = p.reserved; }
          else if (used[p.gpio]) label += '  – used by ' + used[p.gpio];
          else if (p.warn) { label += '  ⚠'; extra.title = p.warn; }
          if (String(p.gpio) === String(bus[k])) delete extra.disabled;
          opts.push([String(p.gpio), label, extra]);
        });
        return sel(opts, srPinSet(bus[k]) ? String(bus[k]) : '', (val) => {
          bus[k] = val === '' ? null : parseInt(val, 10);
          T.bus.emit('tags:changed');
          refresh();
        });
      };
      box.appendChild(T.el('div', { class: 'esp-row' },
        T.el('span', { class: 'esp-badge esp-i2c' }, 'I2C bus'),
        T.el('label', { class: 'esp-opt' }, T.el('span', { class: 'esp-mono esp-role' }, 'SDA'), pinSel('sda')),
        T.el('label', { class: 'esp-opt' }, T.el('span', { class: 'esp-mono esp-role' }, 'SCL'), pinSel('scl')),
        sel([['100', '100 kHz'], ['400', '400 kHz']], String(bus.khz || 100), (val) => {
          bus.khz = parseInt(val, 10); T.bus.emit('tags:changed'); refresh();
        }, { title: '100 kHz is safest with long wires; 400 kHz for short ones' })));
      if (bn.errs.length) box.appendChild(T.el('div', { class: 'esp-banner err' }, '✖ ' + bn.errs.join(' · ')));
      if (bn.warns.length) box.appendChild(T.el('div', { class: 'esp-banner warn' }, '⚠ ' + bn.warns.join(' · ')));
    }
    bus.devices.forEach((d) => {
      const ty = xType(d) || I2C_TYPES.pcf8574, note = v.byX[d.id] || { errs: [] }, st = status[d.id];
      const live = xPill(d.id, st);
      const head = T.el('div', { class: 'esp-row' },
        T.el('span', { class: 'esp-badge esp-i2c' }, d.id),
        T.el('b', {}, ty.label + ' — ' + ty.what),
        sel(ty.addrs.map((a) => [String(a), hex(a)]), String(d.addr), (val) => {
          d.addr = parseInt(val, 10); T.bus.emit('tags:changed'); refresh();
        }, { title: ty.addrHelp }),
        live,
        btn('Remove', () => removeX(d, refresh), 'danger', 'Remove this module'));
      const chans = T.el('div', { class: 'esp-chans' }, Array.from({ length: ty.n }, (_, b) => {
        const g = ensureGpio().find((x) => isXMapped(x) && x.i2c === d.id && +x.bit === b);
        return T.el('div', { class: 'esp-ch' + (g ? ' on esp-' + g.dir : ''), title: d.id + ' ' + ty.ch(b) + (g ? ' → ' + g.tag + ' (' + g.dir + ')' : ' — free') },
          T.el('span', { class: 'n' }, ty.ch(b)), T.el('span', { class: 't' }, g ? g.tag : '·'));
      }));
      box.appendChild(T.el('div', { class: 'esp-srbox' }, head,
        note.errs.length ? T.el('div', { class: 'esp-banner err' }, '✖ ' + note.errs.join(' · ')) : null,
        chans,
        T.el('details', {}, T.el('summary', {}, 'Wiring'), T.el('pre', { class: 'esp-wire' }, X_WIRING[String(d.type)] || ''))));
    });
    box.appendChild(T.el('div', { class: 'esp-row' },
      btn('+ PCF8574 (8 I/O)', () => addX('pcf8574', refresh), '', 'Add a PCF8574 / PCF8574A I/O expander'),
      btn('+ MCP23017 (16 I/O)', () => addX('mcp23017', refresh), '', 'Add an MCP23017 I/O expander'),
      btn('+ ADS1115 (4 analog in)', () => addX('ads1115', refresh), '', 'Add an ADS1115 16-bit ADC')));
    return box;
  }

  /* ------------------------------------------------------- shift-register section */
  function addSr(type, refresh) {
    let n = 1;
    while (srById('SR' + n)) n++;
    ensureSrs().push({ id: 'SR' + n, type, chips: 1, data: null, clock: null, latch: null, enable: null });
    T.bus.emit('tags:changed');
    refresh();
  }
  function removeSr(s, refresh) {
    const tags = ensureGpio().filter((g) => g && g.sr === s.id).map((g) => g.tag);
    if (!confirm('Remove ' + s.id + '?' + (tags.length ? '\n' + tags.join(', ') + ' will be unmapped.' : ''))) return;
    ensureGpio().forEach((g) => { if (g && g.sr === s.id) { g.sr = undefined; g.bit = undefined; g.pin = null; } });
    T.project.shiftRegs = ensureSrs().filter((x) => x !== s);
    T.bus.emit('tags:changed');
    refresh();
  }
  function srPinOptions(s, key, out) {
    const used = pinOwners(null, [s, key]);
    const opts = [['', key === 'enable' ? '— (tied to GND)' : '—']];
    PIN.pins.forEach((p) => {
      if (out && p.output === false) return;
      let label = 'GPIO' + p.gpio;
      const extra = {};
      if (p.reserved) { label += '  – reserved'; extra.disabled = true; extra.title = p.reserved; }
      else if (used[p.gpio]) { label += '  – used by ' + used[p.gpio]; extra.title = 'already assigned'; }
      else if (p.warn) { label += '  ⚠'; extra.title = p.warn; }
      if (String(p.gpio) === String(s[key])) delete extra.disabled;
      opts.push([String(p.gpio), label, extra]);
    });
    return opts;
  }
  const WIRING = {
    595: '74HC595 (8 outputs each)      ESP32 / other chips\n' +
      '  SER    pin 14   chip 1    <- the SER GPIO\n' +
      '  SRCLK  pin 11   all chips <- the SRCLK GPIO\n' +
      '  RCLK   pin 12   all chips <- the RCLK GPIO\n' +
      '  /OE    pin 13   all chips <- the /OE GPIO, or GND\n' +
      '  /SRCLR pin 10   all chips -> 3V3\n' +
      "  QH'    pin 9    chip n    -> SER of chip n+1\n" +
      '  VCC    pin 16 -> 3V3, GND pin 8\n' +
      '  QA..QH = pins 15, 1-7 = Q0..Q7 of chip 1, Q8..Q15 of chip 2 ...\n' +
      '  3.3 V logic: drive LEDs or transistor / relay-module inputs, not loads',
    165: '74HC165 (8 inputs each)       ESP32 / other chips\n' +
      '  QH      pin 9   chip 1    -> the QH GPIO\n' +
      '  CLK     pin 2   all chips <- the CLK GPIO\n' +
      '  SH/LD   pin 1   all chips <- the SH/LD GPIO\n' +
      '  CLK INH pin 15  all chips <- the CLK INH GPIO, or GND\n' +
      '  SER     pin 10  chip n    <- QH of chip n+1 (last chip: GND)\n' +
      '  VCC     pin 16 -> 3V3, GND pin 8\n' +
      '  A..H = pins 11-14, 3-6 = I0..I7 of chip 1, I8..I15 of chip 2 ...\n' +
      '  every input needs a pull-up or pull-down (e.g. 10 k) - no internal ones',
  };
  function buildSrSection(refresh) {
    const v = validate();
    const box = T.el('div');
    box.appendChild(T.el('div', { class: 'esp-intro' },
      'More digital I/O from three GPIOs: a chain of up to 8 daisy-chained ', T.el('b', {}, '74HC595'),
      ' chips gives 8 outputs each, a chain of ', T.el('b', {}, '74HC165'), ' chips 8 inputs each. Their channels then appear in ',
      'the tags\' pin lists above (', T.el('code', {}, 'SR1 · Q0'), '). The PLC reads the 165s at the start of every scan and ',
      'updates the 595s at the end, so they work like any other I/O — forcing and STOP included.'));
    ensureSrs().forEach((s) => {
      const note = v.bySr[s.id] || { errs: [], warns: [] };
      const head = T.el('div', { class: 'esp-row' },
        T.el('span', { class: 'esp-badge esp-sr' }, s.id),
        T.el('b', {}, '74HC' + srType(s) + (srDir(s) === 'in' ? ' — inputs' : ' — outputs')),
        sel([1, 2, 3, 4, 5, 6, 7, 8].map((k) => [String(k), k + (k > 1 ? ' chips' : ' chip') + ' = ' + k * 8 + ' channels']),
          String(srChips(s)), (val) => { s.chips = parseInt(val, 10); T.bus.emit('tags:changed'); refresh(); },
          { title: 'How many chips are daisy-chained' }),
        btn('Remove', () => removeSr(s, refresh), 'danger', 'Remove this chain'));
      const pins = T.el('div', { class: 'esp-row' }, SR_ROLES[srType(s)].map(([key, role, help, out]) =>
        T.el('label', { class: 'esp-opt', title: help },
          T.el('span', { class: 'esp-mono esp-role' }, role),
          sel(srPinOptions(s, key, out), srPinSet(s[key]) ? String(s[key]) : '', (val) => {
            s[key] = val === '' ? null : parseInt(val, 10);
            T.bus.emit('tags:changed');
            refresh();
          }))));
      const chans = T.el('div', { class: 'esp-chans' }, Array.from({ length: srChips(s) * 8 }, (_, b) => {
        const g = ensureGpio().find((x) => isSrMapped(x) && x.sr === s.id && +x.bit === b);
        return T.el('div', { class: 'esp-ch' + (g ? ' on esp-' + srDir(s) : ''), title: chPin(s, b) + (g ? ' → ' + g.tag : ' — free') },
          T.el('span', { class: 'n' }, chName(s, b)), T.el('span', { class: 't' }, g ? g.tag : '·'));
      }));
      box.appendChild(T.el('div', { class: 'esp-srbox' }, head, pins,
        note.errs.length ? T.el('div', { class: 'esp-banner err' }, '✖ ' + note.errs.join(' · ')) : null,
        note.warns.length ? T.el('div', { class: 'esp-banner warn' }, '⚠ ' + note.warns.join(' · ')) : null,
        chans,
        T.el('details', {}, T.el('summary', {}, 'Wiring'), T.el('pre', { class: 'esp-wire' }, WIRING[srType(s)]))));
    });
    box.appendChild(T.el('div', { class: 'esp-row' },
      btn('+ 74HC595 outputs', () => addSr('595', refresh), '', 'Add a chain of 74HC595 shift registers (8 outputs per chip)'),
      btn('+ 74HC165 inputs', () => addSr('165', refresh), '', 'Add a chain of 74HC165 shift registers (8 inputs per chip)')));
    return box;
  }

  /* ------------------------------------------------------- board diagram */
  // Dev-board headers seen from the top, top to bottom. A header block has one
  // or two pin columns; numbers are GPIOs, strings are other pins. Two columns
  // are labelled outside-left / outside-right, a single column on the board's
  // outer side. left: blocks left of the module box, right: blocks right of it.
  const LAYOUTS = {
    'ESP32-S3': {
      board: 'ESP32-S3-DevKitC-1', module: ['ESP32-S3', 'WROOM-1'], usb: '▭ USB   ▭ UART  (bottom)',
      left: [{ name: 'J1', cols: [['3V3', '3V3', 'RST', 4, 5, 6, 7, 15, 16, 17, 18, 8, 3, 46, 9, 10, 11, 12, 13, 14, '5V', 'GND']] }],
      right: [{ name: 'J3', cols: [['GND', 43, 44, 1, 2, 42, 41, 40, 39, 38, 37, 36, 35, 0, 45, 48, 47, 21, 20, 19, 'GND', 'GND']] }],
      labels: { 43: 'TX', 44: 'RX' },
      note: 'ESP32-S3-DevKitC-1 (v1.0 RGB LED on GPIO48, v1.1 on GPIO38)',
    },
    'ESP32': {
      board: 'ESP32-DevKitC V4', module: ['ESP32', 'WROOM-32'], usb: '▭ USB  (bottom)',
      left: [{ name: 'J2', cols: [['3V3', 'EN', 36, 39, 34, 35, 32, 33, 25, 26, 27, 14, 12, 'GND', 13, 9, 10, 11, '5V']] }],
      right: [{ name: 'J3', cols: [['GND', 23, 22, 1, 3, 21, 'GND', 19, 18, 5, 17, 16, 4, 0, 2, 15, 8, 7, 6]] }],
      labels: { 1: 'TX', 3: 'RX' },
      note: 'ESP32-DevKitC V4 (38-pin). 30-pin "DevKit V1" boards carry the same GPIO numbers without 6–11. ' +
        'GPIO34–39 are input-only, without internal pull resistors',
    },
    'ESP32-C6': {
      board: 'ESP32-C6-DevKitC-1', module: ['ESP32-C6', 'WROOM-1'], usb: '▭ USB   ▭ UART  (bottom)',
      left: [{ name: 'J1', cols: [['3V3', 'RST', 4, 5, 6, 7, 0, 1, 8, 10, 11, 2, 3, '5V', 'GND', 'NC']] }],
      right: [{ name: 'J3', cols: [['GND', 16, 17, 15, 23, 22, 21, 20, 19, 18, 9, 'GND', 13, 12, 'GND', 'NC']] }],
      labels: { 16: 'TX', 17: 'RX' },
      note: 'ESP32-C6-DevKitC-1 (RGB LED on GPIO8, BOOT button = GPIO9). Other C6 boards use the same GPIO numbers',
    },
    'ESP32-C3': {
      board: 'ESP32-C3 SuperMini', module: ['ESP32-C3', 'SuperMini'], usb: '▭ USB-C  (top)',
      left: [{ name: '', cols: [['5V', 'GND', '3V3', 0, 1, 2, 3, 4]] }],
      right: [{ name: '', cols: [[5, 6, 7, 8, 9, 10, 20, 21]] }],
      labels: {},
      note: 'ESP32-C3 SuperMini, pin order as in the common pinout diagrams — check your board\'s silkscreen. ' +
        'LED = GPIO8 (status LED), BOOT button = GPIO9; GPIO0–4 are the analog pins',
    },
    // Waveshare ESP32-P4 boards (from their schematics): the C6 link GPIO14-19 is
    // internal, but GPIO54 (C6 reset) and GPIO6 (C6 IO2) reach some headers
    'ws-p4-nano': {
      board: 'Waveshare ESP32-P4-NANO', module: ['ESP32-P4', 'NANO'], usb: '▭ USB-C (UART)  (top)',
      left: [{ name: 'P1', cols: [
        ['3V3', 7, 8, 23, 'GND', 5, 20, 21, '3V3', 25, 26, 32, 'GND'],
        ['5V', '5V', 'GND', 37, 38, 4, 'GND', 22, 24, 'GND', 27, 33, 36]] }],
      right: [{ name: 'P2', cols: [
        ['5V', 'GND', '3V3', 'GND', 3, 2, 54, 47, 46, 45, 'C6 IO12', 'C6 IO13', 'GND'],
        ['VO4', 'GND', 0, 1, 'GND', 6, 53, 48, 'GND', 'C6 RXD', 'C6 TXD', 'C6 IO9', 'GND']] }],
      labels: { 37: 'TX', 38: 'RX' },
      note: 'Waveshare ESP32-P4-NANO, USB-C at the top. The PLC runs the GPIO39–48 bank (and P2 pin 2, VO4) at 3.3 V. ' +
        'BOOT button = GPIO35',
    },
    'ws-p4-module-devkit': {
      board: 'Waveshare ESP32-P4-Module-DEV-KIT', module: ['ESP32-P4', 'Module'], usb: '▭ USB-C UART  ▭ USB-C JTAG',
      left: [{ name: '40-pin (Raspberry Pi order)', cols: [
        ['3V3', 7, 8, 23, 'GND', 21, 20, 6, '3V3', 3, 2, 0, 'GND', 24, 33, 26, 48, 53, 47, 'GND'],
        ['5V', '5V', 'GND', 37, 38, 22, 'GND', 5, 4, 'GND', 1, 36, 32, 25, 'GND', 54, 'GND', 46, 27, 45]] }],
      right: [],
      labels: { 37: 'TX', 38: 'RX' },
      note: 'Waveshare ESP32-P4-Module-DEV-KIT 40-pin header, pin 1 (3V3) top left. The PLC runs GPIO45–48 at 3.3 V. ' +
        'BOOT button = GPIO35',
    },
    'ws-p4-wifi6': {
      board: 'Waveshare ESP32-P4-WIFI6', module: ['ESP32-P4', '+ C6'], usb: '▭ USB-C (UART)  (top)',
      left: [{ name: 'pins 1–20', cols: [[52, 51, 'GND', 31, 30, 29, 28, 'GND', 50, 49, 5, 4, 'GND', 3, 2, 8, 7, 'GND', 24, 25]] }],
      right: [{ name: 'pins 40–21', cols: [['VBUS', 'VSYS', 'GND', '3V3_EN', '3V3', 20, 21, 'GND', 22, 23, 'RUN', 26, 'GND', 27, 32,
        33, 46, 'GND', 47, 48]] }],
      labels: {},
      note: 'Waveshare ESP32-P4-WIFI6 (Raspberry Pi Pico layout), USB-C at the top. The PLC runs GPIO46–48 at 3.3 V. ' +
        'BOOT button = GPIO35 (not on the header)',
    },
  };
  // the PLC names its board (P4 boards) or just its chip; unknown: every GPIO in two columns
  function layout() {
    const b = PIN.board;
    if (b.layout && LAYOUTS[b.layout]) return LAYOUTS[b.layout];
    if (LAYOUTS[chipName()]) return LAYOUTS[chipName()];
    const gp = PIN.pins.map((p) => p.gpio), half = Math.ceil(gp.length / 2);
    return { board: chipName(), module: [chipName(), ''], usb: '', left: [{ name: '', cols: [gp.slice(0, half)] }],
      right: [{ name: '', cols: [gp.slice(half)] }], labels: {}, note: chipName() + ': all GPIOs (no drawing of this board yet)' };
  }
  const DIRCOL = { in: '#2e8b57', out: '#d07a16', pwm: '#7b52ab', ain: '#2f6fb3', sr: '#1f8a8a', i2c: '#8a5a1f' };

  function buildBoard() {
    const L = layout();
    const byPin = {};
    ensureGpio().forEach((g) => { if (isPinMapped(g)) byPin[+g.pin] = g; });
    ensureSrs().forEach((s) => SR_ROLES[srType(s)].forEach(([k, role]) => {
      if (srPinSet(s[k])) byPin[+s[k]] = { tag: s.id + ' ' + role, dir: 'sr' };
    }));
    const i2cBus = ensureI2c();
    if (i2cBus.devices.length) ['sda', 'scl'].forEach((k) => {
      if (srPinSet(i2cBus[k])) byPin[+i2cBus[k]] = { tag: 'I2C ' + k.toUpperCase(), dir: 'i2c' };
    });
    const col = (list, left) => T.el('div', { class: 'col' }, list.map((p) => {
      const isNum = typeof p === 'number';
      const long = !isNum && String(p).length > 3;   // e.g. "C6 IO12": too wide for the number box
      const info = isNum ? pinInfo(p) : null;
      const g = isNum ? byPin[p] : null;
      let cls = 'esp-pin' + (left ? ' l' : '');
      if (!isNum) cls += ' pwr';
      else if (info && info.reserved) cls += ' res';
      else if (info && info.warn) cls += ' wrn';
      const label = !isNum ? (long ? '' : p) : (L.labels[p] || String(p));
      const tip = !isNum ? p : 'GPIO' + p + (info && info.adc ? ' · ' + info.adc : '') +
        (info && info.reserved ? '\nreserved: ' + info.reserved : '') + (info && info.warn ? '\n⚠ ' + info.warn : '') +
        (g ? '\n→ ' + g.tag + ' (' + g.dir + ')' : '');
      return T.el('div', { class: cls, title: tip },
        T.el('span', { class: 'num' }, label),
        T.el('span', { class: 'dot', style: { background: g ? DIRCOL[g.dir] : 'transparent' } }),
        T.el('span', { class: 'tag' + (long ? ' other' : '') }, g ? g.tag : long ? p : (info && info.reserved && isNum ? '·' : '')));
    }));
    // two columns: labels outside on both sides; one column: on the board's outer side
    const block = (h, outerLeft) => T.el('div', { class: 'hdr' },
      T.el('div', { class: 'hname' }, h.name),
      T.el('div', { class: 'cols' }, h.cols.map((c, i) => col(c, h.cols.length === 2 ? i === 0 : outerLeft))));
    const led = PIN.board.statusLed;
    return T.el('div', { class: 'esp-board' },
      L.left.map((h) => block(h, true)),
      T.el('div', { class: 'mid' },
        T.el('div', {}, L.board),
        T.el('div', { class: 'mod' }, L.module[0], T.el('br'), L.module[1]),
        T.el('div', {}, led >= 0 ? 'Status LED: GPIO' + led : ''),
        T.el('div', {}, L.usb)),
      L.right.map((h) => block(h, false)));
  }

  /* ------------------------------------------------------- device panel */
  let _devTimer = null, _devHost = null, _lastInfo = null;
  function fmtUs(us) { return us >= 1000 ? (us / 1000).toFixed(2) + ' ms' : us + ' µs'; }
  function fmtUptime(s) {
    const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    return (d ? d + 'd ' : '') + (h ? h + 'h ' : '') + m + 'm';
  }
  function kv(rows) {
    return T.el('table', { class: 'esp-kv' }, rows.filter(Boolean).map(([k, v]) => T.el('tr', {}, T.el('td', {}, k), T.el('td', {}, v))));
  }

  function renderDevice(host, info) {
    _lastInfo = info;
    updateXStatus(info);
    T.clear(host);
    if (!info) {
      host.appendChild(T.el('div', { class: 'esp-banner info' },
        T.online && T.online.available()
          ? 'Not connected to the PLC. Press Connect in the Online group.'
          : 'This IDE is opened from a file. Open it from the PLC (http://esp32-plc.local or its IP address) to download programs and see the device.'));
      return;
    }
    const c = info.cycle || {}, d = info.device || {}, w = info.wifi || {};
    const cpu = !info.hasProgram ? T.el('span', { class: 'esp-pill none' }, 'NO PROGRAM')
      : T.el('span', { class: 'esp-pill ' + (info.running ? 'run' : 'stop') }, info.running ? 'RUN' : 'STOP');
    const plc = kv([
      ['CPU', cpu],
      ['Program', info.hasProgram ? (info.project || '(unnamed)') + '  · download #' + info.programRev : '—'],
      ['Scan time', (c.scanMs || '?') + ' ms target'],
      ['Cycle', info.running ? 'last ' + fmtUs(c.lastUs || 0) + ' · avg ' + fmtUs(c.avgUs || 0) + ' · max ' + fmtUs(c.maxUs || 0) : '—'],
      c.overruns ? ['Overruns', String(c.overruns) + ' cycle(s) longer than the scan time'] : null,
      ['Scans', String(info.scan || 0)],
      ['I/O points', String(info.ioPoints || 0) + (info.forced ? ' · ' + info.forced + ' FORCED' : '')],
      info.errors ? ['Errors', info.errors + ' · ' + (info.lastError || '')] : null,
      ['Modbus TCP', info.modbusPort ? 'port ' + info.modbusPort : 'off'],
      (info.i2c || []).length ? ['I2C modules', (info.i2c || []).map((m) => m.id + (m.online ? ' ok' : ' NOT RESPONDING') +
        (m.errors ? ' (' + m.errors + ' errors)' : '')).join(' · ')] : null,
    ]);
    const dev = kv([
      ['Chip', (d.chip || chipName()) + ' rev ' + ((d.revision || 0) / 100).toFixed(2) + ' · ' + (d.cores || 2) + ' cores'],
      ['Flash / PSRAM', (d.flashMB || '?') + ' MB / ' + (d.psramKB ? Math.round(d.psramKB / 1024) + ' MB' : 'none')],
      ['Heap', Math.round((d.heapFree || 0) / 1024) + ' KB free · min ' + Math.round((d.heapMin || 0) / 1024) + ' KB'],
      ['Program store', Math.round((d.storedBytes || 0) / 1024) + ' KB of ' + Math.round((d.maxProgramBytes || 0) / 1024) + ' KB'],
      ['Firmware', (d.firmware || '?') + ' · ESP-IDF ' + (d.idf || '?')],
      ['Uptime', fmtUptime(d.uptimeS || 0)],
    ]);
    const net = kv([
      ['Name', (w.hostname || 'esp32-plc') + '.local'],
      ['Wi-Fi', w.connected ? '"' + w.ssid + '" · ' + w.ip + ' · ' + w.rssi + ' dBm' : (w.ssid ? 'not connected to "' + w.ssid + '"' : 'not configured')],
      ['Setup AP', w.ap && w.ap.active ? '"' + w.ap.ssid + '" · ' + (w.ap.ip || '192.168.4.1') + ' · ' + w.ap.clients + ' client(s)' : 'off'],
    ]);
    host.appendChild(T.el('div', { class: 'esp-cols' }, plc, dev, net));
    host.appendChild(T.el('div', { class: 'esp-row', style: { marginTop: '8px' } },
      btn(info.running ? 'Stop CPU' : 'Start CPU', () => (info.running ? T.online.stop() : T.online.run()), info.running ? 'danger' : 'primary'),
      btn('Upload from PLC', () => T.online.upload(), '', 'Load the program stored on the PLC into the editor'),
      info.forced ? btn('Stop forcing', () => T.online.unforceAll(), '', 'Release all forced I/O') : null,
      btn('Erase program', () => {
        if (!confirm('Erase the program stored on the PLC? The CPU stops and all outputs switch off.')) return;
        T.online.api('/api/program', { method: 'DELETE' }).then(() => { T.status('Program erased on the PLC', 'ok'); refreshDevice(); })
          .catch((e) => T.status('Erase failed: ' + e.message, 'err'));
      }, 'danger'),
      btn('Restart PLC', () => {
        if (!confirm('Restart the ESP32? The program restarts from flash.')) return;
        T.online.api('/api/reboot', { method: 'POST' }).then(() => T.status('PLC restarting…', 'ok')).catch(() => {});
      })));
    host.appendChild(buildWifiForm(w));
  }

  function buildWifiForm(w) {
    const box = T.el('div', { style: { marginTop: '10px' } });
    box.appendChild(T.el('div', { class: 'esp-sec' }, 'Wi-Fi network'));
    const ssid = T.el('input', { class: 'tia-input', style: { width: '200px' }, placeholder: 'network name (SSID)', value: w.ssid || '', list: 'esp-ssids' });
    const pass = T.el('input', { class: 'tia-input', style: { width: '170px' }, placeholder: 'password', type: 'password' });
    const list = T.el('datalist', { id: 'esp-ssids' });
    const msg = T.el('span', { class: 'tia-muted' });
    const scan = btn('Scan', () => {
      msg.textContent = 'Scanning…';
      T.online.api('/api/wifi/scan').then((r) => {
        T.clear(list);
        (r.networks || []).forEach((n) => list.appendChild(T.el('option', { value: n.ssid }, n.rssi + ' dBm' + (n.secure ? '' : ' · open'))));
        msg.textContent = (r.networks || []).length + ' network(s) found — pick one in the name field';
      }).catch(() => { msg.textContent = 'Scan failed — try again'; });
    });
    const save = btn('Save & restart', () => {
      const s = ssid.value.trim(), p = pass.value;
      if (!s) { msg.textContent = 'Enter a network name'; return; }
      if (p && p.length < 8) { msg.textContent = 'WPA passwords have at least 8 characters'; return; }
      if (!confirm('Save Wi-Fi "' + s + '" and restart the PLC?\nAfterwards open http://' + ((w.hostname || 'esp32-plc') + '.local') +
        ' (or the IP shown in the serial monitor).')) return;
      T.online.api('/api/wifi', { method: 'POST', body: { ssid: s, password: p } })
        .then(() => { msg.textContent = 'Saved — the PLC restarts and joins "' + s + '".'; })
        .catch((e) => { msg.textContent = 'Failed: ' + e.message; });
    }, 'primary');
    box.appendChild(T.el('div', { class: 'esp-row' }, ssid, list, pass, scan, save, msg));
    box.appendChild(T.el('div', { class: 'tia-muted', style: { fontSize: '11.5px' } },
      'If the PLC cannot join this network it opens the setup access point "' + ((w.ap && w.ap.ssid) || 'ESP32-PLC-XXXX') +
      '" again (password in menuconfig, default plc12345); connect to it and browse to http://192.168.4.1.'));
    return box;
  }

  function refreshDevice() {
    const host = _devHost;
    if (!host || !document.body.contains(host)) { stopDevicePoll(); return; }
    if (!(T.online && T.online.connected)) { renderDevice(host, null); return; }
    // don't rebuild while the user types in the Wi-Fi form
    const a = document.activeElement;
    if (a && host.contains(a) && a.tagName === 'INPUT') return;
    T.online.api('/api/info').then((info) => renderDevice(host, info)).catch(() => renderDevice(host, null));
  }
  function stopDevicePoll() { if (_devTimer) { clearInterval(_devTimer); _devTimer = null; } }

  /* ------------------------------------------------------- the view */
  function render(host) {
    T.clear(host);
    stopDevicePoll();
    const root = T.el('div', { class: 'esp-root' });
    const intro = T.el('div', { class: 'esp-intro' });
    const ioWrap = T.el('div');
    const srWrap = T.el('div');
    const i2cWrap = T.el('div');
    const boardWrap = T.el('div');
    const refresh = () => {
      T.clear(intro); T.clear(ioWrap); T.clear(srWrap); T.clear(i2cWrap); T.clear(boardWrap);
      T.append(intro, ['Assign tags to the ' + chipName() + '\'s pins — they become the PLC\'s I/O modules. ',
        T.el('b', {}, 'Download → PLC'), ' sends the program together with this map; the ESP32 checks it against its own ',
        'board (reserved flash/PSRAM/console pins) and runs it every scan. Bool tags: digital in/out. Numeric tags: ',
        T.el('code', {}, 'PWM'), ' (value 0.0–1.0 = duty) or analog in on ', T.el('code', {}, adcText()),
        ' (use NORM_X / SCALE_X to convert). Unmapped tags stay internal memory.']);
      const v = validate();
      const psram = PIN.board.psramReserved ? ' (PSRAM: ' + PIN.board.psramPins + ' reserved)' : '';
      ioWrap.appendChild(T.el('div', { class: 'esp-row' },
        T.el('span', { class: 'esp-sum' }, summary()),
        T.el('span', { class: 'tia-muted' }, PIN.live ? '· ' + chipName() + ' pin data from the connected PLC' + psram
          : PIN.cached ? '· ' + chipName() + ' pin data from the last connected PLC (connect to refresh)'
            : '· offline ESP32-S3 pin data (connect to read the board)')));
      if (v.errors.length) ioWrap.appendChild(T.el('div', { class: 'esp-banner err' }, '✖ ' + v.errors.join(' · ')));
      const pi = ensureGpio().filter((g) => g && g.bcm != null && !isMapped(g));
      if (pi.length) {
        ioWrap.appendChild(T.el('div', { class: 'esp-banner warn' },
          'This project carries ' + pi.length + ' Raspberry Pi pin mapping(s) (BCM numbers) — assign ' + chipName() + ' GPIOs below. ',
          btn('Remove Pi mappings', () => {
            T.project.gpio = ensureGpio().filter((g) => !(g && g.bcm != null && !isMapped(g)));
            T.bus.emit('tags:changed'); refresh();
          })));
      }
      ioWrap.appendChild(buildIoTable(refresh));
      srWrap.appendChild(buildSrSection(refresh));
      i2cWrap.appendChild(buildI2cSection(refresh, _lastInfo));
      boardWrap.appendChild(T.el('div', { class: 'esp-cols' }, buildBoard(),
        T.el('div', { class: 'esp-legend' },
          T.el('div', {}, T.el('span', { class: 'esp-badge esp-in' }, 'DI'), 'digital input'),
          T.el('div', {}, T.el('span', { class: 'esp-badge esp-out' }, 'DQ'), 'digital output'),
          T.el('div', {}, T.el('span', { class: 'esp-badge esp-pwm' }, 'PWM'), 'PWM output (LEDC)'),
          T.el('div', {}, T.el('span', { class: 'esp-badge esp-ain' }, 'AI'), 'analog input (ADC)'),
          T.el('div', {}, T.el('span', { class: 'esp-badge esp-sr' }, 'SR'), 'shift-register chain pin'),
          T.el('div', {}, T.el('span', { class: 'esp-badge esp-i2c' }, 'I2C'), 'I2C bus pin'),
          T.el('div', { style: { marginTop: '6px' } }, 'Red pins are reserved, amber-outlined pins work with care (hover for details).'),
          T.el('div', { style: { maxWidth: '360px' } }, 'Layout: ' + layout().note + '.'),
          T.el('div', {}, 'Inputs are 3.3 V only — never connect 5 V or 24 V signals directly.'))));
    };

    root.appendChild(intro);
    root.appendChild(T.el('div', { class: 'esp-sec' }, 'Runtime'));
    root.appendChild(T.el('div', { class: 'esp-row' },
      T.el('label', { style: { fontWeight: '600' } }, 'Scan cycle (ms):'),
      T.el('input', {
        class: 'tia-input', type: 'number', min: 1, max: 2000, style: { width: '76px' }, value: (T.project.scanMs || 50),
        onchange: (e) => {
          const v = Math.max(1, Math.min(2000, parseInt(e.target.value, 10) || 50));
          T.project.scanMs = v; e.target.value = v; T.bus.emit('tags:changed');
        },
      }),
      T.el('span', { class: 'tia-muted' },
        'Timers are evaluated once per scan, so this is the floor on timer/blinker speed. The ESP32 runs down to 1 ms ' +
        '(see the measured cycle under Device); the in-browser simulator clamps to ≥20 ms.')));

    root.appendChild(T.el('div', { class: 'esp-sec' }, 'I/O assignment'));
    root.appendChild(ioWrap);
    root.appendChild(T.el('div', { class: 'esp-sec' }, 'Shift registers (74HC595 outputs / 74HC165 inputs)'));
    root.appendChild(srWrap);
    root.appendChild(T.el('div', { class: 'esp-sec' }, 'I2C modules (PCF8574 / MCP23017 / ADS1115)'));
    root.appendChild(i2cWrap);
    root.appendChild(T.el('div', { class: 'esp-sec' }, 'Board'));
    root.appendChild(boardWrap);
    root.appendChild(T.el('div', { class: 'esp-sec' }, 'Device'));
    _devHost = T.el('div');
    root.appendChild(_devHost);
    host.appendChild(root);

    refresh();
    renderDevice(_devHost, null);
    fetchPins().then((got) => { if (got && document.body.contains(root)) refresh(); });
    refreshDevice();
    _devTimer = setInterval(refreshDevice, 2500);
  }

  T.editors = T.editors || {};
  T.editors.esp32 = { open: render, validate, fetchPins, chip: chipName };

  console.log('[TIA] esp32 view loaded');
})(window.TIA);
