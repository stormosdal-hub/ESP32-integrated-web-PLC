# ESP32 Web PLC — a TIA-Portal-style PLC you program from the browser

The ESP32 **is** the PLC — an **ESP32-S3**, a **classic ESP32**, an **ESP32-C3** or **ESP32-C6**, or
an **ESP32-P4** with an ESP32-C6 for Wi-Fi. It serves a
Siemens-TIA-Portal-style IDE over Wi-Fi — **Ladder (LAD)**, **Function Block Diagram
(FBD)** and **Structured Control Language (SCL)** editors, tag table, block interfaces,
PLC data types, global and instance DBs, external source files and a simulator — and
runs the program you download on its own GPIO pins, like a small S7-1200, including
**Open User Communication** over TCP (`TCON`, `TDISCON`, `TSEND`, `TRCV`):

```
 browser (PC / tablet / phone)       ESP32-S3 / ESP32 / C3 / C6 / P4
 ┌──────────────────────────┐   HTTP    ┌───────────────────────────────────────┐
 │ IDE: LAD · FBD · SCL     │ ────────> │ web server ──> runtime (CPU RUN/STOP) │
 │ simulator, monitoring    │ <──────── │                  │ scan task, core 1   │
 └──────────────────────────┘           │                  ├─> PLC engine (C)    │
 SCADA / HMI ── Modbus TCP ───────────> │ Modbus server ───┘   I / Q / M memory  │
                                        │                  └─> GPIO · PWM · ADC  │
                                        └───────────────────────────────────────┘
```

It is the ESP32 sibling of the Raspberry-Pi project *TIA_Portal_Web-app*: same IDE,
same project files, same JSON API — but the runtime is a compiled C engine on the chip
instead of `plc_server.py`, and the program lives in the PLC's flash, so it **keeps
running after a power cycle**.

## What you need

- A board with one of these chips (≥ 4 MB flash; PSRAM optional):
  - **ESP32-S3** — the IDE's board view follows the **ESP32-S3-DevKitC-1**. The default.
  - **classic ESP32** (ESP32-WROOM-32 / WROVER) — the board view follows the
    **ESP32-DevKitC V4**; 30-pin "ESP32 DevKit V1" boards use the same GPIO numbers.
  - **ESP32-C3** — the board view follows the **ESP32-C3 SuperMini**.
  - **ESP32-C6** — the board view follows the **ESP32-C6-DevKitC-1**.
  - **ESP32-P4 + ESP32-C6** — the P4 has no radio; Wi-Fi runs on the board's C6 over
    SDIO (Espressif's `esp_hosted`). Board views for the Waveshare **ESP32-P4-NANO**,
    **ESP32-P4-Module-DEV-KIT** and **ESP32-P4-WIFI6** (Pico-sized). Waveshare's plain
    *ESP32-P4-Pico* has **no C6**, so no network — it can't be used.
- **ESP-IDF v5.1 or newer** (developed with v5.5.1; the P4 needs v5.5.1 as pinned in
  `main/idf_component.yml`). The first build downloads components (`espressif/mdns`;
  on the P4 also `esp_hosted` + `esp_wifi_remote`), so it needs internet once.
- Wiring is **3.3 V only**. Buttons/switches: between the pin and GND, using the
  internal pull-up (*active-low*). LEDs: through a resistor. Relays/motors: through a
  driver (transistor/MOSFET or a relay module) — never directly.

  ```
  input  (pull-up, "inv" ticked):     GPIO4  ──┤ button ├── GND
  output (LED):                       GPIO18 ──[ 330 Ω ]──|>|── GND
  analog input (0–3.1 V):             3V3 ──[ 10 kΩ pot ]── GND,  wiper ── ADC pin
                                      (S3: GPIO1–10, ESP32: GPIO32–36 or 39,
                                       P4: GPIO20–23 or a free one of GPIO49–53,
                                       C3: GPIO0–4, C6: GPIO0–6)
  24 V sensors / loads:               only through an optocoupler / relay module
  ```

## Quick start

**Easiest:** double-click **`Flash-PLC.cmd`** in the project folder. A small menu asks for
the chip, the COM port (found automatically) and what to do — build + flash + monitor,
build only, monitor, settings (menuconfig), or erase — and remembers your answers, so
next time it's Enter, Enter, Enter.

The commands use `tools\idf.ps1`, a wrapper around `idf.py` that activates ESP-IDF
first and keeps one build per chip (PowerShell; in an ESP-IDF terminal `idf.py` with
the same arguments works for the ESP32-S3).

1. **Wi-Fi (optional now).** `.\tools\idf.ps1 menuconfig` → *ESP32 Web PLC* → *Wi-Fi*:
   enter your SSID and password. You can also skip this and set Wi-Fi from the browser
   later (step 4) — that keeps the password out of the project files.
2. **Build and flash** (USB cable in the board's *UART* port; replace `COM5`):

   ```powershell
   .\tools\idf.ps1 -p COM5 flash monitor
   ```
   That builds the main folder (settings in `sdkconfig`, build in `build\`), which is
   the **ESP32-S3** unless you switch it. For a **classic ESP32** add `-Chip esp32` to
   every command — it gets its own settings file `sdkconfig.esp32` and build folder
   `build_esp32\`, so both chips stay ready side by side:

   ```powershell
   .\tools\idf.ps1 -Chip esp32 -p COM7 flash monitor
   ```
   ```powershell
   .\tools\idf.ps1 -Chip esp32 menuconfig
   ```
   (Plain `idf.py` equivalent: `idf.py -B build_esp32 -D SDKCONFIG=sdkconfig.esp32 -D IDF_TARGET=esp32 …`.)
   Shared settings come from `sdkconfig.defaults`, chip extras from
   `sdkconfig.defaults.<chip>`.

   **ESP32-C3 / ESP32-C6:** `-Chip esp32c3` / `-Chip esp32c6`. The C3 SuperMini has only
   the chip's own USB-C port: flash and watch the log through it (it may appear as a
   new COM port after the first flash).

   **ESP32-P4:** `-Chip esp32p4`, and pick your board first in *menuconfig ▸ ESP32 Web
   PLC ▸ ESP32-P4 board* (NANO is the default):

   ```powershell
   .\tools\idf.ps1 -Chip esp32p4 menuconfig
   ```
   ```powershell
   .\tools\idf.ps1 -Chip esp32p4 -p COM9 flash monitor
   ```
   Flash through the board's **USB-C "UART"** port (CH343). The C6 keeps its own
   firmware; the P4 talks to it with `esp_hosted` 2.12 / `esp_wifi_remote` 1.6. ESP-IDF
   5.5.1 supports P4 chip revisions **v0.1–v1.99**: the boot log (or `esptool chip_id`)
   shows yours — a v3.x chip needs a newer ESP-IDF.

   **VS Code ESP-IDF extension:** *Set Espressif Device Target* switches the main folder
   to that chip instead (it empties `build\` and keeps the old settings as
   `sdkconfig.old`); then *Build* before *Flash*. The wrapper follows whatever chip the
   main folder is set to, so both ways can be mixed.
3. **Open the IDE.** The serial monitor prints the address:
   `connected to "MyWiFi" - open http://192.168.1.57  or  http://esp32-plc.local`.
4. **No Wi-Fi configured, or it can't connect?** After 20 s the PLC opens the setup
   access point **`ESP32-PLC-XXXX`** (password `plc12345`). Join it, browse to
   **http://192.168.4.1**, open **ESP32 ▸ I/O config ▸ Device ▸ Wi-Fi network**,
   pick your network (*Scan*), *Save & restart*.

### First program in two minutes

The IDE starts with the **Conveyor_Demo** project, already mapped to pins (the chip of
the last PLC the browser talked to picks the column; a fresh browser assumes the S3):

| Tag | ESP32-S3 | ESP32 | ESP32-C3 | ESP32-C6 | ESP32-P4 | Function |
|---|---|---|---|---|---|---|
| `Start_PB` | **GPIO0** | **GPIO0** | **GPIO9** | **GPIO9** | **GPIO35** | the board's **BOOT button** — no wiring needed |
| `Stop_PB` | GPIO4 | GPIO4 | GPIO10 | GPIO18 | GPIO20 | push button to GND |
| `Part_Sensor` | GPIO5 | GPIO13 | GPIO20 | GPIO19 | GPIO21 | switch to GND |
| `Motor` | GPIO15 | GPIO18 | GPIO21 | GPIO20 | GPIO22 | LED + resistor (or relay driver) |
| `Run_Lamp` | GPIO16 | GPIO19 | GPIO3 | GPIO21 | GPIO23 | LED + resistor |
| `Conveyor_PWM` | GPIO17 | GPIO21 | GPIO1 | GPIO22 | GPIO26 | PWM, 1 kHz — LED brightness follows the part count |

(The P4 pins are on the headers of all three Waveshare P4 boards.)

Press **Download → PLC**. The CPU goes to **RUN**, the status LED turns green (plain LED:
on) and the editors switch to online monitoring (green = energized, dashed blue = not).
Press the board's **BOOT** button: `Motor` latches and `Run_Lamp` follows 3 s later.

## Working online

The *Online (PLC)* toolbar group (and the *Online* menu):

| Button | What it does |
|---|---|
| **Connect** | Goes online. Happens automatically when the IDE is opened from the PLC. |
| **Download → PLC** | Compiles (stops on errors), checks the I/O map, sends the program. The PLC stops, stores the program in flash, compiles it and goes to RUN. If anything fails, the previous program keeps running. |
| **Upload ← PLC** | Loads the program stored on the PLC into the editor (TIA *Upload from device*). A browser that has never saved a project does this automatically on first visit. |
| **Monitor** | Live values on the diagrams, the Simulation table and the data block view. |
| **Start / Stop CPU** | RUN / STOP. STOP switches every output off, like a real PLC. The RUN/STOP state survives a power cycle. |
| **Address** | Where the PLC is reachable (name, IP, Modbus port). |

**Modify vs. force.** While monitoring, changing a value in the Simulation table writes
it once (TIA *modify*). On a tag that is **mapped to a GPIO pin**, it becomes a **force**:
the forced value overrides the physical pin until released — the row shows an amber
**F**, the status bar an **F n** pill (click it to stop forcing), the status LED blinks
yellow. The round *momentary* button forces only while held. *Online ▸ Stop forcing*
releases everything.

Projects still save to browser storage, export to `.json`, and the simulator (*Start*)
works without any PLC — the IDE also runs from a file: double-click `web/index.html`.

## I/O assignment (ESP32 ▸ I/O config)

Each Bool or numeric tag can be connected to a pin:

| Function | Tag type | Behaviour |
|---|---|---|
| **Digital input** | Bool | pull-up / pull-down / none, **inv** (active-low), debounce 0–1000 ms |
| **Digital output** | Bool | optional active-low (relay boards) |
| **PWM output** | Int / Real | LEDC PWM, duty = tag value clamped to **0.0–1.0**, 5 Hz – 40 kHz |
| **Analog input** | Int / Real | ADC pins (**S3: GPIO1–10**, **ESP32: GPIO32–36, 39**, **P4: GPIO20–23 + free ones of GPIO49–53**, **C3: GPIO0–4**, **C6: GPIO0–6**), 0–3.1 V. Value per scan: **0–27648** (S7 analog format, default), raw 0–4095, or calibrated mV. Smoothing none / weak (4) / medium (16) / strong (32), like an S7 analog module |

Convert analog values the TIA way: `NORM_X(MIN:=0, VALUE:=Pot, MAX:=27648)` →
`SCALE_X(MIN:=0, VALUE:=…, MAX:=100)`. Limits: 8 PWM outputs using at most 4 different
frequencies; on the S3 and ESP32, ADC2 pins can't be used (their Wi-Fi owns ADC2 — the
P4's Wi-Fi is on the C6, so there ADC2 works). The classic ESP32's ADC is noticeably
non-linear below ~0.15 V and above ~3 V.

The view shows the board's header with your tags on it, and checks the map against the
**connected PLC's own pin knowledge** (`/api/pins`: chip, reserved pins). The browser
remembers it, so offline editing uses the last board it talked to. The PLC
double-checks every download.

**ESP32-S3**

| Pins | Status |
|---|---|
| 1–18, 21, 38, 47 | free (1–10 also analog) |
| 0 | BOOT button — fine as an input |
| 3, 45, 46 | strapping pins: usable, but don't drive them during reset |
| 19, 20 | native USB D−/D+ (usable; the USB port stops working) |
| 39–42 | JTAG (free unless you use an external JTAG probe) |
| 33–37 | wired to the PSRAM on octal modules (N8R8, N16R8): reserved automatically when the chip reports octal PSRAM, otherwise usable with a warning |
| 26–32 | SPI flash — reserved |
| 43, 44 | UART0 console (TX/RX) — reserved |
| 48 | status LED (DevKitC-1 v1.0; v1.1 boards have it on GPIO38 — see *menuconfig*) |

**Classic ESP32**

| Pins | Status |
|---|---|
| 4, 13, 18, 19, 21–23, 25–27, 32, 33 | free (32, 33 also analog) |
| 34, 35, 36, 39 | **input only, no internal pull-up/down** (fit an external resistor); analog capable |
| 0 | BOOT button — fine as an input |
| 2 | status LED by default (plain LED, see *Status LED*); strapping pin |
| 5, 15 | strapping pins: usable, but they put out a short PWM burst at boot |
| 14 | puts out a short PWM burst at boot |
| 12 | strapping pin (flash voltage): must be **low at reset** or the board won't boot |
| 16, 17 | PSRAM on WROVER modules: reserved when PSRAM is enabled in menuconfig, otherwise usable with a warning (free on WROOM) |
| 6–11 | SPI flash — reserved |
| 1, 3 | UART0 console (TX/RX) — reserved |
| 37, 38 | not brought out on modules — reserved |

**ESP32-C3 (SuperMini)**

| Pins | Status |
|---|---|
| 0, 1, 3, 10, 20, 21 | free (0–4 also analog; 20/21 are free because the console runs over USB) |
| 9 | BOOT button — fine as an input |
| 8 | status LED (blue, active-low; strapping pin) |
| 2 | strapping pin: must be high or open at reset |
| 4–7 | JTAG (free unless you use an external JTAG probe) |
| 18, 19 | USB D−/D+ — the only USB port (flashing, console) — reserved |
| 11–17 | SPI flash — reserved |

**ESP32-C6 (DevKitC-1)**

| Pins | Status |
|---|---|
| 0–3, 10, 11, 18–23 | free (0–6 also analog) |
| 9 | BOOT button — fine as an input |
| 8 | RGB status LED (strapping pin) |
| 4, 5, 15 | strapping pins (4/5 also JTAG) |
| 6, 7 | JTAG (free unless you use an external JTAG probe) |
| 12, 13 | native USB D−/D+ (usable; that USB port stops working) |
| 16, 17 | UART0 console (TX/RX) — reserved |
| 24–30 | SPI flash — reserved |

**ESP32-P4 (Waveshare NANO / Module-DEV-KIT / WIFI6)** — from the boards' schematics;
choose the board in menuconfig so the PLC knows which pins its parts use:

| Pins | Status |
|---|---|
| 20–23, 26, 27, 46–48 | free on all three (20–23 also analog); 32/33 too (Module-DEV-KIT: 2.2 kΩ pull-ups of the I3C connector) |
| 28–31, 49–52 | free on the WIFI6 (49–52 also analog); **Ethernet** on the NANO and Module-DEV-KIT — reserved |
| 35 | BOOT button — fine as an input (also Ethernet TXD1 on the NANO/Module-DEV-KIT, which the PLC doesn't use) |
| 2–5 | JTAG (free unless you use an external JTAG probe) |
| 7, 8 | I2C bus of the audio codec and camera/display connectors (2.2 kΩ pull-ups) |
| 24, 25 | USB-Serial-JTAG D−/D+ (usable; that USB port / second console stops working) |
| 34, 36 | strapping pins (34: Ethernet on NANO/Module-DEV-KIT) |
| 45 | switches the microSD card's power (10 kΩ pull-down) |
| 53 | enables the speaker amplifier (10 kΩ pull-down); analog capable |
| 14–19, 54 | SDIO link and reset of the ESP32-C6 (Wi-Fi) — reserved (taken from the esp_hosted settings) |
| 6 | wired to the ESP32-C6 — reserved |
| 0, 1 | 32.768 kHz crystal — reserved |
| 9–13, 39–44 | audio codec (I2S), microSD card — reserved |
| 37, 38 | UART0 console (CH343 USB-UART) — reserved |

GPIO39–48 get their I/O supply from the P4's internal LDO VO4, which these boards start at
1.8 V; the PLC switches it to **3.3 V** at boot, so header pins 45–48 are normal 3.3 V
pins (on the NANO, header pin P2-2 "VO4" then carries 3.3 V too).

## Shift registers: more I/O (74HC595 / 74HC165)

*ESP32 ▸ I/O config ▸ Shift registers* adds chains of daisy-chained shift registers, each
driven by three GPIOs (a fourth, optional, for /OE or CLK INH):

| Chain | Chips | Gives | ESP32 pins |
|---|---|---|---|
| **74HC595** | 1–8 | 8 digital **outputs** per chip: `SR1 · Q0` … `Q63` | SER, SRCLK, RCLK (+ /OE) |
| **74HC165** | 1–8 | 8 digital **inputs** per chip: `SR2 · I0` … `I63` | QH (input), CLK, SH/LD (+ CLK INH) |

Their channels then appear in each Bool tag's pin list in the I/O table, next to the GPIOs,
with the same options (inverted output, debounce and inverted input). Channels are numbered
straight through the chain: chip 1 (the one wired to the ESP32) has Q0–Q7 = QA–QH, chip 2
Q8–Q15, and so on; for the 165, I0–I7 = inputs A–H of chip 1. The section shows every
channel with the tag on it, and a *Wiring* note per chain.

The PLC reads all 165 chains at the start of each scan and shifts the 595 chains at the end
(only when something changed), so the channels behave like any other I/O: monitoring,
forcing, STOP (outputs to their off state). A 595 chain holds its outputs off (/OE high, if
wired) until the safe state is latched at start-up. A 595 powers up with random outputs, so
for anything that must not twitch while the ESP32 boots, wire /OE to a GPIO **and** a
10 kΩ pull-up to 3V3. Each chain takes about 0.2 ms per scan for 64 channels.

```
74HC595: SER(14) <- ESP32   SRCLK(11), RCLK(12) <- ESP32 (all chips)   /OE(13) -> GND or ESP32
         /SRCLR(10) -> 3V3   QH'(9) -> SER of the next chip   VCC(16) 3V3, GND(8)
74HC165: QH(9) -> ESP32     CLK(2), SH/LD(1) <- ESP32 (all chips)    CLK INH(15) -> GND or ESP32
         SER(10) <- QH of the next chip (last chip: GND)   VCC(16) 3V3, GND(8)
```

Power the chips from **3.3 V**. 165 inputs have no internal pull resistors: give every input a
pull-up or pull-down (e.g. 10 kΩ). 595 outputs are logic signals — drive LEDs or transistor /
relay-module inputs, not loads.

## I2C modules: PCF8574, MCP23017, ADS1115

*ESP32 ▸ I/O config ▸ I2C modules* sets up one I2C bus (SDA and SCL on any two free GPIOs,
100 or 400 kHz) with any mix of these modules, each at its own address:

| Module | Gives | Channels | Addresses |
|---|---|---|---|
| **PCF8574** / PCF8574A | 8 digital inputs or outputs | `PCF1 · P0` … `P7` | 0x20–0x27 / 0x38–0x3F (A0–A2) |
| **MCP23017** | 16 digital inputs or outputs | `MCP1 · A0` … `A7`, `B0` … `B7` | 0x20–0x27 (A0–A2) |
| **ADS1115** | 4 analog inputs, 16 bit | `ADS1 · AIN0` … `AIN3` | 0x48–0x4B (ADDR → GND/VDD/SDA/SCL) |

Their channels appear in the tags' pin lists (Bool tags: PCF8574/MCP23017 pins, each one an
input or an output; numeric analog tags: ADS1115 inputs). Options per channel:

- **PCF8574** — its pins can only *sink* current (they're weakly pulled high when off): wire
  outputs from 3V3 through the load (LED + resistor, relay-module input) to the pin and tick
  **active-low**; inputs are a contact from the pin to GND with **inv** ticked.
- **MCP23017** — push-pull outputs; inputs with its 100 kΩ pull-up (the default) or none.
  Tie its /RESET pin to 3V3.
- **ADS1115** — range ±6.144 / ±4.096 / ±2.048 / ±1.024 / ±0.512 / ±0.256 V (±4.096 V suits
  0–3.3 V signals), value as **0–27648** (= 0 V … the range, S7 style), raw ±32767 or mV,
  and the same smoothing as the built-in ADC. An input must never go above the module's
  supply voltage, whatever the range.

A background task runs the bus, so I2C never lengthens the scan: digital channels are
refreshed about every 2 ms, and each ADS1115 input every 5 ms × the number of inputs used
(250 conversions/s). If a module stops answering, its inputs read 0 / FALSE (like a failed S7
module) and its outputs are re-sent when it's back; *Device* and the module's badge show
"not responding", and the serial log names the module and its address. Power the modules
from 3.3 V; most module boards already carry the bus pull-up resistors.

## Data types, data blocks and SCL

Interface members, PLC data types and DB members take TIA's data types — typed freely
in the *Data type* column, with suggestions:

- every elementary type: `Bool Byte Word DWord SInt USInt Int UInt DInt UDInt Real LReal
  Time Date Time_Of_Day Char` (and `CONN_OUC`, `HW_ANY` … = Word)
- `String` / `String[n]`, `DTL`, `Array[lo..hi(, lo..hi)] of T`, `Struct` (its members
  are edited in nested rows below it), `Variant` (FC parameters)
- **PLC data types** (UDTs, project tree ▸ *PLC data types*) — written `"Name"`
- FB instances: your own FBs (`"Motor"`, a multi-instance) and the system FBs
  `TON TOF TP IEC_TIMER R_TRIG F_TRIG CTU CTD CTUD (… _INT / _DINT / _UDINT …) TCON
  TDISCON TSEND TRCV`, and `TCON_IP_v4`

All of it is laid out like a TIA data block with **standard (non-optimized) access**:
Bools packed into bytes, everything else on even addresses, big-endian, `String[n]` =
n + 2 bytes. A struct sent with `TSEND` therefore has exactly the bytes a real S7 PLC
would send — the IDE's *Offset* column shows where every member sits.

**Data blocks.** *Add new block ▸ DB* makes a global DB with its own members; a DB can
also be of a PLC data type or an instance DB of an FB. Opening a DB shows the typed
structure (expand structs and arrays), the **start values** (editable — used on the
next download, or right away in the stopped simulator) and the **monitor values**:
from the simulator, or read from the ESP32 while monitoring online.

**SCL** is TIA's typed SCL: `#local`, `"Global".member`, `"DB".arr[#i].x`, `%MW10`,
slices (`#w.%X3`, `#d.%B0`), typed literals (`16#FF`, `INT#5`, `T#2s`, `D#2024-01-31`,
`TOD#12:00:00`), `REGION`, `CASE` with constants, FB calls (`#inst(...)`,
`"InstDB"(...)`), FC calls with return values, `EN`/`ENO`, `X_TO_Y` conversions,
`MIN MAX LIMIT SEL SHL SHR ROL ROR NORM_X SCALE_X TRUNC ROUND CEIL FLOOR`,
`CountOfElements`, `LEN`, `MAX_LEN`, `RD_SYS_T` / `RD_LOC_T` (the ESP32 sets its clock
by SNTP once on Wi-Fi; time zone in *menuconfig ▸ ESP32 Web PLC ▸ Clock*). Integer
arithmetic is integer arithmetic (`7 / 2 = 3`, results wrap to the type), `ROUND`
rounds half to even, as on an S7.

There is **no retentive memory**: the ESP32 starts every DB from its start values
after a download or power-up. `RETAIN` in a source file is accepted and ignored.

## External source files (generate blocks from source)

Project tree ▸ *External source files* works like TIA's:

- **Add new external file …** — pick `.scl`, `.udt` or `.db` files (exported from TIA
  or written by hand). A source can hold any number of `TYPE`, `FUNCTION`,
  `FUNCTION_BLOCK`, `ORGANIZATION_BLOCK` and `DATA_BLOCK` units.
- **Generate blocks from source** (right-click, or the button in the opened file) —
  creates or updates the PLC data types, SCL blocks and DBs it contains (it asks before
  overwriting) and compiles them; errors link to their line.
- **Generate source from blocks …** — writes SCL blocks, PLC data types and DBs out as
  a new source file (right-click a block for just that one); *Export file* saves it
  in TIA's format.

Sources are saved with the project but not downloaded to the PLC.

`examples/tcplink/` is a complete example: `TcpLink.scl` (a general PLC ⇄ PC link
over one TCP connection, its retentive history removed for the ESP32), its UDTs and
`TcpLinkDemo.db` (the DBs and a cyclic OB). Add all six files, generate them in the
order `*.udt`, `TcpLink.scl`, `TcpLinkDemo.db`, download, and talk to it from a PC:

```bash
python tools/tcplink_client.py <PLC address> --set StartCmd=1 --set Setpoint=42
```

## Open User Communication (TCP)

`TCON`, `TDISCON`, `TSEND` and `TRCV` work as on an S7-1200 (as system FBs in SCL:
`#conn(REQ := ..., ID := 1, CONNECT := #param, ...)` with a `TCON_IP_v4` parameter
block), with S7 `STATUS` codes (`7000`/`7001`/`7002`, `80A1`, `80A3`, `80A4`, `80A7`,
`80B3`, `80B6`, `80C4`, `8088` …):

- **passive** (`ActiveEstablished := FALSE`): listens on `LocalPort` and accepts one
  client; **active**: connects to `RemoteAddress:RemotePort`, retried about every second
  while refused. Up to 8 connections. `TDISCON` and CPU **STOP** close them (`TCON`
  reports `80A7` if aborted); `TCON` connects again after RUN.
- `TSEND` sends up to 8192 bytes per job; `TRCV` with `LEN > 0` waits for exactly that
  many bytes (TCP stream framing), `LEN = 0` takes what has arrived. The ESP32 keeps
  4 KB per connection until `TRCV` takes it (*menuconfig ▸ Open User Communication*;
  a full buffer just slows the sender down — keep it at least as large as your largest
  fixed `LEN`).
- The sockets are served by their own task: the scan only copies bytes, so a slow
  partner never stretches the cycle. `GET /api/ouc` lists the connections and their
  partners.
- In the **browser simulator** and the parity tests the program's own `TCON`s connect
  to each other over a built-in virtual network (an active `TCON` to the PLC's own
  address reaches a passive one on that port). The **PC emulator** opens real sockets.

**Memory.** Compiling the TcpLink example (≈ 60 KB of project JSON) takes roughly
250 KB of heap at its peak — about 140 KB of that is the parsed JSON and the SCL
compiler's scratch memory, which go to PSRAM when the board has it — and the running
program keeps roughly 100 KB (measured with the PC build, scaled for the ESP32's 32-bit
pointers). Each open connection adds its receive buffer, plus up to 8 KB while sending.
An ESP32-S3 or P4 with PSRAM handles programs of that size comfortably; without PSRAM,
and on a classic ESP32, C3 or C6 next to Wi-Fi, keep programs smaller — a download
that runs out of memory fails with *out of memory while compiling the program*.

## Scan cycle

*ESP32 ▸ I/O config ▸ Runtime ▸ Scan cycle* (1–2000 ms, default 50). Timers are
evaluated once per scan, so this is the resolution of timers and blinkers. The ESP32
runs the scan on its own CPU core with a 1 ms tick; *Device* shows the measured cycle
time (last / average / max) and counts overruns — cycles that took longer than the scan
time. The in-browser simulator clamps to ≥ 20 ms.

## Status LED

Defaults: **ESP32-S3** — the DevKitC-1's RGB LED (WS2812) on GPIO48. **ESP32** — a plain
LED on GPIO2 (the blue LED of DOIT DevKit V1 and most 30-pin boards; Espressif's own
ESP32-DevKitC has no user LED, choose *None* there). **ESP32-C3** — the SuperMini's blue LED on GPIO8
(active-low; the SuperMini *Plus* has an RGB LED there — choose WS2812). **ESP32-C6** —
the DevKitC-1's RGB LED on GPIO8. **ESP32-P4** — none (the Waveshare P4
boards only have a power LED); wire one to a free pin and select it if you like.

| RGB LED | Plain LED | Meaning |
|---|---|---|
| green | on | RUN |
| orange | slow blink | STOP |
| blue | fast blink | no program |
| yellow blinking | on with short gaps | I/O forced (in RUN) |
| purple flash | — | setup access point active, not on Wi-Fi |

Choose *none / WS2812 / plain LED* and the pin in *menuconfig ▸ ESP32 Web PLC ▸ Status LED*.

## Modbus TCP (port 502)

Same map as the Pi runtime, straight onto the S7-style memory (a Modbus write and a
`%MW` in the program hit the same bytes):

| Table | 0 – 9999 | 10000 – 19999 |
|---|---|---|
| Coils (FC01, FC05/0F) | `M` bit | `Q` bit |
| Discrete inputs (FC02) | `I` bit | |
| Holding registers (FC03, FC06/10) | `M` word | `Q` word |
| Input registers (FC04) | `I` word | |

Bit N = byte N/8, bit N%8; register N = bytes 2N, 2N+1 (big-endian). The process images
are S7-1200 sized: I 1 KB, Q 1 KB, M 8 KB. `GET /api/modbus-map` lists every tag's
Modbus address. Disable or move it in *menuconfig ▸ ESP32 Web PLC ▸ Modbus TCP server*.

## HTTP API

Compatible with the Pi's `plc_server.py`, so Automation Sim's `tiaweb` gateway and other
clients keep working.

| Request | Purpose |
|---|---|
| `GET /api/info` | CPU, program, cycle time, device, Wi-Fi |
| `GET /api/state[?dbs=A,B]` | live snapshot: `mem` (tags, members, addresses), `live`, `power`, `pins`, `forced`, `cycle`; `dbs`: the named data blocks' bytes (hex) |
| `GET /api/ouc` | Open User Communication: the program's connections and the sockets behind them |
| `GET /api/tags` | declared tags (+ `programRev`, bumps on every download) |
| `GET /api/netinfo`, `GET /api/modbus-map`, `GET /api/pins` | address info, Modbus map, usable pins |
| `POST /api/program` | download a project (JSON body) |
| `GET /api/program` / `DELETE /api/program` | upload / erase the stored project |
| `POST /api/force` `{"key":"Start_PB","value":true}` | modify, or force a GPIO-mapped tag; `"value":null` releases |
| `POST /api/unforce`, `/api/run`, `/api/stop` | stop forcing, RUN, STOP |
| `GET /api/wifi`, `GET /api/wifi/scan`, `POST /api/wifi` `{ssid,password}`, `POST /api/reboot` | network setup |

Requests that change something must be sent with `Content-Type: application/json`;
together with the CORS policy this stops other web pages in your browser from
operating the PLC.

## Try it without hardware: the PC emulator

```bash
python tools/plc_emulator.py
```

Open http://localhost:8080. It serves the IDE and the same API, running the very same
C engine (compiled with `gcc` on first start). Mapped inputs read like unwired pins;
force them from the Simulation table. It listens on this PC only; add `--host 0.0.0.0`
to open it to other machines on your network. `--chip esp32` gives it the classic
ESP32's pin rules and board view instead of the S3's (`esp32c3`, `esp32c6` likewise); `--chip esp32p4 --board nano`
(or `module`, `wifi6`, `generic`) those of a Waveshare P4 board.

## Tests

```bash
python test/parity/run_parity.py
```

Runs eleven test programs (the demo, LAD bit logic, timers, counters, math/memory
overlap, FBD, block calls with instance DBs, SCL, typed SCL with data types and DBs,
OUC connections, and the TcpLink example generated from its sources talking to a test
client) through **the IDE's own JavaScript simulator in Node** and through **the C
engine**, step by step, and compares every tag value, every live/power/pin flag, every
byte of every data block and every connection's state. It also runs the host tests of
the shift registers, I2C modules and the TCP layer behind OUC (over loopback).
`python test/parity/fuzz.py 3000` feeds randomly corrupted projects to the engine to
make sure a bad download can never crash the PLC (`PLC_STACK_LIMIT=<bytes>` checks the
stack guard's error paths too). Both need `gcc` and `node` on PATH.

```powershell
.\tools\build_all.ps1
```

Builds the firmware for all five chips plus the menuconfig test variants in
`test/config` (compile checks for options and boards the defaults leave off — not meant
for flashing) and lists warnings per configuration. It builds in side folders only, never
in your main `build\`.

## Differences from the Raspberry Pi version

The browser simulator and the ESP32 engine share these fixes (the Pi version had the
bugs in both its simulator and `plc_engine.py`):

- Timer **ET** is whole milliseconds — a fractional ET written to a `Time` tag at an
  `MD` address used to be stored as float bits and read back as garbage. Non-integers
  written to DInt/Time `D` addresses are rounded for the same reason.
- FBD **ADD/MUL** use every input pin (`in3`, `in4`, … were ignored).
- FBD **ET/CV output pins** carry the timer/counter value even without an ET/CV operand.
- An unwired FBD pin reads its operand with its own type (a numeric tag on a call-box
  pin used to arrive as 0/1).
- An FBD call box with an **open EN** executes, as in TIA (it never ran).
- Block-interface members start at their declared **default** values on the PLC too
  (the Pi runtime ignored defaults, so `Constant`s were 0).
- Raspberry-Pi pin numbers (`bcm`) in an imported project are ignored; the I/O view
  offers to remove them.

SCL became TIA's typed SCL (see *Data types, data blocks and SCL*). Programs written for
the untyped SCL keep working, with these differences where the types now matter:

- `/` on two integer operands (Int / DInt tags, members, integer literals) divides as
  integers (`7 / 2 = 3`); write `7.0 / 2` or use a `Real` for a fraction. Results
  written to a typed tag or member wrap to its type (an `Int` holds −32768…32767).
- `ROUND` rounds half to even (`ROUND(2.5) = 2`), as on an S7.
- Interface members and DB members live in typed memory: a `Real` member stores a
  32-bit float, a `Byte` member 0…255.

## Project layout

```
components/plc_core/   portable PLC engine (C): compiler + scan, SCL, JSON — no ESP-IDF deps
main/                  firmware: runtime, I/O, flash store, Wi-Fi, web server, Modbus, LED,
                       OUC sockets (ouc_net.c — also used by the emulator)
web/                   the IDE (served by the ESP32; also runs from file://)
examples/tcplink/      TcpLink: SCL + UDT + DB sources for "Generate blocks from source"
sdkconfig.defaults     build settings for every chip; sdkconfig.defaults.<chip>: chip extras
dependencies.lock.*    pinned component versions, one lock file per chip
tools/idf.ps1          idf.py wrapper (activates ESP-IDF; -Chip <chip> = own sdkconfig + build folder)
tools/build_all.ps1    builds every chip / test configuration
tools/embed_web.py     gzips web/ into the firmware at build time
tools/plc_emulator.py  PC emulator (same engine via ctypes)
tools/tcplink_client.py  PC side of the TcpLink example
test/parity/           JS-simulator-vs-C-engine parity tests and fuzzer
test/config/           menuconfig variants for build_all.ps1
partitions.csv         app 2.5 MB + program store 1 MB (fits 4 MB flash)
```

Build output: `build/` + `sdkconfig` (the main folder: ESP32-S3 unless switched),
`build_<chip>/` + `sdkconfig.<chip>` (`-Chip esp32`, `-Chip esp32p4`, …), `build_variant_*/`
(test variants), `build_host/` (PC test and emulator builds). Only `build/` and
`build_<chip>/` hold firmware for flashing.

## Troubleshooting

- **`esp32-plc.local` doesn't resolve** — use the IP from the serial monitor or your
  router. (mDNS works on Windows 10/11, macOS, Linux; Android often lacks it.)
- **Can't join Wi-Fi** — the serial monitor says why: `could not join "…": <reason>
  (reason N, signal -NN dBm)`. *Wrong password* / *network not found* are what they
  say (the ESP32 only does 2.4 GHz). **"the router did not answer"** together with a
  setup access point that no phone can see means the board's transmissions don't get
  through: check the antenna (modules ending in **-U**, e.g. WROOM-32U, need an external
  antenna on their small round connector), power it from a direct USB port with a short
  cable (no hub), try `idf.py erase-flash` + flash again (redoes the RF calibration),
  and try *menuconfig ▸ ESP32 Web PLC ▸ Wi-Fi ▸ Maximum Wi-Fi transmit power* = 11 or 8
  — some boards with a poorly matched antenna only work at reduced power.
- **`idf.py` complains about a missing Python 3.14 environment** — your ESP-IDF venv is
  for 3.11. Use the wrapper, which activates ESP-IDF with its own Python:
  `.\tools\idf.ps1 build`, `.\tools\idf.ps1 -p COM5 flash monitor`.
- **Linker/`ranlib` blocked by Device Guard** — the top-level `CMakeLists.txt` already
  builds archives without `ranlib`.
- **"Target 'esp32s3' in sdkconfig … does not match IDF_TARGET 'esp32'"** — a build for
  one chip met the other chip's settings. Use `.\tools\idf.ps1 -Chip <chip> …`: it picks
  the main folder or the chip's own folder by itself.
- **Flash says `build\esp32_web_plc.elf could not be found`** — nothing has been built
  since the target was switched (that empties `build\`). *Build* first.
- **`ninja: error: failed recompaction: Permission denied`** — VS Code's *SDK
  Configuration Editor* still holds the build folder (`ninja confserver`): close that
  tab, then build again.
- **ESP32-C3 SuperMini doesn't join Wi-Fi / drops out** — its small antenna and regulator
  often can't take full transmit power, so the C3 build starts at 9 dBm (*menuconfig ▸
  ESP32 Web PLC ▸ Wi-Fi ▸ Maximum Wi-Fi transmit power*); try 8, or a better USB cable.
- **Two PLCs on one network** — both answer to `esp32-plc.local` by default; give each
  its own name in *menuconfig ▸ ESP32 Web PLC ▸ Wi-Fi ▸ Hostname*, or use the IPs.
  Each name/IP keeps its own project in browser storage.
- **Download rejected: "GPIOxx is reserved"** — that pin is used by flash, PSRAM, the
  console, the status LED or (P4) a part of *this* board; pick another. On a P4, check
  that *menuconfig ▸ ESP32 Web PLC ▸ ESP32-P4 board* names your board.
- **ESP32-P4: "chip revision v3.x … not supported" at boot** — ESP-IDF 5.5.1 handles
  P4 revisions up to v1.99; v3.x chips need a newer ESP-IDF (Waveshare ships both).
- **ESP32-P4: no Wi-Fi / setup AP** — look for `esp_hosted` messages in the log. A line
  `Version mismatch: Host [2.12.x] > Co-proc [...]` means the C6 runs a different
  esp_hosted firmware generation than the P4 expects (RPC timeouts follow); Waveshare's
  FAQ describes reflashing the C6. The plain *ESP32-P4-Pico* has no C6 at all.
- **Program too large / "not enough memory"** — compiling needs roughly 30–50 KB of heap
  for a small project and about 2.5–3× the project's JSON size for large ones (*Device ▸
  Heap* shows what is free; *Export* shows the JSON size). Without PSRAM that means
  projects up to a few tens of KB; enable PSRAM in menuconfig if your module has it. The
  upload limit itself is set in *menuconfig ▸ ESP32 Web PLC ▸ PLC runtime* (default 256 KB).

## Safety

This is a learning tool, not a safety PLC: no authentication (anyone on your network can
operate it — keep it on a trusted network), no redundancy, 3.3 V logic. Never wire
emergency stops through it.
