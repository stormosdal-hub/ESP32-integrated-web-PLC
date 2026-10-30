/* ============================================================================
 * plc_engine.c — compile a TIA Web Practice project into an executable form and
 * run its scan cycle. Semantics follow web/js/sim.js (the IDE simulator); see
 * plc_internal.h for the value/cell model.
 *
 * Deliberate behaviour shared with the patched simulator in this repo (each one
 * fixes a bug the Raspberry-Pi version had in both sim.js and plc_engine.py):
 *   - timer ET is written as whole milliseconds,
 *   - a non-integer written to a DInt/Time D-address is rounded, not packed as
 *     float32 bits,
 *   - FBD ADD/MUL use every input pin (in3, in4 ... were ignored),
 *   - FBD ET/CV output pins carry the timer/counter value even when no ET/CV
 *     operand is assigned,
 *   - an unwired FBD input reads its operand with its own type (a numeric tag
 *     on a call-box pin used to arrive as 0/1).
 * ==========================================================================*/
#include <ctype.h>
#include <setjmp.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>

#include "plc_internal.h"

/* longjmp target for out-of-memory during compile / force */
typedef struct {
    plc_t *p;
    jmp_buf jb;
} oom_ctx_t;
static oom_ctx_t *s_oom; /* engine calls are serialised by the caller's mutex */

static void oom(plc_t *p)
{
    p->oom = true;
    if (s_oom && s_oom->p == p) longjmp(s_oom->jb, 1);
}

/* ======================================================================== *
 *  Allocation: arena (IR, strings) + heap (growable tables)                  *
 * ======================================================================== */
static void *h_alloc(plc_t *p, size_t n) { return p->env.alloc ? p->env.alloc(n) : malloc(n); }
static void h_free(plc_t *p, void *x)
{
    if (!x) return;
    if (p->env.free) p->env.free(x);
    else free(x);
}

#define AR_CHUNK 8192
#define AR_HDR ((sizeof(ar_chunk_t) + 7) & ~(size_t)7)

void *plc_ar_alloc(plc_t *p, size_t n)
{
    n = (n + 7) & ~(size_t)7;
    if (n == 0) n = 8;
    ar_chunk_t *c = p->ar.head;
    if (n > AR_CHUNK / 4) {
        /* big block: own chunk, linked behind the current one so the
         * current chunk's free space is not abandoned */
        ar_chunk_t *bc = (ar_chunk_t *)h_alloc(p, AR_HDR + n);
        if (!bc) {
            oom(p);
            return NULL;
        }
        bc->used = bc->cap = n;
        if (c) {
            bc->next = c->next;
            c->next = bc;
        } else {
            bc->next = NULL;
            p->ar.head = bc;
        }
        void *r = (uint8_t *)bc + AR_HDR;
        memset(r, 0, n);
        return r;
    }
    if (!c || c->used + n > c->cap) {
        ar_chunk_t *nc = (ar_chunk_t *)h_alloc(p, AR_HDR + AR_CHUNK);
        if (!nc) {
            oom(p);
            return NULL;
        }
        nc->next = c;
        nc->used = 0;
        nc->cap = AR_CHUNK;
        p->ar.head = nc;
        c = nc;
    }
    void *r = (uint8_t *)c + AR_HDR + c->used;
    c->used += n;
    memset(r, 0, n);
    return r;
}

char *plc_ar_strdup(plc_t *p, const char *s, size_t n)
{
    char *r = (char *)plc_ar_alloc(p, n + 1);
    if (n) memcpy(r, s, n);
    r[n] = 0;
    return r;
}

static char *ar_dup(plc_t *p, const char *s) { return plc_ar_strdup(p, s ? s : "", s ? strlen(s) : 0); }

static void *vec_reserve(plc_t *p, void *arr, size_t *cap, size_t need, size_t elsz)
{
    if (need <= *cap) return arr;
    size_t nc = *cap ? *cap * 2 : 16;
    while (nc < need) nc *= 2;
    void *na = h_alloc(p, nc * elsz);
    if (!na) {
        oom(p);
        return arr;
    }
    if (arr) {
        memcpy(na, arr, *cap * elsz);
        h_free(p, arr);
    }
    *cap = nc;
    return na;
}

/* ---------------------------------------------------------- string map */
static uint32_t hash_str(const char *s)
{
    uint32_t h = 2166136261u;
    while (*s) {
        h ^= (uint8_t)*s++;
        h *= 16777619u;
    }
    return h;
}

static int32_t smap_get(const smap_t *m, const char *k)
{
    if (!m->cap) return -1;
    uint32_t i = hash_str(k) & (m->cap - 1);
    while (m->keys[i]) {
        if (strcmp(m->keys[i], k) == 0) return m->vals[i];
        i = (i + 1) & (m->cap - 1);
    }
    return -1;
}

static void smap_insert_raw(smap_t *m, const char *k, int32_t v)
{
    uint32_t i = hash_str(k) & (m->cap - 1);
    while (m->keys[i]) {
        if (strcmp(m->keys[i], k) == 0) {
            m->vals[i] = v;
            return;
        }
        i = (i + 1) & (m->cap - 1);
    }
    m->keys[i] = k;
    m->vals[i] = v;
    m->n++;
}

/* key must outlive the map (arena string). Existing keys are updated. */
static void smap_put(plc_t *p, smap_t *m, const char *k, int32_t v)
{
    if ((m->n + 1) * 10 >= m->cap * 7) {
        uint32_t nc = m->cap ? m->cap * 2 : 32;
        smap_t nm = {0};
        nm.keys = (const char **)h_alloc(p, nc * sizeof(char *));
        nm.vals = (int32_t *)h_alloc(p, nc * sizeof(int32_t));
        if (!nm.keys || !nm.vals) {
            h_free(p, (void *)nm.keys);
            h_free(p, nm.vals);
            oom(p);
            return;
        }
        memset((void *)nm.keys, 0, nc * sizeof(char *));
        nm.cap = nc;
        for (uint32_t i = 0; i < m->cap; i++)
            if (m->keys[i]) smap_insert_raw(&nm, m->keys[i], m->vals[i]);
        h_free(p, (void *)m->keys);
        h_free(p, m->vals);
        *m = nm;
    }
    smap_insert_raw(m, k, v);
}

/* put only when absent (Python setdefault / "first one wins") */
static void smap_put_first(plc_t *p, smap_t *m, const char *k, int32_t v)
{
    if (smap_get(m, k) < 0) smap_put(p, m, k, v);
}

static void smap_free(plc_t *p, smap_t *m)
{
    h_free(p, (void *)m->keys);
    h_free(p, m->vals);
    memset(m, 0, sizeof *m);
}

/* ======================================================================== *
 *  Diagnostics                                                               *
 * ======================================================================== */
#define PLC_MAX_WARNINGS 64

void plc_warnf(plc_t *p, const char *fmt, ...)
{
    if (p->nwarn >= PLC_MAX_WARNINGS) return;
    char buf[200];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    for (size_t i = 0; i < p->nwarn; i++)
        if (strcmp(p->warn[i], buf) == 0) return; /* no duplicates */
    p->warn = (const char **)vec_reserve(p, (void *)p->warn, &p->cwarn, p->nwarn + 1, sizeof(char *));
    p->warn[p->nwarn++] = ar_dup(p, buf);
}

void plc_errorf(plc_t *p, const char *fmt, ...)
{
    p->err_count++;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(p->last_error, sizeof p->last_error, fmt, ap);
    va_end(ap);
}

/* ======================================================================== *
 *  Small string helpers (ASCII, locale-free)                                 *
 * ======================================================================== */
static char lc(char c) { return (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c; }
static char ucc(char c) { return (c >= 'a' && c <= 'z') ? (char)(c - 32) : c; }
static bool isdig(char c) { return c >= '0' && c <= '9'; }
static bool isws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == '\f' || c == '\v'; }

static bool ieq(const char *a, const char *b)
{
    while (*a && *b) {
        if (lc(*a) != lc(*b)) return false;
        a++, b++;
    }
    return *a == *b;
}

static void trim_copy(const char *s, char *out, size_t cap)
{
    if (!s) s = "";
    while (isws(*s)) s++;
    size_t n = strlen(s);
    while (n && isws(s[n - 1])) n--;
    if (n >= cap) n = cap - 1;
    memcpy(out, s, n);
    out[n] = 0;
}

static void to_lower(const char *s, char *out, size_t cap)
{
    size_t i = 0;
    for (; s[i] && i + 1 < cap; i++) out[i] = lc(s[i]);
    out[i] = 0;
}

static void to_upper(const char *s, char *out, size_t cap)
{
    size_t i = 0;
    for (; s[i] && i + 1 < cap; i++) out[i] = ucc(s[i]);
    out[i] = 0;
}

/* ^-?\d+(\.\d+)?$ */
static bool is_num_lit(const char *s)
{
    if (*s == '-') s++;
    if (!isdig(*s)) return false;
    while (isdig(*s)) s++;
    if (*s == '.') {
        s++;
        if (!isdig(*s)) return false;
        while (isdig(*s)) s++;
    }
    return *s == 0;
}

/* ^\d+(\.\d+)?$ */
static bool is_unum_lit(const char *s) { return *s != '-' && is_num_lit(s); }

/* ^(s5)?t(ime)?#  (case-insensitive); returns prefix length or 0 */
static size_t time_prefix(const char *s)
{
    size_t i = 0;
    if (lc(s[0]) == 's' && s[1] == '5') i = 2;
    if (lc(s[i]) != 't') return 0;
    i++;
    if (lc(s[i]) == 'i' && lc(s[i + 1]) == 'm' && lc(s[i + 2]) == 'e') i += 3;
    if (s[i] != '#') return 0;
    return i + 1;
}

/* JS parseFloat(): leading decimal literal, NaN when none */
static double js_parse_float(const char *s)
{
    while (isws(*s)) s++;
    const char *b = s;
    if (*s == '+' || *s == '-') s++;
    if (strncmp(s, "Infinity", 8) == 0) return (*b == '-') ? -INFINITY : INFINITY;
    bool dig = false;
    while (isdig(*s)) s++, dig = true;
    if (*s == '.') {
        s++;
        while (isdig(*s)) s++, dig = true;
    }
    if (!dig) return NAN;
    if (*s == 'e' || *s == 'E') {
        const char *e = s + 1;
        if (*e == '+' || *e == '-') e++;
        if (isdig(*e)) {
            while (isdig(*e)) e++;
            s = e;
        }
    }
    char buf[64];
    size_t n = (size_t)(s - b);
    if (n >= sizeof buf) n = sizeof buf - 1;
    memcpy(buf, b, n);
    buf[n] = 0;
    return strtod(buf, NULL);
}

static double js_round(double x) { return floor(x + 0.5); }

/* T.parseTime: IEC time literal / plain ms -> milliseconds */
double plc_parse_time_ms(const char *in)
{
    char s[128];
    trim_copy(in, s, sizeof s);
    if (is_unum_lit(s)) return js_round(strtod(s, NULL));
    const char *body = s + time_prefix(s);
    double ms = 0;
    bool matched = false;
    size_t i = 0;
    while (body[i]) {
        if (!isdig(body[i])) {
            i++;
            continue;
        }
        size_t j = i;
        while (isdig(body[j])) j++;
        size_t int_end = j, frac_end = j;
        if (body[j] == '.' && isdig(body[j + 1])) {
            j++;
            while (isdig(body[j])) j++;
            frac_end = j;
        }
        bool hit = false;
        for (int pass = 0; pass < 2 && !hit; pass++) {
            size_t num_end = pass == 0 ? frac_end : int_end;
            if (pass == 1 && frac_end == int_end) break;
            size_t k = num_end;
            while (isws(body[k])) k++;
            double mult = 0;
            size_t ulen = 0;
            char u0 = lc(body[k]), u1 = lc(body[k + 1]);
            if (u0 == 'm' && u1 == 's') mult = 1, ulen = 2;
            else if (u0 == 's') mult = 1000, ulen = 1;
            else if (u0 == 'm') mult = 60000, ulen = 1;
            else if (u0 == 'h') mult = 3600000, ulen = 1;
            else if (u0 == 'd') mult = 86400000, ulen = 1;
            if (ulen) {
                char nb[48];
                size_t nl = num_end - i;
                if (nl >= sizeof nb) nl = sizeof nb - 1;
                memcpy(nb, body + i, nl);
                nb[nl] = 0;
                ms += strtod(nb, NULL) * mult;
                matched = true;
                i = k + ulen;
                hit = true;
            }
        }
        if (!hit) i++;
    }
    if (matched) return js_round(ms);
    double v = js_parse_float(body);
    return (isnan(v) || v == 0) ? 0 : v;
}

/* ======================================================================== *
 *  Addresses                                                                 *
 * ======================================================================== */
typedef struct {
    uint8_t k, area, bit;
    uint32_t off;
} addr_t;

static size_t area_size(uint8_t a)
{
    return a == AREA_I ? PLC_AREA_I_BYTES : a == AREA_Q ? PLC_AREA_Q_BYTES : PLC_AREA_M_BYTES;
}

static uint8_t *area_ptr(plc_t *p, uint8_t a) { return a == AREA_I ? p->I : a == AREA_Q ? p->Q : p->M; }

static bool rd_uint(const char **ps, uint32_t *out)
{
    const char *s = *ps;
    if (!isdig(*s)) return false;
    uint64_t v = 0;
    while (isdig(*s)) {
        v = v * 10 + (uint64_t)(*s - '0');
        if (v > 0xFFFFFFFFu) v = 0xFFFFFFFFu;
        s++;
    }
    *out = (uint32_t)v;
    *ps = s;
    return true;
}

/* 0 = not an address, 1 = valid, 2 = address-shaped but out of range */
static int parse_addr(const char *s, addr_t *a)
{
    char c = ucc(s[0]);
    if (c != 'I' && c != 'Q' && c != 'M') return 0;
    a->area = c == 'I' ? AREA_I : c == 'Q' ? AREA_Q : AREA_M;
    const char *q = s + 1;
    uint32_t off, bit;
    size_t width;
    if (isdig(*q)) {
        if (!rd_uint(&q, &off) || *q != '.') return 0;
        q++;
        if (!rd_uint(&q, &bit) || *q) return 0;
        a->k = CK_BIT;
        a->off = off;
        if (bit > 7) return 2;
        a->bit = (uint8_t)bit;
        width = 1;
    } else {
        char w = ucc(*q);
        if (w != 'B' && w != 'W' && w != 'D') return 0;
        q++;
        if (!rd_uint(&q, &off) || *q) return 0;
        a->k = w == 'B' ? CK_BYTE : w == 'W' ? CK_WORD : CK_DINT;
        a->off = off;
        a->bit = 0;
        width = w == 'B' ? 1 : w == 'W' ? 2 : 4;
    }
    if ((uint64_t)off + width > area_size(a->area)) return 2;
    return 1;
}

static void addr_name(const addr_t *a, char *out, size_t cap)
{
    static const char AR[3] = {'I', 'Q', 'M'};
    if (a->k == CK_BIT) snprintf(out, cap, "%c%u.%u", AR[a->area], (unsigned)a->off, (unsigned)a->bit);
    else snprintf(out, cap, "%c%c%u", AR[a->area], a->k == CK_BYTE ? 'B' : a->k == CK_WORD ? 'W' : 'D', (unsigned)a->off);
}

/* ======================================================================== *
 *  Cells                                                                     *
 * ======================================================================== */
static cref_t mkref(uint8_t k, uint8_t area, uint8_t bit, uint16_t off, uint16_t idx)
{
    cref_t c;
    c.k = k;
    c.area = area;
    c.bit = bit;
    c.pad = 0;
    c.off = off;
    c.idx = idx;
    return c;
}

static cref_t lit_cell(plc_t *p, pv_t v)
{
    if (p->nlits >= 0xFFFF) return mkref(CK_NONE, 0, 0, 0, 0);
    p->lits = (pv_t *)vec_reserve(p, p->lits, &p->clits, p->nlits + 1, sizeof(pv_t));
    p->lits[p->nlits] = v;
    return mkref(CK_LIT, 0, 0, 0, (uint16_t)p->nlits++);
}

static cref_t addr_cell(plc_t *p, const addr_t *a)
{
    char name[24];
    addr_name(a, name, sizeof name);
    int32_t r = smap_get(&p->reg_map, name);
    uint8_t k = a->k;
    if (k == CK_DINT && smap_get(&p->real_addr, name) == 1) k = CK_REAL;
    if (r < 0) {
        if (p->nregs >= 0xFFFF) return mkref(CK_NONE, 0, 0, 0, 0);
        p->regs = (areg_t *)vec_reserve(p, p->regs, &p->cregs, p->nregs + 1, sizeof(areg_t));
        areg_t *e = &p->regs[p->nregs];
        e->name = ar_dup(p, name);
        e->k = k;
        e->area = a->area;
        e->bit = a->bit;
        e->off = (uint16_t)a->off;
        e->touched = 0;
        r = (int32_t)p->nregs++;
        smap_put(p, &p->reg_map, e->name, r);
    }
    return mkref(k, a->area, a->bit, (uint16_t)a->off, (uint16_t)r);
}

/* named flat cell, case-insensitive (JS keys '@'+NAME.toUpperCase()) */
static cref_t sym_cell(plc_t *p, const char *name, uint8_t type, bool *created)
{
    char key[200];
    to_upper(name, key, sizeof key);
    int32_t i = smap_get(&p->sym_map, key);
    if (created) *created = (i < 0);
    if (i < 0) {
        if (p->nsyms >= 0xFFFF) return mkref(CK_NONE, 0, 0, 0, 0);
        p->syms = (sym_t *)vec_reserve(p, p->syms, &p->csyms, p->nsyms + 1, sizeof(sym_t));
        sym_t *s = &p->syms[p->nsyms];
        s->name = ar_dup(p, name);
        s->type = type;
        s->v = (type == SYM_BOOL) ? pvb(false) : pvn(0);
        s->written = 0;
        s->is_tag = 0;
        i = (int32_t)p->nsyms++;
        smap_put(p, &p->sym_map, ar_dup(p, key), i);
    }
    return mkref(CK_SYM, 0, 0, 0, (uint16_t)i);
}

static void touch(plc_t *p, cref_t c)
{
    if (c.idx < p->nregs) p->regs[c.idx].touched = 1;
}

static double round7(float f)
{
    if (f == 0) return 0;
    if (!isfinite(f)) return (double)f;
    char b[40];
    snprintf(b, sizeof b, "%.7g", (double)f);
    return strtod(b, NULL);
}

pv_t plc_rd(plc_t *p, cref_t c)
{
    switch (c.k) {
    case CK_LIT: return p->lits[c.idx];
    case CK_SYM: return p->syms[c.idx].v;
    case CK_BIT: return pvb((area_ptr(p, c.area)[c.off] >> c.bit) & 1);
    case CK_BYTE: return pvn(area_ptr(p, c.area)[c.off]);
    case CK_WORD: {
        const uint8_t *b = area_ptr(p, c.area) + c.off;
        return pvn((int16_t)(uint16_t)((b[0] << 8) | b[1]));
    }
    case CK_DINT:
    case CK_REAL: {
        const uint8_t *b = area_ptr(p, c.area) + c.off;
        uint32_t u = ((uint32_t)b[0] << 24) | ((uint32_t)b[1] << 16) | ((uint32_t)b[2] << 8) | b[3];
        if (c.k == CK_DINT) return pvn((int32_t)u);
        float f;
        memcpy(&f, &u, 4);
        return pvn(round7(f));
    }
    default: return pvb(false);
    }
}

/* ECMAScript ToUint32 of an integral double */
static uint32_t js_u32(double x)
{
    if (!isfinite(x)) return 0;
    double m = fmod(trunc(x), 4294967296.0);
    if (m < 0) m += 4294967296.0;
    return (uint32_t)m;
}

void plc_wr(plc_t *p, cref_t c, pv_t v)
{
    switch (c.k) {
    case CK_SYM: {
        sym_t *s = &p->syms[c.idx];
        if (s->type == SYM_BOOL) s->v = pvb(truthy(v));
        else if (s->type == SYM_NUM || v.t == PV_NUM) s->v = pvn(numv(v));
        else s->v = v;
        s->written = 1;
        return;
    }
    case CK_BIT: {
        uint8_t *b = area_ptr(p, c.area) + c.off;
        if (truthy(v)) *b = (uint8_t)(*b | (1u << c.bit));
        else *b = (uint8_t)(*b & ~(1u << c.bit));
        touch(p, c);
        return;
    }
    case CK_BYTE:
    case CK_WORD:
    case CK_DINT:
    case CK_REAL: {
        uint8_t *b = area_ptr(p, c.area) + c.off;
        double x = numv(v);
        if (c.k == CK_BYTE) {
            b[0] = (uint8_t)(js_u32(floor(x + 0.5)) & 0xFF);
        } else if (c.k == CK_WORD) {
            uint32_t w = js_u32(floor(x + 0.5)) & 0xFFFF;
            b[0] = (uint8_t)(w >> 8);
            b[1] = (uint8_t)w;
        } else {
            uint32_t u;
            if (c.k == CK_REAL) {
                float f = (float)x;
                memcpy(&u, &f, 4);
            } else {
                u = js_u32(floor(x + 0.5));
            }
            b[0] = (uint8_t)(u >> 24);
            b[1] = (uint8_t)(u >> 16);
            b[2] = (uint8_t)(u >> 8);
            b[3] = (uint8_t)u;
        }
        touch(p, c);
        return;
    }
    default: return; /* CK_NONE / CK_LIT */
    }
}

static inline bool rdb(plc_t *p, cref_t c) { return truthy(plc_rd(p, c)); }
static inline double rdn(plc_t *p, cref_t c) { return numv(plc_rd(p, c)); }
static inline void wrb(plc_t *p, cref_t c, bool b) { plc_wr(p, c, pvb(b)); }
static inline void wrn(plc_t *p, cref_t c, double x) { plc_wr(p, c, pvn(x)); }

/* ======================================================================== *
 *  Operand resolution (T.resolve)                                            *
 * ======================================================================== */
ref_t plc_resolve(plc_t *p, const members_t *mem, const char *raw_in)
{
    ref_t r;
    r.c = mkref(CK_NONE, 0, 0, 0, 0);
    r.bit = false;
    char sbuf[192];
    trim_copy(raw_in, sbuf, sizeof sbuf);
    char *s = sbuf;
    if (!*s) return r;
    if (*s == '%') {
        s++;
        while (isws(*s)) s++;
        if (!*s) return r;
    }
    if (is_num_lit(s)) {
        r.c = lit_cell(p, pvn(strtod(s, NULL)));
        return r;
    }
    if (ieq(s, "true") || ieq(s, "false")) {
        r.c = lit_cell(p, pvb(ieq(s, "true")));
        return r;
    }
    if (time_prefix(s)) {
        r.c = lit_cell(p, pvn(plc_parse_time_ms(s)));
        return r;
    }
    addr_t a;
    int ar = parse_addr(s, &a);
    if (ar == 1) {
        r.c = addr_cell(p, &a);
        r.bit = (a.k == CK_BIT);
        return r;
    }
    char low[192];
    to_lower(s, low, sizeof low);
    if (mem && mem->n) {
        int32_t mi = smap_get(&mem->map, low);
        if (mi >= 0) {
            r.c = mem->cell[mi];
            r.bit = mem->is_bool[mi] != 0;
            return r;
        }
    }
    int32_t ti = smap_get(&p->tag_exact, s);
    if (ti < 0) ti = smap_get(&p->tag_lower, low);
    if (ti >= 0) {
        r.c = p->tags[ti].c;
        r.bit = p->tags[ti].is_bool != 0;
        return r;
    }
    if (ar == 2) plc_warnf(p, "Address %s is outside the process image (I/Q %u bytes, M %u bytes) - kept as a symbolic cell",
                           s, (unsigned)PLC_AREA_I_BYTES, (unsigned)PLC_AREA_M_BYTES);
    r.c = sym_cell(p, s, SYM_ANY, NULL);
    return r;
}

/* ======================================================================== *
 *  JSON access helpers (compile time)                                        *
 * ======================================================================== */
#define D (p->doc)

static void jget_str(plc_t *p, int obj, const char *key, char *out, size_t cap)
{
    int v = jd_get(D, obj, key);
    if (v < 0 || jd_type(D, v) == JD_NULL) {
        out[0] = 0;
        return;
    }
    jd_str(D, v, out, cap);
}

static char *jdup_node(plc_t *p, int v)
{
    if (v < 0) return ar_dup(p, "");
    size_t n = jd_str(D, v, NULL, 0);
    char *s = (char *)plc_ar_alloc(p, n + 1);
    jd_str(D, v, s, n + 1);
    return s;
}

static char *jdup(plc_t *p, int obj, const char *key) { return jdup_node(p, jd_get(D, obj, key)); }

static int jarr(plc_t *p, int obj, const char *key)
{
    int v = jd_get(D, obj, key);
    return jd_type(D, v) == JD_ARR ? v : -1;
}

/* ======================================================================== *
 *  Monitor flag slots                                                        *
 * ======================================================================== */
enum { FL_LIVE, FL_POWER, FL_PIN };

static int32_t flag_slot(plc_t *p, int which, const char *id)
{
    if (!id || !*id) return -1;
    flag_t **arr;
    size_t *n, *cap;
    smap_t *m;
    if (which == FL_LIVE) arr = &p->live, n = &p->nlive, cap = &p->clive, m = &p->live_map;
    else if (which == FL_POWER) arr = &p->power, n = &p->npower, cap = &p->cpower, m = &p->power_map;
    else arr = &p->pins, n = &p->npins, cap = &p->cpins, m = &p->pin_map;
    int32_t i = smap_get(m, id);
    if (i >= 0) return i;
    *arr = (flag_t *)vec_reserve(p, *arr, cap, *n + 1, sizeof(flag_t));
    flag_t *f = &(*arr)[*n];
    f->id = ar_dup(p, id);
    f->v = 0;
    f->seen = 0;
    i = (int32_t)(*n)++;
    smap_put(p, m, f->id, i);
    return i;
}

/* slot for the model object's "id" (read via a stack buffer: flag_slot keeps
 * the only arena copy) */
static int32_t flag_slot_of(plc_t *p, int which, int obj)
{
    char id[96];
    jget_str(p, obj, "id", id, sizeof id);
    return flag_slot(p, which, id);
}

static inline void setflag(flag_t *arr, int32_t slot, bool v)
{
    if (slot >= 0) {
        arr[slot].v = v ? 1 : 0;
        arr[slot].seen = 1;
    }
}

/* ======================================================================== *
 *  Instruction catalog                                                       *
 * ======================================================================== */
static const struct {
    const char *name;
    uint8_t k;
} KINDS[] = {
    {"contact_no", K_CONTACT_NO}, {"contact_nc", K_CONTACT_NC}, {"edge_p", K_EDGE_P}, {"edge_n", K_EDGE_N},
    {"coil", K_COIL}, {"coil_neg", K_COIL_NEG}, {"coil_set", K_COIL_SET}, {"coil_reset", K_COIL_RESET},
    {"sr", K_SR}, {"rs", K_RS}, {"p_trig", K_P_TRIG}, {"n_trig", K_N_TRIG}, {"r_trig", K_R_TRIG},
    {"f_trig", K_F_TRIG}, {"fb_and", K_FB_AND}, {"fb_or", K_FB_OR}, {"fb_xor", K_FB_XOR}, {"fb_not", K_FB_NOT},
    {"assign", K_ASSIGN}, {"compare", K_COMPARE}, {"ton", K_TON}, {"tof", K_TOF}, {"tp", K_TP},
    {"ctu", K_CTU}, {"ctd", K_CTD}, {"ctud", K_CTUD}, {"move", K_MOVE}, {"add", K_ADD}, {"sub", K_SUB},
    {"mul", K_MUL}, {"div", K_DIV}, {"norm_x", K_NORM_X}, {"scale_x", K_SCALE_X}, {"call", K_CALL},
};

static uint8_t kind_of(const char *s)
{
    for (size_t i = 0; i < sizeof KINDS / sizeof KINDS[0]; i++)
        if (strcmp(KINDS[i].name, s) == 0) return KINDS[i].k;
    return K_UNKNOWN;
}

static const char *const KP_TIMER[] = {"pt", "q", "et", NULL};
static const char *const KP_CTR[] = {"pv", "r", "cv", "q", NULL};
static const char *const KP_CTUD[] = {"pv", "r", "cv", "ld", "cd", "qu", "qd", NULL};
static const char *const KP_MOVE[] = {"in", "out", NULL};
static const char *const KP_MATH[] = {"in1", "in2", "out", "eno", NULL};
static const char *const KP_SCALE[] = {"min", "val", "max", "out", "eno", NULL};
static const char *const KP_CMP[] = {"in1", "in2", NULL};
static const char *const KP_SR[] = {"r", NULL};
static const char *const KP_RS[] = {"s", NULL};
static const char *const KP_TRIG[] = {"q", NULL};

static const char *const *kparams(uint8_t k)
{
    switch (k) {
    case K_TON: case K_TOF: case K_TP: return KP_TIMER;
    case K_CTU: case K_CTD: return KP_CTR;
    case K_CTUD: return KP_CTUD;
    case K_MOVE: return KP_MOVE;
    case K_ADD: case K_SUB: case K_MUL: case K_DIV: return KP_MATH;
    case K_NORM_X: case K_SCALE_X: return KP_SCALE;
    case K_COMPARE: return KP_CMP;
    case K_SR: return KP_SR;
    case K_RS: return KP_RS;
    case K_P_TRIG: case K_N_TRIG: case K_R_TRIG: case K_F_TRIG: return KP_TRIG;
    default: return NULL;
    }
}

static bool is_timer(uint8_t k) { return k == K_TON || k == K_TOF || k == K_TP; }

/* kinds that keep per-instance state between scans (node->st) */
static bool has_state(uint8_t k)
{
    switch (k) {
    case K_EDGE_P: case K_EDGE_N: case K_SR: case K_RS:
    case K_P_TRIG: case K_N_TRIG: case K_R_TRIG: case K_F_TRIG:
    case K_TON: case K_TOF: case K_TP: case K_CTU: case K_CTD: case K_CTUD:
        return true;
    default:
        return false;
    }
}

static uint8_t cmp_of(const char *s)
{
    if (!*s || !strcmp(s, "==")) return CMP_EQ;
    if (!strcmp(s, "<>")) return CMP_NE;
    if (!strcmp(s, ">")) return CMP_GT;
    if (!strcmp(s, "<")) return CMP_LT;
    if (!strcmp(s, ">=")) return CMP_GE;
    if (!strcmp(s, "<=")) return CMP_LE;
    return CMP_BAD;
}

/* sim.js inParamKey: unwired numeric pins read a params literal/operand */
static const char *in_param_key(uint8_t k, const char *pin)
{
    switch (k) {
    case K_COMPARE:
    case K_ADD: case K_SUB: case K_MUL: case K_DIV:
        if (!strcmp(pin, "in1")) return "in1";
        if (!strcmp(pin, "in2")) return "in2";
        return NULL;
    case K_TON: case K_TOF: case K_TP: return !strcmp(pin, "PT") ? "pt" : NULL;
    case K_CTU: case K_CTD: case K_CTUD: return !strcmp(pin, "PV") ? "pv" : NULL;
    case K_MOVE: return !strcmp(pin, "IN") ? "in" : NULL;
    case K_NORM_X: case K_SCALE_X:
        if (!strcmp(pin, "MIN")) return "min";
        if (!strcmp(pin, "VALUE")) return "val";
        if (!strcmp(pin, "MAX")) return "max";
        return NULL;
    default: return NULL;
    }
}

/* sim.js unwiredNum(): named numeric inputs -> (pin name, params key, param slot) */
typedef struct {
    const char *want, *pkey;
    int8_t slot;
} sem_t;

static int sem_inputs(uint8_t k, sem_t out[3])
{
    switch (k) {
    case K_COMPARE:
        out[0] = (sem_t){"in1", "in1", CP_IN1};
        out[1] = (sem_t){"in2", "in2", CP_IN2};
        return 2;
    case K_ADD: case K_SUB: case K_MUL: case K_DIV:
        out[0] = (sem_t){"in1", "in1", MA_IN1};
        out[1] = (sem_t){"in2", "in2", MA_IN2};
        return 2;
    case K_NORM_X: case K_SCALE_X:
        out[0] = (sem_t){"MIN", "min", SC_MIN};
        out[1] = (sem_t){"VALUE", "val", SC_VAL};
        out[2] = (sem_t){"MAX", "max", SC_MAX};
        return 3;
    case K_TON: case K_TOF: case K_TP: out[0] = (sem_t){"PT", "pt", TM_PT}; return 1;
    case K_CTU: case K_CTD: case K_CTUD: out[0] = (sem_t){"PV", "pv", CT_PV}; return 1;
    case K_MOVE: out[0] = (sem_t){"IN", "in", MV_IN}; return 1;
    default: return 0;
    }
}

/* ======================================================================== *
 *  Compile: tags                                                             *
 * ======================================================================== */
static uint8_t sym_type_for(const char *dtype) { return strcmp(dtype, "Bool") == 0 ? SYM_BOOL : SYM_NUM; }

static void compile_tags(plc_t *p)
{
    int arr = jarr(p, 0, "tags");
    uint32_t cnt = jd_count(D, arr);
    p->tags = (tag_t *)plc_ar_alloc(p, sizeof(tag_t) * (cnt ? cnt : 1));
    char name[160], dtype[32], addr[64], up[64];

    /* pass 1: which D addresses hold a Real (first tag at an address decides,
     * like core.js isRealAddr -> T.tagByAddress) */
    smap_t seen_addr = {0};
    for (int t = jd_first(D, arr); t >= 0; t = jd_next(D, t)) {
        if (jd_type(D, t) != JD_OBJ) continue;
        jget_str(p, t, "address", addr, sizeof addr);
        char tr[64];
        trim_copy(addr, tr, sizeof tr);
        addr_t a;
        if (!*tr || parse_addr(tr, &a) != 1 || a.k != CK_DINT) continue;
        addr_name(&a, up, sizeof up);
        if (smap_get(&seen_addr, up) >= 0) continue;
        const char *key = ar_dup(p, up);
        smap_put(p, &seen_addr, key, 1);
        jget_str(p, t, "dataType", dtype, sizeof dtype);
        smap_put(p, &p->real_addr, key, strcmp(dtype, "Real") == 0 ? 1 : 0);
    }
    smap_free(p, &seen_addr);

    /* pass 2: cells + aliases + seed values */
    for (int t = jd_first(D, arr); t >= 0; t = jd_next(D, t)) {
        if (jd_type(D, t) != JD_OBJ) continue;
        jget_str(p, t, "name", name, sizeof name);
        char nm[160];
        trim_copy(name, nm, sizeof nm);
        if (!*nm) continue;
        tag_t *tg = &p->tags[p->ntags];
        tg->name = ar_dup(p, name);
        tg->dtype = jdup(p, t, "dataType");
        if (!*tg->dtype) tg->dtype = "Bool";
        jget_str(p, t, "address", addr, sizeof addr);
        char tr[64];
        trim_copy(addr, tr, sizeof tr);
        tg->addr = ar_dup(p, tr);
        tg->comment = jdup(p, t, "comment");
        tg->is_bool = strcmp(tg->dtype, "Bool") == 0;
        uint8_t st = sym_type_for(tg->dtype);
        addr_t a;
        int ar = *tr ? parse_addr(tr, &a) : 0;
        if (ar == 1) {
            tg->c = addr_cell(p, &a);
        } else {
            if (ar == 2) plc_warnf(p, "Tag \"%s\": address %s is outside the process image - kept as a symbolic cell", tg->name, tr);
            if (*tr) to_upper(tr, up, sizeof up);
            tg->c = sym_cell(p, *tr ? up : tg->name, st, NULL);
            if (tg->c.k == CK_SYM) {
                p->syms[tg->c.idx].is_tag = 1;
                p->syms[tg->c.idx].type = st;
            }
        }
        /* aliases: exact name, then case-insensitive name (first one wins) */
        smap_put_first(p, &p->tag_exact, tg->name, (int32_t)p->ntags);
        char low[160];
        to_lower(tg->name, low, sizeof low);
        smap_put_first(p, &p->tag_lower, ar_dup(p, low), (int32_t)p->ntags);
        /* seed: declared tags exist with FALSE / 0 (plc_engine.py _seed_memory) */
        plc_wr(p, tg->c, tg->is_bool ? pvb(false) : pvn(0));
        p->ntags++;
    }
}

/* ======================================================================== *
 *  Compile: blocks index                                                     *
 * ======================================================================== */
static blk_t *find_block(plc_t *p, const char *ref)
{
    if (!ref || !*ref) return NULL;
    int32_t i = smap_get(&p->blk_id, ref);
    if (i < 0) i = smap_get(&p->blk_name, ref);
    return i >= 0 ? &p->blocks[i] : NULL;
}

static void index_blocks(plc_t *p)
{
    int arr = jarr(p, 0, "blocks");
    uint32_t cnt = jd_count(D, arr);
    p->blocks = (blk_t *)plc_ar_alloc(p, sizeof(blk_t) * (cnt ? cnt : 1));
    char buf[32];
    for (int b = jd_first(D, arr); b >= 0; b = jd_next(D, b)) {
        if (jd_type(D, b) != JD_OBJ) continue;
        blk_t *k = &p->blocks[p->nblocks];
        k->json = b;
        k->id = jdup(p, b, "id");
        k->name = jdup(p, b, "name");
        jget_str(p, b, "type", buf, sizeof buf);
        k->type = !strcmp(buf, "OB") ? BT_OB : !strcmp(buf, "FC") ? BT_FC : !strcmp(buf, "FB") ? BT_FB
                : !strcmp(buf, "DB") ? BT_DB : BT_OTHER;
        jget_str(p, b, "lang", buf, sizeof buf);
        k->lang = !strcmp(buf, "SCL") ? BL_SCL : !strcmp(buf, "FBD") ? BL_FBD : BL_LAD;
        k->number = jd_num(D, jd_get(D, b, "number"), 0);
        if (k->type != BT_DB) p->has_logic = true;
        if (*k->id) smap_put_first(p, &p->blk_id, k->id, (int32_t)p->nblocks);
        if (*k->name) smap_put_first(p, &p->blk_name, k->name, (int32_t)p->nblocks);
        p->nblocks++;
    }
}

static void mark_called_in(plc_t *p, int list)
{
    char tgt[160];
    for (int e = jd_first(D, list); e >= 0; e = jd_next(D, e)) {
        if (jd_type(D, e) != JD_OBJ) continue;
        int kv = jd_get(D, e, "kind");
        if (!jd_eq(D, kv, "call")) continue;
        jget_str(p, jd_get(D, e, "params"), "target", tgt, sizeof tgt);
        char tr[160];
        trim_copy(tgt, tr, sizeof tr);
        blk_t *b = find_block(p, tr);
        if (b) b->called = 1;
    }
}

static void mark_called(plc_t *p)
{
    for (size_t i = 0; i < p->nblocks; i++) {
        int nets = jarr(p, p->blocks[i].json, "networks");
        for (int n = jd_first(D, nets); n >= 0; n = jd_next(D, n)) {
            if (jd_type(D, n) != JD_OBJ) continue;
            mark_called_in(p, jarr(p, n, "outputs"));
            mark_called_in(p, jarr(p, n, "boxes"));
        }
    }
}

/* ======================================================================== *
 *  Compile: units (block instances)                                          *
 * ======================================================================== */
static uint8_t is_bool_type(const char *dt) { return strcmp(dt, "Bool") == 0; }

/* "<inst>.<member>" cell, initialised to the declared default the first time
 * (sim.js buildScope: boolDefault / numDefault) */
static cref_t member_cell(plc_t *p, const char *inst, const char *mname, const char *dtype, const char *def)
{
    char key[256];
    snprintf(key, sizeof key, "%s.%s", inst, mname);
    uint8_t st = sym_type_for(dtype);
    cref_t c = sym_cell(p, key, st, NULL);
    if (c.k != CK_SYM) return c;
    sym_t *s = &p->syms[c.idx];
    if (!s->written) {
        s->type = st;
        char d[64];
        trim_copy(def, d, sizeof d);
        if (st == SYM_BOOL) {
            s->v = pvb(ieq(d, "1") || ieq(d, "true") || ieq(d, "on") || ieq(d, "yes"));
        } else if (!strcmp(dtype, "Time")) {
            s->v = pvn(plc_parse_time_ms(d));
        } else {
            double v = js_parse_float(d);
            s->v = pvn(isnan(v) ? 0 : v);
        }
        s->written = 1;
    }
    return c;
}

static const char *const SECT_FB[] = {"input", "output", "inout", "static", "temp", "constant", NULL};
static const char *const SECT_FC[] = {"input", "output", "inout", "temp", "constant", NULL};
static const char *const SECT_OB[] = {"temp", "constant", NULL};

static void build_members(plc_t *p, unit_t *u)
{
    blk_t *b = u->blk;
    int iface = jd_get(D, b->json, "iface");
    if (jd_type(D, iface) != JD_OBJ) return;
    const char *const *secs = b->type == BT_FB ? SECT_FB : b->type == BT_FC ? SECT_FC : SECT_OB;
    int total = 0;
    for (int s = 0; secs[s]; s++) total += (int)jd_count(D, jarr(p, iface, secs[s]));
    if (!total) return;
    u->mem.cell = (cref_t *)plc_ar_alloc(p, sizeof(cref_t) * (size_t)total);
    u->mem.is_bool = (uint8_t *)plc_ar_alloc(p, (size_t)total);
    char name[128], dtype[32], def[64], low[128];
    for (int s = 0; secs[s]; s++) {
        int arr = jarr(p, iface, secs[s]);
        for (int m = jd_first(D, arr); m >= 0; m = jd_next(D, m)) {
            if (jd_type(D, m) != JD_OBJ) continue;
            jget_str(p, m, "name", name, sizeof name);
            char nm[128];
            trim_copy(name, nm, sizeof nm);
            if (!*nm) continue;
            jget_str(p, m, "dataType", dtype, sizeof dtype);
            jget_str(p, m, "default", def, sizeof def);
            int i = u->mem.n++;
            u->mem.cell[i] = member_cell(p, u->inst, name, dtype, def);
            u->mem.is_bool[i] = is_bool_type(dtype);
            to_lower(name, low, sizeof low);
            smap_put(p, &u->mem.map, ar_dup(p, low), i); /* last one wins (scope object) */
        }
    }
}

static unit_t *unit_get(plc_t *p, blk_t *b, const char *inst)
{
    for (unit_t *u = p->units; u; u = u->next)
        if (u->blk == b && strcmp(u->inst, inst) == 0) return u;
    unit_t *u = (unit_t *)plc_ar_alloc(p, sizeof(unit_t));
    u->blk = b;
    u->inst = ar_dup(p, inst);
    u->next = p->units;
    p->units = u;
    build_members(p, u);
    u->pend = p->pending;
    p->pending = u;
    return u;
}

/* ======================================================================== *
 *  Compile: elements / boxes                                                 *
 * ======================================================================== */
static call_t *compile_call(plc_t *p, unit_t *u, int el, const char *elid, bool fbd, char **in_names, int nin)
{
    call_t *c = (call_t *)plc_ar_alloc(p, sizeof(call_t));
    int params = jd_get(D, el, "params");
    char tgt[160], tr[160], idb[160];
    jget_str(p, params, "target", tgt, sizeof tgt);
    trim_copy(tgt, tr, sizeof tr);
    blk_t *tb = find_block(p, tr);
    if (!tb || tb->type == BT_DB) return c;

    char inst[256];
    jget_str(p, params, "instanceDb", idb, sizeof idb);
    char itr[160];
    trim_copy(idb, itr, sizeof itr);
    blk_t *db = *itr ? find_block(p, itr) : NULL;
    if (db && *db->name) snprintf(inst, sizeof inst, "%s", db->name);
    else snprintf(inst, sizeof inst, "%s_%s", *tb->name ? tb->name : "blk", elid);
    c->u = unit_get(p, tb, inst);

    int iface = jd_get(D, tb->json, "iface");
    int args = jd_get(D, el, "args");
    const char *in_secs[] = {"input", "inout", NULL};
    const char *out_secs[] = {"output", "inout", NULL};
    for (int dir = 0; dir < 2; dir++) {
        const char **secs = dir == 0 ? in_secs : out_secs;
        int total = 0;
        for (int s = 0; secs[s]; s++) total += (int)jd_count(D, jarr(p, iface, secs[s]));
        cparam_t *arr = total ? (cparam_t *)plc_ar_alloc(p, sizeof(cparam_t) * (size_t)total) : NULL;
        int n = 0;
        char name[128], dtype[32], def[64], argv[192];
        for (int s = 0; secs[s]; s++) {
            int ma = jarr(p, iface, secs[s]);
            for (int m = jd_first(D, ma); m >= 0; m = jd_next(D, m)) {
                if (jd_type(D, m) != JD_OBJ) continue;
                jget_str(p, m, "name", name, sizeof name);
                char nm[128];
                trim_copy(name, nm, sizeof nm);
                if (!*nm) continue;
                jget_str(p, m, "dataType", dtype, sizeof dtype);
                jget_str(p, m, "default", def, sizeof def);
                cparam_t *cp = &arr[n++];
                cp->mem = member_cell(p, inst, name, dtype, def);
                cp->is_bool = is_bool_type(dtype);
                cp->pin = -1;
                cp->arg = mkref(CK_NONE, 0, 0, 0, 0);
                if (fbd) {
                    for (int i = 0; i < nin; i++)
                        if (in_names[i] && strcmp(in_names[i], name) == 0) {
                            cp->pin = (int16_t)i;
                            break;
                        }
                } else {
                    jget_str(p, args, name, argv, sizeof argv);
                    cp->arg = plc_resolve(p, &u->mem, argv).c;
                }
            }
        }
        if (dir == 0) c->ins = arr, c->nin = (uint16_t)n;
        else c->outs = arr, c->nout = (uint16_t)n;
    }
    if (!fbd && c->nin) c->tmp = (pv_t *)plc_ar_alloc(p, sizeof(pv_t) * c->nin);
    return c;
}

/* compile a LAD element or an FBD box (pins are wired later for FBD) */
static node_t *compile_node(plc_t *p, unit_t *u, int el, bool fbd, char ***in_names_out)
{
    node_t *n = (node_t *)plc_ar_alloc(p, sizeof(node_t));
    char kind[32], buf[192];
    jget_str(p, el, "kind", kind, sizeof kind);
    n->kind = kind_of(kind);
    if (has_state(n->kind)) n->st = (st_t *)plc_ar_alloc(p, sizeof(st_t));
    char elid[96];
    jget_str(p, el, "id", elid, sizeof elid);
    n->live = flag_slot(p, FL_LIVE, elid);
    jget_str(p, el, "operand", buf, sizeof buf);
    n->op = plc_resolve(p, &u->mem, buf).c;
    n->sidx[0] = n->sidx[1] = n->sidx[2] = -1;

    int params = jd_get(D, el, "params");
    const char *const *kp = kparams(n->kind);
    if (kp) {
        int cnt = 0;
        while (kp[cnt]) cnt++;
        n->par = (cref_t *)plc_ar_alloc(p, sizeof(cref_t) * (size_t)cnt);
        for (int i = 0; i < cnt; i++) {
            jget_str(p, params, kp[i], buf, sizeof buf);
            char tr[192];
            trim_copy(buf, tr, sizeof tr);
            if (!fbd && is_timer(n->kind) && i == TM_PT && (time_prefix(tr) || is_num_lit(tr))) {
                /* sim.js resolvePT: literals go through T.parseTime (plain ms rounded) */
                n->par[i] = lit_cell(p, pvn(plc_parse_time_ms(tr)));
            } else {
                n->par[i] = plc_resolve(p, &u->mem, tr).c;
            }
        }
    }
    if (n->kind == K_COMPARE) {
        jget_str(p, params, "op", buf, sizeof buf);
        n->cmp = cmp_of(buf);
    }

    char **in_names = NULL;
    if (fbd) {
        int ins = jarr(p, el, "inputs"), outs = jarr(p, el, "outputs");
        uint32_t ni = jd_count(D, ins), no = jd_count(D, outs);
        if (ni > 250) ni = 250;
        if (no > 250) no = 250;
        n->nin = (uint8_t)ni;
        n->nout = (uint8_t)no;
        n->in = ni ? (fin_t *)plc_ar_alloc(p, sizeof(fin_t) * ni) : NULL;
        n->iv = ni ? (pv_t *)plc_ar_alloc(p, sizeof(pv_t) * ni) : NULL;
        n->out = no ? (fout_t *)plc_ar_alloc(p, sizeof(fout_t) * no) : NULL;
        in_names = ni ? (char **)plc_ar_alloc(p, sizeof(char *) * ni) : NULL;
        uint32_t i = 0;
        for (int pi = jd_first(D, ins); pi >= 0 && i < ni; pi = jd_next(D, pi), i++) {
            in_names[i] = jdup(p, pi, "name");
            n->in[i].slot = flag_slot_of(p, FL_PIN, pi);
            n->in[i].inv = jd_bool(D, jd_get(D, pi, "inverted"), false);
            n->in[i].src = FI_FALSE;
        }
        i = 0;
        for (int po = jd_first(D, outs); po >= 0 && i < no; po = jd_next(D, po), i++) {
            n->out[i].v = pvb(false);
            n->out[i].slot = flag_slot_of(p, FL_PIN, po);
            n->out[i].cm = -1;
            jget_str(p, po, "name", buf, sizeof buf);
            n->out[i].pn = !strcmp(buf, "ET") ? PN_ET : !strcmp(buf, "CV") ? PN_CV : !strcmp(buf, "ENO") ? PN_ENO
                         : !strcmp(buf, "QU") ? PN_QU : !strcmp(buf, "QD") ? PN_QD : PN_OTHER;
        }
        sem_t sem[3];
        int ns = sem_inputs(n->kind, sem);
        for (int s = 0; s < ns; s++)
            for (uint32_t k = 0; k < ni; k++)
                if (!strcmp(in_names[k], sem[s].want) || !strcmp(in_names[k], sem[s].pkey)) {
                    n->sidx[s] = (int8_t)k;
                    break;
                }
    }

    if (n->kind == K_CALL) {
        n->call = compile_call(p, u, el, elid, fbd, in_names, n->nin);
        if (fbd && n->call) {
            int ouc = jarr(p, el, "outputs");
            uint32_t i = 0;
            for (int po = jd_first(D, ouc); po >= 0 && i < n->nout; po = jd_next(D, po), i++) {
                if (n->out[i].pn == PN_ENO) continue;
                jget_str(p, po, "name", buf, sizeof buf);
                n->out[i].pn = PN_OTHER;
                /* sim.js _callOut[name]: the last member written under a name wins */
                if (n->call->u) {
                    int iface = jd_get(D, n->call->u->blk->json, "iface");
                    int idx = 0;
                    const char *secs[] = {"output", "inout", NULL};
                    char mn[128];
                    for (int s = 0; secs[s]; s++) {
                        int ma = jarr(p, iface, secs[s]);
                        for (int m = jd_first(D, ma); m >= 0; m = jd_next(D, m)) {
                            if (jd_type(D, m) != JD_OBJ) continue;
                            jget_str(p, m, "name", mn, sizeof mn);
                            char t2[128];
                            trim_copy(mn, t2, sizeof t2);
                            if (!*t2) continue;
                            if (!strcmp(mn, buf)) n->out[i].cm = (int16_t)idx;
                            idx++;
                        }
                    }
                }
            }
        }
    }
    if (in_names_out) *in_names_out = in_names;
    return n;
}

/* ---------------------------------------------------------------- LAD */
static node_t **compile_list(plc_t *p, unit_t *u, int arr, uint16_t *count)
{
    uint32_t cnt = jd_count(D, arr);
    node_t **v = cnt ? (node_t **)plc_ar_alloc(p, sizeof(node_t *) * cnt) : NULL;
    uint16_t n = 0;
    for (int e = jd_first(D, arr); e >= 0; e = jd_next(D, e)) {
        if (jd_type(D, e) != JD_OBJ) continue;
        v[n++] = compile_node(p, u, e, false, NULL);
    }
    *count = n;
    return v;
}

static void compile_lad_net(plc_t *p, unit_t *u, int net, net_t *out)
{
    out->fbd = 0;
    out->power = flag_slot_of(p, FL_POWER, net);
    int stages = jarr(p, net, "stages");
    uint32_t ns = jd_count(D, stages);
    out->st = ns ? (stage_t *)plc_ar_alloc(p, sizeof(stage_t) * ns) : NULL;
    for (int s = jd_first(D, stages); s >= 0; s = jd_next(D, s)) {
        stage_t *st = &out->st[out->nst++];
        int brs = jarr(p, s, "branches");
        uint32_t nb = jd_count(D, brs);
        st->br = nb ? (branch_t *)plc_ar_alloc(p, sizeof(branch_t) * nb) : NULL;
        for (int b = jd_first(D, brs); b >= 0; b = jd_next(D, b)) {
            branch_t *br = &st->br[st->nbr++];
            br->els = compile_list(p, u, jarr(p, b, "elements"), &br->n);
            if (br->n) st->has_els = 1;
        }
    }
    out->outs = compile_list(p, u, jarr(p, net, "outputs"), &out->nout);
}

/* ---------------------------------------------------------------- FBD */
static void compile_fbd_net(plc_t *p, unit_t *u, int net, net_t *out)
{
    out->fbd = 1;
    out->power = -1;
    int boxes = jarr(p, net, "boxes");
    uint32_t nb = jd_count(D, boxes);
    if (!nb) return;
    node_t **nodes = (node_t **)plc_ar_alloc(p, sizeof(node_t *) * nb);
    char ***names = (char ***)plc_ar_alloc(p, sizeof(char **) * nb);
    int *bjson = (int *)plc_ar_alloc(p, sizeof(int) * nb);
    smap_t bmap = {0};
    uint32_t n = 0;
    for (int b = jd_first(D, boxes); b >= 0; b = jd_next(D, b)) {
        if (jd_type(D, b) != JD_OBJ) continue;
        bjson[n] = b;
        nodes[n] = compile_node(p, u, b, true, &names[n]);
        if (nodes[n]->live >= 0) smap_put_first(p, &bmap, p->live[nodes[n]->live].id, (int32_t)n);
        n++;
    }

    /* wires: "toBox:toPin" -> wire (the last one wins, like sim.js wireIdx) */
    int wires = jarr(p, net, "wires");
    uint32_t nw = jd_count(D, wires);
    smap_t wmap = {0};
    char fb_[128], fp_[128], tb_[128], tp_[128], key[264];
    int *wfrom_box = nw ? (int *)plc_ar_alloc(p, sizeof(int) * nw) : NULL;
    char **wfrom_pin = nw ? (char **)plc_ar_alloc(p, sizeof(char *) * nw) : NULL;
    uint8_t *dep = (uint8_t *)h_alloc(p, (size_t)n * n);
    if (!dep) oom(p);
    memset(dep, 0, (size_t)n * n);
    uint32_t wi = 0;
    for (int w = jd_first(D, wires); w >= 0; w = jd_next(D, w), wi++) {
        wfrom_box[wi] = -1;
        wfrom_pin[wi] = NULL;
        if (jd_type(D, w) != JD_OBJ) continue;
        int from = jd_get(D, w, "from"), to = jd_get(D, w, "to");
        if (jd_type(D, from) != JD_OBJ || jd_type(D, to) != JD_OBJ) continue;
        jget_str(p, from, "box", fb_, sizeof fb_);
        jget_str(p, from, "pin", fp_, sizeof fp_);
        jget_str(p, to, "box", tb_, sizeof tb_);
        jget_str(p, to, "pin", tp_, sizeof tp_);
        int32_t fi = smap_get(&bmap, fb_), ti = smap_get(&bmap, tb_);
        wfrom_box[wi] = fi;
        wfrom_pin[wi] = ar_dup(p, fp_);
        snprintf(key, sizeof key, "%s:%s", tb_, tp_);
        smap_put(p, &wmap, ar_dup(p, key), (int32_t)wi);
        if (fi >= 0 && ti >= 0 && fi != ti) dep[(size_t)ti * n + (size_t)fi] = 1;
    }

    /* link inputs */
    for (uint32_t i = 0; i < n; i++) {
        node_t *bx = nodes[i];
        int params = jd_get(D, bjson[i], "params");
        int ins = jarr(p, bjson[i], "inputs");
        int pi = jd_first(D, ins);
        for (uint32_t k = 0; k < bx->nin; k++, pi = jd_next(D, pi)) {
            fin_t *f = &bx->in[k];
            const char *pid = f->slot >= 0 ? p->pins[f->slot].id : "";
            const char *bid = bx->live >= 0 ? p->live[bx->live].id : "";
            snprintf(key, sizeof key, "%s:%s", bid, pid);
            int32_t w = (*bid && *pid) ? smap_get(&wmap, key) : -1;
            if (w >= 0) {
                f->src = FI_FALSE;
                int32_t sb = wfrom_box[w];
                if (sb >= 0 && wfrom_pin[w]) {
                    node_t *src = nodes[sb];
                    for (uint32_t o = 0; o < src->nout; o++) {
                        int32_t sl = src->out[o].slot;
                        if (sl >= 0 && strcmp(p->pins[sl].id, wfrom_pin[w]) == 0) {
                            f->src = FI_WIRE;
                            f->wire = &src->out[o].v;
                            break;
                        }
                    }
                }
                continue;
            }
            const char *pk = in_param_key(bx->kind, names[i][k]);
            char buf[192];
            if (pk) {
                jget_str(p, params, pk, buf, sizeof buf);
                f->src = FI_PARAM;
                f->ref = plc_resolve(p, &u->mem, buf).c;
            } else {
                jget_str(p, pi, "operand", buf, sizeof buf);
                char tr[192];
                trim_copy(buf, tr, sizeof tr);
                if (*tr) {
                    f->src = FI_OPERAND;
                    f->ref = plc_resolve(p, &u->mem, tr).c;
                } else if (bx->kind == K_CALL && strcmp(names[i][k], "EN") == 0) {
                    f->src = FI_TRUE; /* TIA: an open EN executes the block unconditionally */
                } else {
                    f->src = FI_FALSE;
                }
            }
        }
    }

    /* evaluation order: sim.js orderBoxes() */
    out->boxes = (node_t **)plc_ar_alloc(p, sizeof(node_t *) * n);
    uint8_t *done = (uint8_t *)h_alloc(p, n);
    if (!done) {
        h_free(p, dep);
        oom(p);
    }
    memset(done, 0, n);
    uint32_t cnt = 0;
    long guard = (long)n * (long)n + (long)n + 1;
    while (cnt < n && guard-- > 0) {
        bool progressed = false;
        for (uint32_t i = 0; i < n; i++) {
            if (done[i]) continue;
            bool ready = true;
            for (uint32_t j = 0; j < n && ready; j++)
                if (dep[(size_t)i * n + j] && !done[j]) ready = false;
            if (ready) {
                out->boxes[cnt++] = nodes[i];
                done[i] = 1;
                progressed = true;
            }
        }
        if (!progressed) {
            for (uint32_t i = 0; i < n; i++)
                if (!done[i]) {
                    out->boxes[cnt++] = nodes[i];
                    done[i] = 1;
                }
            break;
        }
    }
    out->nbox = (uint16_t)cnt;
    h_free(p, done);
    h_free(p, dep);
    smap_free(p, &bmap);
    smap_free(p, &wmap);
}

static void compile_unit_body(plc_t *p, unit_t *u)
{
    blk_t *b = u->blk;
    u->compiled = true;
    if (b->lang == BL_SCL) {
        int cv = jd_get(D, b->json, "code");
        size_t len = cv >= 0 ? jd_str(D, cv, NULL, 0) : 0;
        if (!len) {
            u->scl_ok = true;
            u->scl = NULL;
            return;
        }
        char *src = (char *)h_alloc(p, len + 1);
        if (!src) oom(p);
        jd_str(D, cv, src, len + 1);
        char err[160];
        u->scl_ok = plc_scl_compile(p, &u->mem, src, &u->scl, err, sizeof err, b->name);
        h_free(p, src);
        return;
    }
    int nets = jarr(p, b->json, "networks");
    uint32_t nn = jd_count(D, nets);
    u->nets = nn ? (net_t *)plc_ar_alloc(p, sizeof(net_t) * nn) : NULL;
    for (int n = jd_first(D, nets); n >= 0; n = jd_next(D, n)) {
        if (jd_type(D, n) != JD_OBJ) continue; /* null network entries are skipped */
        net_t *nt = &u->nets[u->nnet++];
        if (b->lang == BL_FBD) compile_fbd_net(p, u, n, nt);
        else compile_lad_net(p, u, n, nt);
    }
}

/* ======================================================================== *
 *  Compile: hardware I/O map (project.gpio)                                  *
 * ======================================================================== */
/* GPIO number of a chain pin: -1 when missing / null / nonsense */
static int jpin(plc_t *p, int obj, const char *key)
{
    int v = jd_get(D, obj, key);
    if (v < 0 || jd_type(D, v) != JD_NUM) return -1;
    double n = jd_num(D, v, -1);
    return (n >= 0 && n <= 63 && n == floor(n)) ? (int)n : -1;
}

/* project.shiftRegs: [{id, type:"595"|"165", chips, data, clock, latch, enable}] */
static void compile_srs(plc_t *p)
{
    int arr = jarr(p, 0, "shiftRegs");
    uint32_t cnt = jd_count(D, arr);
    if (!cnt) return;
    if (cnt > 16) cnt = 16;
    p->srs = (plc_sr_t *)plc_ar_alloc(p, sizeof(plc_sr_t) * cnt);
    char id[32], buf[16];
    for (int e = jd_first(D, arr); e >= 0 && p->nsr < cnt; e = jd_next(D, e)) {
        if (jd_type(D, e) != JD_OBJ) continue;
        jget_str(p, e, "id", id, sizeof id);
        if (!id[0]) continue;
        bool dup = false;
        for (size_t i = 0; i < p->nsr; i++) dup |= strcmp(p->srs[i].id, id) == 0;
        if (dup) {
            plc_warnf(p, "Shift register \"%s\" is defined twice - the second one is ignored", id);
            continue;
        }
        int tv = jd_get(D, e, "type");
        if (jd_type(D, tv) == JD_NUM) snprintf(buf, sizeof buf, "%d", (int)jd_num(D, tv, 0));
        else jget_str(p, e, "type", buf, sizeof buf);
        plc_sr_t *s = &p->srs[p->nsr];
        if (!strcmp(buf, "595")) s->type = PLC_SR_595;
        else if (!strcmp(buf, "165")) s->type = PLC_SR_165;
        else {
            plc_warnf(p, "Shift register \"%s\": type must be 595 or 165 - ignored", id);
            continue;
        }
        double chips = jd_num(D, jd_get(D, e, "chips"), 1);
        s->chips = (uint8_t)(chips < 1 ? 1 : chips > PLC_SR_MAX_CHIPS ? PLC_SR_MAX_CHIPS : chips);
        s->id = plc_ar_strdup(p, id, strlen(id));
        s->data = jpin(p, e, "data");
        s->clock = jpin(p, e, "clock");
        s->latch = jpin(p, e, "latch");
        s->enable = jpin(p, e, "enable");
        p->nsr++;
    }
}

/* project.i2c: {sda, scl, khz, devices: [{id, type:"pcf8574"|"mcp23017"|"ads1115", addr}]} */
static void compile_i2c(plc_t *p)
{
    p->i2c_bus.sda = p->i2c_bus.scl = -1;
    p->i2c_bus.khz = 100;
    int bus = jd_get(D, 0, "i2c");
    if (jd_type(D, bus) != JD_OBJ) return;
    p->i2c_bus.sda = jpin(p, bus, "sda");
    p->i2c_bus.scl = jpin(p, bus, "scl");
    p->i2c_bus.khz = jd_num(D, jd_get(D, bus, "khz"), 100) >= 400 ? 400 : 100;
    int arr = jarr(p, bus, "devices");
    uint32_t cnt = jd_count(D, arr);
    if (!cnt) return;
    if (cnt > 16) cnt = 16;
    p->i2c = (plc_i2c_dev_t *)plc_ar_alloc(p, sizeof(plc_i2c_dev_t) * cnt);
    char id[32], buf[16];
    for (int e = jd_first(D, arr); e >= 0 && p->ni2c < cnt; e = jd_next(D, e)) {
        if (jd_type(D, e) != JD_OBJ) continue;
        jget_str(p, e, "id", id, sizeof id);
        if (!id[0]) continue;
        jget_str(p, e, "type", buf, sizeof buf);
        for (char *c = buf; *c; c++) *c = (char)lc(*c);
        plc_i2c_dev_t *d = &p->i2c[p->ni2c];
        if (!strcmp(buf, "pcf8574")) d->type = PLC_I2C_PCF8574;
        else if (!strcmp(buf, "mcp23017")) d->type = PLC_I2C_MCP23017;
        else if (!strcmp(buf, "ads1115")) d->type = PLC_I2C_ADS1115;
        else {
            plc_warnf(p, "I2C module \"%s\": unknown type \"%s\" - ignored", id, buf);
            continue;
        }
        double a = jd_num(D, jd_get(D, e, "addr"), -1);
        if (a < 0x08 || a > 0x77 || a != floor(a)) {
            plc_warnf(p, "I2C module \"%s\": invalid address - ignored", id);
            continue;
        }
        bool dup = false;
        for (size_t i = 0; i < p->ni2c; i++) dup |= strcmp(p->i2c[i].id, id) == 0;
        for (size_t i = 0; i < p->nsr; i++) dup |= strcmp(p->srs[i].id, id) == 0;
        if (dup) {
            plc_warnf(p, "I2C module \"%s\": the name is used twice - ignored", id);
            continue;
        }
        d->addr = (uint8_t)a;
        d->id = plc_ar_strdup(p, id, strlen(id));
        p->ni2c++;
    }
}

static int i2c_index(const plc_t *p, const char *id)
{
    for (size_t i = 0; i < p->ni2c; i++)
        if (strcmp(p->i2c[i].id, id) == 0) return (int)i;
    return -1;
}

static int sr_index(const plc_t *p, const char *id)
{
    for (size_t i = 0; i < p->nsr; i++)
        if (strcmp(p->srs[i].id, id) == 0) return (int)i;
    return -1;
}

static void compile_io(plc_t *p)
{
    compile_srs(p);
    compile_i2c(p);
    int arr = jarr(p, 0, "gpio");
    uint32_t cnt = jd_count(D, arr);
    if (!cnt) return;
    p->io = (plc_io_t *)plc_ar_alloc(p, sizeof(plc_io_t) * cnt);
    p->iocell = (cref_t *)plc_ar_alloc(p, sizeof(cref_t) * cnt);
    char tag[160], buf[32];
    bool warned_bcm = false;
    for (int e = jd_first(D, arr); e >= 0; e = jd_next(D, e)) {
        if (jd_type(D, e) != JD_OBJ) continue;
        jget_str(p, e, "tag", tag, sizeof tag);
        /* a shift-register channel instead of a GPIO: {sr:"SR1", bit:n} */
        char srid[32];
        jget_str(p, e, "sr", srid, sizeof srid);
        int sr = -1;
        double bit = 0;
        if (srid[0]) {
            sr = sr_index(p, srid);
            bit = jd_num(D, jd_get(D, e, "bit"), -1);
            if (sr < 0) {
                plc_warnf(p, "Tag \"%s\": shift register \"%s\" does not exist - mapping ignored", tag, srid);
                continue;
            }
            if (bit < 0 || bit != floor(bit) || bit >= p->srs[sr].chips * 8) {
                plc_warnf(p, "Tag \"%s\": %s has no channel %g - mapping ignored", tag, srid, bit);
                continue;
            }
        }
        /* ... or a channel of an I2C module: {i2c:"PCF1", bit:n} */
        int xd = -1;
        if (sr < 0) {
            jget_str(p, e, "i2c", srid, sizeof srid);
            if (srid[0]) {
                xd = i2c_index(p, srid);
                bit = jd_num(D, jd_get(D, e, "bit"), -1);
                if (xd < 0) {
                    plc_warnf(p, "Tag \"%s\": I2C module \"%s\" does not exist - mapping ignored", tag, srid);
                    continue;
                }
                if (bit < 0 || bit != floor(bit) || bit >= plc_i2c_channels(p->i2c[xd].type)) {
                    plc_warnf(p, "Tag \"%s\": %s has no channel %g - mapping ignored", tag, srid, bit);
                    continue;
                }
            }
        }
        bool ext = sr >= 0 || xd >= 0;
        int pv = jd_get(D, e, "pin");
        double pin = ext ? -1 : jd_num(D, pv, -1);
        if (!ext && (pv < 0 || jd_type(D, pv) == JD_NULL || pin < 0)) {
            if (!warned_bcm && jd_get(D, e, "bcm") >= 0 && jd_type(D, jd_get(D, e, "bcm")) != JD_NULL) {
                plc_warnf(p, "Raspberry Pi (BCM) pin mappings are ignored - assign ESP32-S3 GPIOs in the I/O view");
                warned_bcm = true;
            }
            continue;
        }
        if (!ext && (pin != floor(pin) || pin > 63)) {
            plc_warnf(p, "Tag \"%s\": invalid GPIO number - mapping ignored", tag);
            continue;
        }
        int32_t ti = smap_get(&p->tag_exact, tag);
        if (ti < 0) {
            plc_warnf(p, "I/O mapping for unknown tag \"%s\" ignored", tag);
            continue;
        }
        bool dup = false;
        for (size_t i = 0; i < p->nio; i++)
            if (strcmp(p->io[i].tag, p->tags[ti].name) == 0) dup = true;
        if (dup) {
            plc_warnf(p, "Tag \"%s\" is mapped twice - the second mapping is ignored", tag);
            continue;
        }
        plc_io_t *io = &p->io[p->nio];
        tag_t *tg = &p->tags[ti];
        io->tag = tg->name;
        io->addr = tg->addr;
        io->pin = ext ? -1 : (int)pin;
        io->sr = sr;
        io->i2c = xd;
        io->bit = (uint16_t)bit;
        /* ADS1115 range: the smallest standard one that covers the request */
        double rng = jd_num(D, jd_get(D, e, "range"), 4096);
        io->range_mv = (uint16_t)(rng <= 256 ? 256 : rng <= 512 ? 512 : rng <= 1024 ? 1024 : rng <= 2048 ? 2048
                                  : rng <= 4096 ? 4096 : 6144);
        jget_str(p, e, "dir", buf, sizeof buf);
        if (!strcmp(buf, "in")) io->dir = PLC_IO_IN;
        else if (!strcmp(buf, "out")) io->dir = PLC_IO_OUT;
        else if (!strcmp(buf, "pwm")) io->dir = PLC_IO_PWM;
        else if (!strcmp(buf, "ain")) io->dir = PLC_IO_AIN;
        else if (*buf && strcmp(buf, "\xE2\x80\x94") != 0 && strcmp(buf, "-") != 0) io->dir = PLC_IO_OUT;
        else if (!*buf) io->dir = (lc(tg->addr[0]) == 'i') ? PLC_IO_IN : PLC_IO_OUT;
        else continue; /* "—" = explicitly unmapped */
        jget_str(p, e, "pull", buf, sizeof buf);
        io->pull = !strcmp(buf, "up") ? PLC_PULL_UP : !strcmp(buf, "none") ? PLC_PULL_NONE : PLC_PULL_DOWN;
        if (!buf[0] && xd >= 0 && p->i2c[xd].type == PLC_I2C_MCP23017) io->pull = PLC_PULL_UP; /* all it has */
        io->active_low = jd_bool(D, jd_get(D, e, "activeLow"), false);
        double deb = jd_num(D, jd_get(D, e, "debounce"), 0);
        io->debounce_ms = (uint16_t)(deb < 0 ? 0 : deb > 1000 ? 1000 : deb);
        double fq = jd_num(D, jd_get(D, e, "freq"), 1000);
        io->freq_hz = (uint32_t)(fq < 1 ? 1 : fq > 40000 ? 40000 : fq);
        jget_str(p, e, "mode", buf, sizeof buf);
        io->ain_mode = !strcmp(buf, "raw") ? PLC_AIN_RAW : !strcmp(buf, "mv") ? PLC_AIN_MV : PLC_AIN_S7;
        double sm = jd_num(D, jd_get(D, e, "smooth"), 0);
        io->smooth = (uint8_t)(sm < 0 ? 0 : sm > 3 ? 3 : sm);
        io->cell = (uint16_t)p->nio;
        p->iocell[p->nio] = tg->c;
        p->nio++;
    }
}

/* ======================================================================== *
 *  Compile: project                                                          *
 * ======================================================================== */
static void sort_blocks(blk_t **v, size_t n)
{
    /* stable insertion sort by number (JS Array.sort is stable) */
    for (size_t i = 1; i < n; i++) {
        blk_t *x = v[i];
        size_t j = i;
        while (j > 0 && v[j - 1]->number > x->number) {
            v[j] = v[j - 1];
            j--;
        }
        v[j] = x;
    }
}

static void compile_project(plc_t *p)
{
    char buf[200];
    int nm = jd_get(D, 0, "name");
    if (nm >= 0 && jd_type(D, nm) != JD_NULL) p->name = jdup_node(p, nm);
    double sm = jd_num(D, jd_get(D, 0, "scanMs"), 50);
    if (!(sm >= 1)) sm = 50;
    if (sm > 10000) sm = 10000;
    p->scan_ms = (uint32_t)js_round(sm);

    compile_tags(p);
    index_blocks(p);
    mark_called(p);
    compile_io(p);

    /* SCL syntax problems are reported once per block, whether or not it runs */
    for (size_t i = 0; i < p->nblocks; i++) {
        blk_t *b = &p->blocks[i];
        if (b->type == BT_DB || b->lang != BL_SCL) continue;
        int cv = jd_get(D, b->json, "code");
        size_t len = cv >= 0 ? jd_str(D, cv, NULL, 0) : 0;
        if (!len) continue;
        char *src = (char *)h_alloc(p, len + 1);
        if (!src) oom(p);
        jd_str(D, cv, src, len + 1);
        char err[160];
        void *dummy = NULL;
        if (!plc_scl_compile(NULL, NULL, src, (struct scl_stmt **)&dummy, err, sizeof err, b->name))
            plc_warnf(p, "SCL block \"%s\": %s (block is skipped)", *b->name ? b->name : "?", err);
        h_free(p, src);
    }

    /* execution list: every OB by number, then FC/FB nobody calls (sim.js scanOnce) */
    blk_t **tmp = (blk_t **)plc_ar_alloc(p, sizeof(blk_t *) * (p->nblocks ? p->nblocks : 1));
    p->cyc = (unit_t **)plc_ar_alloc(p, sizeof(unit_t *) * (p->nblocks ? p->nblocks : 1));
    const uint8_t order[3] = {BT_OB, BT_FC, BT_FB};
    for (int o = 0; o < 3; o++) {
        size_t n = 0;
        for (size_t i = 0; i < p->nblocks; i++)
            if (p->blocks[i].type == order[o] && (order[o] == BT_OB || !p->blocks[i].called)) tmp[n++] = &p->blocks[i];
        sort_blocks(tmp, n);
        for (size_t i = 0; i < n; i++) {
            blk_t *b = tmp[i];
            if (order[o] == BT_OB) snprintf(buf, sizeof buf, "%s", *b->name ? b->name : b->id);
            else snprintf(buf, sizeof buf, "%s_inst", *b->name ? b->name : "blk");
            p->cyc[p->ncyc++] = unit_get(p, b, buf);
        }
    }
    /* compile bodies breadth-first (no recursion: call chains can be deep) */
    while (p->pending) {
        unit_t *u = p->pending;
        p->pending = u->pend;
        if (!u->compiled) compile_unit_body(p, u);
    }
    /* lookup maps only the compiler needs (force/resolve at runtime use the
     * tag, symbol, address and real-address maps, which stay) */
    smap_free(p, &p->live_map);
    smap_free(p, &p->power_map);
    smap_free(p, &p->pin_map);
    smap_free(p, &p->blk_id);
    smap_free(p, &p->blk_name);
    for (unit_t *u = p->units; u; u = u->next) smap_free(p, &u->mem.map);
}

/* ======================================================================== *
 *  Runtime: timers / counters (sim.js evalTON/TOF/TP/CTU/CTD/CTUD)          *
 * ======================================================================== */
#define CMAX 32767.0

static bool run_timer(plc_t *p, node_t *n, bool in, double pt)
{
    st_t *s = n->st;
    double el = 0;
    bool q = false;
    if (n->kind == K_TON) {
        if (in) {
            if (!s->run) {
                s->run = 1;
                s->t0 = p->now;
            }
            el = p->now - s->t0;
        } else {
            s->run = 0;
        }
        q = s->run && el >= pt;
        if (el > pt) el = pt;
    } else if (n->kind == K_TOF) {
        if (in) {
            s->run = 0;
            q = true;
        } else {
            if (s->prev) {
                s->run = 1;
                s->t0 = p->now;
            }
            if (s->run) {
                el = p->now - s->t0;
                if (el >= pt) {
                    q = false;
                    el = pt;
                } else {
                    q = true;
                }
            }
        }
        s->prev = in;
    } else { /* TP */
        if (in && !s->prev && !s->run) {
            s->run = 1;
            s->t0 = p->now;
        }
        if (s->run) {
            el = p->now - s->t0;
            if (el < pt) {
                q = true;
            } else {
                el = pt;
                if (!in) s->run = 0;
            }
        }
        s->prev = in;
        if (el > pt) el = pt;
    }
    s->et = js_round(el);
    s->q = q;
    wrb(p, n->par[TM_Q], q);
    wrn(p, n->par[TM_ET], s->et);
    return q;
}

static bool run_ctu(plc_t *p, node_t *n, bool cu, bool reset, double pv)
{
    st_t *s = n->st;
    if (reset) s->c = 0;
    else if (cu && !s->prev) s->c = fmin(s->c + 1, CMAX);
    s->prev = cu;
    bool q = s->c >= pv;
    wrn(p, n->par[CT_CV], s->c);
    wrb(p, n->par[CT_Q], q);
    return q;
}

static bool run_ctd(plc_t *p, node_t *n, bool cd, bool load, double pv)
{
    st_t *s = n->st;
    if (load) s->c = pv;
    else if (cd && !s->prev) s->c = fmax(s->c - 1, -CMAX);
    s->prev = cd;
    bool q = s->c <= 0;
    wrn(p, n->par[CT_CV], s->c);
    wrb(p, n->par[CT_Q], q);
    return q;
}

static void run_ctud(plc_t *p, node_t *n, bool cu, bool cd, bool reset, bool load, double pv, bool *qu, bool *qd)
{
    st_t *s = n->st;
    bool eu = cu && !s->pu, ed = cd && !s->pd;
    if (reset) s->c = 0;
    else if (load) s->c = pv;
    else if (eu && !ed) s->c = fmin(s->c + 1, CMAX);
    else if (ed && !eu) s->c = fmax(s->c - 1, -CMAX);
    s->pu = cu;
    s->pd = cd;
    *qu = s->c >= pv;
    *qd = s->c <= 0;
    wrn(p, n->par[CT_CV], s->c);
    wrb(p, n->par[CT_QU], *qu);
    wrb(p, n->par[CT_QD], *qd);
}

static bool cmpop(uint8_t op, double a, double b)
{
    switch (op) {
    case CMP_EQ: return a == b;
    case CMP_NE: return a != b;
    case CMP_GT: return a > b;
    case CMP_LT: return a < b;
    case CMP_GE: return a >= b;
    case CMP_LE: return a <= b;
    default: return false;
    }
}

static double mathop(uint8_t k, double a, double b)
{
    switch (k) {
    case K_ADD: return a + b;
    case K_SUB: return a - b;
    case K_MUL: return a * b;
    case K_DIV: return b == 0 ? 0 : a / b;
    default: return 0;
    }
}

static double norm_x(double mn, double v, double mx)
{
    double d = mx - mn;
    return d == 0 ? 0 : (v - mn) / d;
}

static double scale_x(double mn, double v, double mx) { return v * (mx - mn) + mn; }

/* ======================================================================== *
 *  Runtime: block execution                                                  *
 * ======================================================================== */
static void run_unit(plc_t *p, unit_t *u);

static void lad_call(plc_t *p, node_t *n)
{
    call_t *c = n->call;
    if (!c || !c->u || c->u->blk->active) return; /* missing target / cycle guard */
    /* sample every argument in the caller's scope first, then copy in */
    for (uint16_t i = 0; i < c->nin; i++) {
        cparam_t *cp = &c->ins[i];
        if (cp->arg.k != CK_NONE) c->tmp[i] = cp->is_bool ? pvb(rdb(p, cp->arg)) : pvn(rdn(p, cp->arg));
    }
    for (uint16_t i = 0; i < c->nin; i++)
        if (c->ins[i].arg.k != CK_NONE) plc_wr(p, c->ins[i].mem, c->tmp[i]);
    run_unit(p, c->u);
    for (uint16_t i = 0; i < c->nout; i++) {
        cparam_t *cp = &c->outs[i];
        if (cp->arg.k == CK_NONE) continue;
        pv_t v = plc_rd(p, cp->mem);
        if (cp->is_bool) wrb(p, cp->arg, truthy(v));
        else wrn(p, cp->arg, numv(v));
    }
}

static bool inline_value(plc_t *p, node_t *n)
{
    bool v;
    switch (n->kind) {
    case K_CONTACT_NO: v = rdb(p, n->op); break;
    case K_CONTACT_NC: v = !rdb(p, n->op); break;
    case K_EDGE_P: {
        bool cur = rdb(p, n->op);
        v = cur && !n->st->prev;
        n->st->prev = cur;
        break;
    }
    case K_EDGE_N: {
        bool cur = rdb(p, n->op);
        v = !cur && n->st->prev;
        n->st->prev = cur;
        break;
    }
    case K_COMPARE: v = cmpop(n->cmp, rdn(p, n->par[CP_IN1]), rdn(p, n->par[CP_IN2])); break;
    default: v = false;
    }
    setflag(p->live, n->live, v);
    return v;
}

static bool rung_power(plc_t *p, net_t *net)
{
    if (!net->nst) return true; /* direct rail connection */
    bool rung = true;
    for (uint16_t s = 0; s < net->nst; s++) {
        stage_t *st = &net->st[s];
        bool sv;
        if (!st->nbr) {
            sv = true; /* a stage with no branches passes power */
        } else {
            sv = false;
            for (uint16_t b = 0; b < st->nbr; b++) {
                branch_t *br = &st->br[b];
                bool bv = true;
                for (uint16_t e = 0; e < br->n; e++)
                    if (!inline_value(p, br->els[e])) bv = false; /* evaluate all (live flags) */
                /* an empty branch only conducts while the whole stage is empty */
                if (bv && (!st->has_els || br->n)) sv = true;
            }
        }
        if (!sv) rung = false;
    }
    return rung;
}

static void apply_output(plc_t *p, node_t *n, bool pw)
{
    cref_t *par = n->par;
    bool live = pw;
    switch (n->kind) {
    case K_COIL: wrb(p, n->op, pw); break;
    case K_COIL_NEG: wrb(p, n->op, !pw); break;
    case K_COIL_SET:
        if (pw) wrb(p, n->op, true);
        live = rdb(p, n->op);
        break;
    case K_COIL_RESET:
        if (pw) wrb(p, n->op, false);
        break;
    case K_TON: case K_TOF: case K_TP: run_timer(p, n, pw, fmax(0, rdn(p, par[TM_PT]))); break;
    case K_CTU: run_ctu(p, n, pw, rdb(p, par[CT_R]), rdn(p, par[CT_PV])); break;
    case K_CTD: run_ctd(p, n, pw, rdb(p, par[CT_R]), rdn(p, par[CT_PV])); break;
    case K_CTUD: {
        bool qu, qd;
        run_ctud(p, n, pw, rdb(p, par[CT_CD]), rdb(p, par[CT_R]), rdb(p, par[CT_LD]), rdn(p, par[CT_PV]), &qu, &qd);
        break;
    }
    case K_MOVE:
        if (pw) wrn(p, par[MV_OUT], rdn(p, par[MV_IN]));
        break;
    case K_ADD: case K_SUB: case K_MUL: case K_DIV: {
        double b = rdn(p, par[MA_IN2]);
        double r = mathop(n->kind, rdn(p, par[MA_IN1]), b);
        if (pw) wrn(p, par[MA_OUT], r);
        wrb(p, par[MA_ENO], pw && !(n->kind == K_DIV && b == 0) && isfinite(r));
        break;
    }
    case K_NORM_X: {
        double mn = rdn(p, par[SC_MIN]), mx = rdn(p, par[SC_MAX]);
        double r = norm_x(mn, rdn(p, par[SC_VAL]), mx);
        if (pw) wrn(p, par[SC_OUT], r);
        wrb(p, par[SC_ENO], pw && mx != mn && isfinite(r));
        break;
    }
    case K_SCALE_X: {
        double r = scale_x(rdn(p, par[SC_MIN]), rdn(p, par[SC_VAL]), rdn(p, par[SC_MAX]));
        if (pw) wrn(p, par[SC_OUT], r);
        wrb(p, par[SC_ENO], pw && isfinite(r));
        break;
    }
    case K_SR: { /* reset dominant; the operand stores Q */
        bool q = rdb(p, n->op);
        if (rdb(p, par[LT_X])) q = false;
        else if (pw) q = true;
        wrb(p, n->op, q);
        live = q;
        break;
    }
    case K_RS: { /* set dominant */
        bool q = rdb(p, n->op);
        if (rdb(p, par[LT_X])) q = true;
        else if (pw) q = false;
        wrb(p, n->op, q);
        live = q;
        break;
    }
    case K_P_TRIG: case K_R_TRIG: {
        bool q = pw && !n->st->prev;
        n->st->prev = pw;
        wrb(p, par[TG_Q], q);
        live = q;
        break;
    }
    case K_N_TRIG: case K_F_TRIG: {
        bool q = !pw && n->st->prev;
        n->st->prev = pw;
        wrb(p, par[TG_Q], q);
        live = q;
        break;
    }
    case K_CALL:
        setflag(p->live, n->live, pw);
        if (pw) lad_call(p, n);
        return;
    default: break;
    }
    setflag(p->live, n->live, live);
}

static void lad_net(plc_t *p, net_t *net)
{
    bool pw = rung_power(p, net);
    setflag(p->power, net->power, pw);
    for (uint16_t i = 0; i < net->nout; i++) apply_output(p, net->outs[i], pw);
}

/* ---------------------------------------------------------------- FBD */
static pv_t fin_value(plc_t *p, fin_t *f)
{
    pv_t v;
    switch (f->src) {
    case FI_WIRE: v = *f->wire; break;
    case FI_PARAM: v = pvn(rdn(p, f->ref)); break;
    case FI_OPERAND: v = plc_rd(p, f->ref); break;
    case FI_TRUE: v = pvb(true); break;
    default: v = pvb(false);
    }
    if (f->inv && (v.t == PV_BOOL || v.n == 0 || v.n == 1)) v = pvb(!truthy(v));
    setflag(p->pins, f->slot, truthy(v));
    return v;
}

/* sim.js unwiredNum: named pin value, else the params fallback */
static double sem_val(plc_t *p, node_t *n, int s, int slot)
{
    if (n->sidx[s] >= 0) return numv(n->iv[(int)n->sidx[s]]);
    return n->par ? rdn(p, n->par[slot]) : 0;
}

static void fbd_call(plc_t *p, node_t *n, bool en)
{
    call_t *c = n->call;
    if (!en || !c || !c->u || c->u->blk->active) return;
    for (uint16_t i = 0; i < c->nin; i++) {
        cparam_t *cp = &c->ins[i];
        if (cp->pin < 0) continue;
        pv_t v = n->iv[cp->pin];
        plc_wr(p, cp->mem, cp->is_bool ? pvb(truthy(v)) : pvn(numv(v)));
    }
    run_unit(p, c->u);
}

static void eval_box(plc_t *p, node_t *n)
{
    for (uint8_t i = 0; i < n->nin; i++) n->iv[i] = fin_value(p, &n->in[i]);
    pv_t *iv = n->iv;
    const uint8_t ni = n->nin;
    cref_t *par = n->par;
    pv_t out = pvb(false);
    bool live = false;
    bool has_qu = false, has_qd = false, has_cv = false, has_eno = false;
    pv_t m_qu = pvb(false), m_qd = pvb(false), m_cv = pvn(0), m_eno = pvb(false);
    double et_v = 0, cv_v = 0;

    switch (n->kind) {
    case K_FB_AND: {
        bool v = ni > 0;
        for (uint8_t i = 0; i < ni; i++)
            if (!truthy(iv[i])) v = false;
        out = pvb(v);
        live = v;
        break;
    }
    case K_FB_OR: {
        bool v = false;
        for (uint8_t i = 0; i < ni; i++)
            if (truthy(iv[i])) v = true;
        out = pvb(v);
        live = v;
        break;
    }
    case K_FB_XOR: {
        int acc = 0;
        for (uint8_t i = 0; i < ni; i++) acc ^= truthy(iv[i]) ? 1 : 0;
        out = pvb(acc == 1);
        live = acc == 1;
        break;
    }
    case K_FB_NOT: {
        bool v = ni ? !truthy(iv[0]) : true;
        out = pvb(v);
        live = v;
        break;
    }
    case K_ASSIGN: {
        bool v = ni && truthy(iv[0]);
        wrb(p, n->op, v);
        out = pvb(v);
        live = v;
        break;
    }
    case K_COMPARE: {
        bool v = cmpop(n->cmp, sem_val(p, n, 0, CP_IN1), sem_val(p, n, 1, CP_IN2));
        out = pvb(v);
        live = v;
        break;
    }
    case K_SR:
    case K_RS: {
        bool q = (n->op.k != CK_NONE) ? rdb(p, n->op) : (n->st->q != 0);
        bool a = ni > 0 && truthy(iv[0]), b = ni > 1 && truthy(iv[1]);
        if (n->kind == K_SR) { /* pins [S, R1]: reset dominant */
            if (b) q = false;
            else if (a) q = true;
        } else { /* pins [R, S1]: set dominant */
            if (b) q = true;
            else if (a) q = false;
        }
        wrb(p, n->op, q);
        n->st->q = q;
        out = pvb(q);
        live = q;
        break;
    }
    case K_P_TRIG: case K_R_TRIG: case K_N_TRIG: case K_F_TRIG: {
        bool clk = ni > 0 && truthy(iv[0]);
        bool rising = (n->kind == K_P_TRIG || n->kind == K_R_TRIG);
        bool q = rising ? (clk && !n->st->prev) : (!clk && n->st->prev);
        n->st->prev = clk;
        wrb(p, par[TG_Q], q);
        out = pvb(q);
        live = q;
        break;
    }
    case K_TON: case K_TOF: case K_TP: {
        double pt = fmax(0, sem_val(p, n, 0, TM_PT));
        bool q = run_timer(p, n, ni > 0 && truthy(iv[0]), pt);
        et_v = n->st->et;
        out = pvb(q);
        live = q;
        break;
    }
    case K_CTU: case K_CTD: {
        double pv = sem_val(p, n, 0, CT_PV);
        bool a = ni > 0 && truthy(iv[0]), b = ni > 1 && truthy(iv[1]);
        bool q = n->kind == K_CTU ? run_ctu(p, n, a, b, pv) : run_ctd(p, n, a, b, pv);
        cv_v = n->st->c;
        out = pvb(q);
        live = q;
        break;
    }
    case K_CTUD: { /* pins [CU, CD, R, LD, PV] */
        double pv = sem_val(p, n, 0, CT_PV);
        bool qu, qd;
        run_ctud(p, n, ni > 0 && truthy(iv[0]), ni > 1 && truthy(iv[1]), ni > 2 && truthy(iv[2]),
                 ni > 3 && truthy(iv[3]), pv, &qu, &qd);
        has_qu = has_qd = has_cv = true;
        m_qu = pvb(qu);
        m_qd = pvb(qd);
        m_cv = pvn(n->st->c);
        out = pvb(qu);
        live = qu;
        break;
    }
    case K_MOVE: {
        double v = sem_val(p, n, 0, MV_IN);
        wrn(p, par[MV_OUT], v);
        out = pvn(v);
        live = true;
        break;
    }
    case K_ADD: case K_SUB: case K_MUL: case K_DIV: {
        double a = sem_val(p, n, 0, MA_IN1), b = sem_val(p, n, 1, MA_IN2);
        double r = mathop(n->kind, a, b);
        if (n->kind == K_ADD || n->kind == K_MUL) { /* expanded inputs in3, in4 ... */
            for (uint8_t i = 0; i < ni; i++) {
                if (i == (uint8_t)n->sidx[0] || i == (uint8_t)n->sidx[1]) continue;
                double x = numv(iv[i]);
                r = n->kind == K_ADD ? r + x : r * x;
            }
        }
        wrn(p, par[MA_OUT], r);
        bool eno = !(n->kind == K_DIV && b == 0) && isfinite(r);
        wrb(p, par[MA_ENO], eno);
        has_eno = true;
        m_eno = pvb(eno);
        out = pvn(r);
        live = true;
        break;
    }
    case K_NORM_X: case K_SCALE_X: {
        double mn = sem_val(p, n, 0, SC_MIN), vl = sem_val(p, n, 1, SC_VAL), mx = sem_val(p, n, 2, SC_MAX);
        double r = n->kind == K_NORM_X ? norm_x(mn, vl, mx) : scale_x(mn, vl, mx);
        wrn(p, par[SC_OUT], r);
        bool eno = (n->kind != K_NORM_X || mx != mn) && isfinite(r);
        wrb(p, par[SC_ENO], eno);
        has_eno = true;
        m_eno = pvb(eno);
        out = pvn(r);
        live = true;
        break;
    }
    case K_CALL: {
        bool en = ni > 0 && truthy(iv[0]);
        fbd_call(p, n, en);
        out = pvb(en);
        live = en;
        break;
    }
    default:
        out = ni ? iv[0] : pvb(false);
        live = truthy(out);
    }

    for (uint8_t i = 0; i < n->nout; i++) {
        fout_t *o = &n->out[i];
        pv_t v = out;
        if (has_qu && o->pn == PN_QU) v = m_qu;
        else if (has_qd && o->pn == PN_QD) v = m_qd;
        else if (has_cv && o->pn == PN_CV) v = m_cv;
        else if (has_eno && o->pn == PN_ENO) v = m_eno;
        else if (is_timer(n->kind)) v = o->pn == PN_ET ? pvn(et_v) : out;
        else if (n->kind == K_CTU || n->kind == K_CTD) v = o->pn == PN_CV ? pvn(cv_v) : out;
        else if (n->kind == K_CALL) {
            if (o->pn == PN_ENO) v = out;
            else if (o->cm >= 0 && n->call && o->cm < n->call->nout) {
                cparam_t *cp = &n->call->outs[o->cm];
                pv_t mv = plc_rd(p, cp->mem);
                v = cp->is_bool ? pvb(truthy(mv)) : pvn(numv(mv));
            } else v = pvb(false);
        }
        o->v = v;
        setflag(p->pins, o->slot, truthy(v));
    }
    setflag(p->live, n->live, live);
}

static void fbd_net(plc_t *p, net_t *net)
{
    for (uint16_t i = 0; i < net->nbox; i++) eval_box(p, net->boxes[i]);
}

static void run_unit(plc_t *p, unit_t *u)
{
    blk_t *b = u->blk;
    if (b->active) return;
    if (p->depth >= PLC_MAX_CALL_DEPTH) {
        plc_errorf(p, "%s: block call nesting deeper than %d - call skipped", *b->name ? b->name : "?",
                   PLC_MAX_CALL_DEPTH);
        return;
    }
    b->active = 1;
    p->depth++;
    if (b->lang == BL_SCL) {
        if (u->scl_ok && u->scl) plc_scl_run(p, u->scl, b->name);
    } else {
        for (uint16_t i = 0; i < u->nnet; i++) {
            net_t *net = &u->nets[i];
            if (net->fbd) fbd_net(p, net);
            else lad_net(p, net);
        }
    }
    p->depth--;
    b->active = 0;
}

void plc_scan(plc_t *p)
{
    if (!p) return;
    p->now = p->env.now_ms(p->env.user);
    p->depth = 0;
    for (size_t i = 0; i < p->ncyc; i++) run_unit(p, p->cyc[i]);
    p->scan_count++;
}

/* ======================================================================== *
 *  Public API                                                                *
 * ======================================================================== */
static void plc_destroy(plc_t *p)
{
    if (!p) return;
    /* unit structs live in the arena: release their heap maps first */
    for (unit_t *u = p->units; u; u = u->next) smap_free(p, &u->mem.map);
    ar_chunk_t *c = p->ar.head;
    while (c) {
        ar_chunk_t *nx = c->next;
        h_free(p, c);
        c = nx;
    }
    h_free(p, p->syms);
    h_free(p, p->lits);
    h_free(p, p->regs);
    h_free(p, p->live);
    h_free(p, p->power);
    h_free(p, p->pins);
    h_free(p, (void *)p->warn);
    smap_free(p, &p->tag_exact);
    smap_free(p, &p->tag_lower);
    smap_free(p, &p->real_addr);
    smap_free(p, &p->sym_map);
    smap_free(p, &p->reg_map);
    smap_free(p, &p->live_map);
    smap_free(p, &p->power_map);
    smap_free(p, &p->pin_map);
    smap_free(p, &p->blk_id);
    smap_free(p, &p->blk_name);
    void (*fr)(void *) = p->env.free ? p->env.free : free;
    fr(p);
}

void plc_free(plc_t *p) { plc_destroy(p); }

plc_t *plc_load(const char *json, size_t len, const plc_env_t *env, char *err, size_t errlen)
{
    if (err && errlen) err[0] = 0;
    plc_t *p = (plc_t *)((env && env->alloc) ? env->alloc(sizeof(plc_t)) : malloc(sizeof(plc_t)));
    if (!p) {
        if (err) snprintf(err, errlen, "out of memory");
        return NULL;
    }
    memset(p, 0, sizeof *p);
    if (env) p->env = *env;
    p->scan_ms = 50;

    oom_ctx_t oc;
    oc.p = p;
    oom_ctx_t *prev = s_oom;
    s_oom = &oc;
    jd_doc_t doc;
    memset(&doc, 0, sizeof doc);
    void (*fr)(void *) = p->env.free ? p->env.free : free;
    if (setjmp(oc.jb)) {
        s_oom = prev;
        jd_release(&doc, fr);
        if (err) snprintf(err, errlen, "out of memory while compiling the program");
        plc_destroy(p);
        return NULL;
    }
    if (json && len) {
        jd_alloc_fn big = p->env.alloc_big ? p->env.alloc_big : p->env.alloc ? p->env.alloc : malloc;
        if (!jd_parse(&doc, json, len, big)) {
            if (!err) {
            } else if (doc.err && !strcmp(doc.err, "out of memory")) {
                snprintf(err, errlen, "not enough memory to load this %u KB program on this board (enable PSRAM, or split the project)",
                         (unsigned)(len / 1024));
            } else {
                snprintf(err, errlen, "invalid JSON at byte %u: %s", (unsigned)doc.err_pos, doc.err ? doc.err : "?");
            }
            jd_release(&doc, fr);
            s_oom = prev;
            plc_destroy(p);
            return NULL;
        }
        if (jd_type(&doc, 0) != JD_OBJ) {
            if (err) snprintf(err, errlen, "expected project JSON object");
            jd_release(&doc, fr);
            s_oom = prev;
            plc_destroy(p);
            return NULL;
        }
        p->doc = &doc;
        compile_project(p);
        p->doc = NULL;
        jd_release(&doc, fr);
    }
    s_oom = prev;
    return p;
}

const char *plc_project_name(const plc_t *p) { return p ? p->name : NULL; }
uint32_t plc_scan_ms(const plc_t *p) { return p ? p->scan_ms : 50; }
bool plc_has_logic(const plc_t *p) { return p && p->has_logic; }
size_t plc_warning_count(const plc_t *p) { return p ? p->nwarn : 0; }
const char *plc_warning(const plc_t *p, size_t i) { return (p && i < p->nwarn) ? p->warn[i] : ""; }
uint32_t plc_scan_count(const plc_t *p) { return p ? p->scan_count : 0; }
uint32_t plc_error_count(const plc_t *p) { return p ? p->err_count : 0; }
const char *plc_last_error(const plc_t *p) { return (p && p->last_error[0]) ? p->last_error : NULL; }

size_t plc_io_count(const plc_t *p) { return p ? p->nio : 0; }
plc_io_t *plc_io(plc_t *p, size_t i) { return (p && i < p->nio) ? &p->io[i] : NULL; }
size_t plc_sr_count(const plc_t *p) { return p ? p->nsr : 0; }
const plc_sr_t *plc_sr(const plc_t *p, size_t i) { return (p && i < p->nsr) ? &p->srs[i] : NULL; }
const plc_i2c_bus_t *plc_i2c_bus(const plc_t *p) { return p ? &p->i2c_bus : NULL; }
size_t plc_i2c_count(const plc_t *p) { return p ? p->ni2c : 0; }
const plc_i2c_dev_t *plc_i2c_dev(const plc_t *p, size_t i) { return (p && i < p->ni2c) ? &p->i2c[i] : NULL; }

void plc_io_set_input(plc_t *p, size_t i, double value)
{
    if (!p || i >= p->nio) return;
    plc_io_t *io = &p->io[i];
    if (io->forced) value = io->force_val;
    cref_t c = p->iocell[io->cell];
    if (io->dir == PLC_IO_AIN) plc_wr(p, c, pvn(value));
    else plc_wr(p, c, pvb(value != 0));
}

double plc_io_get_output(plc_t *p, size_t i)
{
    if (!p || i >= p->nio) return 0;
    plc_io_t *io = &p->io[i];
    cref_t c = p->iocell[io->cell];
    if (io->forced) {
        /* TIA: the force value also overwrites the output image */
        plc_wr(p, c, io->dir == PLC_IO_OUT ? pvb(io->force_val != 0) : pvn(io->force_val));
        return io->force_val;
    }
    pv_t v = plc_rd(p, c);
    return io->dir == PLC_IO_OUT ? (truthy(v) ? 1.0 : 0.0) : numv(v);
}

static bool same_cell(cref_t a, cref_t b)
{
    if (a.k == CK_SYM || b.k == CK_SYM) return a.k == b.k && a.idx == b.idx;
    if (a.k == CK_NONE || a.k == CK_LIT || b.k == CK_NONE || b.k == CK_LIT) return false;
    /* address cells: same storage bytes */
    return a.area == b.area && a.off == b.off && a.k == b.k && a.bit == b.bit;
}

int plc_force(plc_t *p, const char *key, plc_vtype_t t, double value)
{
    if (!p || !key) return -1;
    oom_ctx_t oc;
    oc.p = p;
    oom_ctx_t *prev = s_oom;
    s_oom = &oc;
    if (setjmp(oc.jb)) {
        s_oom = prev;
        return -1;
    }
    ref_t r = plc_resolve(p, NULL, key);
    s_oom = prev;
    if (r.c.k == CK_NONE || r.c.k == CK_LIT) return -1;
    for (size_t i = 0; i < p->nio; i++) {
        plc_io_t *io = &p->io[i];
        if (!same_cell(p->iocell[io->cell], r.c)) continue;
        if (t == PLC_V_NULL) {
            io->forced = false;
        } else {
            io->forced = true;
            io->force_val = (t == PLC_V_BOOL) ? (value != 0 ? 1.0 : 0.0) : value;
        }
    }
    if (t == PLC_V_NULL) return 0;
    plc_wr(p, r.c, t == PLC_V_BOOL ? pvb(value != 0) : pvn(value));
    return 0;
}

void plc_unforce_all(plc_t *p)
{
    if (!p) return;
    for (size_t i = 0; i < p->nio; i++) p->io[i].forced = false;
}

size_t plc_forced_count(const plc_t *p)
{
    size_t n = 0;
    if (p)
        for (size_t i = 0; i < p->nio; i++) n += p->io[i].forced ? 1 : 0;
    return n;
}

uint8_t *plc_area(plc_t *p, char area, size_t *size)
{
    if (!p) return NULL;
    char a = ucc(area);
    uint8_t ai = a == 'I' ? AREA_I : a == 'Q' ? AREA_Q : AREA_M;
    if (size) *size = area_size(ai);
    return area_ptr(p, ai);
}

/* ---------------------------------------------------------------- JSON out */
static void jw_pv(jw_t *w, pv_t v)
{
    if (v.t == PV_BOOL) jw_bool(w, v.n != 0);
    else jw_num(w, v.n);
}

void plc_snapshot_json(plc_t *p, jw_t *w)
{
    jw_kint(w, "scan", p ? p->scan_count : 0);
    jw_key(w, "mem");
    jw_obj(w);
    if (p) {
        for (size_t i = 0; i < p->ntags; i++) {
            tag_t *t = &p->tags[i];
            if (smap_get(&p->tag_exact, t->name) != (int32_t)i) continue; /* duplicate name */
            jw_key(w, t->name);
            pv_t v = plc_rd(p, t->c);
            if (t->is_bool) jw_bool(w, truthy(v));
            else jw_num(w, numv(v));
        }
        for (size_t i = 0; i < p->nsyms; i++) {
            sym_t *s = &p->syms[i];
            if (!s->written || s->is_tag) continue;
            jw_key(w, s->name);
            jw_pv(w, s->v);
        }
        for (size_t i = 0; i < p->nregs; i++) {
            areg_t *r = &p->regs[i];
            if (!r->touched) continue;
            jw_key(w, r->name);
            jw_pv(w, plc_rd(p, mkref(r->k, r->area, r->bit, r->off, (uint16_t)i)));
        }
    }
    jw_obj_end(w);
    const char *keys[3] = {"live", "power", "pins"};
    for (int k = 0; k < 3; k++) {
        jw_key(w, keys[k]);
        jw_obj(w);
        if (p) {
            flag_t *arr = k == 0 ? p->live : k == 1 ? p->power : p->pins;
            size_t n = k == 0 ? p->nlive : k == 1 ? p->npower : p->npins;
            for (size_t i = 0; i < n; i++)
                if (arr[i].seen) {
                    jw_key(w, arr[i].id);
                    jw_bool(w, arr[i].v);
                }
        }
        jw_obj_end(w);
    }
    jw_kint(w, "errors", p ? p->err_count : 0);
    jw_kstr(w, "lastError", plc_last_error(p));
    jw_key(w, "forced");
    jw_obj(w);
    if (p)
        for (size_t i = 0; i < p->nio; i++) {
            plc_io_t *io = &p->io[i];
            if (!io->forced) continue;
            jw_key(w, io->tag);
            if (io->dir == PLC_IO_IN || io->dir == PLC_IO_OUT) jw_bool(w, io->force_val != 0);
            else jw_num(w, io->force_val);
        }
    jw_obj_end(w);
}

void plc_tags_json(const plc_t *p, jw_t *w)
{
    jw_arr(w);
    if (p)
        for (size_t i = 0; i < p->ntags; i++) {
            const tag_t *t = &p->tags[i];
            jw_obj(w);
            jw_kstr(w, "name", t->name);
            jw_kstr(w, "dataType", t->dtype);
            jw_kstr(w, "address", *t->addr ? t->addr : NULL);
            jw_kstr(w, "comment", *t->comment ? t->comment : NULL);
            jw_obj_end(w);
        }
    jw_arr_end(w);
}

void plc_modbus_map_json(const plc_t *p, jw_t *w, unsigned bank)
{
    jw_obj(w);
    if (p)
        for (size_t i = 0; i < p->ntags; i++) {
            const tag_t *t = &p->tags[i];
            if (!*t->addr) continue;
            addr_t a;
            if (parse_addr(t->addr, &a) != 1 || a.k == CK_BYTE) continue;
            jw_key(w, t->name);
            jw_obj(w);
            if (a.k == CK_BIT) {
                unsigned nbit = (unsigned)a.off * 8u + a.bit;
                if (a.area == AREA_I) {
                    jw_kstr(w, "kind", "discrete");
                    jw_kint(w, "address", nbit);
                } else {
                    jw_kstr(w, "kind", "coil");
                    jw_kint(w, "address", (a.area == AREA_Q ? bank : 0) + nbit);
                }
            } else {
                unsigned reg = (unsigned)a.off / 2u;
                jw_kstr(w, "kind", a.area == AREA_I ? "input" : "holding");
                jw_kint(w, "address", (a.area == AREA_Q ? bank : 0) + reg);
                jw_kint(w, "registers", a.k == CK_WORD ? 1 : 2);
            }
            jw_obj_end(w);
        }
    jw_obj_end(w);
}
