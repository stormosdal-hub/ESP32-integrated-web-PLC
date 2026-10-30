# CLAUDE.md — ESP32 Web PLC (contributor / agent guide)

An ESP-IDF project: an ESP32-S3 (default), classic ESP32, ESP32-C3, ESP32-C6 or ESP32-P4
(+ ESP32-C6 for Wi-Fi) serves a TIA-Portal-style IDE (`web/`) and runs the downloaded LAD/FBD/SCL program
on its GPIO with a C engine (`components/plc_core`).
User docs: `README.md`. The IDE is a fork of the Raspberry-Pi version at
`C:\Users\Storm\OneDrive\Documents\Koding_programmering\Web_GUIs\web-apps\TIA_Portal_Web-app`;
its module contract (`T.*`, data model, `SPEC.md` there) is unchanged.

## The one rule: semantics live in two places
`web/js/sim.js` (+ `core.js` memory, `scl.js`) is the **source of truth** for what a
program does; `components/plc_core/` must behave identically. Any semantic change goes
into **both**, then:

```
python test/parity/run_parity.py      # JS simulator (Node) vs C engine, every value
python test/parity/fuzz.py 3000       # malformed projects must never crash the engine
```
Add a case to `test/parity/make_cases.js` for new instructions/behaviour (build projects
with `T.model.*` so shapes match the editors). Cases are regenerated on every run.

## Build / flash (Windows, this machine)
- ESP-IDF v5.5.1 at `C:\Users\Storm\esp\v5.5.1\esp-idf`. Its venv is Python **3.11**
  (system `python` is 3.14 and makes `export.ps1` fail). `.\tools\idf.ps1 <idf.py args>`
  activates it correctly: `build`, `-p COMx flash monitor`, `menuconfig`.
- **Chips**: the main folder (`sdkconfig` + `build/`) is whatever `CONFIG_IDF_TARGET`
  in `sdkconfig` says — S3 by default, but the user switches it with the VS Code
  extension (set-target empties `build/`, keeps `sdkconfig.old`). Don't overwrite their
  `sdkconfig`. `.\tools\idf.ps1 -Chip <other chip> …` → `sdkconfig.<chip>` +
  `build_<chip>/`. The wrapper sets `IDF_TARGET` for the run only. A running VS Code
  SDK Configuration Editor (`ninja confserver`) locks `build/`. Shared settings in
  `sdkconfig.defaults`, chip extras in `sdkconfig.defaults.<chip>`, chip-dependent
  Kconfig defaults via `default X if IDF_TARGET_ESP32`.
- `.\tools\build_all.ps1` builds all five chips + the `test/config` variants (a–c S3,
  d ESP32, e–f P4) in side folders and lists warnings; run it after Kconfig,
  `sdkconfig.defaults*` or chip-specific changes.
- **ESP32-P4**: Wi-Fi is `esp_wifi_remote` + `esp_hosted` (P4-only deps in
  `main/idf_component.yml`, pinned to 1.6.x / 2.12.x — the versions the user's C6s run
  with IDF 5.5.1; esp_hosted 3.x also breaks on Windows' 260-char path limit). One
  `dependencies.lock.<chip>` per chip (`DEPENDENCIES_LOCK` in the top CMakeLists).
  The board is a Kconfig choice (`PLC_P4_BOARD_*`); its pin tables come from Waveshare's
  schematics (NANO, Module-DEV-KIT, WIFI6 — the plain "P4-Pico" has no C6). IDF 5.5.1
  only supports P4 rev ≤ v1.99.
- **C3 / C6** are single-core: nothing may be pinned to core 1 (`SOC_CPU_CORES_NUM`;
  `FREERTOS_UNICORE` is *not* set there). The C3 is drawn as the SuperMini: console on
  USB-Serial-JTAG (UART0 GPIO20/21 freed) and Wi-Fi TX power 9 dBm by default
  (`sdkconfig.defaults.esp32c3`); the C6 as the DevKitC-1.
- Device Guard blocks some toolchain `ranlib.exe`: the top-level `CMakeLists.txt`
  builds archives with `ar qcs` and a no-op finish step. Keep that block.
- `sdkconfig` is generated from `sdkconfig.defaults`; delete `sdkconfig` after changing
  defaults, or the old values stick.
- The IDE is gzipped into the firmware by `tools/embed_web.py` at build time; editing
  `web/` and rebuilding is enough. Keep every web file referenced by `index.html`.

## Where things live
- `components/plc_core/` — portable engine, **no ESP-IDF includes** (also built by
  gcc for tests and the emulator). `plc_engine.h` public API; `plc_internal.h` IR;
  `plc_engine.c` compile + scan; `plc_scl.c` typed SCL (tokens through a 256-token
  ring, parsed and compiled one top-level statement at a time in scratch memory);
  `plc_types.c` data types + S7 standard layout (port of `types.js`); `plc_sysfb.c`
  system FBs incl. TCON/TDISCON/TSEND/TRCV and the virtual network (port of
  `sysfb.js`); `jdom` read-only JSON DOM (cJSON costs ~90 B/value — too much RAM);
  `jw` JSON writer. Compile uses an arena; OOM during compile/force longjmps out.
- `main/` — `plc_runtime` (CPU, mutex, scan task on core 1, download pipeline),
  `plc_io_esp` (GPIO/LEDC/ADC + board pin knowledge + I/O validation — **all
  per-chip pin rules live here**: `CHIP_NAME`, `BOOT_PIN`, `BOARD_LAYOUT`,
  `board_classify()`, `board_warnings()`, `board_power()`; P4 boards are `pinnote_t`
  tables and the C6 link is read from esp_hosted's `CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_*`;
  a new chip/board is an `#elif` there, a `LAYOUTS` entry in `esp32.js` and a
  `board_<chip>()` / `P4_BOARDS` entry in `tools/plc_emulator.py`), `plc_store`
  (A/B flash slots, header written last, read via mmap), `web_server` (API + gzip
  assets), `wifi_mgr` (STA + setup-AP fallback + mDNS + SNTP), `modbus_tcp`,
  `status_led`, `ouc_net` (the engine's `plc_net_t` over non-blocking sockets — no IDF
  includes, also linked into the emulator and `test/host/test_ouc_net.c`) and `ouc_esp`
  (its poll task on core 0).
- `web/js/esp32.js` — the ESP32 view (I/O map, board diagram per chip, device); pin
  data comes from `/api/pins` and is cached in localStorage. `online.js` — API
  client, monitoring, forcing, upload. `types.js` data types / layout / typed
  buffers (`T.types`, `T.inst`), `scl.js` typed SCL, `sysfb.js` system FBs + OUC
  (`T.ouc`), `sources.js` source parser / generator (`T.sources`), `extsrc.js` the
  External source files UI, `iface.js` member editor + PLC data type editor + DB view.
  Other `web/js/*` follow the Pi project's
  `CLAUDE.md` rules (classic scripts, `window.TIA`, `T.el`, `T.injectCSS`, must still
  run from `file://`).
- `tools/plc_emulator.py` + `tools/emulator/plc_emu.c` — PC emulator of the API using
  the same engine through ctypes (`--chip esp32` for the classic ESP32's pin rules;
  they mirror `plc_io_esp.c` by hand — keep both in step). `.claude/launch.json`
  starts it on :8080.

## Invariants (bit us before)
- The runtime mutex is **not recursive**: never call a `plc_rt_*` helper that locks
  from inside a locked region — use `plc_rt_status_locked()`.
- Never hold the lock across flash erase/write, Wi-Fi scans or network sends.
- `plc_destroy`: unit structs live in the arena — free their heap maps **before** the
  arena (a use-after-free the fuzzer found).
- Recursion costs stack on the 16 KB task stacks: SCL nesting is capped
  (`MAX_EXPR_DEPTH`/`MAX_STMT_DEPTH`), block calls at 16 (`PLC_MAX_CALL_DEPTH`), and
  `env.stack_limit` (10 KB in the firmware) is checked with `plc_stack_low()` in every
  recursive path (SCL parse / compile / `ev` / `run_s`, `run_unit`, `ty_parse`) — a
  new recursive path needs the check too. Don't put big buffers in the frames of
  recursive paths: move them to a non-recursive helper or `plc_tmp_alloc()`. Operator
  chains are left-deep trees as long as the chain: keep them iterative (`bin_chain`,
  `X_CHAIN`, `called_walk`). Check with `-fstack-usage` and a 16 KB thread.
- Released outputs are parked pulled to their *inactive* level, not `gpio_reset_pin`
  (which enables the pull-up). STOP drives outputs inactive.
- State-changing API requests require `Content-Type: application/json` (CSRF guard),
  matched on the **exact MIME essence** — `text/plain;application/json` is sent
  cross-site without a preflight. `online.js` always sends it. CORS preflights approve
  GET only.
- Editing `main/Kconfig.projbuild` does **not** make the next build reconfigure (ESP-IDF
  5.5 only watches `sdkconfig`): run `idf.py reconfigure` (via the wrapper), or a new
  option is missing from `sdkconfig.h` (`#if CONFIG_X < 20` then silently uses 0).
- Kconfig bools that can be disabled are **absent** from `sdkconfig.h`: test them only
  with `#if`/`#ifdef`, never in C expressions. Run `.\tools\build_all.ps1` after
  Kconfig changes (variants a–c: S3, d: classic ESP32 with PSRAM + WS2812 + unicore).
- Chip facts differ more than they look: use `soc/soc_caps.h` (`SOC_GPIO_PIN_COUNT`,
  `SOC_LEDC_*`, `SOC_RMT_MEM_WORDS_PER_CHANNEL` — 48 on the S3 but 64 on the ESP32,
  where a smaller RMT block is refused) instead of S3 numbers; ADC calibration is
  curve fitting on the S3/P4, line fitting on the ESP32 (`cali_new()`); ESP32 GPIO34–39
  are input-only **without pull resistors** (`has_pulls()`); ADC2 is only usable without
  on-chip Wi-Fi (the P4). On the Waveshare P4 boards GPIO39–48 hang off LDO VO4 (1.8 V
  at reset) — `board_power()` sets it to 3.3 V.
- esp_timer callbacks must not block: Wi-Fi mode switches / connects are posted as
  `PLCWIFI_EVENT`s and run on the default event loop.
- LEDC on the S3 cannot do 100 % duty at its maximum (14-bit) resolution: full-on is
  `ledc_stop(ch, 1)`, PWM duty is capped at 2^bits−1 (on every chip, for one code path). Pins LEDC reserved are released
  with `esp_gpio_revoke()` on program change.
- Sockets: every blocking `send()` needs `SO_SNDTIMEO` (lwIP default is forever).
- Shift registers: `project.shiftRegs` = `[{id, type:'595'|'165', chips:1..8, data, clock,
  latch, enable}]`; a tag on a chain is a `project.gpio` entry `{tag, dir, sr:'SR1', bit}`
  with no pin. Engine: `plc_sr()` + `plc_io_t.sr/bit`; firmware: `sr_apply/sr_release` in
  `plc_io_esp.c`, the shifting itself in `main/shiftreg.c` (no IDF includes — its bit order
  is checked against simulated chips by `test/host/test_shiftreg.c`, run by run_parity).
  Channel n = chip n/8 (chip 0 wired to the ESP32), QA..QH / A..H = n%8.
- I2C modules: `project.i2c` = `{sda, scl, khz, devices:[{id, type:'pcf8574'|'mcp23017'|
  'ads1115', addr}]}`; a tag on a module is `{tag, dir, i2c:'PCF1', bit, range?}`. Engine:
  `plc_i2c_bus()/plc_i2c_dev()` + `plc_io_t.i2c/bit/range_mv`. Firmware: a background task
  (`i2c_task` in `plc_io_esp.c`) owns the bus; the scan swaps values with it under
  `s_xlock` — never do I2C inside the scan. Register protocols in `main/i2c_dev.c` (no IDF
  includes), checked against simulated chips by `test/host/test_i2c_dev.c` (run_parity).
  A module that stops answering reads 0 and is re-initialised every 0.5 s.
- OUC: the `plc_net_t` callbacks run inside the scan with the runtime lock held —
  memory only (`ouc_net` copies into per-connection buffers under its own mutex); every
  socket call is in `ouc_net_poll()` on its own task. Without a driver the engine uses
  the virtual network, like the simulator (parity tests). Status codes and the
  DONE/BUSY/ERROR timing are part of the semantics: change `sysfb.js` and
  `plc_sysfb.c` together.
- Typed data: `project.types` = `[{id, name, comment, version, members}]`; a member is
  `{id, name, dataType, default, comment, members?}` (`members` for `Struct` / `Array
  of Struct`); a global DB has `members` or `dbType`, an instance DB `instanceOf`, both
  `startValues: {'a.b[2]': 'literal'}`; an FC's return is `iface.return = [] |
  [{name:'RET_VAL', dataType}]`. `project.sources = [{id, name, text}]` is never
  downloaded (`online.js` strips it). Layout rules: `types.js` header — the C port must
  give the same bytes (run_parity compares every DB byte by byte).
- `project.gpio` entries: `{tag, pin, dir:'in'|'out'|'pwm'|'ain', pull, debounce,
  activeLow, freq, mode:'s7'|'raw'|'mv', smooth:0..3}`. A missing/null `pin` = unmapped.
  Pi entries carry `bcm` and are ignored.

## Verifying UI changes
Start the emulator (`preview_start` with `plc-emulator`, or `python tools/plc_emulator.py`),
then drive the IDE in the browser pane. `window.confirm` blocks automation — stub it
(`window.confirm = () => true`) before clicking Upload / Erase / Restart.
