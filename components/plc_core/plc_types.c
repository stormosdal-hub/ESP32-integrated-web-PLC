/* ============================================================================
 * plc_types.c — PLC data types: parsing, S7 memory layout, typed buffers.
 * The C port of web/js/types.js (same rules, same bytes — test/parity
 * compares the instance buffers):
 *   Bool                  next bit (consecutive Bools share a byte)
 *   Byte Char SInt USInt  next byte
 *   everything else       next EVEN byte
 *   Struct / Array        size rounded up to an even number of bytes
 *   Array of Bool         packed bits, element i at byte i/8, bit i%8
 *   String[n]             [max n][current length][n chars] = n + 2 bytes
 * Multi-byte values are big-endian. Strings hold Latin-1 bytes (UTF-8 text
 * from the project is decoded like JavaScript strings are: code points above
 * 255 become '?').
 * ==========================================================================*/
#include <stdio.h>
#include <stdlib.h>

#include "plc_internal.h"

/* ------------------------------------------------------ elementary types */
#define EL(nm, sz, cl, bi, sg) {.k = TK_EL, .cls = cl, .bits = bi, .sign = sg, .size = sz, .name = nm}
const ty_t TY_BOOL = EL("Bool", 0, TC_BOOL, 1, 0);
const ty_t TY_BYTE = EL("Byte", 1, TC_BITS, 8, 0);
const ty_t TY_WORD = EL("Word", 2, TC_BITS, 16, 0);
const ty_t TY_DWORD = EL("DWord", 4, TC_BITS, 32, 0);
const ty_t TY_SINT = EL("SInt", 1, TC_INT, 8, 1);
const ty_t TY_USINT = EL("USInt", 1, TC_INT, 8, 0);
const ty_t TY_INT = EL("Int", 2, TC_INT, 16, 1);
const ty_t TY_UINT = EL("UInt", 2, TC_INT, 16, 0);
const ty_t TY_DINT = EL("DInt", 4, TC_INT, 32, 1);
const ty_t TY_UDINT = EL("UDInt", 4, TC_INT, 32, 0);
const ty_t TY_REAL = EL("Real", 4, TC_REAL, 32, 0);
const ty_t TY_LREAL = EL("LReal", 8, TC_REAL, 64, 0);
const ty_t TY_TIME = EL("Time", 4, TC_TIME, 32, 1);
const ty_t TY_DATE = EL("Date", 2, TC_DATE, 16, 0);
const ty_t TY_TOD = EL("Time_Of_Day", 4, TC_TOD, 32, 0);
const ty_t TY_CHAR = EL("Char", 1, TC_CHAR, 8, 0);
const ty_t TY_ANYINT = {.k = TK_EL, .cls = TC_INT, .bits = 0, .sign = 1, .any = 1, .name = "ANY_INT"};
const ty_t TY_ANYREAL = {.k = TK_EL, .cls = TC_REAL, .bits = 64, .any = 1, .name = "ANY_REAL"};
const ty_t TY_NUM = {.k = TK_EL, .cls = TC_NUM, .name = "NUM"};
const ty_t TY_VARIANT = {.k = TK_VARIANT, .name = "Variant"};
const ty_t TY_STRV = {.k = TK_STRV, .name = "String"};
const ty_t TY_VOID = {.k = TK_VOID, .name = "Void"};

static const struct {
    const char *up;
    const ty_t *t;
} ELS[] = {
    {"BOOL", &TY_BOOL}, {"BYTE", &TY_BYTE}, {"WORD", &TY_WORD}, {"DWORD", &TY_DWORD}, {"SINT", &TY_SINT},
    {"USINT", &TY_USINT}, {"INT", &TY_INT}, {"UINT", &TY_UINT}, {"DINT", &TY_DINT}, {"UDINT", &TY_UDINT},
    {"REAL", &TY_REAL}, {"LREAL", &TY_LREAL}, {"TIME", &TY_TIME}, {"DATE", &TY_DATE},
    {"TIME_OF_DAY", &TY_TOD}, {"CHAR", &TY_CHAR},
    /* aliases (types.js ALIAS) */
    {"TOD", &TY_TOD}, {"BOOLEAN", &TY_BOOL},
    {"HW_ANY", &TY_WORD}, {"HW_IO", &TY_WORD}, {"HW_INTERFACE", &TY_WORD}, {"HW_DEVICE", &TY_WORD},
    {"HW_SUBMODULE", &TY_WORD}, {"HW_HSC", &TY_WORD}, {"HW_PWM", &TY_WORD}, {"HW_PTO", &TY_WORD},
    {"CONN_OUC", &TY_WORD}, {"CONN_ANY", &TY_WORD}, {"CONN_PRG", &TY_WORD}, {"PORT", &TY_WORD},
    {"RTM", &TY_WORD}, {"PIP", &TY_WORD}, {"OB_ANY", &TY_WORD}, {"OB_CYCLIC", &TY_WORD}, {"EVENT_ANY", &TY_WORD},
};

static char upc(char c) { return (c >= 'a' && c <= 'z') ? (char)(c - 32) : c; }
static char lwc(char c) { return (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c; }
static bool isdig(char c) { return c >= '0' && c <= '9'; }
static bool isws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; }
static int hexval(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    c = lwc(c);
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return 99;
}

/* case-insensitive "starts with" a word */
static bool iprefix(const char *s, const char *w)
{
    while (*w) {
        if (lwc(*s) != lwc(*w)) return false;
        s++, w++;
    }
    return true;
}

static const ty_t *el_by_name(const char *up)
{
    for (size_t i = 0; i < sizeof ELS / sizeof ELS[0]; i++)
        if (!strcmp(ELS[i].up, up)) return ELS[i].t;
    return NULL;
}

/* ------------------------------------------------------------ layout */
static uint8_t align_of(const ty_t *t) { return t->k == TK_EL ? (t->size == 1 || t->cls == TC_BOOL ? 1 : 2) : 2; }

static uint32_t layout_fields(fld_t *f, uint16_t n)
{
    uint32_t byte = 0;
    uint8_t bit = 0;
    for (uint16_t i = 0; i < n; i++) {
        const ty_t *t = f[i].t;
        if (t->k == TK_VARIANT) {
            f[i].off = byte;
            f[i].bit = 0;
            continue;
        }
        if (t->k == TK_EL && t->cls == TC_BOOL) {
            f[i].off = byte;
            f[i].bit = bit;
            if (++bit == 8) byte++, bit = 0;
            continue;
        }
        if (bit) byte++, bit = 0;
        if (align_of(t) == 2 && (byte & 1)) byte++;
        f[i].off = byte;
        f[i].bit = 0;
        byte += t->size;
    }
    if (bit) byte++;
    return (byte + 1) & ~1u;
}

static ty_t *mk_struct(plc_t *p, fld_t *f, uint16_t n, const char *name)
{
    ty_t *t = (ty_t *)plc_ar_alloc(p, sizeof(ty_t));
    t->k = TK_STRUCT;
    t->f = f;
    t->nf = n;
    t->name = name ? name : "";
    t->size = layout_fields(f, n);
    return t;
}

static ty_t *mk_array(plc_t *p, const int32_t *lo, const int32_t *hi, uint8_t ndim, const ty_t *el)
{
    ty_t *t = (ty_t *)plc_ar_alloc(p, sizeof(ty_t));
    t->k = TK_ARR;
    t->ndim = ndim;
    uint32_t count = 1;
    for (uint8_t i = 0; i < ndim; i++) {
        t->lo[i] = lo[i];
        t->hi[i] = hi[i];
        count *= (uint32_t)(hi[i] - lo[i] + 1);
    }
    t->count = count;
    t->el = el;
    if (el->k == TK_EL && el->cls == TC_BOOL) {
        t->stride = 0;
        t->size = ((count + 15) >> 4) << 1;
    } else {
        t->stride = align_of(el) == 2 ? (el->size + 1) & ~1u : el->size;
        t->size = (count * t->stride + 1) & ~1u;
    }
    return t;
}

static ty_t *mk_string(plc_t *p, uint16_t n)
{
    ty_t *t = (ty_t *)plc_ar_alloc(p, sizeof(ty_t));
    t->k = TK_STR;
    t->len = n;
    t->size = n + 2u;
    return t;
}

/* ------------------------------------------- built-in structs + system FBs */
typedef struct {
    const char *name;
    const ty_t *t;   /* NULL: the counter type */
    uint8_t sec, ref;
} fspec_t;

#define FS_END {NULL, NULL, 0, 0}
static const fspec_t FS_TIMER[] = {{"IN", &TY_BOOL, SEC_IN, 0}, {"PT", &TY_TIME, SEC_IN, 0}, {"Q", &TY_BOOL, SEC_OUT, 0},
                                   {"ET", &TY_TIME, SEC_OUT, 0}, {"_run", &TY_BOOL, SEC_STAT, 0}, {"_prev", &TY_BOOL, SEC_STAT, 0},
                                   {"_t0", &TY_LREAL, SEC_STAT, 0}, FS_END};
static const fspec_t FS_TRIG[] = {{"CLK", &TY_BOOL, SEC_IN, 0}, {"Q", &TY_BOOL, SEC_OUT, 0}, {"_prev", &TY_BOOL, SEC_STAT, 0}, FS_END};
static const fspec_t FS_CTU[] = {{"CU", &TY_BOOL, SEC_IN, 0}, {"R", &TY_BOOL, SEC_IN, 0}, {"PV", NULL, SEC_IN, 0},
                                 {"Q", &TY_BOOL, SEC_OUT, 0}, {"CV", NULL, SEC_OUT, 0}, {"_prev", &TY_BOOL, SEC_STAT, 0}, FS_END};
static const fspec_t FS_CTD[] = {{"CD", &TY_BOOL, SEC_IN, 0}, {"LD", &TY_BOOL, SEC_IN, 0}, {"PV", NULL, SEC_IN, 0},
                                 {"Q", &TY_BOOL, SEC_OUT, 0}, {"CV", NULL, SEC_OUT, 0}, {"_prev", &TY_BOOL, SEC_STAT, 0}, FS_END};
static const fspec_t FS_CTUD[] = {{"CU", &TY_BOOL, SEC_IN, 0}, {"CD", &TY_BOOL, SEC_IN, 0}, {"R", &TY_BOOL, SEC_IN, 0},
                                  {"LD", &TY_BOOL, SEC_IN, 0}, {"PV", NULL, SEC_IN, 0}, {"QU", &TY_BOOL, SEC_OUT, 0},
                                  {"QD", &TY_BOOL, SEC_OUT, 0}, {"CV", NULL, SEC_OUT, 0}, {"_pu", &TY_BOOL, SEC_STAT, 0},
                                  {"_pd", &TY_BOOL, SEC_STAT, 0}, FS_END};
static const fspec_t FS_TCON[] = {{"REQ", &TY_BOOL, SEC_IN, 0}, {"ID", &TY_WORD, SEC_IN, 0}, {"CONNECT", &TY_VARIANT, SEC_INOUT, 1},
                                  {"DONE", &TY_BOOL, SEC_OUT, 0}, {"BUSY", &TY_BOOL, SEC_OUT, 0}, {"ERROR", &TY_BOOL, SEC_OUT, 0},
                                  {"STATUS", &TY_WORD, SEC_OUT, 0}, {"_prev", &TY_BOOL, SEC_STAT, 0}, {"_job", &TY_BOOL, SEC_STAT, 0}, FS_END};
static const fspec_t FS_TDISCON[] = {{"REQ", &TY_BOOL, SEC_IN, 0}, {"ID", &TY_WORD, SEC_IN, 0}, {"DONE", &TY_BOOL, SEC_OUT, 0},
                                     {"BUSY", &TY_BOOL, SEC_OUT, 0}, {"ERROR", &TY_BOOL, SEC_OUT, 0}, {"STATUS", &TY_WORD, SEC_OUT, 0},
                                     {"_prev", &TY_BOOL, SEC_STAT, 0}, FS_END};
static const fspec_t FS_TSEND[] = {{"REQ", &TY_BOOL, SEC_IN, 0}, {"ID", &TY_WORD, SEC_IN, 0}, {"LEN", &TY_UDINT, SEC_IN, 0},
                                   {"DATA", &TY_VARIANT, SEC_INOUT, 1}, {"DONE", &TY_BOOL, SEC_OUT, 0}, {"BUSY", &TY_BOOL, SEC_OUT, 0},
                                   {"ERROR", &TY_BOOL, SEC_OUT, 0}, {"STATUS", &TY_WORD, SEC_OUT, 0}, {"_prev", &TY_BOOL, SEC_STAT, 0},
                                   {"_job", &TY_BOOL, SEC_STAT, 0}, FS_END};
static const fspec_t FS_TRCV[] = {{"EN_R", &TY_BOOL, SEC_IN, 0}, {"ID", &TY_WORD, SEC_IN, 0}, {"LEN", &TY_UDINT, SEC_IN, 0},
                                  {"ADHOC", &TY_BOOL, SEC_IN, 0}, {"DATA", &TY_VARIANT, SEC_INOUT, 1}, {"NDR", &TY_BOOL, SEC_OUT, 0},
                                  {"BUSY", &TY_BOOL, SEC_OUT, 0}, {"ERROR", &TY_BOOL, SEC_OUT, 0}, {"STATUS", &TY_WORD, SEC_OUT, 0},
                                  {"RCVD_LEN", &TY_UDINT, SEC_OUT, 0}, {"_busy", &TY_BOOL, SEC_STAT, 0}, FS_END};

static const sysdef_t SYS[] = {
    {"TON", SK_TON, NULL}, {"TOF", SK_TOF, NULL}, {"TP", SK_TP, NULL}, {"IEC_TIMER", SK_IEC_TIMER, NULL},
    {"R_TRIG", SK_R_TRIG, NULL}, {"F_TRIG", SK_F_TRIG, NULL},
    {"CTU", SK_CTU, &TY_INT}, {"CTD", SK_CTD, &TY_INT}, {"CTUD", SK_CTUD, &TY_INT},
    {"CTU_SINT", SK_CTU, &TY_SINT}, {"CTD_SINT", SK_CTD, &TY_SINT}, {"CTUD_SINT", SK_CTUD, &TY_SINT},
    {"CTU_INT", SK_CTU, &TY_INT}, {"CTD_INT", SK_CTD, &TY_INT}, {"CTUD_INT", SK_CTUD, &TY_INT},
    {"CTU_DINT", SK_CTU, &TY_DINT}, {"CTD_DINT", SK_CTD, &TY_DINT}, {"CTUD_DINT", SK_CTUD, &TY_DINT},
    {"CTU_USINT", SK_CTU, &TY_USINT}, {"CTD_USINT", SK_CTD, &TY_USINT}, {"CTUD_USINT", SK_CTUD, &TY_USINT},
    {"CTU_UINT", SK_CTU, &TY_UINT}, {"CTD_UINT", SK_CTD, &TY_UINT}, {"CTUD_UINT", SK_CTUD, &TY_UINT},
    {"CTU_UDINT", SK_CTU, &TY_UDINT}, {"CTD_UDINT", SK_CTD, &TY_UDINT}, {"CTUD_UDINT", SK_CTUD, &TY_UDINT},
    {"TCON", SK_TCON, NULL}, {"TDISCON", SK_TDISCON, NULL}, {"TSEND", SK_TSEND, NULL}, {"TRCV", SK_TRCV, NULL},
};
#define NSYS (sizeof SYS / sizeof SYS[0])
static const char *const SYS_ALIAS[][2] = {{"TON_TIME", "TON"}, {"TOF_TIME", "TOF"}, {"TP_TIME", "TP"}};

static const fspec_t *fspec_of(uint8_t kind)
{
    switch (kind) {
    case SK_TON: case SK_TOF: case SK_TP: case SK_IEC_TIMER: return FS_TIMER;
    case SK_R_TRIG: case SK_F_TRIG: return FS_TRIG;
    case SK_CTU: return FS_CTU;
    case SK_CTD: return FS_CTD;
    case SK_CTUD: return FS_CTUD;
    case SK_TCON: return FS_TCON;
    case SK_TDISCON: return FS_TDISCON;
    case SK_TSEND: return FS_TSEND;
    default: return FS_TRCV;
    }
}

static fld_t *fields_from_spec(plc_t *p, const fspec_t *s, const ty_t *cv, uint16_t *n)
{
    uint16_t k = 0;
    while (s[k].name) k++;
    fld_t *f = (fld_t *)plc_ar_alloc(p, sizeof(fld_t) * k);
    for (uint16_t i = 0; i < k; i++) {
        f[i].name = s[i].name;
        f[i].t = s[i].t ? s[i].t : cv;
        f[i].sec = s[i].sec;
        f[i].ref = s[i].ref;
        f[i].reft = s[i].ref ? f[i].t : NULL;
        f[i].def = "";
    }
    *n = k;
    return f;
}

/* the system FB type of a name (TON, TON_TIME, CTU_DINT, TCON ...), built once per program */
const ty_t *plc_sysfb_type(plc_t *p, const char *name)
{
    char up[24];
    size_t i = 0;
    for (; name[i] && i + 1 < sizeof up; i++) up[i] = upc(name[i]);
    up[i] = 0;
    if (name[i]) return NULL;
    for (size_t a = 0; a < sizeof SYS_ALIAS / sizeof SYS_ALIAS[0]; a++)
        if (!strcmp(up, SYS_ALIAS[a][0])) {
            snprintf(up, sizeof up, "%s", SYS_ALIAS[a][1]);
            break;
        }
    for (size_t k = 0; k < NSYS; k++) {
        if (strcmp(SYS[k].name, up)) continue;
        if (p->bty[k]) return p->bty[k];
        uint16_t n;
        fld_t *f = fields_from_spec(p, fspec_of(SYS[k].kind), SYS[k].cv, &n);
        ty_t *t = mk_struct(p, f, n, SYS[k].name);
        t->k = TK_FB;
        t->sys = &SYS[k];
        p->bty[k] = t;
        return t;
    }
    return NULL;
}

/* DTL, IP_V4, TCON_IP_v4 */
const ty_t *ty_builtin_struct(plc_t *p, const char *name)
{
    char up[24];
    size_t i = 0;
    for (; name[i] && i + 1 < sizeof up; i++) up[i] = upc(name[i]);
    up[i] = 0;
    if (name[i]) return NULL;
    if (!strcmp(up, "DTL")) {
        if (!p->bty[NSYS]) {
            static const fspec_t S[] = {{"YEAR", &TY_UINT, 0, 0}, {"MONTH", &TY_USINT, 0, 0}, {"DAY", &TY_USINT, 0, 0},
                                        {"WEEKDAY", &TY_USINT, 0, 0}, {"HOUR", &TY_USINT, 0, 0}, {"MINUTE", &TY_USINT, 0, 0},
                                        {"SECOND", &TY_USINT, 0, 0}, {"NANOSECOND", &TY_UDINT, 0, 0}, FS_END};
            uint16_t n;
            fld_t *f = fields_from_spec(p, S, NULL, &n);
            p->bty[NSYS] = mk_struct(p, f, n, "DTL");
        }
        return p->bty[NSYS];
    }
    if (!strcmp(up, "IP_V4") || !strcmp(up, "TCON_IP_V4")) {
        if (!p->bty[NSYS + 1]) {
            int32_t lo = 1, hi = 4;
            fld_t *f = (fld_t *)plc_ar_alloc(p, sizeof(fld_t));
            f->name = "ADDR";
            f->t = mk_array(p, &lo, &hi, 1, &TY_BYTE);
            f->def = "";
            p->bty[NSYS + 1] = mk_struct(p, f, 1, "IP_V4");
            static const fspec_t S[] = {{"InterfaceId", &TY_WORD, 0, 0}, {"ID", &TY_WORD, 0, 0}, {"ConnectionType", &TY_BYTE, 0, 0},
                                        {"ActiveEstablished", &TY_BOOL, 0, 0}, {"RemoteAddress", NULL, 0, 0},
                                        {"RemotePort", &TY_UINT, 0, 0}, {"LocalPort", &TY_UINT, 0, 0}, FS_END};
            uint16_t n;
            fld_t *g = fields_from_spec(p, S, p->bty[NSYS + 1], &n);
            p->bty[NSYS + 2] = mk_struct(p, g, n, "TCON_IP_v4");
        }
        return p->bty[!strcmp(up, "IP_V4") ? NSYS + 1 : NSYS + 2];
    }
    return NULL;
}

/* ------------------------------------------------------------- parse */
#define TERR(...)                                   \
    do {                                            \
        if (err && errlen) snprintf(err, errlen, __VA_ARGS__); \
        return NULL;                                \
    } while (0)

static void trim_into(const char *s, size_t n, char *out, size_t cap)
{
    while (n && isws(*s)) s++, n--;
    while (n && isws(s[n - 1])) n--;
    if (n >= cap) n = cap - 1;
    memcpy(out, s, n);
    out[n] = 0;
}

static const ty_t *udt_type(plc_t *p, size_t u, char *err, size_t errlen);

const ty_t *ty_parse(plc_t *p, const char *str, int members_json, char *err, size_t errlen)
{
    char s[256];
    trim_into(str ? str : "", str ? strlen(str) : 0, s, sizeof s);
    if (!*s) TERR("missing data type");
    /* Array[lo..hi, ...] of T */
    if (iprefix(s, "array")) {
        const char *q = s + 5;
        while (isws(*q)) q++;
        if (*q == '[') {
            const char *close = strchr(q, ']');
            const char *of = close ? close + 1 : NULL;
            if (of) {
                while (isws(*of)) of++;
                if (iprefix(of, "of") && isws(of[2])) {
                    int32_t lo[TY_MAX_DIMS + 1], hi[TY_MAX_DIMS + 1];
                    uint8_t nd = 0;
                    const char *d = q + 1;
                    uint64_t count = 1;
                    while (d < close) {
                        const char *e = d;
                        while (e < close && *e != ',') e++;
                        char dim[64];
                        trim_into(d, (size_t)(e - d), dim, sizeof dim);
                        /* ^(-?\d+)\s*\.\.\s*(-?\d+)$ */
                        char *x = dim;
                        char *end1;
                        if (!(isdig(*x) || (*x == '-' && isdig(x[1])))) TERR("bad array bounds \"%s\"", dim);
                        long a = strtol(x, &end1, 10);
                        x = end1;
                        while (isws(*x)) x++;
                        if (x[0] != '.' || x[1] != '.') TERR("bad array bounds \"%s\"", dim);
                        x += 2;
                        while (isws(*x)) x++;
                        if (!(isdig(*x) || (*x == '-' && isdig(x[1])))) TERR("bad array bounds \"%s\"", dim);
                        long b = strtol(x, &end1, 10);
                        if (*end1) TERR("bad array bounds \"%s\"", dim);
                        if (b < a) TERR("array upper bound below lower bound");
                        if (nd >= TY_MAX_DIMS) TERR("too many array dimensions");
                        if (a < -2147483647L || b > 2147483647L) TERR("array too large (more than 65535 elements)");
                        lo[nd] = (int32_t)a;
                        hi[nd] = (int32_t)b;
                        nd++;
                        count *= (uint64_t)(b - a + 1);
                        if (count > 65535) TERR("array too large (more than 65535 elements)");
                        d = e < close ? e + 1 : close;
                    }
                    if (!nd) TERR("bad array bounds \"\"");
                    const ty_t *el = ty_parse(p, of + 3, members_json, err, errlen);
                    if (!el) return NULL;
                    if (el->k == TK_VARIANT) TERR("Array of Variant is not allowed");
                    ty_t *t = mk_array(p, lo, hi, nd, el);
                    if (t->size > 65534) TERR("array too large (%u bytes)", (unsigned)t->size);
                    return t;
                }
            }
        }
    }
    /* String / String[n] */
    if (iprefix(s, "string")) {
        const char *q = s + 6;
        while (isws(*q)) q++;
        long n = 254;
        bool ok = !*q;
        if (*q == '[') {
            q++;
            while (isws(*q)) q++;
            if (isdig(*q)) {
                char *e;
                n = strtol(q, &e, 10);
                while (isws(*e)) e++;
                ok = (*e == ']' && !e[1]);
            }
        }
        if (ok) {
            if (n < 1 || n > 254) TERR("String length must be 1..254");
            return mk_string(p, (uint16_t)n);
        }
    }
    if (plc_ieq(s, "struct")) return ty_struct_of(p, members_json, "", err, errlen);
    if (plc_ieq(s, "variant")) return &TY_VARIANT;
    bool quoted = s[0] == '"';
    char name[160];
    size_t sl = strlen(s);
    if (sl >= 2 && s[0] == '"' && s[sl - 1] == '"') trim_into(s + 1, sl - 2, name, sizeof name);
    else trim_into(s, sl, name, sizeof name);
    char up[160];
    size_t i = 0;
    for (; name[i] && i + 1 < sizeof up; i++) up[i] = upc(name[i]);
    up[i] = 0;
    if (!quoted) {
        const ty_t *e = el_by_name(up);
        if (e) return e;
        e = ty_builtin_struct(p, name);
        if (e) return e;
        e = plc_sysfb_type(p, name);
        if (e) return e;
    }
    for (size_t u = 0; u < p->nudt; u++)
        if (plc_ieq(p->udt_name[u], name)) return udt_type(p, u, err, errlen);
    blk_t *fb = plc_find_block_name(p, name);
    if (fb && fb->type == BT_FB) {
        const ty_t *t = plc_block_type(p, fb);
        if (!t) {
            if (fb->ty_state == 1) TERR("FB \"%s\" contains an instance of itself", name);
            TERR("%s", fb->ty_err ? fb->ty_err : "?");
        }
        return t;
    }
    TERR("unknown data type \"%s\"", s);
}

static const ty_t *udt_type(plc_t *p, size_t u, char *err, size_t errlen)
{
    if (p->udt_state[u] == 2) return p->udt_ty[u];
    if (p->udt_state[u] == 1) TERR("data type \"%s\" contains itself", p->udt_name[u]);
    p->udt_state[u] = 1;
    const ty_t *t = ty_struct_of(p, jd_get(p->doc, p->udt_json[u], "members"), p->udt_name[u], err, errlen);
    p->udt_state[u] = t ? 2 : 0;
    p->udt_ty[u] = t;
    return t;
}

/* text of a JSON value as JavaScript's String() would give it ("" for null / missing) */
static const char *jtext(plc_t *p, int v, char *buf, size_t cap)
{
    buf[0] = 0;
    if (v < 0) return buf;
    switch (jd_type(p->doc, v)) {
    case JD_STR: jd_str(p->doc, v, buf, cap); break;
    case JD_NUM: jd_str(p->doc, v, buf, cap); break;
    case JD_TRUE: snprintf(buf, cap, "true"); break;
    case JD_FALSE: snprintf(buf, cap, "false"); break;
    default: break;
    }
    return buf;
}

/* member list (JSON array of {name, dataType, default, members}) -> fields */
static fld_t *member_fields(plc_t *p, int arr, uint16_t *count, char *err, size_t errlen, uint8_t sec, uint16_t extra)
{
    uint32_t total = jd_count(p->doc, arr);
    fld_t *f = (fld_t *)plc_ar_alloc(p, sizeof(fld_t) * (total + extra + 1));
    uint16_t n = 0;
    char name[160], dt[256], def[256];
    for (int m = jd_first(p->doc, arr); m >= 0; m = jd_next(p->doc, m)) {
        if (jd_type(p->doc, m) != JD_OBJ) continue;
        jtext(p, jd_get(p->doc, m, "name"), name, sizeof name);
        char nm[160];
        trim_into(name, strlen(name), nm, sizeof nm);
        if (!*nm) continue;
        jtext(p, jd_get(p->doc, m, "dataType"), dt, sizeof dt);
        char e2[160];
        const ty_t *t = ty_parse(p, dt, jd_get(p->doc, m, "members"), e2, sizeof e2);
        if (!t) {
            if (err && errlen) snprintf(err, errlen, "%s: %s", nm, e2);
            return NULL;
        }
        int dv = jd_get(p->doc, m, "default");
        f[n].name = plc_ar_strdup(p, nm, strlen(nm));
        f[n].t = t;
        f[n].def = NULL;
        if (dv >= 0 && jd_type(p->doc, dv) != JD_NULL) {
            jtext(p, dv, def, sizeof def);
            f[n].def = plc_ar_strdup(p, def, strlen(def));
        }
        f[n].sec = sec;
        n++;
    }
    *count = n;
    return f;
}

const ty_t *ty_struct_of(plc_t *p, int members_json, const char *name, char *err, size_t errlen)
{
    uint16_t n = 0;
    fld_t *f = member_fields(p, members_json, &n, err, errlen, SEC_NONE, 0);
    if (!f) return NULL;
    return mk_struct(p, f, n, name);
}

/* sections of a code block in instance order ('return' = an FC's RET_VAL) */
static bool is_ref_param(uint8_t sec, const ty_t *t, uint8_t btype)
{
    if (t->k == TK_VARIANT) return true;
    if (sec == SEC_INOUT && t->k != TK_EL) return true;
    if (btype == BT_FC && (sec == SEC_IN || sec == SEC_OUT) && t->k != TK_EL) return true;
    return false;
}

const ty_t *ty_block_fields(plc_t *p, blk_t *b, char *err, size_t errlen)
{
    static const char *const FB[] = {"input", "output", "inout", "static", "temp", "constant", NULL};
    static const char *const FC[] = {"return", "input", "output", "inout", "temp", "constant", NULL};
    static const char *const OB[] = {"temp", "constant", NULL};
    static const uint8_t SFB[] = {SEC_IN, SEC_OUT, SEC_INOUT, SEC_STAT, SEC_TEMP, SEC_CONST};
    static const uint8_t SFC[] = {SEC_RET, SEC_IN, SEC_OUT, SEC_INOUT, SEC_TEMP, SEC_CONST};
    static const uint8_t SOB[] = {SEC_TEMP, SEC_CONST};
    const char *const *secs = b->type == BT_FB ? FB : b->type == BT_FC ? FC : OB;
    const uint8_t *sc = b->type == BT_FB ? SFB : b->type == BT_FC ? SFC : SOB;
    int iface = jd_get(p->doc, b->json, "iface");
    uint32_t total = 0;
    for (int s = 0; secs[s]; s++) total += jd_count(p->doc, jd_get(p->doc, iface, secs[s]));
    fld_t *all = (fld_t *)plc_ar_alloc(p, sizeof(fld_t) * (total + 1));
    uint16_t n = 0;
    for (int s = 0; secs[s]; s++) {
        uint16_t k = 0;
        int arr = jd_type(p->doc, iface) == JD_OBJ ? jd_get(p->doc, iface, secs[s]) : -1;
        if (jd_type(p->doc, arr) != JD_ARR) continue;
        fld_t *f = member_fields(p, arr, &k, err, errlen, sc[s], 0);
        if (!f) return NULL;
        for (uint16_t i = 0; i < k; i++) {
            if (is_ref_param(sc[s], f[i].t, b->type)) {
                f[i].ref = 1;
                f[i].reft = f[i].t;
                f[i].t = &TY_VARIANT;
            }
            all[n++] = f[i];
        }
    }
    ty_t *t = mk_struct(p, all, n, b->name);
    t->k = b->type == BT_FB ? TK_FB : TK_STRUCT;
    t->blk = b;
    return t;
}

const fld_t *ty_field(const ty_t *t, const char *name)
{
    if (!t || (t->k != TK_STRUCT && t->k != TK_FB)) return NULL;
    for (uint16_t i = 0; i < t->nf; i++)
        if (plc_ieq(t->f[i].name, name)) return &t->f[i];
    return NULL;
}

/* ----------------------------------------------------- signatures */
typedef struct {
    char *b;
    size_t n, cap;
    plc_t *p;
} sb_t;
static void sb_add(sb_t *s, const char *x)
{
    size_t l = strlen(x);
    if (s->n + l + 1 > s->cap) {
        size_t nc = (s->cap ? s->cap * 2 : 256);
        while (nc < s->n + l + 1) nc *= 2;
        char *nb = (char *)realloc(s->b, nc);
        if (!nb) return;
        s->b = nb;
        s->cap = nc;
    }
    memcpy(s->b + s->n, x, l + 1);
    s->n += l;
}
static void sig_into(sb_t *s, const ty_t *t)
{
    char tmp[64];
    switch (t->k) {
    case TK_EL: sb_add(s, t->name); return;
    case TK_STR: snprintf(tmp, sizeof tmp, "S%u", t->len); sb_add(s, tmp); return;
    case TK_VARIANT: sb_add(s, "V"); return;
    case TK_ARR:
        sb_add(s, "A");
        for (uint8_t i = 0; i < t->ndim; i++) {
            snprintf(tmp, sizeof tmp, "%s%ld:%ld", i ? "," : "", (long)t->lo[i], (long)t->hi[i]);
            sb_add(s, tmp);
        }
        sb_add(s, "(");
        sig_into(s, t->el);
        sb_add(s, ")");
        return;
    default:
        sb_add(s, "{");
        for (uint16_t i = 0; i < t->nf; i++) {
            if (i) sb_add(s, ";");
            char low[160];
            size_t k = 0;
            for (; t->f[i].name[k] && k + 1 < sizeof low; k++) low[k] = lwc(t->f[i].name[k]);
            low[k] = 0;
            sb_add(s, low);
            snprintf(tmp, sizeof tmp, "@%lu.%u:", (unsigned long)t->f[i].off, t->f[i].bit);
            sb_add(s, tmp);
            sig_into(s, t->f[i].t);
        }
        sb_add(s, "}");
    }
}
const char *ty_sig(plc_t *p, const ty_t *t)
{
    if (t->sig) return t->sig;
    sb_t s = {NULL, 0, 0, p};
    sig_into(&s, t);
    const char *r = plc_ar_strdup(p, s.b ? s.b : "", s.n);
    free(s.b);
    if (t->k != TK_EL) ((ty_t *)t)->sig = r; /* built-in elementary types are const */
    return r;
}
bool ty_same(plc_t *p, const ty_t *a, const ty_t *b) { return a == b || !strcmp(ty_sig(p, a), ty_sig(p, b)); }

const char *ty_name(const ty_t *t, char *buf, size_t cap)
{
    switch (t->k) {
    case TK_EL: snprintf(buf, cap, "%s", t->cls == TC_NUM ? "number" : t->name); break;
    case TK_STR: snprintf(buf, cap, "String[%u]", t->len); break;
    case TK_STRV: snprintf(buf, cap, "String"); break;
    case TK_VARIANT: snprintf(buf, cap, "Variant"); break;
    case TK_VOID: snprintf(buf, cap, "Void"); break;
    case TK_ARR: {
        char e[64];
        size_t n = (size_t)snprintf(buf, cap, "Array[");
        for (uint8_t i = 0; i < t->ndim && n < cap; i++)
            n += (size_t)snprintf(buf + n, cap - n, "%s%ld..%ld", i ? ", " : "", (long)t->lo[i], (long)t->hi[i]);
        if (n < cap) snprintf(buf + n, cap - n, "] of %s", ty_name(t->el, e, sizeof e));
        break;
    }
    case TK_FB: snprintf(buf, cap, t->sys ? "%s" : "\"%s\"", t->name); break;
    default:
        if (!t->name || !*t->name) snprintf(buf, cap, "Struct");
        else if (!strcmp(t->name, "DTL") || !strcmp(t->name, "IP_V4") || !strcmp(t->name, "TCON_IP_v4")) snprintf(buf, cap, "%s", t->name);
        else snprintf(buf, cap, "\"%s\"", t->name);
    }
    return buf;
}

/* ------------------------------------------------- elementary access */
double ty_round7(float f)
{
    if (f == 0) return 0;
    if (!isfinite(f)) return (double)f;
    char b[40];
    snprintf(b, sizeof b, "%.7g", (double)f);
    return strtod(b, NULL);
}

double ty_read(const uint8_t *b, uint8_t bit, const ty_t *t)
{
    if (t->cls == TC_BOOL) return (b[0] >> bit) & 1;
    switch (t->size) {
    case 1: return t->sign ? (double)(int8_t)b[0] : (double)b[0];
    case 2: {
        uint16_t v = (uint16_t)((b[0] << 8) | b[1]);
        return t->sign ? (double)(int16_t)v : (double)v;
    }
    case 4: {
        uint32_t u = ((uint32_t)b[0] << 24) | ((uint32_t)b[1] << 16) | ((uint32_t)b[2] << 8) | b[3];
        if (t->cls == TC_REAL) {
            float f;
            memcpy(&f, &u, 4);
            return isfinite(f) ? ty_round7(f) : (double)f;
        }
        return t->sign ? (double)(int32_t)u : (double)u;
    }
    case 8: {
        uint64_t u = 0;
        for (int i = 0; i < 8; i++) u = (u << 8) | b[i];
        double d;
        memcpy(&d, &u, 8);
        return d;
    }
    }
    return 0;
}

void ty_write(uint8_t *b, uint8_t bit, const ty_t *t, double v)
{
    if (t->cls == TC_BOOL) {
        if (v != 0) b[0] = (uint8_t)(b[0] | (1u << bit));
        else b[0] = (uint8_t)(b[0] & ~(1u << bit));
        return;
    }
    switch (t->size) {
    case 1: b[0] = (uint8_t)((int64_t)v & 0xFF); return;
    case 2: {
        uint32_t w = (uint32_t)((int64_t)v & 0xFFFF);
        b[0] = (uint8_t)(w >> 8);
        b[1] = (uint8_t)w;
        return;
    }
    case 4: {
        uint32_t u;
        if (t->cls == TC_REAL) {
            float f = (float)v;
            memcpy(&u, &f, 4);
        } else {
            u = (uint32_t)((int64_t)v & 0xFFFFFFFF);
        }
        b[0] = (uint8_t)(u >> 24);
        b[1] = (uint8_t)(u >> 16);
        b[2] = (uint8_t)(u >> 8);
        b[3] = (uint8_t)u;
        return;
    }
    case 8: {
        uint64_t u;
        memcpy(&u, &v, 8);
        for (int i = 7; i >= 0; i--) {
            b[i] = (uint8_t)u;
            u >>= 8;
        }
        return;
    }
    }
}

/* ------------------------------------------------------- conversions */
static double numx(double v) { return isfinite(v) ? v : 0.0; }

double ty_rhe(double x)
{
    double f = floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return fmod(f, 2.0) == 0 ? f : f + 1;
}

double ty_wrap(double x, int bits, bool sign)
{
    double m = bits == 32 ? 4294967296.0 : bits == 16 ? 65536.0 : 256.0;
    double r = x - floor(x / m) * m;
    if (sign && r >= m / 2) r -= m;
    return r + 0.0;
}

double ty_conv(double v, const ty_t *t)
{
    double x = numx(v);
    if (t->cls == TC_BOOL) return x != 0 ? 1.0 : 0.0;
    if (t->cls == TC_REAL) return t->bits == 32 ? (double)(float)x : x;
    if (t->cls == TC_NUM) return x;
    if (x != floor(x)) x = ty_rhe(x);
    return ty_wrap(x, t->bits, t->sign);
}

/* ----------------------------------------------------- literal parsing */
/* $-escapes of an SCL string and UTF-8 -> Latin-1 (code points > 255 = '?',
 * outside the BMP '??' like a JavaScript surrogate pair) */
size_t ty_unescape(const char *s, size_t n, char *out, size_t cap)
{
    size_t o = 0;
    for (size_t i = 0; i < n;) {
        unsigned c = (unsigned char)s[i];
        unsigned cp;
        if (c == '$' && i + 1 < n) {
            char e = upc(s[i + 1]);
            int esc = -1;
            if (e == '$') esc = '$';
            else if (e == '\'') esc = '\'';
            else if (e == 'L' || e == 'N') esc = '\n';
            else if (e == 'R') esc = '\r';
            else if (e == 'T') esc = '\t';
            else if (e == 'P') esc = '\f';
            else if (i + 2 < n && hexval(s[i + 1]) < 16 && hexval(s[i + 2]) < 16) {
                esc = hexval(s[i + 1]) * 16 + hexval(s[i + 2]);
                if (o + 1 < cap) out[o++] = (char)esc;
                i += 3;
                continue;
            }
            if (esc >= 0) {
                if (o + 1 < cap) out[o++] = (char)esc;
                i += 2;
                continue;
            }
        }
        int extra = 0;
        if (c < 0x80) cp = c;
        else if ((c & 0xE0) == 0xC0) cp = c & 0x1F, extra = 1;
        else if ((c & 0xF0) == 0xE0) cp = c & 0x0F, extra = 2;
        else if ((c & 0xF8) == 0xF0) cp = c & 0x07, extra = 3;
        else cp = 0xFFFD;
        i++;
        for (int k = 0; k < extra && i < n && ((unsigned char)s[i] & 0xC0) == 0x80; k++, i++) cp = (cp << 6) | ((unsigned char)s[i] & 0x3F);
        if (cp >= 0x10000) {
            if (o + 1 < cap) out[o++] = '?';
            if (o + 1 < cap) out[o++] = '?';
        } else if (o + 1 < cap) out[o++] = (char)(cp < 256 ? cp : '?');
    }
    if (cap) out[o < cap ? o : cap - 1] = 0;
    return o;
}

/* [+-]?(2|8|16)#[0-9A-Fa-f_]+ */
static bool radix(const char *s, double *v)
{
    bool neg = false;
    if (*s == '+' || *s == '-') neg = *s++ == '-';
    int base;
    if (s[0] == '1' && s[1] == '6' && s[2] == '#') base = 16, s += 3;
    else if (s[0] == '2' && s[1] == '#') base = 2, s += 2;
    else if (s[0] == '8' && s[1] == '#') base = 8, s += 2;
    else return false;
    if (!*s) return false;
    double x = 0;
    for (; *s; s++) {
        if (*s == '_') continue;
        int d = hexval(*s);
        if (d >= base) return false;
        x = x * base + d;
    }
    *v = neg ? -x : x;
    return true;
}

/* ^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$ -> parseFloat without the _ */
static bool decimal(const char *s, double *v)
{
    const char *q = s;
    if (*q == '+' || *q == '-') q++;
    if (!isdig(*q)) return false;
    while (isdig(*q) || *q == '_') q++;
    if (*q == '.') {
        q++;
        if (!isdig(*q)) return false;
        while (isdig(*q) || *q == '_') q++;
    }
    if (*q == 'e' || *q == 'E') {
        q++;
        if (*q == '+' || *q == '-') q++;
        if (!isdig(*q)) return false;
        while (isdig(*q)) q++;
    }
    if (*q) return false;
    char buf[80];
    size_t o = 0;
    for (q = s; *q && o + 1 < sizeof buf; q++)
        if (*q != '_') buf[o++] = *q;
    buf[o] = 0;
    *v = strtod(buf, NULL);
    return true;
}

bool ty_time_lit(const char *body, double *ms_out)
{
    char s[96];
    size_t o = 0;
    trim_into(body, strlen(body), s, sizeof s);
    for (size_t i = 0; s[i]; i++)
        if (s[i] != '_') s[o++] = s[i];
    s[o] = 0;
    const char *q = s;
    double sign = 1;
    if (*q == '-') sign = -1, q++;
    else if (*q == '+') q++;
    /* ^\d+(\.\d+)?$ */
    const char *r = q;
    if (isdig(*r)) {
        while (isdig(*r)) r++;
        if (*r == '.' && isdig(r[1])) {
            r++;
            while (isdig(*r)) r++;
        }
        if (!*r) {
            *ms_out = sign * floor(strtod(q, NULL) + 0.5);
            return true;
        }
    }
    double ms = 0;
    bool any = false;
    while (*q) {
        const char *st = q;
        if (!isdig(*q)) return false;
        while (isdig(*q)) q++;
        if (*q == '.' && isdig(q[1])) {
            q++;
            while (isdig(*q)) q++;
        }
        char nb[48];
        size_t nl = (size_t)(q - st);
        if (nl >= sizeof nb) nl = sizeof nb - 1;
        memcpy(nb, st, nl);
        nb[nl] = 0;
        double v = strtod(nb, NULL);
        char u0 = lwc(q[0]), u1 = lwc(q[1]);
        if (u0 == 'm' && u1 == 's') ms += v, q += 2;
        else if (u0 == 'd') ms += v * 86400000.0, q++;
        else if (u0 == 'h') ms += v * 3600000.0, q++;
        else if (u0 == 'm') ms += v * 60000.0, q++;
        else if (u0 == 's') ms += v * 1000.0, q++;
        else return false;
        any = true;
    }
    if (!any) return false;
    *ms_out = sign * floor(ms + 0.5);
    return true;
}

int ty_literal(const char *text, double *v, char *str, size_t strcap)
{
    char s[256];
    trim_into(text ? text : "", text ? strlen(text) : 0, s, sizeof s);
    if (!*s) return 0;
    size_t n = strlen(s);
    if (n >= 2 && s[0] == '\'' && s[n - 1] == '\'') {
        if (str) ty_unescape(s + 1, n - 2, str, strcap);
        return 2;
    }
    if (plc_ieq(s, "true")) return *v = 1, 1;
    if (plc_ieq(s, "false")) return *v = 0, 1;
    const char *body = s;
    /* ^([A-Za-z_]+)#(.*)$ */
    size_t k = 0;
    while ((s[k] >= 'A' && s[k] <= 'Z') || (s[k] >= 'a' && s[k] <= 'z') || s[k] == '_') k++;
    if (k && s[k] == '#') {
        char pre[24];
        size_t pl = k < sizeof pre - 1 ? k : sizeof pre - 1;
        for (size_t i = 0; i < pl; i++) pre[i] = upc(s[i]);
        pre[pl] = 0;
        const char *rest = s + k + 1;
        if (!strcmp(pre, "T") || !strcmp(pre, "TIME") || !strcmp(pre, "S5T") || !strcmp(pre, "S5TIME"))
            return ty_time_lit(rest, v) ? 1 : 0;
        if (!strcmp(pre, "BOOL")) return ty_literal(rest, v, str, strcap);
        body = rest;
        /* ^[+-]?\d+# */
        const char *q = body;
        if (*q == '+' || *q == '-') q++;
        if (isdig(*q)) {
            while (isdig(*q)) q++;
            if (*q == '#') return radix(body, v) ? 1 : 0;
        }
    }
    if (decimal(body, v)) return 1;
    return radix(body, v) ? 1 : 0;
}

/* ------------------------------------------------------------ strings */
size_t ty_str_read(const uint8_t *b, const ty_t *t, char *out, size_t cap)
{
    size_t n = b[1] < t->len ? b[1] : t->len;
    if (n >= cap) n = cap - 1;
    memcpy(out, b + 2, n);
    out[n] = 0;
    return n;
}

void ty_str_write(uint8_t *b, const ty_t *t, const char *s, size_t n)
{
    if (n > t->len) n = t->len;
    b[0] = (uint8_t)t->len;
    b[1] = (uint8_t)n;
    memcpy(b + 2, s, n);
}

/* ------------------------------------------------------- start values */
/* the member default as the IDE understood it before (types.js legacyDefault) */
static bool legacy_default(const char *def, const ty_t *t, double *v)
{
    char d[256];
    trim_into(def, strlen(def), d, sizeof d);
    if (!*d) return false;
    double x;
    if (t->cls == TC_BOOL) {
        if (!strcmp(d, "1") || plc_ieq(d, "true") || plc_ieq(d, "on") || plc_ieq(d, "yes")) return *v = 1, true;
        *v = ty_literal(d, &x, NULL, 0) == 1 ? x : 0;
        return true;
    }
    if (ty_literal(d, &x, NULL, 0) == 1) return *v = x, true;
    if (t->cls == TC_TIME) return *v = plc_parse_time_ms(d), true;
    x = plc_js_parse_float(d);
    if (isnan(x)) return false;
    *v = x;
    return true;
}

/* split "a, b(c, d), 'x,y'" at top-level commas; returns the count */
static int split_top(const char *s, const char **parts, size_t *lens, int maxp)
{
    int n = 0, depth = 0;
    bool q = false;
    const char *cur = s;
    for (const char *c = s;; c++) {
        if (!*c || (!q && depth == 0 && *c == ',')) {
            if (*c || c > cur || n) {
                if (n < maxp) parts[n] = cur, lens[n] = (size_t)(c - cur);
                n++;
            }
            if (!*c) break;
            cur = c + 1;
            continue;
        }
        if (*c == '\'') q = !q;
        if (!q && (*c == '(' || *c == '[')) depth++;
        if (!q && (*c == ')' || *c == ']')) depth--;
    }
    return n;
}

void ty_init(plc_t *p, uint8_t *b, uint8_t bit, const ty_t *t, const char *def)
{
    switch (t->k) {
    case TK_EL: {
        double v;
        if (def && legacy_default(def, t, &v)) ty_write(b, bit, t, ty_conv(v, t));
        return;
    }
    case TK_STR: {
        b[0] = (uint8_t)t->len;
        char sv[256];
        double dummy;
        if (def && ty_literal(def, &dummy, sv, sizeof sv) == 2) ty_str_write(b, t, sv, strlen(sv));
        return;
    }
    case TK_STRUCT:
    case TK_FB:
        for (uint16_t i = 0; i < t->nf; i++)
            if (t->f[i].t->k != TK_VARIANT) ty_init(p, b + t->f[i].off, t->f[i].bit, t->f[i].t, t->f[i].def);
        return;
    case TK_ARR: {
        /* per-element default texts: "[1, 2]", "16(0)", or one value for all */
        const char *vals[64];
        size_t vlen[64];
        int nv = 0;
        bool all = false;
        char s[256];
        if (def) {
            trim_into(def, strlen(def), s, sizeof s);
            size_t sl = strlen(s);
            char *body = s;
            if (sl >= 2 && s[0] == '[' && s[sl - 1] == ']') s[sl - 1] = 0, body = s + 1;
            if (*s) {
                const char *parts[64];
                size_t lens[64];
                int np = split_top(body, parts, lens, 64);
                if (np > 64) np = 64;
                const char *p0 = parts[0];
                while (np && isws(*p0)) p0++;
                bool rep0 = false;
                if (np) {
                    const char *q = p0;
                    if (isdig(*q)) {
                        while (isdig(*q)) q++;
                        while (isws(*q)) q++;
                        rep0 = *q == '(';
                    }
                }
                if (np == 1 && !rep0) {
                    all = true;
                    vals[0] = parts[0], vlen[0] = lens[0];
                    nv = 1;
                } else {
                    for (int i = 0; i < np; i++) {
                        char part[128];
                        trim_into(parts[i], lens[i], part, sizeof part);
                        char *e;
                        long rep = isdig(part[0]) ? strtol(part, &e, 10) : -1;
                        if (rep >= 0) {
                            while (isws(*e)) e++;
                            size_t pl = strlen(e);
                            if (*e == '(' && pl >= 2 && e[pl - 1] == ')') {
                                /* n(value): point into the original text */
                                const char *orig = parts[i];
                                const char *open = strchr(orig, '(');
                                const char *close = orig + lens[i];
                                while (close > open && *(close - 1) != ')') close--;
                                for (long r = 0; r < rep && nv < 64; r++) vals[nv] = open + 1, vlen[nv] = (size_t)(close - 1 - (open + 1)), nv++;
                                continue;
                            }
                        }
                        if (nv < 64) vals[nv] = parts[i], vlen[nv] = lens[i], nv++;
                    }
                }
            }
        }
        for (uint32_t i = 0; i < t->count; i++) {
            char d[128];
            const char *dp = NULL;
            int idx = all ? 0 : (int)i;
            if (nv && idx < nv) {
                trim_into(vals[idx], vlen[idx], d, sizeof d);
                dp = d;
            }
            if (t->el->k == TK_EL && t->el->cls == TC_BOOL) ty_init(p, b + (i >> 3), (uint8_t)(i & 7), t->el, dp);
            else ty_init(p, b + i * t->stride, 0, t->el, dp);
        }
        return;
    }
    default: return;
    }
}

/* ---------------------------------------------------- paths in a type */
/* parts of "a.b[3, 4].c": names (quoted or not) and constant index lists */
typedef struct {
    const char *name;
    size_t nlen;
    int nidx;
    long idx[TY_MAX_DIMS];
} part_t;

static int path_parts(const char *s, part_t *out, int max)
{
    int n = 0;
    while (*s) {
        while (isws(*s)) s++;
        if (!*s) break;
        if (*s == '.') {
            s++;
            continue;
        }
        if (n >= max) return -1;
        part_t *pt = &out[n];
        memset(pt, 0, sizeof *pt);
        if (*s == '"') {
            const char *e = strchr(s + 1, '"');
            if (!e || e == s + 1) return -1;
            pt->name = s + 1;
            pt->nlen = (size_t)(e - s - 1);
            s = e + 1;
        } else if ((*s >= 'A' && *s <= 'Z') || (*s >= 'a' && *s <= 'z') || *s == '_') {
            const char *e = s;
            while ((*e >= 'A' && *e <= 'Z') || (*e >= 'a' && *e <= 'z') || *e == '_' || isdig(*e)) e++;
            pt->name = s;
            pt->nlen = (size_t)(e - s);
            s = e;
        } else if (*s == '[') {
            const char *e = strchr(s, ']');
            if (!e) return -1;
            const char *q = s + 1;
            while (q <= e) {
                const char *c = q;
                while (c < e && *c != ',') c++;
                char num[32];
                trim_into(q, (size_t)(c - q), num, sizeof num);
                char *x = num;
                if (*x == '-') x++;
                if (!isdig(*x)) return -1;
                while (isdig(*x)) x++;
                if (*x) return -1;
                if (pt->nidx >= TY_MAX_DIMS) return -1;
                pt->idx[pt->nidx++] = strtol(num, NULL, 10);
                q = c + 1;
            }
            s = e + 1;
        } else return -1;
        n++;
    }
    return n;
}

static const ty_t *locate_parts(const ty_t *t, const part_t *pt, int n, uint32_t *off, uint8_t *bit)
{
    uint32_t o = 0;
    uint8_t b = 0;
    for (int i = 0; i < n; i++) {
        if (pt[i].name) {
            if (t->k != TK_STRUCT && t->k != TK_FB) return NULL;
            char nm[160];
            size_t l = pt[i].nlen < sizeof nm - 1 ? pt[i].nlen : sizeof nm - 1;
            memcpy(nm, pt[i].name, l);
            nm[l] = 0;
            const fld_t *f = ty_field(t, nm);
            if (!f || f->t->k == TK_VARIANT) return NULL;
            o += f->off;
            b = f->bit;
            t = f->t;
        } else {
            if (t->k != TK_ARR || pt[i].nidx != t->ndim) return NULL;
            uint32_t lin = 0;
            for (int d = 0; d < t->ndim; d++) {
                if (pt[i].idx[d] < t->lo[d] || pt[i].idx[d] > t->hi[d]) return NULL;
                lin = lin * (uint32_t)(t->hi[d] - t->lo[d] + 1) + (uint32_t)(pt[i].idx[d] - t->lo[d]);
            }
            if (t->el->k == TK_EL && t->el->cls == TC_BOOL) o += lin >> 3, b = (uint8_t)(lin & 7);
            else o += lin * t->stride, b = 0;
            t = t->el;
        }
    }
    *off = o;
    *bit = b;
    return t;
}

const ty_t *ty_locate(const ty_t *t, const char *path, uint32_t *off, uint8_t *bit)
{
    part_t pt[24];
    int n = path_parts(path, pt, 24);
    if (n < 0) return NULL;
    return locate_parts(t, pt, n, off, bit);
}

void ty_start_values(plc_t *p, uint8_t *buf, const ty_t *t, int obj)
{
    if (jd_type(p->doc, obj) != JD_OBJ) return;
    char key[256], val[256], sv[256];
    for (int k = jd_first(p->doc, obj); k >= 0; k = jd_next(p->doc, k)) {
        int m = k + 1;
        jd_str(p->doc, k, key, sizeof key);
        uint32_t off;
        uint8_t bit;
        const ty_t *lt = ty_locate(t, key, &off, &bit);
        if (!lt) continue;
        jtext(p, m, val, sizeof val);
        double v;
        int k = ty_literal(val, &v, sv, sizeof sv);
        if (lt->k == TK_EL && k == 1) ty_write(buf + off, bit, lt, ty_conv(v, lt));
        else if (lt->k == TK_STR && k == 2) ty_str_write(buf + off, lt, sv, strlen(sv));
    }
}

/* ------------------------------------------------------------- DTL */
void ty_write_dtl(uint8_t *b, double ms)
{
    ms = floor(numx(ms));
    double days = floor(ms / 86400000.0);
    double rem = ms - days * 86400000.0;
    /* civil from days (Howard Hinnant) */
    double z = days + 719468;
    double era = floor(z / 146097);
    double doe = z - era * 146097;
    double yoe = floor((doe - floor(doe / 1460) + floor(doe / 36524) - floor(doe / 146096)) / 365);
    double y = yoe + era * 400;
    double doy = doe - (365 * yoe + floor(yoe / 4) - floor(yoe / 100));
    double mp = floor((5 * doy + 2) / 153);
    double d = doy - floor((153 * mp + 2) / 5) + 1;
    double m = mp < 10 ? mp + 3 : mp - 9;
    if (m <= 2) y += 1;
    double wd = fmod(fmod(days, 7) + 7 + 4, 7);
    ty_write(b, 0, &TY_UINT, ty_wrap(y, 16, false));
    b[2] = (uint8_t)m;
    b[3] = (uint8_t)d;
    b[4] = (uint8_t)(wd + 1);
    b[5] = (uint8_t)floor(rem / 3600000);
    rem = fmod(rem, 3600000);
    b[6] = (uint8_t)floor(rem / 60000);
    rem = fmod(rem, 60000);
    b[7] = (uint8_t)floor(rem / 1000);
    rem = fmod(rem, 1000);
    ty_write(b + 8, 0, &TY_UDINT, rem * 1000000);
}
