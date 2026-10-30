/* ============================================================================
 * plc_engine.h — portable PLC interpreter for TIA Web Practice projects.
 *
 * A C port of the IDE's simulator (web/js/sim.js, the source of truth) and of
 * the Raspberry-Pi runtime it was mirrored in (plc_engine.py). A project JSON
 * (the same object the browser POSTs to /api/program) is COMPILED once into a
 * compact in-memory form — operands resolved to memory cells, FBD boxes put in
 * evaluation order, SCL parsed to an AST — so a scan is just a walk over that
 * structure with no string handling.
 *
 * No ESP-IDF dependencies: the same files build into the firmware and into a
 * host library used by the parity tests (test/) and the PC emulator (tools/).
 *
 * Thread safety: none. The caller (main/plc_runtime.c) serialises every call
 * with one mutex, exactly like plc_server.py's Runtime.lock.
 * ==========================================================================*/
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "jw.h"

#ifdef __cplusplus
extern "C" {
#endif

/* S7-1200 sized process images (CPU 1214C: 1 KB I, 1 KB Q, 8 KB M) */
#define PLC_AREA_I_BYTES 1024
#define PLC_AREA_Q_BYTES 1024
#define PLC_AREA_M_BYTES 8192

#define PLC_MAX_CALL_DEPTH 16   /* S7-1200 nesting depth from a program-cycle OB */
#define PLC_SCL_MAX_ITER 200000 /* per-loop guard, same as scl.js */

typedef struct plc plc_t;

/* ---- Open User Communication transport (TCON/TDISCON/TSEND/TRCV) --------- */
#define PLC_MAX_CONNS 8         /* OUC connections open at the same time */

typedef struct {
    uint16_t id;            /* connection ID (CONN_OUC), 1..4095 */
    uint8_t type;           /* 11 = TCP (the only type the engine opens) */
    bool active;            /* true: connect to rip:rport; false: listen on lport */
    uint8_t rip[4];         /* remote IPv4 address (active) */
    uint16_t rport;         /* remote port (active) */
    uint16_t lport;         /* local port (passive: required; active: 0 = any) */
} plc_conn_cfg_t;

enum { PLC_NET_CONNECTING = 0, PLC_NET_CONNECTED = 1, PLC_NET_CLOSED = 2 };

/* The network behind the OUC instructions. Every call comes from inside
 * plc_scan() (scan task, runtime lock held), so none may block. Failures are
 * returned as the negated S7 STATUS word (e.g. -0x80A1). Without one
 * (plc_env_t.net == NULL) the engine uses its built-in virtual network:
 * connections between the program's own TCONs only, like the simulator. */
typedef struct {
    void *user;
    /* start listening (passive) or connecting (active): a handle >= 0, or -status */
    int (*open)(void *user, const plc_conn_cfg_t *cfg);
    /* PLC_NET_CONNECTING / PLC_NET_CONNECTED / PLC_NET_CLOSED (the partner
     * closed it, or it broke after being established), or -status */
    int (*state)(void *user, int h);
    /* take one whole message to send (copied): 0, or -status (e.g. the
     * previous message is still being sent, or it does not fit the buffer) */
    int (*send)(void *user, int h, const uint8_t *data, uint32_t len);
    /* 1: the last accepted message has been handed to TCP, 0: still
     * sending, -status: the send failed */
    int (*send_done)(void *user, int h);
    /* bytes received and not yet taken */
    uint32_t (*rx_avail)(void *user, int h);
    /* remove up to n received bytes into buf; returns how many were taken */
    uint32_t (*rx_take)(void *user, int h, uint8_t *buf, uint32_t n);
    /* close and forget the connection (also aborts a listen / connect) */
    void (*close)(void *user, int h);
} plc_net_t;

typedef struct {
    double (*now_ms)(void *user);   /* monotonic clock in milliseconds (required) */
    void *user;
    void *(*alloc)(size_t n);       /* IR + tables; NULL -> malloc */
    void *(*alloc_big)(size_t n);   /* transient JSON DOM (may be PSRAM); NULL -> alloc */
    void (*free)(void *p);          /* NULL -> free */
    /* wall clock for RD_SYS_T / RD_LOC_T: milliseconds since 1970-01-01, UTC
     * (local == false) or local time (local == true). NULL -> derived from
     * now_ms, starting at 1970-01-01 */
    double (*wall_ms)(void *user, bool local);
    const plc_net_t *net;           /* OUC transport; NULL -> virtual network */
    /* C stack the engine may use below plc_load() / plc_scan() / plc_force()
     * (bytes; 0 = unchecked). Past it a program nested too deeply fails to
     * compile, or the block call / SCL statement is cut short with a runtime
     * error, instead of overflowing the task stack. Keep room above it for
     * the caller's frames and the deepest leaf calls (printf). */
    size_t stack_limit;
} plc_env_t;

/* ---- hardware I/O points (from project.gpio) ----------------------------- */
typedef enum { PLC_IO_IN = 0, PLC_IO_OUT, PLC_IO_PWM, PLC_IO_AIN } plc_io_dir_t;
typedef enum { PLC_PULL_NONE = 0, PLC_PULL_UP, PLC_PULL_DOWN } plc_pull_t;
typedef enum { PLC_AIN_S7 = 0, PLC_AIN_RAW, PLC_AIN_MV } plc_ain_mode_t;

/* Shift-register I/O expansion (from project.shiftRegs): a chain of 1..8
 * daisy-chained 74HC595 (8 outputs each) or 74HC165 (8 inputs each). Channel n
 * of a chain is chip n/8 (chip 0 = the one wired to the ESP32), pin Q/D(n%8). */
typedef enum { PLC_SR_595 = 0, PLC_SR_165 } plc_sr_type_t;
#define PLC_SR_MAX_CHIPS 8
typedef struct {
    const char *id;         /* "SR1" ... (referenced by I/O points) */
    plc_sr_type_t type;
    uint8_t chips;          /* 1..PLC_SR_MAX_CHIPS */
    int data;               /* 595: SER (ESP32 output) / 165: QH (ESP32 input) */
    int clock;              /* 595: SRCLK / 165: CLK */
    int latch;              /* 595: RCLK (latch) / 165: SH/LD (load, active low) */
    int enable;             /* optional, -1: 595 /OE / 165 CLK INH (both active low) */
} plc_sr_t;

/* I2C I/O modules (from project.i2c): one bus, several modules on it.
 *   PCF8574   8 quasi-bidirectional pins P0..P7 (digital in or out)
 *   MCP23017  16 pins A0..A7, B0..B7 = channels 0..15 (digital in or out)
 *   ADS1115   4 single-ended analog inputs AIN0..AIN3 (16 bit) */
typedef enum { PLC_I2C_PCF8574 = 0, PLC_I2C_MCP23017, PLC_I2C_ADS1115 } plc_i2c_type_t;
typedef struct {
    int sda, scl;           /* GPIOs, -1 = not set */
    uint32_t khz;           /* 100 or 400 */
} plc_i2c_bus_t;
typedef struct {
    const char *id;         /* "PCF1", "MCP1", "ADS1" ... (referenced by I/O points) */
    plc_i2c_type_t type;
    uint8_t addr;           /* 7-bit address */
} plc_i2c_dev_t;

typedef struct {
    const char *tag;        /* tag name */
    const char *addr;       /* tag address ("" if symbolic) */
    int pin;                /* GPIO number, -1 on a shift register / I2C module */
    int sr;                 /* -1, or the shift-register chain (index for plc_sr()) */
    int i2c;                /* -1, or the I2C module (index for plc_i2c_dev()) */
    uint16_t bit;           /* channel on that chain / module */
    uint16_t range_mv;      /* ADS1115: full-scale range (6144 4096 2048 1024 512 256) */
    plc_io_dir_t dir;
    plc_pull_t pull;        /* inputs */
    bool active_low;        /* digital in/out */
    uint16_t debounce_ms;   /* digital in */
    uint32_t freq_hz;       /* pwm */
    plc_ain_mode_t ain_mode;/* analog in scaling */
    uint8_t smooth;         /* analog in smoothing 0..3 (none/weak/medium/strong) */
    bool forced;            /* TIA-style force: overrides the physical value */
    double force_val;
    uint16_t cell;          /* internal */
} plc_io_t;

/* ---- lifecycle ----------------------------------------------------------- */
/* Compile a project. Returns NULL with a message in err on a hard error (bad
 * JSON / not a project). Soft problems are reported as warnings. A NULL/empty
 * json yields an empty program (memory only — Modbus/force still work). */
plc_t *plc_load(const char *json, size_t len, const plc_env_t *env, char *err, size_t errlen);
void plc_free(plc_t *p);

const char *plc_project_name(const plc_t *p); /* NULL when none */
uint32_t plc_scan_ms(const plc_t *p);         /* requested cycle time */
bool plc_has_logic(const plc_t *p);           /* at least one OB/FC/FB */
size_t plc_warning_count(const plc_t *p);
const char *plc_warning(const plc_t *p, size_t i);

/* ---- cyclic execution ---------------------------------------------------- */
void plc_scan(plc_t *p);                      /* one program cycle (no I/O) */
uint32_t plc_scan_count(const plc_t *p);

/* ---- I/O image <-> hardware ---------------------------------------------- */
size_t plc_io_count(const plc_t *p);
plc_io_t *plc_io(plc_t *p, size_t i);
size_t plc_sr_count(const plc_t *p);
const plc_sr_t *plc_sr(const plc_t *p, size_t i);
const plc_i2c_bus_t *plc_i2c_bus(const plc_t *p);   /* never NULL for a program */
size_t plc_i2c_count(const plc_t *p);
const plc_i2c_dev_t *plc_i2c_dev(const plc_t *p, size_t i);
/* channels of a module type: 8 / 16 / 4 */
static inline int plc_i2c_channels(plc_i2c_type_t t) { return t == PLC_I2C_MCP23017 ? 16 : t == PLC_I2C_ADS1115 ? 4 : 8; }
void plc_io_set_input(plc_t *p, size_t i, double value);  /* ignored while forced */
double plc_io_get_output(plc_t *p, size_t i);             /* forced value if forced */

/* ---- modify / force ------------------------------------------------------ */
typedef enum { PLC_V_NULL = 0, PLC_V_BOOL, PLC_V_NUM } plc_vtype_t;
/* Write `value` to the operand `key` (tag name, address, "<inst>.<member>").
 * On a GPIO-mapped tag this becomes a persistent force (TIA force table);
 * PLC_V_NULL releases that force. Returns 0 ok, -1 unknown/unwritable key. */
int plc_force(plc_t *p, const char *key, plc_vtype_t t, double value);
void plc_unforce_all(plc_t *p);
size_t plc_forced_count(const plc_t *p);

/* ---- monitoring (JSON) --------------------------------------------------- */
/* Emits the members "scan","mem","live","power","pins","errors","lastError",
 * "forced" into the object currently open in w. */
void plc_snapshot_json(plc_t *p, jw_t *w);
void plc_tags_json(const plc_t *p, jw_t *w);            /* array of {name,dataType,address,comment} */
/* data block contents: object {"<DB name>": "<hex bytes>"} — every DB, or only
 * the comma-separated names in `only` (the IDE decodes them with its own
 * copy of the layout rules, web/js/types.js) */
void plc_dbs_json(plc_t *p, jw_t *w, const char *only);
void plc_modbus_map_json(const plc_t *p, jw_t *w, unsigned bank); /* object tag -> {kind,address[,registers]} */
uint32_t plc_error_count(const plc_t *p);
const char *plc_last_error(const plc_t *p);

/* raw process image access (Modbus) */
uint8_t *plc_area(plc_t *p, char area, size_t *size);

/* ---- Open User Communication --------------------------------------------- */
/* Close every OUC connection (CPU STOP; plc_free does it too). The program's
 * TCON/TSEND/TRCV calls see the connections gone and report errors, so a
 * state machine like TcpLink reconnects on the next RUN. */
void plc_comm_reset(plc_t *p);
/* array of the program's connections: {id, state, active, localPort,
 * remoteAddress, remotePort} (state: "connecting" / "connected" / "closed") */
void plc_conns_json(plc_t *p, jw_t *w);

#ifdef __cplusplus
}
#endif
