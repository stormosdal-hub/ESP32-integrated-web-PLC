/* ============================================================================
 * plc_internal.h — compiled-program representation shared by plc_engine.c and
 * plc_scl.c. Not part of the public API.
 *
 * Value model (mirrors sim.js): a value is a JS-like number or boolean (pv_t).
 * Storage cells (cref_t):
 *   CK_BIT/BYTE/WORD/DINT/REAL — S7-style overlapping bytes of the I/Q/M
 *       process images (big-endian; W signed 16, B unsigned 8, D signed 32 or
 *       IEEE float32 when a Real tag sits on that D address)
 *   CK_SYM — a named flat cell: symbolic tag, block-interface member
 *       ("<instance>.<member>"), or undeclared symbol
 *   CK_LIT — a literal; CK_NONE — empty operand (reads FALSE, ignores writes)
 * ==========================================================================*/
#pragma once

#include <math.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "jdom.h"
#include "plc_engine.h"

/* ------------------------------------------------------------ values */
typedef struct {
    double n;   /* number, or 0/1 for booleans */
    uint8_t t;  /* PV_NUM / PV_BOOL */
} pv_t;
enum { PV_NUM = 0, PV_BOOL = 1 };

static inline pv_t pvn(double x) { pv_t v; v.n = x; v.t = PV_NUM; return v; }
static inline pv_t pvb(bool b) { pv_t v; v.n = b ? 1.0 : 0.0; v.t = PV_BOOL; return v; }
/* sim.js num(): non-finite -> 0 */
static inline double numv(pv_t v) { return isfinite(v.n) ? v.n : 0.0; }
/* JS truthiness (NaN is falsy) */
static inline bool truthy(pv_t v) { return v.n != 0.0 && !isnan(v.n); }

/* ------------------------------------------------------------- cells */
enum { CK_NONE = 0, CK_LIT, CK_BIT, CK_BYTE, CK_WORD, CK_DINT, CK_REAL, CK_SYM };
enum { AREA_I = 0, AREA_Q = 1, AREA_M = 2 };

typedef struct {
    uint8_t k;      /* CK_* */
    uint8_t area;   /* AREA_* (address kinds) */
    uint8_t bit;    /* CK_BIT */
    uint8_t pad;
    uint16_t off;   /* byte offset (address kinds) */
    uint16_t idx;   /* CK_SYM: symbol, CK_LIT: literal, address kinds: registry entry */
} cref_t;

typedef struct {
    cref_t c;
    bool bit;       /* storage class is a bit (SCL typing, sim.js opIsBit) */
} ref_t;

enum { SYM_ANY = 0, SYM_BOOL, SYM_NUM };
typedef struct {
    const char *name;
    pv_t v;
    uint8_t type;     /* SYM_*: coercion applied on write */
    uint8_t written;  /* report in the snapshot */
    uint8_t is_tag;   /* backing cell of a tag (already reported under the tag name) */
} sym_t;

/* address registry: every distinct I/Q/M address the program touches */
typedef struct {
    const char *name; /* canonical, e.g. "MW10" */
    uint8_t k, area, bit, touched;
    uint16_t off;
} areg_t;

/* live/power/pin monitor flags keyed by model id */
typedef struct {
    const char *id;
    uint8_t v, seen;
} flag_t;

/* ------------------------------------------------------- arena / maps */
typedef struct ar_chunk {
    struct ar_chunk *next;
    size_t used, cap;
} ar_chunk_t;

typedef struct {
    ar_chunk_t *head;
} arena_t;

typedef struct {
    const char **keys;
    int32_t *vals;
    uint32_t cap, n;
} smap_t;

/* -------------------------------------------------------- instructions */
enum {
    K_UNKNOWN = 0,
    K_CONTACT_NO, K_CONTACT_NC, K_EDGE_P, K_EDGE_N,
    K_COIL, K_COIL_NEG, K_COIL_SET, K_COIL_RESET,
    K_SR, K_RS, K_P_TRIG, K_N_TRIG, K_R_TRIG, K_F_TRIG,
    K_FB_AND, K_FB_OR, K_FB_XOR, K_FB_NOT, K_ASSIGN,
    K_COMPARE,
    K_TON, K_TOF, K_TP,
    K_CTU, K_CTD, K_CTUD,
    K_MOVE, K_ADD, K_SUB, K_MUL, K_DIV,
    K_NORM_X, K_SCALE_X,
    K_CALL,
    K__COUNT
};

/* parameter slots per kind (see KPARAMS in plc_engine.c) */
enum { TM_PT = 0, TM_Q, TM_ET };                                  /* ton tof tp */
enum { CT_PV = 0, CT_R, CT_CV, CT_Q, CT_LD = 3, CT_CD, CT_QU, CT_QD }; /* ctu ctd (Q@3) / ctud (LD@3) */
enum { MV_IN = 0, MV_OUT };                                       /* move */
enum { MA_IN1 = 0, MA_IN2, MA_OUT, MA_ENO };                      /* add sub mul div */
enum { SC_MIN = 0, SC_VAL, SC_MAX, SC_OUT, SC_ENO };              /* norm_x scale_x */
enum { CP_IN1 = 0, CP_IN2 };                                      /* compare */
enum { LT_X = 0 };                                                /* sr: r / rs: s */
enum { TG_Q = 0 };                                                /* *_trig */

enum { CMP_EQ = 0, CMP_NE, CMP_GT, CMP_LT, CMP_GE, CMP_LE, CMP_BAD };

/* per-instance element state (timers / counters / edges / latches) */
typedef struct {
    double t0, c, et;
    uint8_t run, prev, pu, pd, q;
} st_t;

/* FBD input pin */
enum { FI_FALSE = 0, FI_TRUE, FI_OPERAND, FI_PARAM, FI_WIRE };
typedef struct {
    uint8_t src;        /* FI_* */
    uint8_t inv;        /* inverted (bubble) */
    int32_t slot;       /* pins[] monitor slot */
    cref_t ref;         /* FI_OPERAND / FI_PARAM */
    const pv_t *wire;   /* FI_WIRE: source output value (persists across scans) */
} fin_t;

/* FBD output pin */
enum { PN_OTHER = 0, PN_ET, PN_CV, PN_ENO, PN_QU, PN_QD };
typedef struct {
    pv_t v;             /* this scan's value; last scan's until the box runs */
    int32_t slot;
    uint8_t pn;         /* PN_* */
    int16_t cm;         /* call box: index into call->outs, -1 none */
} fout_t;

struct unit;

typedef struct {
    cref_t mem;         /* callee member cell */
    cref_t arg;         /* LAD: caller operand */
    uint8_t is_bool;
    int16_t pin;        /* FBD: input pin index, -1 none */
} cparam_t;

typedef struct {
    struct unit *u;     /* NULL: target missing / not a code block */
    uint16_t nin, nout;
    cparam_t *ins, *outs;
    pv_t *tmp;          /* LAD: sampled arguments (a call site never re-enters itself) */
} call_t;

typedef struct node {
    uint8_t kind, cmp;
    uint8_t nin, nout;
    int8_t sidx[3];     /* FBD: pin index of the named numeric inputs, -1 = use param */
    int32_t live;       /* live[] monitor slot */
    cref_t op;          /* element/box operand */
    cref_t *par;        /* kind-specific params */
    st_t *st;           /* timers / counters / edges / latches only (else NULL) */
    fin_t *in;
    fout_t *out;
    pv_t *iv;           /* FBD scratch: input values */
    call_t *call;
} node_t;

typedef struct {
    uint16_t n;
    node_t **els;
} branch_t;

typedef struct {
    uint16_t nbr;
    uint8_t has_els;
    branch_t *br;
} stage_t;

typedef struct {
    uint8_t fbd;
    int32_t power;      /* power[] monitor slot (LAD) */
    uint16_t nst, nout, nbox;
    stage_t *st;
    node_t **outs;
    node_t **boxes;     /* FBD: evaluation order */
} net_t;

enum { BT_OB = 0, BT_FC, BT_FB, BT_DB, BT_OTHER };
enum { BL_LAD = 0, BL_FBD, BL_SCL, BL_NONE };

typedef struct {
    const char *id, *name;
    uint8_t type, lang;
    uint8_t active;     /* recursion guard while executing */
    uint8_t called;     /* referenced by a call (not an orphan) */
    double number;
    int json;           /* jd node of the block object */
} blk_t;

/* compile context of one unit: the block's interface members for this instance */
typedef struct {
    smap_t map;         /* lowercase member name -> index */
    cref_t *cell;
    uint8_t *is_bool;
    int n;
} members_t;

struct scl_stmt;

typedef struct unit {
    blk_t *blk;
    const char *inst;
    members_t mem;
    uint16_t nnet;
    net_t *nets;
    struct scl_stmt *scl;
    bool scl_ok;
    bool compiled;
    struct unit *next;      /* memo list */
    struct unit *pend;      /* pending-compile list */
} unit_t;

typedef struct {
    const char *name, *dtype, *addr, *comment;
    cref_t c;
    uint8_t is_bool;
} tag_t;

struct plc {
    plc_env_t env;
    arena_t ar;

    uint8_t I[PLC_AREA_I_BYTES];
    uint8_t Q[PLC_AREA_Q_BYTES];
    uint8_t M[PLC_AREA_M_BYTES];

    const char *name;
    uint32_t scan_ms;
    bool has_logic;

    tag_t *tags;
    size_t ntags;
    smap_t tag_exact, tag_lower, real_addr;

    sym_t *syms;
    size_t nsyms, csyms;
    smap_t sym_map;

    pv_t *lits;
    size_t nlits, clits;

    areg_t *regs;
    size_t nregs, cregs;
    smap_t reg_map;

    flag_t *live, *power, *pins;
    size_t nlive, clive, npower, cpower, npins, cpins;
    smap_t live_map, power_map, pin_map;

    blk_t *blocks;
    size_t nblocks;
    smap_t blk_id, blk_name;

    unit_t *units;          /* memo */
    unit_t *pending;
    unit_t **cyc;           /* OBs + orphan FC/FB, in execution order */
    size_t ncyc;

    plc_sr_t *srs;          /* shift-register chains (project.shiftRegs) */
    size_t nsr;
    plc_i2c_bus_t i2c_bus;  /* project.i2c */
    plc_i2c_dev_t *i2c;
    size_t ni2c;
    plc_io_t *io;
    cref_t *iocell;
    size_t nio;

    const char **warn;
    size_t nwarn, cwarn;

    uint32_t scan_count, err_count;
    char last_error[160];

    double now;
    int depth;
    bool oom;

    const jd_doc_t *doc;    /* compile time only */
};

/* -------------------------------------------- engine services (plc_engine.c) */
void *plc_ar_alloc(plc_t *p, size_t n);
char *plc_ar_strdup(plc_t *p, const char *s, size_t n);
void plc_warnf(plc_t *p, const char *fmt, ...);
void plc_errorf(plc_t *p, const char *fmt, ...);

pv_t plc_rd(plc_t *p, cref_t c);
void plc_wr(plc_t *p, cref_t c, pv_t v);
/* resolve an operand string; mem = interface members in scope (NULL = global) */
ref_t plc_resolve(plc_t *p, const members_t *mem, const char *raw);
double plc_parse_time_ms(const char *s);

/* ------------------------------------------------------ SCL (plc_scl.c) */
/* Parse + resolve SCL source. p == NULL: syntax check only (no cells created).
 * Returns false on a syntax error (message "line N: ..." in err). An empty
 * program compiles to *out == NULL. */
bool plc_scl_compile(plc_t *p, const members_t *mem, const char *src, struct scl_stmt **out,
                     char *err, size_t errlen, const char *blkname);
void plc_scl_run(plc_t *p, struct scl_stmt *prog, const char *blkname);
