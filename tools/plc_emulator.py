#!/usr/bin/env python3
"""PC emulator of the ESP32 Web PLC (ESP32-S3 or classic ESP32 pin rules).

Serves the IDE (web/) and the same JSON API as the firmware, running the very
same C engine (components/plc_core) through ctypes — so you can write,
download, run and monitor programs with no ESP32 attached. GPIO-mapped inputs
read like unwired pins (FALSE / 0); drive them by toggling them in the IDE's
Simulation table while monitoring — that forces them, exactly like on the
device (the momentary button forces only while held). TCON / TSEND / TRCV open
real TCP connections from this PC (main/ouc_net.c, as on the ESP32).

    python tools/plc_emulator.py               # http://localhost:8080
    python tools/plc_emulator.py --port 8000
    python tools/plc_emulator.py --chip esp32    # classic ESP32 pins / board
    python tools/plc_emulator.py --chip esp32p4 --board nano   # or module / wifi6 / generic
    python tools/plc_emulator.py --chip esp32c3                # or esp32c6

Needs Python 3.8+ and gcc on PATH (the engine is compiled on first start).
The downloaded program is kept in build_host/emu_program.json, so it survives
an emulator restart like it survives a power cycle on the ESP32.
"""
import argparse
import ctypes
import glob
import json
import os
import posixpath
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from urllib.parse import unquote, urlparse

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WEB = os.path.join(ROOT, 'web')
CORE = os.path.join(ROOT, 'components', 'plc_core')
OUT = os.path.join(ROOT, 'build_host')
LIB = os.path.join(OUT, 'plc_emu.dll' if os.name == 'nt' else 'libplc_emu.so')
STORE = os.path.join(OUT, 'emu_program.json')
MAX_PROGRAM = 256 * 1024
BANK = 10000
MIME = {'.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml'}


# --------------------------------------------------------------- engine ----
def build_lib():
    # the engine + the TCP connections behind TCON/TSEND/TRCV (main/ouc_net.c, as on the ESP32)
    mdir = os.path.join(ROOT, 'main')
    srcs = sorted(glob.glob(os.path.join(CORE, '*.c')))
    srcs += [os.path.join(ROOT, 'tools', 'emulator', 'plc_emu.c'), os.path.join(mdir, 'ouc_net.c')]
    hdrs = glob.glob(os.path.join(CORE, '**', '*.h'), recursive=True) + [os.path.join(mdir, 'ouc_net.h')]
    newest = max(os.path.getmtime(p) for p in srcs + hdrs)
    if os.path.exists(LIB) and os.path.getmtime(LIB) >= newest:
        return
    os.makedirs(OUT, exist_ok=True)
    cmd = ['gcc', '-std=c11', '-O2', '-shared', '-I' + os.path.join(CORE, 'include'), '-I' + CORE, '-I' + mdir] + srcs + ['-lm']
    if os.name == 'nt':
        cmd.append('-lws2_32')
    else:
        cmd.insert(1, '-fPIC')
    cmd += ['-o', LIB]
    print('building engine:', os.path.basename(LIB))
    subprocess.run(cmd, check=True)


class Engine:
    """ctypes binding for tools/emulator/plc_emu.c"""

    def __init__(self):
        build_lib()
        L = self.L = ctypes.CDLL(LIB)
        vp, cp = ctypes.c_void_p, ctypes.c_char_p
        L.emu_load.restype = vp
        L.emu_load.argtypes = [cp, ctypes.c_int, ctypes.c_char_p, ctypes.c_int]
        for f in ('emu_free', 'emu_unforce', 'emu_comm_reset'):
            getattr(L, f).argtypes = [vp]
        L.emu_cycle.argtypes = [vp, ctypes.c_double]
        for f in ('emu_snapshot', 'emu_tags', 'emu_warnings', 'emu_io', 'emu_srs', 'emu_i2c', 'emu_conns'):
            getattr(L, f).restype = vp
            getattr(L, f).argtypes = [vp]
        L.emu_sockets.restype = vp
        L.emu_sockets.argtypes = []
        L.emu_modbus_map.restype = vp
        L.emu_modbus_map.argtypes = [vp, ctypes.c_int]
        L.emu_free_str.argtypes = [vp]
        L.emu_force.argtypes = [vp, cp, ctypes.c_int, ctypes.c_double]
        for f in ('emu_forced', 'emu_scan_ms', 'emu_has_logic', 'emu_io_count'):
            getattr(L, f).argtypes = [vp]
        for f in ('emu_scan_count', 'emu_errors'):
            getattr(L, f).argtypes = [vp]
            getattr(L, f).restype = ctypes.c_uint
        for f in ('emu_last_error', 'emu_name'):
            getattr(L, f).argtypes = [vp]
            getattr(L, f).restype = cp

    def load(self, text):
        err = ctypes.create_string_buffer(256)
        raw = text.encode('utf-8') if isinstance(text, str) else text
        h = self.L.emu_load(raw, len(raw), err, 256)
        return h, err.value.decode('utf-8', 'replace')

    def json(self, fn, *args):
        p = getattr(self.L, fn)(*args)
        if not p:
            return None
        try:
            return json.loads(ctypes.string_at(p).decode('utf-8'))
        finally:
            self.L.emu_free_str(p)

    def text(self, fn, h):
        v = getattr(self.L, fn)(h)
        return v.decode('utf-8', 'replace') if v else None


# --------------------------------------------- board (firmware defaults) ----
# Mirror of main/plc_io_esp.c with the default menuconfig: same pins, texts
# and checks per chip, so the IDE behaves as it does against a real board.
LED_TEXT = 'status LED (menuconfig: ESP32 Web PLC > Status LED)'
BOOT_TEXT = 'BOOT button + strapping pin: must not be held low at reset (fine as a button input)'


def board_esp32s3():
    pins = []
    for g in range(49):
        if 22 <= g <= 25:
            continue
        p = {'gpio': g, 'adc': ('ADC1_CH%d' % (g - 1)) if 1 <= g <= 10 else None, 'output': True,
             'pulls': True, 'reserved': None, 'warn': None}
        if 26 <= g <= 32:
            p['reserved'] = 'SPI flash/PSRAM bus'
        elif 33 <= g <= 37:
            p['warn'] = 'wired to PSRAM on octal (N8R8/N16R8) modules'
        elif g == 43:
            p['reserved'] = 'UART0 TX (console / USB-UART port)'
        elif g == 44:
            p['reserved'] = 'UART0 RX (console / USB-UART port)'
        pins.append(p)
    warn = {0: BOOT_TEXT, 3: "strapping pin (JTAG select): don't drive it during reset",
            45: 'strapping pin (flash voltage): must be low at reset', 46: 'strapping pin (boot mode): keep low at reset',
            19: 'USB D- : the native USB port stops working', 20: 'USB D+ : the native USB port stops working'}
    warn.update({g: 'JTAG pin: free unless you debug over external JTAG' for g in range(39, 43)})
    board = {'chip': 'ESP32-S3', 'psramReserved': False, 'psramPins': 'GPIO33-37', 'statusLed': 48}
    return board, pins, warn


def board_esp32():
    adc1 = {36: 0, 37: 1, 38: 2, 39: 3, 32: 4, 33: 5, 34: 6, 35: 7}
    pins = []
    for g in range(40):
        if g in (20, 24) or 28 <= g <= 31:
            continue
        p = {'gpio': g, 'adc': ('ADC1_CH%d' % adc1[g]) if g in adc1 else None, 'output': g < 34,
             'pulls': g < 34, 'reserved': None, 'warn': None}
        if 6 <= g <= 11:
            p['reserved'] = 'SPI flash (inside the module)'
        elif g in (37, 38):
            p['reserved'] = 'not brought out on WROOM/WROVER modules'
        elif g in (16, 17):
            p['warn'] = 'PSRAM on WROVER modules, flash on PICO-D4 (free on WROOM)'
        elif g == 1:
            p['reserved'] = 'UART0 TX (console / USB-UART chip)'
        elif g == 3:
            p['reserved'] = 'UART0 RX (console / USB-UART chip)'
        pins.append(p)
    warn = {0: BOOT_TEXT, 2: 'strapping pin: must be low or open while flashing (on-board LED on many boards)',
            5: 'strapping pin: must be high at reset; outputs a short PWM burst at boot',
            12: "strapping pin (flash voltage): high at reset = 1.8 V flash, the board won't boot",
            14: 'outputs a short PWM burst at boot', 15: 'strapping pin: outputs a short PWM burst at boot'}
    board = {'chip': 'ESP32', 'psramReserved': False, 'psramPins': 'GPIO16-17', 'statusLed': 2}
    return board, pins, warn


P4_WS_COMMON = [
    (0, True, '32.768 kHz crystal'), (1, True, '32.768 kHz crystal'),
    (6, True, 'wired to the ESP32-C6 (its IO2)'),
] + [(g, True, 'I2S to the ES8311 audio codec') for g in range(9, 14)] + [
    (g, True, 'microSD card slot') for g in range(39, 45)] + [
    (7, False, 'I2C bus of the audio codec and camera/display connectors (2.2 k pull-up)'),
    (8, False, 'I2C bus of the audio codec and camera/display connectors (2.2 k pull-up)'),
    (45, False, "switches the microSD card's power (10 k pull-down)"),
    (53, False, 'enables the on-board speaker amplifier (10 k pull-down)'),
]
P4_ETHERNET = [
    (28, True, 'Ethernet (IP101 PHY: CRS_DV)'), (29, True, 'Ethernet (IP101 PHY: RXD0)'),
    (30, True, 'Ethernet (IP101 PHY: RXD1)'), (31, True, 'Ethernet (IP101 PHY: MDC)'),
    (34, True, 'Ethernet (IP101 PHY: TXD0)'),
    (35, False, 'BOOT button + strapping pin (also Ethernet TXD1): fine as a button input'),
    (49, True, 'Ethernet (IP101 PHY: TX_EN)'), (50, True, 'Ethernet (IP101 PHY: REF_CLK)'),
    (51, True, 'Ethernet (IP101 PHY: reset)'), (52, True, 'Ethernet (IP101 PHY: MDIO)'),
]
P4_BOARDS = {   # --board: (layout, board-specific notes)
    'nano': ('ws-p4-nano', P4_ETHERNET),
    'module': ('ws-p4-module-devkit', P4_ETHERNET + [(32, False, 'I3C connector J9 (2.2 k pull-up)'),
                                                    (33, False, 'I3C connector J9 (2.2 k pull-up)')]),
    'wifi6': ('ws-p4-wifi6', []),
    'generic': (None, None),
}


def board_esp32p4(board='nano'):
    layout, notes = P4_BOARDS[board]
    adc = {g: 'ADC1_CH%d' % (g - 16) for g in range(16, 24)}
    adc.update({g: 'ADC2_CH%d' % (g - 49) for g in range(49, 55)})   # no on-chip Wi-Fi: ADC2 is usable
    pins = [{'gpio': g, 'adc': adc.get(g), 'output': True, 'pulls': True, 'reserved': None, 'warn': None}
            for g in range(55)]
    pins[37]['reserved'] = 'UART0 TX (console / USB-UART port)'
    pins[38]['reserved'] = 'UART0 RX (console / USB-UART port)'
    for g in range(14, 20):     # esp_hosted's default SDIO pins (slot 1, 4-bit)
        pins[g]['reserved'] = 'SDIO link to the ESP32-C6 (Wi-Fi)'
    pins[54]['reserved'] = 'resets the ESP32-C6 (Wi-Fi)'
    if notes is not None:
        for g, res, why in P4_WS_COMMON + notes:
            if not pins[g]['reserved']:
                pins[g]['reserved' if res else 'warn'] = why
    warn = [(35, BOOT_TEXT), (34, 'strapping pin (JTAG source select)'),
            (36, 'strapping pin: must not be held low at reset')]
    warn += [(g, 'JTAG pin: free unless you debug over external JTAG') for g in range(2, 6)]
    warn += [(24, 'USB-Serial-JTAG D- (second console / debug port): that USB port stops working'),
             (25, 'USB-Serial-JTAG D+ (second console / debug port): that USB port stops working')]
    board = {'chip': 'ESP32-P4', 'psramReserved': False, 'psramPins': 'none', 'statusLed': -1,
             'layout': layout, 'bootPin': 35}
    return board, pins, warn


def board_esp32c3():
    """ESP32-C3 SuperMini: console on the native USB (GPIO18/19), so UART0 is free"""
    pins = []
    for g in range(22):
        p = {'gpio': g, 'adc': ('ADC1_CH%d' % g) if g <= 4 else None, 'output': True,
             'pulls': True, 'reserved': None, 'warn': None}
        if 11 <= g <= 17:
            p['reserved'] = 'SPI flash (inside the chip / module)'
        elif g == 18:
            p['reserved'] = 'USB D- (the USB port: flashing and console)'
        elif g == 19:
            p['reserved'] = 'USB D+ (the USB port: flashing and console)'
        pins.append(p)
    warn = {9: BOOT_TEXT, 8: 'strapping pin: must be high at reset (on-board LED on SuperMini boards)',
            2: 'strapping pin: must be high or open at reset'}
    warn.update({g: 'JTAG pin: free unless you debug over external JTAG' for g in range(4, 8)})
    board = {'chip': 'ESP32-C3', 'psramReserved': False, 'psramPins': 'none', 'statusLed': 8}
    return board, pins, warn


def board_esp32c6():
    pins = []
    for g in range(31):
        p = {'gpio': g, 'adc': ('ADC1_CH%d' % g) if g <= 6 else None, 'output': True,
             'pulls': True, 'reserved': None, 'warn': None}
        if 24 <= g <= 30:
            p['reserved'] = 'SPI flash (inside the module)'
        elif g == 16:
            p['reserved'] = 'UART0 TX (console / USB-UART port)'
        elif g == 17:
            p['reserved'] = 'UART0 RX (console / USB-UART port)'
        pins.append(p)
    warn = {9: BOOT_TEXT, 8: 'strapping pin: must be high at reset (RGB LED on the DevKitC-1)',
            15: 'strapping pin (JTAG source select)',
            4: "strapping pin + JTAG (MTMS): don't drive it during reset",
            5: "strapping pin + JTAG (MTDI): don't drive it during reset",
            6: 'JTAG pin: free unless you debug over external JTAG', 7: 'JTAG pin: free unless you debug over external JTAG',
            12: 'USB D- : the native USB port (flashing / second console) stops working',
            13: 'USB D+ : the native USB port (flashing / second console) stops working'}
    board = {'chip': 'ESP32-C6', 'psramReserved': False, 'psramPins': 'none', 'statusLed': 8}
    return board, pins, warn


def adc_text(pins):
    """"GPIO1-10" / "GPIO32-36, GPIO39" like make_adc_text() in the firmware"""
    ok = sorted(p['gpio'] for p in pins if p['adc'] and not p['reserved'])
    runs = []
    for g in ok:
        if runs and runs[-1][1] == g - 1:
            runs[-1][1] = g
        else:
            runs.append([g, g])
    return ', '.join('GPIO%d-%d' % (a, b) if b > a else 'GPIO%d' % a for a, b in runs)


def board_pins(chip, p4_board='nano'):
    if chip == 'esp32p4':
        board, pins, warn = board_esp32p4(p4_board)
    else:
        board, pins, warn = {'esp32s3': board_esp32s3, 'esp32': board_esp32,
                             'esp32c3': board_esp32c3, 'esp32c6': board_esp32c6}[chip]()
        board.update(layout=None, bootPin=9 if chip in ('esp32c3', 'esp32c6') else 0)
        warn = list(warn.items())
    by = {p['gpio']: p for p in pins}
    if board['statusLed'] in by and not by[board['statusLed']]['reserved']:
        by[board['statusLed']].update(reserved=LED_TEXT, warn=None)
    for g, text in warn:   # like warn_pin(): never over a reservation or a board-specific note
        if g in by and not by[g]['reserved'] and not by[g]['warn']:
            by[g]['warn'] = text
    board.update(adcPins=adc_text(pins), pwmChannels=8, pwmFrequencies=4, pwmMinHz=5, pwmMaxHz=40000)
    return board, pins


BOARD, PINS = board_pins('esp32s3')   # replaced by --chip in main()
PIN_BY = {p['gpio']: p for p in PINS}


SR_ROLES = {'595': (('data', 'SER', True), ('clock', 'SRCLK', True), ('latch', 'RCLK', True), ('enable', '/OE', True)),
            '165': (('data', 'QH', False), ('clock', 'CLK', True), ('latch', 'SH/LD', True), ('enable', 'CLK INH', True))}


I2C_NAMES = {'pcf8574': 'PCF8574', 'mcp23017': 'MCP23017', 'ads1115': 'ADS1115'}
I2C_CHANNELS = {'pcf8574': 8, 'mcp23017': 16, 'ads1115': 4}


def i2c_addr_ok(t, a):
    if t == 'pcf8574':
        return 0x20 <= a <= 0x27 or 0x38 <= a <= 0x3F
    return 0x20 <= a <= 0x27 if t == 'mcp23017' else 0x48 <= a <= 0x4B


def bus_pin(name, role, g, out, owner, warns):
    """a chain / I2C bus pin, like check_sr_pin() in the firmware: error text or None"""
    info = PIN_BY.get(g)
    if not info:
        return '%s: choose a GPIO for %s' % (name, role)
    if info['reserved']:
        return '%s %s: GPIO%d is reserved (%s)' % (name, role, g, info['reserved'])
    if g in owner:
        return 'GPIO%d is used twice (%s and %s %s)' % (g, owner[g], name, role)
    owner[g] = '%s %s' % (name, role)
    if out and not info['output']:
        return '%s %s: GPIO%d is input-only' % (name, role, g)
    if info['warn']:
        warns.append('%s %s on GPIO%d: %s' % (name, role, g, info['warn']))
    return None


def validate_io(io, srs=(), i2c=None):
    """mirror of main/plc_io_esp.c plc_io_validate: (error | None, [warnings])"""
    owner, freqs, npwm, warns, used = {}, set(), 0, [], set()
    chip = BOARD['chip']
    for s in srs:   # the chains' pins first
        for key, role, out in SR_ROLES[s['type']]:
            g = s[key]
            if g < 0:
                if key == 'enable':
                    continue
                return '%s: choose a GPIO for %s' % (s['id'], role), warns
            err = bus_pin(s['id'], role, g, out, owner, warns)
            if err:
                return err, warns
    devs = (i2c or {}).get('devices') or []
    if devs:
        for k, role in (('sda', 'SDA'), ('scl', 'SCL')):
            g = i2c[k]
            err = '%s: choose a GPIO for %s' % ('I2C', role) if g < 0 else bus_pin('I2C', role, g, True, owner, warns)
            if err:
                return err, warns
        for k, d in enumerate(devs):
            if not i2c_addr_ok(d['type'], d['addr']):
                return 'I2C module %s: 0x%02X is not a %s address' % (d['id'], d['addr'], I2C_NAMES[d['type']]), warns
            for o in devs[:k]:
                if o['addr'] == d['addr']:
                    return 'I2C modules %s and %s both use address 0x%02X' % (o['id'], d['id'], d['addr']), warns
    by_x = {d['id']: d for d in devs}
    by_id = {s['id']: s for s in srs}
    for p in io:
        if p.get('i2c'):
            d, tag, bit = by_x.get(p['i2c']), p['tag'], p['bit']
            if not d or bit >= I2C_CHANNELS[d['type']]:
                return 'Tag "%s": no such I2C module channel' % tag, warns
            adc = d['type'] == 'ads1115'
            if (p['dir'] != 'ain') if adc else (p['dir'] not in ('in', 'out')):
                return 'Tag "%s": %s (%s) has %s' % (tag, d['id'], I2C_NAMES[d['type']],
                                                      'analog inputs only' if adc else 'digital inputs / outputs only'), warns
            if (d['id'], bit) in used:
                return '%s channel %d is assigned to two tags (one is "%s")' % (d['id'], bit, tag), warns
            used.add((d['id'], bit))
            continue
        if p.get('sr'):
            s, tag, bit = by_id.get(p['sr']), p['tag'], p['bit']
            if not s or bit >= s['chips'] * 8:
                return 'Tag "%s": no such shift-register channel' % tag, warns
            o595 = s['type'] == '595'
            if p['dir'] != ('out' if o595 else 'in'):
                return 'Tag "%s": %s is a 74HC%s - its channels are digital %s only' % (
                    tag, s['id'], s['type'], 'outputs' if o595 else 'inputs'), warns
            if (s['id'], bit) in used:
                return '%s %s%d is assigned to two tags (one is "%s")' % (s['id'], 'Q' if o595 else 'I', bit, tag), warns
            used.add((s['id'], bit))
            continue
        g, tag, d = p['pin'], p['tag'], p['dir']
        info = PIN_BY.get(g)
        if not info:
            return 'Tag "%s": GPIO%d does not exist on the %s' % (tag, g, chip), warns
        if info['reserved']:
            return 'Tag "%s": GPIO%d is reserved (%s)' % (tag, g, info['reserved']), warns
        if g in owner:
            return 'GPIO%d is used twice ("%s" and "%s")' % (g, owner[g], tag), warns
        owner[g] = tag
        if d in ('out', 'pwm') and not info['output']:
            return 'Tag "%s": GPIO%d is input-only and cannot drive an output' % (tag, g), warns
        if d == 'ain' and not info['adc']:
            return 'Tag "%s": GPIO%d has no usable ADC channel - analog inputs must use %s' % (tag, g, BOARD['adcPins']), warns
        if d == 'pwm':
            npwm += 1
            if npwm > 8:
                return 'Too many PWM outputs (the %s has 8 LEDC channels)' % chip, warns
            if not 5 <= p['freq'] <= 40000:
                return 'Tag "%s": PWM frequency must be 5..40000 Hz' % tag, warns
            freqs.add(p['freq'])
            if len(freqs) > 4:
                return 'PWM outputs may use at most 4 different frequencies', warns
        if info['warn'] and not (g == BOARD['bootPin'] and d == 'in'):
            warns.append('Tag "%s" on GPIO%d: %s' % (tag, g, info['warn']))
        if d == 'in' and p.get('pull') and not info['pulls']:
            warns.append('Tag "%s" on GPIO%d: this pin has no internal pull resistor - fit an external one' % (tag, g))
    return None, warns


# --------------------------------------------------------------- runtime ----
class Runtime:
    def __init__(self):
        self.eng = Engine()
        self.lock = threading.Lock()
        self.h, _ = self.eng.load('')
        self.running = False
        self.has_program = False
        self.text = None
        self.rev = 0
        self.t0 = time.monotonic()
        self.stats = {'lastUs': 0, 'avgUs': 0, 'minUs': 0, 'maxUs': 0, 'overruns': 0, 'cycles': 0}
        if os.path.exists(STORE):
            with open(STORE, encoding='utf-8') as f:
                text = f.read()
            ok, msg, _ = self._install(text)
            if ok:
                self.running = True
                print('restored program "%s" from %s' % (self.eng.text('emu_name', self.h), os.path.basename(STORE)))
            else:
                print('stored program not loaded:', msg)
        threading.Thread(target=self._loop, daemon=True).start()

    def now_ms(self):
        return (time.monotonic() - self.t0) * 1000.0

    def _install(self, text):
        h, err = self.eng.load(text)
        if not h:
            return False, err or 'compile failed', []
        io = self.eng.json('emu_io', h) or []
        verr, iowarn = validate_io(io, self.eng.json('emu_srs', h) or [], self.eng.json('emu_i2c', h))
        if verr:
            self.eng.L.emu_free(h)
            return False, verr, []
        warns = (self.eng.json('emu_warnings', h) or []) + iowarn
        old = self.h
        self.h, self.text, self.has_program = h, text, True
        self.rev += 1
        self.stats = {'lastUs': 0, 'avgUs': 0, 'minUs': 0, 'maxUs': 0, 'overruns': 0, 'cycles': 0}
        if old:
            self.eng.L.emu_free(old)
        return True, '', warns

    def download(self, text):
        with self.lock:
            ok, msg, warns = self._install(text)
            if not ok:
                return False, msg, []
            self.running = True
            with open(STORE, 'w', encoding='utf-8') as f:
                f.write(text)
            return True, '', warns

    def erase(self):
        with self.lock:
            old = self.h
            self.h, _ = self.eng.load('')
            self.eng.L.emu_free(old)
            self.has_program, self.running, self.text = False, False, None
            self.rev += 1
            if os.path.exists(STORE):
                os.remove(STORE)

    def _loop(self):
        while True:
            start = time.perf_counter()
            with self.lock:
                run = self.running and self.has_program
                period = self.eng.L.emu_scan_ms(self.h) / 1000.0 if run else 0.05
                if run:
                    self.eng.L.emu_cycle(self.h, self.now_ms())
                    us = int((time.perf_counter() - start) * 1e6)
                    s = self.stats
                    s['lastUs'] = us
                    s['minUs'] = us if not s['cycles'] else min(s['minUs'], us)
                    s['maxUs'] = max(s['maxUs'], us)
                    s['avgUs'] = us if not s['cycles'] else s['avgUs'] + (us - s['avgUs']) // 16
                    s['cycles'] += 1
            delay = period - (time.perf_counter() - start)
            if run and delay <= 0:
                self.stats['overruns'] += 1
            time.sleep(max(delay, 0.001))


RT = None


# --------------------------------------------------------------- HTTP ------
class Handler(BaseHTTPRequestHandler):
    server_version = 'ESP32-Web-PLC-Emulator/1.0'

    def log_message(self, fmt, *args):
        # args[0] is the request line, or an HTTPStatus when send_error() logs
        if '/api/state' not in (str(args[0]) if args else ''):
            sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def _send(self, code, body, ctype='application/json; charset=utf-8', extra=None):
        data = body if isinstance(body, bytes) else json.dumps(body).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Access-Control-Allow-Origin', '*')
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(data)

    def _err(self, code, msg):
        self._send(code, {'ok': False, 'error': msg})

    def _json_body(self, limit=4096):
        n = int(self.headers.get('Content-Length') or 0)
        if n > limit:
            raise ValueError('body too large')
        raw = self.rfile.read(n) if n else b''
        return raw

    def _needs_json(self):
        # MIME essence must be exactly application/json (same rule as the firmware)
        essence = (self.headers.get('Content-Type') or '').split(';')[0].strip().lower()
        if essence != 'application/json':
            self._err(415, 'Content-Type must be application/json')
            return False
        return True

    def do_HEAD(self):
        # readiness probes / link checkers: the GET response without its body
        real, self.wfile = self.wfile, BytesIO()
        try:
            self.do_GET()
            head = self.wfile.getvalue().split(b'\r\n\r\n', 1)[0] + b'\r\n\r\n'
        finally:
            self.wfile = real
        self.wfile.write(head)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Content-Length', '0')
        self.end_headers()

    # ---------------------------------------------------------------- GET
    def do_GET(self):
        path = urlparse(self.path).path
        if not path.startswith('/api/'):
            return self._static(path)
        rt, e = RT, RT.eng
        with rt.lock:
            h = rt.h
            if path == '/api/info':
                return self._send(200, {
                    'ok': True, 'running': rt.running, 'mock': True, 'scan': e.L.emu_scan_count(h),
                    'hasProgram': rt.has_program, 'project': e.text('emu_name', h) if rt.has_program else None,
                    'programRev': rt.rev, 'errors': e.L.emu_errors(h), 'lastError': e.text('emu_last_error', h),
                    'forced': e.L.emu_forced(h), 'ioPoints': e.L.emu_io_count(h), 'modbusPort': None,
                    'i2c': [{'id': d['id'], 'type': I2C_NAMES[d['type']], 'addr': d['addr'], 'online': True, 'errors': 0}
                            for d in ((e.json('emu_i2c', h) or {}).get('devices') or [])],
                    'cycle': dict(rt.stats, scanMs=e.L.emu_scan_ms(h)),
                    'device': {'chip': BOARD['chip'] + ' (PC emulator)', 'revision': 0, 'cores': 2, 'flashMB': 4, 'psramKB': 0,
                               'firmware': 'emulator', 'idf': '-', 'built': '', 'uptimeS': int(time.monotonic() - rt.t0),
                               'heapFree': 0, 'heapMin': 0, 'heapLargest': 0,
                               'storedBytes': len(rt.text.encode('utf-8')) if rt.text else 0, 'maxProgramBytes': MAX_PROGRAM},
                    'wifi': {'hostname': 'localhost', 'ssid': '(emulator)', 'connected': True, 'ip': '127.0.0.1', 'rssi': 0,
                             'ap': {'active': False, 'ssid': '', 'ip': None, 'clients': 0}}})
            if path == '/api/state':
                snap = e.json('emu_snapshot', h) or {}
                snap.update({'running': rt.running, 'programRev': rt.rev, 'cycle': dict(rt.stats, scanMs=e.L.emu_scan_ms(h))})
                return self._send(200, snap)
            if path == '/api/tags':
                return self._send(200, {'ok': True, 'programRev': rt.rev, 'tags': e.json('emu_tags', h) or []})
            if path == '/api/modbus-map':
                return self._send(200, {'ok': True, 'port': None, 'bank': BANK, 'map': e.json('emu_modbus_map', h, BANK) or {}})
            if path == '/api/ouc':
                # the program's TCON connections + the real sockets behind them
                return self._send(200, {'ok': True, 'conns': e.json('emu_conns', h) or [], 'sockets': e.json('emu_sockets') or []})
            if path == '/api/program':
                if not rt.text:
                    return self._err(404, 'no program stored on the PLC')
                return self._send(200, rt.text.encode('utf-8'))
        if path == '/api/pins':
            return self._send(200, {'ok': True, 'board': BOARD, 'pins': PINS})
        if path == '/api/netinfo':
            port = self.server.server_address[1]
            return self._send(200, {'ok': True, 'hostname': socket.gethostname(), 'mdns': 'localhost', 'port': port,
                                    'modbusPort': None, 'addresses': ['127.0.0.1'], 'urls': ['http://localhost:%d' % port]})
        if path == '/api/wifi':
            return self._send(200, {'ok': True, 'hostname': 'localhost', 'ssid': '(emulator)', 'connected': True,
                                    'ip': '127.0.0.1', 'rssi': 0, 'ap': {'active': False, 'ssid': '', 'ip': None, 'clients': 0}})
        if path == '/api/wifi/scan':
            return self._send(200, {'ok': True, 'networks': [{'ssid': 'Emulated-WiFi', 'rssi': -48, 'secure': True, 'channel': 6}]})
        return self._err(404, 'unknown endpoint')

    # ---------------------------------------------------------- POST / DELETE
    def do_POST(self):
        path = urlparse(self.path).path
        if not path.startswith('/api/'):
            return self._err(404, 'not found')
        if not self._needs_json():
            return
        rt, e = RT, RT.eng
        try:
            if path == '/api/program':
                n = int(self.headers.get('Content-Length') or 0)
                if not n:
                    return self._err(400, 'empty program')
                if n > MAX_PROGRAM:
                    return self._err(413, 'program too large (%d bytes, limit %d)' % (n, MAX_PROGRAM))
                text = self.rfile.read(n).decode('utf-8')
                ok, msg, warns = rt.download(text)
                if not ok:
                    return self._err(400, msg)
                return self._send(200, {'ok': True, 'programRev': rt.rev, 'warnings': warns})
            body = self._json_body()
            if path == '/api/force':
                req = json.loads(body or b'{}')
                key = str(req.get('key') or '')
                if not key:
                    return self._err(400, 'missing key')
                v = req.get('value')
                if v is None:
                    t, val = 0, 0.0
                elif isinstance(v, bool):
                    t, val = 1, float(v)
                elif isinstance(v, (int, float)):
                    t, val = 2, float(v)
                elif isinstance(v, str) and v.strip().lower() in ('true', 'false'):
                    t, val = 1, float(v.strip().lower() == 'true')
                else:
                    try:
                        t, val = 2, float(v)
                    except (TypeError, ValueError):
                        return self._err(400, 'value must be true/false, a number, or null')
                with rt.lock:
                    r = e.L.emu_force(rt.h, key.encode('utf-8'), t, val)
                return self._send(200, {'ok': True}) if r >= 0 else self._err(400, 'not a writable operand')
            if path == '/api/unforce':
                with rt.lock:
                    e.L.emu_unforce(rt.h)
                return self._send(200, {'ok': True})
            if path in ('/api/run', '/api/stop'):
                with rt.lock:
                    was = rt.running
                    rt.running = (path == '/api/run') and rt.has_program
                    if was and not rt.running:
                        e.L.emu_comm_reset(rt.h)  # STOP drops the TCP connections, like the PLC
                    return self._send(200, {'ok': True, 'running': rt.running})
            if path == '/api/wifi':
                return self._send(200, {'ok': True, 'restarting': False})
            if path == '/api/reboot':
                return self._send(200, {'ok': True})
        except (ValueError, UnicodeDecodeError) as ex:
            return self._err(400, str(ex))
        return self._err(404, 'unknown endpoint')

    def do_DELETE(self):
        if urlparse(self.path).path != '/api/program':
            return self._err(404, 'unknown endpoint')
        if not self._needs_json():
            return
        RT.erase()
        return self._send(200, {'ok': True})

    # ---------------------------------------------------------------- static
    def _static(self, path):
        rel = posixpath.normpath(unquote(path)).lstrip('/') or 'index.html'
        full = os.path.abspath(os.path.join(WEB, *rel.split('/')))
        if not full.startswith(WEB + os.sep) or not os.path.isfile(full):
            return self._send(404, b'Not found', 'text/plain')
        with open(full, 'rb') as f:
            data = f.read()
        return self._send(200, data, MIME.get(os.path.splitext(full)[1], 'application/octet-stream'))


class Server6(ThreadingHTTPServer):
    address_family = socket.AF_INET6

    def server_bind(self):
        # v6 only, so it can share the port with the IPv4 socket on every OS
        self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
        super().server_bind()


def make_servers(host, port):
    # browsers try ::1 first for "localhost"; with no IPv6 listener every
    # request waits ~250 ms for the IPv4 fallback, which makes monitoring lag
    hosts = {'localhost': ['127.0.0.1', '::1'], '0.0.0.0': ['0.0.0.0', '::']}.get(host, [host])
    servers = []
    for h in hosts:
        try:
            servers.append((Server6 if ':' in h else ThreadingHTTPServer)((h, port), Handler))
        except OSError as ex:
            if h == hosts[0]:
                raise
            print('note: not listening on %s (%s)' % (h, ex))
    return servers


def main():
    global RT, BOARD, PINS, PIN_BY
    ap = argparse.ArgumentParser(description='PC emulator of the ESP32 Web PLC')
    ap.add_argument('--port', type=int, default=8080)
    ap.add_argument('--host', default='localhost', help='localhost = this PC only; 0.0.0.0 = reachable from other machines')
    ap.add_argument('--chip', default='esp32s3', choices=['esp32s3', 'esp32', 'esp32p4', 'esp32c3', 'esp32c6'], help='whose pin rules and board to emulate')
    ap.add_argument('--board', default='nano', choices=sorted(P4_BOARDS), help='ESP32-P4 board (with --chip esp32p4)')
    args = ap.parse_args()
    BOARD, PINS = board_pins(args.chip, args.board)
    PIN_BY = {p['gpio']: p for p in PINS}
    RT = Runtime()
    servers = make_servers(args.host, args.port)
    for s in servers[1:]:
        threading.Thread(target=s.serve_forever, daemon=True).start()
    print('%s Web PLC emulator: http://localhost:%d   (Ctrl+C stops)' % (BOARD['chip'], args.port))
    try:
        servers[0].serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
