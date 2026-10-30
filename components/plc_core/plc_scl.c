/* ============================================================================
 * plc_scl.c — Structured Control Language: tokenizer, parser, typed compiler
 * and evaluator. The C port of web/js/scl.js: same grammar (TIA dialect:
 * #local, "Global", %MW10, .%X3 slices, arrays, structs, PLC data types,
 * String, DTL, typed literals, FB / FC calls, system FBs, conversions …),
 * same typing rules (Int / Int divides as integers, results wrap to their
 * type), same results.
 *
 * A block is parsed into an AST in scratch memory, then compiled per unit
 * (block instance) into IR in the arena with every variable resolved to a
 * cell or to a place in a typed buffer; the AST is freed. Recursion depth is
 * bounded at parse time (expressions / statements) and evaluator frames stay
 * small — the ESP32 scan task has a 16 KB stack.
 *
 *   precedence (low -> high): OR, XOR, AND, = <>, < > <= >=, + -, * / MOD,
 *   unary (NOT, -), **, postfix (.member [index] (args))
 * ==========================================================================*/
#include <setjmp.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>

#include "plc_internal.h"

/* ================================================================ tokens */
enum { T_NUM, T_STR, T_ID, T_LID, T_QID, T_ADDR, T_KW, T_OP, T_EOF };
enum {
    KW_IF, KW_THEN, KW_ELSIF, KW_ELSE, KW_END_IF, KW_CASE, KW_OF, KW_END_CASE, KW_FOR, KW_TO, KW_BY, KW_DO,
    KW_END_FOR, KW_WHILE, KW_END_WHILE, KW_REPEAT, KW_UNTIL, KW_END_REPEAT, KW_EXIT, KW_CONTINUE, KW_RETURN,
    KW_AND, KW_OR, KW_XOR, KW_NOT, KW_MOD, KW_TRUE, KW_FALSE, KW_REGION, KW_END_REGION, KW_GOTO, KW__N
};
static const char *const KWS[KW__N] = {
    "IF", "THEN", "ELSIF", "ELSE", "END_IF", "CASE", "OF", "END_CASE", "FOR", "TO", "BY", "DO",
    "END_FOR", "WHILE", "END_WHILE", "REPEAT", "UNTIL", "END_REPEAT", "EXIT", "CONTINUE", "RETURN",
    "AND", "OR", "XOR", "NOT", "MOD", "TRUE", "FALSE", "REGION", "END_REGION", "GOTO"};

enum { LIT_INT = 0, LIT_REAL, LIT_TYPED };

typedef struct {
    uint8_t t, kw, lit, slice;
    char op[4];
    const ty_t *ty;   /* typed literal */
    double v;
    const char *s;    /* id / str / addr text (NUL-terminated scratch copy) */
    uint32_t sl;
    int line, col;
} tok_t;

/* ================================================================== AST */
enum { AN_NUM, AN_STR, AN_BOOL, AN_NAME, AN_ADDR, AN_MEM, AN_SLICE, AN_IDX, AN_CALL, AN_UN, AN_BIN,
       AN_ARG, AN_ASSIGN, AN_CALLST, AN_IF, AN_CASE, AN_FOR, AN_WHILE, AN_REPEAT, AN_REGION, AN_EXIT,
       AN_CONTINUE, AN_RETURN, AN_ARM, AN_LAB };

typedef struct an an_t;
struct an {
    uint8_t n, lit, local, quoted, out, slk;
    char op[4];
    int line, col;
    double v;
    const ty_t *ty;
    const char *s;        /* name / string text */
    uint32_t sl;
    int sidx;
    an_t *a, *b, *c, *d;
    an_t **list;          /* args / indices / statements / arms / labels */
    uint16_t nlist;
    an_t **body;          /* statement lists */
    uint16_t nbody;
    an_t **els;
    uint16_t nels;
    uint8_t has_els;
    /* case label: lo / hi value or #constant name */
    double lo, hi;
    const char *loc, *hic;
};

/* ==================================================================== IR */
enum { PK_CELL = 0, PK_LOC, PK_SLICE };
enum { B_SELF = 0, B_DB, B_REF };

typedef struct sx sx_t;
typedef struct {
    uint8_t k;        /* 0 field offset, 1 array index */
    uint8_t bit;
    uint32_t off;
    const ty_t *arr;
    sx_t **idx;
} plst_t;

typedef struct pl {
    uint8_t pk, base, is_const, variant, dyn, cbit;
    uint8_t per, sli, width;   /* slice: bits per element, index, base width */
    const ty_t *ty;
    cref_t cell;
    uint8_t *ptr;              /* B_SELF / B_DB */
    vref_t *ref;               /* B_REF */
    uint16_t nst;
    plst_t *st;
    struct pl *sbase;
    const fld_t *field;
} pl_t;

enum { X_K, X_KS, X_RD, X_RDS, X_NOT, X_BNOT, X_NEG, X_AND, X_OR, X_XOR, X_BIT, X_CMP, X_AR, X_CONV, X_FN,
       X_CNT, X_RDT, X_CALL };
enum { O_ADD, O_SUB, O_MUL, O_DIV, O_MOD, O_POW, O_EQ, O_NE, O_LT, O_GT, O_LE, O_GE, O_BAND, O_BOR, O_BXOR };
enum { M_NUM, M_FLT, M_INT };
enum { F_ABS, F_SQRT, F_SQR, F_LN, F_LOG, F_EXP, F_SIN, F_COS, F_TAN, F_ASIN, F_ACOS, F_ATAN, F_TRUNC,
       F_ROUND, F_CEIL, F_FLOOR, F_REAL, F_MIN, F_MAX, F_LIMIT, F_SEL, F_NORM_X, F_SCALE_X, F_LEN, F_SHL,
       F_SHR, F_ROL, F_ROR };

typedef struct scall scall_t;
struct sx {
    uint8_t op, o, mode, flag;
    uint8_t fn;
    const ty_t *ty;
    double v;
    const char *s;     /* string constant (Latin-1, may hold NUL) */
    uint16_t sl;
    sx_t *a, *b;
    sx_t **args;
    uint16_t nargs;
    pl_t *p;
    scall_t *call;
};

enum { BM_IN, BM_INOUT, BM_INS, BM_INCOPY, BM_INOUTCOPY, BM_REF, BM_OUT, BM_OUTCOPY };
typedef struct {
    const fld_t *f;
    uint16_t fi;       /* field index (reference slot) */
    uint8_t mode;
    sx_t *e;
    pl_t *p;
} bind_t;

struct scall {
    unit_t *cu;        /* user FB / FC */
    const ty_t *sys;   /* system FB type */
    pl_t *inst;        /* system FB instance */
    vref_t *srefs;     /* system FB: reference slots */
    bind_t *b;
    uint16_t nb;
    sx_t *en;
    pl_t *eno;
    const fld_t *ret;
    uint8_t ret_str, is_fc;
    const ty_t *ty;
};

enum { S_SET, S_SETS, S_COPY, S_CALL, S_IF, S_CASE, S_FOR, S_WHILE, S_REPEAT, S_BLOCK, S_EXIT, S_CONT, S_RET };
typedef struct scl_stmt ss_t;
typedef struct {
    sx_t *c;
    double *lo, *hi;
    uint16_t nlab;
    ss_t *body;
} sarm_t;
struct scl_stmt {
    uint8_t s;
    pl_t *p, *src;
    sx_t *e, *from, *to, *by;
    uint32_t size;
    scall_t *call;
    sarm_t *arms;
    uint16_t narms;
    ss_t *els, *body;
    ss_t *next;
};

/* ======================================================= compile context */
typedef struct pchunk {
    struct pchunk *next;
    size_t used, cap;
} pchunk_t;

#define MAX_EXPR_DEPTH 32
#define MAX_STMT_DEPTH 24

typedef struct {
    plc_t *p;            /* NULL: syntax only */
    unit_t *u;
    const ty_t *t;       /* instance type */
    char fcret[160];     /* FC name (lowercase) when it has a RET_VAL, else "" */
    const char *src;
    tok_t *toks;
    size_t ntok, ctok, pos;
    pchunk_t *scratch;
    char *err;
    size_t errlen;
    int edepth, sdepth;
    uint16_t ncalls;
    jmp_buf jb;
} cx_t;

static void fail_at(cx_t *cx, int line, const char *fmt, ...)
{
    char msg[160];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof msg, fmt, ap);
    va_end(ap);
    if (cx->err && cx->errlen) snprintf(cx->err, cx->errlen, "line %d: %s", line, msg);
    longjmp(cx->jb, 1);
}

static void *sa(cx_t *cx, size_t n)
{
    n = (n + 7) & ~(size_t)7;
    size_t hdr = (sizeof(pchunk_t) + 7) & ~(size_t)7;
    pchunk_t *c = cx->scratch;
    if (!c || c->used + n > c->cap) {
        size_t cap = n > 8192 ? n : 8192;
        c = (pchunk_t *)malloc(hdr + cap);
        if (!c) fail_at(cx, 0, "out of memory");
        c->next = cx->scratch;
        c->used = 0;
        c->cap = cap;
        cx->scratch = c;
    }
    void *r = (uint8_t *)c + hdr + c->used;
    c->used += n;
    memset(r, 0, n);
    return r;
}
static void *aa(cx_t *cx, size_t n) { return plc_ar_alloc(cx->p, n); }
static char *sdup(cx_t *cx, const char *s, size_t n)
{
    char *r = (char *)sa(cx, n + 1);
    memcpy(r, s, n);
    r[n] = 0;
    return r;
}

/* ============================================================= tokenizer */
static bool is_a(char c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_'; }
static bool is_d(char c) { return c >= '0' && c <= '9'; }
static bool is_an(char c) { return is_a(c) || is_d(c); }
static char upc(char c) { return (c >= 'a' && c <= 'z') ? (char)(c - 32) : c; }
static char lwc(char c) { return (c >= 'A' && c <= 'Z') ? (char)(c + 32) : c; }
static bool is_hex(char c) { return is_d(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }

static tok_t *push_tok(cx_t *cx)
{
    if (cx->ntok + 1 > cx->ctok) {
        size_t nc = cx->ctok ? cx->ctok * 2 : 128;
        tok_t *nt = (tok_t *)realloc(cx->toks, nc * sizeof(tok_t));
        if (!nt) fail_at(cx, 0, "out of memory");
        cx->toks = nt;
        cx->ctok = nc;
    }
    tok_t *t = &cx->toks[cx->ntok++];
    memset(t, 0, sizeof *t);
    return t;
}

static void tokenize(cx_t *cx)
{
    const char *s = cx->src;
    size_t i = 0, n = strlen(s);
    int line = 1, col = 1;
#define ADV(k)                                         \
    do {                                               \
        size_t _k = (size_t)(k);                       \
        for (size_t _j = 0; _j < _k; _j++) {           \
            if (s[i] == '\n') line++, col = 1;         \
            else col++;                                \
            i++;                                       \
        }                                              \
    } while (0)
    while (i < n) {
        char c = s[i];
        if (c == ' ' || c == '\t' || c == '\r' || c == '\n') {
            ADV(1);
            continue;
        }
        if (c == '/' && s[i + 1] == '/') {
            while (i < n && s[i] != '\n') ADV(1);
            continue;
        }
        if ((c == '(' && s[i + 1] == '*') || (c == '/' && s[i + 1] == '*')) {
            char close = c == '(' ? ')' : '/';
            int L = line;
            ADV(2);
            while (i < n && !(s[i] == '*' && s[i + 1] == close)) ADV(1);
            if (i >= n) fail_at(cx, L, close == ')' ? "Unterminated (* comment *)" : "Unterminated /* comment */");
            ADV(2);
            continue;
        }
        if (c == '{') {
            int L = line;
            while (i < n && s[i] != '}') ADV(1);
            if (i >= n) fail_at(cx, L, "Unterminated { attribute }");
            ADV(1);
            continue;
        }
        int L = line, C = col;
        if (is_d(c)) {
            size_t st = i;
            while (i < n && (is_d(s[i]) || s[i] == '_')) ADV(1);
            size_t dl = i - st;
            if (s[i] == '#' && ((dl == 1 && (s[st] == '2' || s[st] == '8')) || (dl == 2 && s[st] == '1' && s[st + 1] == '6'))) {
                ADV(1);
                while (i < n && (is_hex(s[i]) || s[i] == '_')) ADV(1);
                char lit[96];
                size_t ll = i - st < sizeof lit - 1 ? i - st : sizeof lit - 1;
                memcpy(lit, s + st, ll);
                lit[ll] = 0;
                double v;
                if (ty_literal(lit, &v, NULL, 0) != 1) fail_at(cx, L, "Bad number %s", lit);
                tok_t *t = push_tok(cx);
                t->t = T_NUM, t->v = v, t->lit = LIT_INT, t->line = L, t->col = C;
                continue;
            }
            bool real = false;
            if (s[i] == '.' && is_d(s[i + 1])) {
                real = true;
                ADV(1);
                while (i < n && (is_d(s[i]) || s[i] == '_')) ADV(1);
            }
            if ((s[i] == 'e' || s[i] == 'E') && is_d((s[i + 1] == '+' || s[i + 1] == '-') ? s[i + 2] : s[i + 1])) {
                real = true;
                ADV(1);
                if (s[i] == '+' || s[i] == '-') ADV(1);
                while (i < n && is_d(s[i])) ADV(1);
            }
            char lit[96];
            size_t o = 0;
            for (size_t k = st; k < i && o + 1 < sizeof lit; k++)
                if (s[k] != '_') lit[o++] = s[k];
            lit[o] = 0;
            tok_t *t = push_tok(cx);
            t->t = T_NUM, t->v = strtod(lit, NULL), t->lit = real ? LIT_REAL : LIT_INT, t->line = L, t->col = C;
            continue;
        }
        if (is_a(c)) {
            size_t st = i;
            while (i < n && is_an(s[i])) ADV(1);
            size_t len = i - st;
            char up[40];
            size_t ul = len < sizeof up - 1 ? len : sizeof up - 1;
            for (size_t k = 0; k < ul; k++) up[k] = upc(s[st + k]);
            up[ul] = 0;
            if (s[i] == '#') {
                ADV(1);
                tok_t *t = push_tok(cx);
                t->t = T_NUM, t->lit = LIT_TYPED, t->line = L, t->col = C;
                size_t rs = i;
                if (len < sizeof up && (!strcmp(up, "T") || !strcmp(up, "TIME") || !strcmp(up, "S5T") || !strcmp(up, "S5TIME") ||
                                        !strcmp(up, "LT") || !strcmp(up, "LTIME"))) {
                    if (s[i] == '-' || s[i] == '+') ADV(1);
                    while (i < n && (is_an(s[i]) || s[i] == '.')) ADV(1);
                    char body[96];
                    size_t bl = i - rs < sizeof body - 1 ? i - rs : sizeof body - 1;
                    memcpy(body, s + rs, bl);
                    body[bl] = 0;
                    double ms;
                    if (!ty_time_lit(body, &ms)) fail_at(cx, L, "Bad time literal %s#%s", up, body);
                    t->v = ms, t->ty = &TY_TIME;
                    continue;
                }
                if (len < sizeof up && (!strcmp(up, "D") || !strcmp(up, "DATE"))) {
                    while (i < n && (is_d(s[i]) || s[i] == '-')) ADV(1);
                    char body[48];
                    size_t bl = i - rs < sizeof body - 1 ? i - rs : sizeof body - 1;
                    memcpy(body, s + rs, bl);
                    body[bl] = 0;
                    int y, mo, d;
                    char tail;
                    if (sscanf(body, "%4d-%2d-%2d%c", &y, &mo, &d, &tail) != 3 || strlen(body) < 8 || body[4] != '-')
                        fail_at(cx, L, "Bad date literal %s#%s", up, body);
                    if (mo < 1 || mo > 12 || d < 1 || d > 31) fail_at(cx, L, "Bad date literal %s#%s", up, body);
                    /* days from civil (Howard Hinnant), then since 1990-01-01 */
                    long yy = mo <= 2 ? y - 1 : y;
                    long era = (yy >= 0 ? yy : yy - 399) / 400;
                    long yoe = yy - era * 400;
                    long doy = (153L * (mo + (mo > 2 ? -3 : 9)) + 2) / 5 + d - 1;
                    long doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
                    t->v = (double)(era * 146097 + doe - 719468) - 7305;
                    t->ty = &TY_DATE;
                    continue;
                }
                if (len < sizeof up && (!strcmp(up, "TOD") || !strcmp(up, "TIME_OF_DAY"))) {
                    while (i < n && (is_d(s[i]) || s[i] == ':' || s[i] == '.')) ADV(1);
                    char body[48];
                    size_t bl = i - rs < sizeof body - 1 ? i - rs : sizeof body - 1;
                    memcpy(body, s + rs, bl);
                    body[bl] = 0;
                    /* ^(\d{1,2}):(\d{1,2})(?::(\d{1,2})(?:\.(\d{1,3}))?)?$ */
                    int part[4] = {0, 0, 0, 0}, np = 0;
                    char frac[4] = "000";
                    const char *q = body;
                    bool ok = true;
                    for (np = 0; np < 3 && ok; np++) {
                        int dg = 0;
                        while (is_d(*q) && dg < 2) part[np] = part[np] * 10 + (*q++ - '0'), dg++;
                        if (!dg) ok = false;
                        if (*q == ':' && np < 2) q++;
                        else break;
                    }
                    if (ok && np < 1) ok = false;
                    if (ok && *q == '.' && np == 2) {
                        q++;
                        int dg = 0;
                        while (is_d(*q) && dg < 3) frac[dg++] = *q++;
                        if (!dg) ok = false;
                    }
                    if (!ok || *q) fail_at(cx, L, "Bad time-of-day literal %s#%s", up, body);
                    t->v = ((part[0] * 60.0 + part[1]) * 60.0 + part[2]) * 1000.0 + (double)strtol(frac, NULL, 10);
                    t->ty = &TY_TOD;
                    continue;
                }
                const ty_t *ty = NULL;
                static const struct {
                    const char *n;
                    const ty_t *t;
                } TL[] = {{"BOOL", &TY_BOOL}, {"BYTE", &TY_BYTE}, {"WORD", &TY_WORD}, {"DWORD", &TY_DWORD}, {"SINT", &TY_SINT},
                          {"USINT", &TY_USINT}, {"INT", &TY_INT}, {"UINT", &TY_UINT}, {"DINT", &TY_DINT}, {"UDINT", &TY_UDINT},
                          {"REAL", &TY_REAL}, {"LREAL", &TY_LREAL}, {"TIME", &TY_TIME}, {"DATE", &TY_DATE},
                          {"TIME_OF_DAY", &TY_TOD}, {"CHAR", &TY_CHAR}};
                if (len < sizeof up)
                    for (size_t k = 0; k < sizeof TL / sizeof TL[0]; k++)
                        if (!strcmp(TL[k].n, up)) ty = TL[k].t;
                if (s[i] == '-' || s[i] == '+') ADV(1);
                while (i < n && (is_an(s[i]) || s[i] == '.' || s[i] == '#')) ADV(1);
                char rest[96];
                size_t rl = i - rs < sizeof rest - 1 ? i - rs : sizeof rest - 1;
                memcpy(rest, s + rs, rl);
                rest[rl] = 0;
                if (ty && ty->cls == TC_BOOL) {
                    if (plc_ieq(rest, "true") || !strcmp(rest, "1")) t->v = 1;
                    else if (plc_ieq(rest, "false") || !strcmp(rest, "0")) t->v = 0;
                    else fail_at(cx, L, "Bad Bool literal %s#%s", up, rest);
                    t->ty = ty;
                    continue;
                }
                double v;
                char sv[8];
                if (ty_literal(rest, &v, sv, sizeof sv) != 1) fail_at(cx, L, "Bad literal %s#%s", up, rest);
                t->v = v;
                if (!ty) {
                    bool realish = strpbrk(rest, ".eE") && !strchr(rest, '#');
                    t->lit = realish ? LIT_REAL : LIT_INT;
                } else t->ty = ty;
                continue;
            }
            if (len == 6 && !strcmp(up, "REGION")) {
                while (i < n && s[i] != '\n') ADV(1);
                tok_t *t = push_tok(cx);
                t->t = T_KW, t->kw = KW_REGION, t->line = L, t->col = C;
                continue;
            }
            tok_t *t = push_tok(cx);
            t->line = L, t->col = C;
            t->t = T_ID;
            t->s = sdup(cx, s + st, len);
            t->sl = (uint32_t)len;
            if (len < sizeof up)
                for (int k = 0; k < KW__N; k++)
                    if (!strcmp(up, KWS[k])) {
                        t->t = T_KW;
                        t->kw = (uint8_t)k;
                        break;
                    }
            continue;
        }
        if (c == '#') {
            ADV(1);
            if (!(i < n && is_a(s[i]))) fail_at(cx, L, "Expected a name after #");
            size_t st = i;
            while (i < n && is_an(s[i])) ADV(1);
            tok_t *t = push_tok(cx);
            t->t = T_LID, t->s = sdup(cx, s + st, i - st), t->sl = (uint32_t)(i - st), t->line = L, t->col = C;
            continue;
        }
        if (c == '"') {
            ADV(1);
            size_t st = i;
            while (i < n && s[i] != '"' && s[i] != '\n') ADV(1);
            if (s[i] != '"') fail_at(cx, L, "Unterminated \"name\"");
            size_t len = i - st;
            ADV(1);
            bool blank = true;
            for (size_t k = st; k < st + len; k++)
                if (!(s[k] == ' ' || s[k] == '\t' || s[k] == '\r')) blank = false;
            if (blank) fail_at(cx, L, "Empty \"name\"");
            tok_t *t = push_tok(cx);
            t->t = T_QID, t->s = sdup(cx, s + st, len), t->sl = (uint32_t)len, t->line = L, t->col = C;
            continue;
        }
        if (c == '\'') {
            ADV(1);
            size_t st = i;
            while (i < n && s[i] != '\'' && s[i] != '\n') {
                if (s[i] == '$' && i + 1 < n) ADV(1);
                ADV(1);
            }
            if (s[i] != '\'') fail_at(cx, L, "Unterminated 'string'");
            size_t len = i - st;
            ADV(1);
            char *out = (char *)sa(cx, len * 2 + 1);
            size_t ol = ty_unescape(s + st, len, out, len * 2 + 1);
            tok_t *t = push_tok(cx);
            t->t = T_STR, t->s = out, t->sl = (uint32_t)ol, t->line = L, t->col = C;
            continue;
        }
        if (c == '%') {
            /* %(I|Q|M)X?n.b  %(I|Q|M)(B|W|D)n  %(X|B|W|D)n (slice) */
            size_t q = i + 1;
            char a0 = upc(s[q]);
            char txt[32];
            bool slice = false, ok = false;
            if ((a0 == 'I' || a0 == 'Q' || a0 == 'M')) {
                size_t r = q + 1;
                char a1 = upc(s[r]);
                if (a1 == 'B' || a1 == 'W' || a1 == 'D') {
                    size_t d = r + 1, ds = d;
                    while (is_d(s[d])) d++;
                    if (d > ds && d - ds < 12) {
                        snprintf(txt, sizeof txt, "%c%c%.*s", a0, a1, (int)(d - ds), s + ds);
                        ADV(d - i);
                        ok = true;
                    }
                }
                if (!ok) {
                    if (a1 == 'X') r++;
                    size_t d = r, ds = d;
                    while (is_d(s[d])) d++;
                    if (d > ds && s[d] == '.' && is_d(s[d + 1]) && d - ds < 12) {
                        size_t e = d + 1, es = e;
                        while (is_d(s[e])) e++;
                        snprintf(txt, sizeof txt, "%c%.*s.%.*s", a0, (int)(d - ds), s + ds, (int)(e - es), s + es);
                        ADV(e - i);
                        ok = true;
                    }
                }
            }
            if (!ok && (a0 == 'X' || a0 == 'B' || a0 == 'W' || a0 == 'D')) {
                size_t d = q + 1, ds = d;
                while (is_d(s[d])) d++;
                if (d > ds && d - ds < 12) {
                    snprintf(txt, sizeof txt, "%c%.*s", a0, (int)(d - ds), s + ds);
                    ADV(d - i);
                    ok = slice = true;
                }
            }
            if (!ok) fail_at(cx, L, "Bad address after %%");
            tok_t *t = push_tok(cx);
            t->t = T_ADDR, t->s = sdup(cx, txt, strlen(txt)), t->sl = (uint32_t)strlen(txt), t->slice = slice, t->line = L,
            t->col = C;
            continue;
        }
        static const char *const TWO[] = {":=", "=>", "<=", ">=", "<>", "..", "**", "+=", "-=", "*=", "/="};
        bool done = false;
        for (size_t k = 0; k < sizeof TWO / sizeof TWO[0]; k++)
            if (c == TWO[k][0] && s[i + 1] == TWO[k][1]) {
                tok_t *t = push_tok(cx);
                t->t = T_OP, t->op[0] = TWO[k][0], t->op[1] = TWO[k][1], t->line = L, t->col = C;
                ADV(2);
                done = true;
                break;
            }
        if (done) continue;
        if (c && strchr("+-*/()<>=;:,.[]&", c)) {
            tok_t *t = push_tok(cx);
            t->t = T_OP, t->op[0] = c, t->line = L, t->col = C;
            ADV(1);
            continue;
        }
        if ((unsigned char)c >= 0x80) fail_at(cx, line, "Unexpected character (non-ASCII)");
        fail_at(cx, line, "Unexpected character \"%c\"", c);
    }
    tok_t *t = push_tok(cx);
    t->t = T_EOF, t->line = line, t->col = col;
#undef ADV
}

/* ================================================================ parser */
static tok_t *peek(cx_t *cx) { return &cx->toks[cx->pos]; }
static tok_t *peek_at(cx_t *cx, size_t k) { return &cx->toks[cx->pos + k < cx->ntok ? cx->pos + k : cx->ntok - 1]; }
static tok_t *nxt(cx_t *cx)
{
    tok_t *t = &cx->toks[cx->pos];
    if (t->t != T_EOF) cx->pos++;
    return t;
}
static void tok_text(const tok_t *t, char *out, size_t cap)
{
    switch (t->t) {
    case T_EOF: snprintf(out, cap, "<eof>"); break;
    case T_KW: snprintf(out, cap, "%s", KWS[t->kw]); break;
    case T_OP: snprintf(out, cap, "%s", t->op); break;
    case T_NUM: snprintf(out, cap, "%g", t->v); break;
    case T_QID: snprintf(out, cap, "\"%.*s\"", (int)(t->sl < cap ? t->sl : cap - 3), t->s); break;
    case T_LID: snprintf(out, cap, "#%.*s", (int)(t->sl < cap ? t->sl : cap - 2), t->s); break;
    case T_STR: snprintf(out, cap, "'%.*s'", (int)(t->sl < cap ? t->sl : cap - 3), t->s); break;
    default: snprintf(out, cap, "%.*s", (int)(t->sl < cap ? t->sl : cap - 1), t->s);
    }
}
static void perr(cx_t *cx, const char *msg)
{
    tok_t *t = peek(cx);
    char tx[64];
    tok_text(t, tx, sizeof tx);
    fail_at(cx, t->line, "%s near \"%s\"", msg, tx);
}
static bool is_op(cx_t *cx, const char *v) { tok_t *t = peek(cx); return t->t == T_OP && !strcmp(t->op, v); }
static bool is_kw(cx_t *cx, int k) { tok_t *t = peek(cx); return t->t == T_KW && t->kw == k; }
static bool accept_op(cx_t *cx, const char *v)
{
    if (is_op(cx, v)) {
        nxt(cx);
        return true;
    }
    return false;
}
static void eat_op(cx_t *cx, const char *v)
{
    if (!is_op(cx, v)) {
        char m[32];
        snprintf(m, sizeof m, "Expected \"%s\"", v);
        perr(cx, m);
    }
    nxt(cx);
}
static void eat_kw(cx_t *cx, int k)
{
    if (!is_kw(cx, k)) {
        char m[32];
        snprintf(m, sizeof m, "Expected %s", KWS[k]);
        perr(cx, m);
    }
    nxt(cx);
}

static an_t *node(cx_t *cx, uint8_t n, const tok_t *t)
{
    an_t *a = (an_t *)sa(cx, sizeof(an_t));
    a->n = n;
    a->line = t->line;
    a->col = t->col;
    return a;
}
/* growable list of AST pointers in scratch memory */
typedef struct {
    an_t **v;
    uint16_t n, cap;
} alist_t;
static void alist_push(cx_t *cx, alist_t *l, an_t *x)
{
    if (l->n >= l->cap) {
        uint16_t nc = l->cap ? (uint16_t)(l->cap * 2) : 8;
        if (nc < l->cap) perr(cx, "Too many items");
        an_t **nv = (an_t **)sa(cx, sizeof(an_t *) * nc);
        if (l->n) memcpy(nv, l->v, sizeof(an_t *) * l->n);
        l->v = nv;
        l->cap = nc;
    }
    l->v[l->n++] = x;
}

static an_t *p_expr(cx_t *cx);
static an_t *p_postfix(cx_t *cx);
static an_t *p_stmt(cx_t *cx);

typedef bool (*stop_fn)(cx_t *cx);
static void p_stmts(cx_t *cx, stop_fn stop, an_t ***out, uint16_t *n)
{
    alist_t l = {0};
    while (!stop(cx)) {
        if (peek(cx)->t == T_EOF) break;
        if (accept_op(cx, ";")) continue;
        alist_push(cx, &l, p_stmt(cx));
    }
    *out = l.v;
    *n = l.n;
}
static bool stop_eof(cx_t *cx) { return peek(cx)->t == T_EOF; }
static bool stop_if(cx_t *cx) { return is_kw(cx, KW_ELSIF) || is_kw(cx, KW_ELSE) || is_kw(cx, KW_END_IF); }
static bool stop_endif(cx_t *cx) { return is_kw(cx, KW_END_IF); }
static bool stop_endfor(cx_t *cx) { return is_kw(cx, KW_END_FOR); }
static bool stop_endwhile(cx_t *cx) { return is_kw(cx, KW_END_WHILE); }
static bool stop_until(cx_t *cx) { return is_kw(cx, KW_UNTIL); }
static bool stop_endregion(cx_t *cx) { return is_kw(cx, KW_END_REGION); }
static bool stop_endcase(cx_t *cx) { return is_kw(cx, KW_END_CASE); }

static int label_len(cx_t *cx, size_t q)
{
    tok_t *t = &cx->toks[q < cx->ntok ? q : cx->ntok - 1];
    if (t->t == T_OP && !strcmp(t->op, "-")) return (q + 1 < cx->ntok && cx->toks[q + 1].t == T_NUM) ? 2 : 0;
    if (t->t == T_NUM || t->t == T_LID) return 1;
    return 0;
}
static bool tok_is_op(cx_t *cx, size_t q, const char *v)
{
    if (q >= cx->ntok) return false;
    return cx->toks[q].t == T_OP && !strcmp(cx->toks[q].op, v);
}
static bool stop_case(cx_t *cx)
{
    if (is_kw(cx, KW_END_CASE) || is_kw(cx, KW_ELSE)) return true;
    size_t q = cx->pos;
    for (int first = 1;; first = 0) {
        if (!first) {
            if (!tok_is_op(cx, q, ",")) break;
            q++;
        }
        int a = label_len(cx, q);
        if (!a) return false;
        q += (size_t)a;
        if (tok_is_op(cx, q, "..")) {
            q++;
            int b = label_len(cx, q);
            if (!b) return false;
            q += (size_t)b;
        }
    }
    return tok_is_op(cx, q, ":");
}
static void case_value(cx_t *cx, double *v, const char **c)
{
    tok_t *t = peek(cx);
    if (t->t == T_LID) {
        nxt(cx);
        *c = t->s;
        return;
    }
    double sign = 1;
    if (is_op(cx, "-")) {
        nxt(cx);
        sign = -1;
    }
    tok_t *n = peek(cx);
    if (n->t != T_NUM || n->lit == LIT_REAL || (n->ty && n->ty->cls == TC_BOOL) || n->v != floor(n->v))
        perr(cx, "Expected an integer in the CASE label");
    nxt(cx);
    *v = sign * n->v;
    *c = NULL;
}

static an_t *p_stmt1(cx_t *cx)
{
    tok_t *t = peek(cx);
    if (t->t == T_KW) {
        switch (t->kw) {
        case KW_IF: {
            nxt(cx);
            an_t *a = node(cx, AN_IF, t);
            alist_t arms = {0};
            an_t *arm = node(cx, AN_ARM, t);
            arm->a = p_expr(cx);
            eat_kw(cx, KW_THEN);
            p_stmts(cx, stop_if, &arm->body, &arm->nbody);
            alist_push(cx, &arms, arm);
            while (is_kw(cx, KW_ELSIF)) {
                tok_t *e = nxt(cx);
                arm = node(cx, AN_ARM, e);
                arm->a = p_expr(cx);
                eat_kw(cx, KW_THEN);
                p_stmts(cx, stop_if, &arm->body, &arm->nbody);
                alist_push(cx, &arms, arm);
            }
            if (is_kw(cx, KW_ELSE)) {
                nxt(cx);
                a->has_els = 1;
                p_stmts(cx, stop_endif, &a->els, &a->nels);
            }
            eat_kw(cx, KW_END_IF);
            accept_op(cx, ";");
            a->list = arms.v, a->nlist = arms.n;
            return a;
        }
        case KW_CASE: {
            nxt(cx);
            an_t *a = node(cx, AN_CASE, t);
            a->a = p_expr(cx);
            eat_kw(cx, KW_OF);
            alist_t arms = {0};
            while (!is_kw(cx, KW_END_CASE) && !is_kw(cx, KW_ELSE)) {
                if (peek(cx)->t == T_EOF) perr(cx, "Expected END_CASE");
                an_t *arm = node(cx, AN_ARM, peek(cx));
                alist_t labs = {0};
                do {
                    an_t *lb = node(cx, AN_LAB, peek(cx));
                    case_value(cx, &lb->lo, &lb->loc);
                    lb->hi = lb->lo, lb->hic = lb->loc;
                    if (accept_op(cx, "..")) case_value(cx, &lb->hi, &lb->hic);
                    alist_push(cx, &labs, lb);
                } while (accept_op(cx, ","));
                eat_op(cx, ":");
                arm->list = labs.v, arm->nlist = labs.n;
                p_stmts(cx, stop_case, &arm->body, &arm->nbody);
                alist_push(cx, &arms, arm);
            }
            if (is_kw(cx, KW_ELSE)) {
                nxt(cx);
                accept_op(cx, ":");
                a->has_els = 1;
                p_stmts(cx, stop_endcase, &a->els, &a->nels);
            }
            eat_kw(cx, KW_END_CASE);
            accept_op(cx, ";");
            a->list = arms.v, a->nlist = arms.n;
            return a;
        }
        case KW_FOR: {
            nxt(cx);
            an_t *a = node(cx, AN_FOR, t);
            a->a = p_postfix(cx);
            eat_op(cx, ":=");
            a->b = p_expr(cx);
            eat_kw(cx, KW_TO);
            a->c = p_expr(cx);
            if (is_kw(cx, KW_BY)) {
                nxt(cx);
                a->d = p_expr(cx);
            }
            eat_kw(cx, KW_DO);
            p_stmts(cx, stop_endfor, &a->body, &a->nbody);
            eat_kw(cx, KW_END_FOR);
            accept_op(cx, ";");
            return a;
        }
        case KW_WHILE: {
            nxt(cx);
            an_t *a = node(cx, AN_WHILE, t);
            a->a = p_expr(cx);
            eat_kw(cx, KW_DO);
            p_stmts(cx, stop_endwhile, &a->body, &a->nbody);
            eat_kw(cx, KW_END_WHILE);
            accept_op(cx, ";");
            return a;
        }
        case KW_REPEAT: {
            nxt(cx);
            an_t *a = node(cx, AN_REPEAT, t);
            p_stmts(cx, stop_until, &a->body, &a->nbody);
            eat_kw(cx, KW_UNTIL);
            a->a = p_expr(cx);
            eat_kw(cx, KW_END_REPEAT);
            accept_op(cx, ";");
            return a;
        }
        case KW_EXIT: nxt(cx); accept_op(cx, ";"); return node(cx, AN_EXIT, t);
        case KW_CONTINUE: nxt(cx); accept_op(cx, ";"); return node(cx, AN_CONTINUE, t);
        case KW_RETURN: nxt(cx); accept_op(cx, ";"); return node(cx, AN_RETURN, t);
        case KW_REGION: {
            nxt(cx);
            an_t *a = node(cx, AN_REGION, t);
            p_stmts(cx, stop_endregion, &a->body, &a->nbody);
            eat_kw(cx, KW_END_REGION);
            accept_op(cx, ";");
            return a;
        }
        case KW_GOTO: perr(cx, "GOTO is not supported");
        }
    }
    if (t->t == T_ID || t->t == T_LID || t->t == T_QID || t->t == T_ADDR) {
        an_t *lhs = p_postfix(cx);
        tok_t *o = peek(cx);
        if (o->t == T_OP && (!strcmp(o->op, ":=") || !strcmp(o->op, "+=") || !strcmp(o->op, "-=") || !strcmp(o->op, "*=") ||
                             !strcmp(o->op, "/="))) {
            nxt(cx);
            an_t *a = node(cx, AN_ASSIGN, t);
            memcpy(a->op, o->op, 3);
            a->a = lhs;
            a->b = p_expr(cx);
            accept_op(cx, ";");
            return a;
        }
        if (lhs->n == AN_CALL) {
            accept_op(cx, ";");
            an_t *a = node(cx, AN_CALLST, t);
            a->a = lhs;
            return a;
        }
        perr(cx, "Expected \":=\"");
    }
    perr(cx, "Unexpected statement");
    return NULL;
}
static an_t *p_stmt(cx_t *cx)
{
    if (++cx->sdepth > MAX_STMT_DEPTH) perr(cx, "Statements nested too deeply");
    an_t *r = p_stmt1(cx);
    cx->sdepth--;
    return r;
}

static an_t *bin(cx_t *cx, const char *op, an_t *a, an_t *b, const tok_t *t)
{
    an_t *x = node(cx, AN_BIN, t);
    snprintf(x->op, sizeof x->op, "%s", op);
    x->a = a;
    x->b = b;
    return x;
}
static an_t *p_or(cx_t *cx);
static an_t *p_expr(cx_t *cx)
{
    if (++cx->edepth > MAX_EXPR_DEPTH) perr(cx, "Expression nested too deeply");
    an_t *r = p_or(cx);
    cx->edepth--;
    return r;
}
static an_t *p_xor(cx_t *cx);
static an_t *p_and(cx_t *cx);
static an_t *p_eq(cx_t *cx);
static an_t *p_rel(cx_t *cx);
static an_t *p_add(cx_t *cx);
static an_t *p_mul(cx_t *cx);
static an_t *p_unary(cx_t *cx);
static an_t *p_or(cx_t *cx)
{
    an_t *a = p_xor(cx);
    while (is_kw(cx, KW_OR)) {
        tok_t t = *nxt(cx);
        a = bin(cx, "OR", a, p_xor(cx), &t);
    }
    return a;
}
static an_t *p_xor(cx_t *cx)
{
    an_t *a = p_and(cx);
    while (is_kw(cx, KW_XOR)) {
        tok_t t = *nxt(cx);
        a = bin(cx, "XOR", a, p_and(cx), &t);
    }
    return a;
}
static an_t *p_and(cx_t *cx)
{
    an_t *a = p_eq(cx);
    while (is_kw(cx, KW_AND) || is_op(cx, "&")) {
        tok_t t = *nxt(cx);
        a = bin(cx, "AND", a, p_eq(cx), &t);
    }
    return a;
}
static an_t *p_eq(cx_t *cx)
{
    an_t *a = p_rel(cx);
    while (is_op(cx, "=") || is_op(cx, "<>")) {
        tok_t t = *nxt(cx);
        a = bin(cx, t.op, a, p_rel(cx), &t);
    }
    return a;
}
static an_t *p_rel(cx_t *cx)
{
    an_t *a = p_add(cx);
    while (is_op(cx, "<") || is_op(cx, ">") || is_op(cx, "<=") || is_op(cx, ">=")) {
        tok_t t = *nxt(cx);
        a = bin(cx, t.op, a, p_add(cx), &t);
    }
    return a;
}
static an_t *p_add(cx_t *cx)
{
    an_t *a = p_mul(cx);
    while (is_op(cx, "+") || is_op(cx, "-")) {
        tok_t t = *nxt(cx);
        a = bin(cx, t.op, a, p_mul(cx), &t);
    }
    return a;
}
static an_t *p_mul(cx_t *cx)
{
    an_t *a = p_unary(cx);
    while (is_op(cx, "*") || is_op(cx, "/") || is_kw(cx, KW_MOD)) {
        tok_t t = *nxt(cx);
        a = bin(cx, t.t == T_KW ? "MOD" : t.op, a, p_unary(cx), &t);
    }
    return a;
}
static an_t *p_unary_operand(cx_t *cx)
{
    if (++cx->edepth > MAX_EXPR_DEPTH) perr(cx, "Expression nested too deeply");
    an_t *r = p_unary(cx);
    cx->edepth--;
    return r;
}
static an_t *p_primary(cx_t *cx);
static an_t *p_unary(cx_t *cx)
{
    tok_t *t = peek(cx);
    if (is_kw(cx, KW_NOT) || is_op(cx, "-")) {
        tok_t tt = *nxt(cx);
        an_t *x = node(cx, AN_UN, &tt);
        snprintf(x->op, sizeof x->op, "%s", tt.t == T_KW ? "NOT" : "-");
        x->a = p_unary_operand(cx);
        return x;
    }
    if (is_op(cx, "+")) {
        nxt(cx);
        return p_unary_operand(cx);
    }
    (void)t;
    an_t *a = p_primary(cx);
    while (is_op(cx, "**")) {
        tok_t tt = *nxt(cx);
        a = bin(cx, "**", a, p_unary_operand(cx), &tt);
    }
    return a;
}
static an_t *p_primary(cx_t *cx)
{
    tok_t *t = peek(cx);
    if (t->t == T_NUM) {
        nxt(cx);
        an_t *x = node(cx, AN_NUM, t);
        x->v = t->v, x->lit = t->lit, x->ty = t->ty;
        return x;
    }
    if (t->t == T_STR) {
        nxt(cx);
        an_t *x = node(cx, AN_STR, t);
        x->s = t->s, x->sl = t->sl;
        return x;
    }
    if (t->t == T_KW && (t->kw == KW_TRUE || t->kw == KW_FALSE)) {
        nxt(cx);
        an_t *x = node(cx, AN_BOOL, t);
        x->v = t->kw == KW_TRUE;
        return x;
    }
    if (is_op(cx, "(")) {
        nxt(cx);
        an_t *e = p_expr(cx);
        eat_op(cx, ")");
        return e;
    }
    if (t->t == T_ID || t->t == T_LID || t->t == T_QID || t->t == T_ADDR) return p_postfix(cx);
    perr(cx, "Unexpected token in expression");
    return NULL;
}
static an_t *p_postfix(cx_t *cx)
{
    tok_t *t = nxt(cx);
    an_t *a;
    if (t->t == T_ADDR) {
        if (t->slice) fail_at(cx, t->line, "A slice (%%X0) needs a variable in front of it near \"%s\"", t->s);
        a = node(cx, AN_ADDR, t);
        a->s = t->s, a->sl = t->sl;
    } else {
        a = node(cx, AN_NAME, t);
        a->s = t->s, a->sl = t->sl;
        a->local = t->t == T_LID;
        a->quoted = t->t == T_QID;
    }
    for (;;) {
        if (is_op(cx, ".")) {
            nxt(cx);
            tok_t *m = peek(cx);
            if (m->t == T_ID || m->t == T_QID) {
                nxt(cx);
                an_t *x = node(cx, AN_MEM, m);
                x->a = a, x->s = m->s, x->sl = m->sl;
                a = x;
                continue;
            }
            if (m->t == T_KW) {
                nxt(cx);
                an_t *x = node(cx, AN_MEM, m);
                x->a = a, x->s = KWS[m->kw], x->sl = (uint32_t)strlen(KWS[m->kw]);
                a = x;
                continue;
            }
            if (m->t == T_ADDR && m->slice) {
                nxt(cx);
                an_t *x = node(cx, AN_SLICE, m);
                x->a = a;
                x->slk = (uint8_t)m->s[0];
                x->sidx = atoi(m->s + 1);
                a = x;
                continue;
            }
            perr(cx, "Expected member name");
        }
        if (is_op(cx, "[")) {
            tok_t *b = nxt(cx);
            an_t *x = node(cx, AN_IDX, b);
            x->a = a;
            alist_t l = {0};
            alist_push(cx, &l, p_expr(cx));
            while (accept_op(cx, ",")) alist_push(cx, &l, p_expr(cx));
            eat_op(cx, "]");
            x->list = l.v, x->nlist = l.n;
            a = x;
            continue;
        }
        if (is_op(cx, "(")) {
            if (a->n == AN_CALL) perr(cx, "Unexpected \"(\"");
            tok_t *b = nxt(cx);
            an_t *x = node(cx, AN_CALL, b);
            x->a = a;
            alist_t l = {0};
            if (!is_op(cx, ")")) {
                do {
                    tok_t *k = peek(cx), *k2 = peek_at(cx, 1);
                    an_t *ar = node(cx, AN_ARG, k);
                    if ((k->t == T_ID || k->t == T_KW) && k2->t == T_OP && (!strcmp(k2->op, ":=") || !strcmp(k2->op, "=>"))) {
                        ar->s = k->t == T_KW ? KWS[k->kw] : k->s;
                        ar->sl = (uint32_t)strlen(ar->s);
                        ar->out = k2->op[0] == '=';
                        nxt(cx);
                        nxt(cx);
                        ar->a = ar->out ? p_postfix(cx) : p_expr(cx);
                    } else {
                        ar->a = p_expr(cx);
                    }
                    alist_push(cx, &l, ar);
                } while (accept_op(cx, ","));
            }
            eat_op(cx, ")");
            x->list = l.v, x->nlist = l.n;
            a = x;
            continue;
        }
        return a;
    }
}

/* ============================================================== compiler */
#define CERR(node, ...) fail_at(cx, (node) ? (node)->line : 0, __VA_ARGS__)

static bool is_bool(const ty_t *t) { return t->k == TK_EL && t->cls == TC_BOOL; }
static bool is_num(const ty_t *t) { return t->k == TK_EL && t->cls == TC_NUM; }
static bool is_real(const ty_t *t) { return t->k == TK_EL && t->cls == TC_REAL; }
static bool is_intlike(const ty_t *t)
{
    return t->k == TK_EL && (t->cls == TC_INT || t->cls == TC_BITS || t->cls == TC_TIME || t->cls == TC_DATE || t->cls == TC_TOD ||
                             t->cls == TC_CHAR);
}
static bool is_value(const ty_t *t) { return t->k == TK_EL || t->k == TK_STRV; }
static const char *tn(const ty_t *t, char *b) { return ty_name(t, b, 96); }

static const ty_t *int_result(const ty_t *a, const ty_t *b)
{
    if (a->any && b->any) return &TY_ANYINT;
    if (a->any) return b;
    if (b->any) return a;
    if (a->cls == TC_TIME || b->cls == TC_TIME) return &TY_TIME;
    if (a->bits != b->bits) return a->bits > b->bits ? a : b;
    if (a == b || !strcmp(a->name, b->name)) return a;
    if (a->cls == TC_BITS || a->cls == TC_CHAR || a->cls == TC_DATE || a->cls == TC_TOD) return b;
    if (b->cls == TC_BITS || b->cls == TC_CHAR || b->cls == TC_DATE || b->cls == TC_TOD) return a;
    return a->bits >= 32 ? &TY_DINT : a->bits == 8 ? &TY_INT : &TY_DINT;
}
static const ty_t *num_result(const ty_t *a, const ty_t *b)
{
    if (is_num(a) || is_num(b) || is_bool(a) || is_bool(b)) return &TY_NUM;
    if (is_real(a) || is_real(b)) {
        if ((is_real(a) && a->bits == 64 && !a->any) || (is_real(b) && b->bits == 64 && !b->any)) return &TY_LREAL;
        if ((is_real(a) && !a->any) || (is_real(b) && !b->any)) return &TY_REAL;
        return &TY_ANYREAL;
    }
    return int_result(a, b);
}

static sx_t *X(cx_t *cx, uint8_t op, const ty_t *ty)
{
    sx_t *x = (sx_t *)aa(cx, sizeof(sx_t));
    x->op = op;
    x->ty = ty;
    return x;
}
static sx_t *K(cx_t *cx, double v, const ty_t *ty)
{
    sx_t *x = X(cx, X_K, ty);
    x->v = v;
    return x;
}

static double ev(plc_t *p, sx_t *x);
/* constant folding: keeps CASE labels, indices and offsets static */
static sx_t *fold(cx_t *cx, sx_t *x)
{
    if (x->a && x->a->op != X_K) return x;
    if (x->b && x->b->op != X_K) return x;
    if (!x->a && !x->b) return x;
    if (x->op == X_FN || x->op == X_CALL || x->op == X_CNT || x->op == X_RDT) return x;
    return K(cx, ev(cx->p, x), x->ty);
}

/* ---- places ---- */
static pl_t *pl_new(cx_t *cx) { return (pl_t *)aa(cx, sizeof(pl_t)); }
static pl_t *pl_copy(cx_t *cx, const pl_t *b, uint16_t extra)
{
    pl_t *r = pl_new(cx);
    *r = *b;
    r->st = (plst_t *)aa(cx, sizeof(plst_t) * (size_t)(b->nst + extra + 1));
    if (b->nst) memcpy(r->st, b->st, sizeof(plst_t) * b->nst);
    return r;
}
static pl_t *step_field(cx_t *cx, const pl_t *b, const fld_t *f, an_t *n)
{
    if (b->pk != PK_LOC) CERR(n, "Cannot access members here");
    pl_t *r = pl_copy(cx, b, 1);
    if (r->nst && r->st[r->nst - 1].k == 0) {
        r->st[r->nst - 1].off += f->off;
        r->st[r->nst - 1].bit = f->bit;
    } else {
        r->st[r->nst].k = 0;
        r->st[r->nst].off = f->off;
        r->st[r->nst].bit = f->bit;
        r->nst++;
    }
    r->ty = f->t;
    r->is_const = b->is_const || f->sec == SEC_CONST;
    r->field = f;
    r->variant = 0;
    return r;
}
static int field_index(const ty_t *t, const fld_t *f) { return (int)(f - t->f); }
static pl_t *self_field(cx_t *cx, const fld_t *f)
{
    pl_t *r = pl_new(cx);
    r->pk = PK_LOC;
    r->field = f;
    if (f->ref) {
        r->base = B_REF;
        r->ref = &cx->u->mem.m->refs[field_index(cx->t, f)];
        r->ty = f->reft;
        r->variant = f->reft->k == TK_VARIANT;
        return r;
    }
    r->base = B_SELF;
    r->ptr = cx->u->mem.m->buf;
    r->st = (plst_t *)aa(cx, sizeof(plst_t));
    r->st[0].k = 0;
    r->st[0].off = f->off;
    r->st[0].bit = f->bit;
    r->nst = 1;
    r->ty = f->t;
    r->is_const = f->sec == SEC_CONST;
    return r;
}
static const fld_t *local_field(cx_t *cx, const char *name)
{
    if (!cx->t) return NULL;
    if (cx->fcret[0] && plc_ieq(name, cx->fcret)) return ty_field(cx->t, "RET_VAL");
    return ty_field(cx->t, name);
}
static const ty_t *tag_type(plc_t *p, int ti)
{
    const ty_t *t = ty_parse(p, p->tags[ti].dtype, -1, NULL, 0);
    return t && t->k == TK_EL ? t : &TY_NUM;
}
static pl_t *global_place(cx_t *cx, const char *name, an_t *n)
{
    plc_t *p = cx->p;
    int ti = plc_tag_index(p, name);
    if (ti >= 0) {
        pl_t *r = pl_new(cx);
        r->pk = PK_CELL;
        r->cell = p->tags[ti].c;
        r->cbit = p->tags[ti].is_bool;
        r->ty = tag_type(p, ti);
        return r;
    }
    for (size_t i = 0; i < p->nblocks; i++) {
        blk_t *db = &p->blocks[i];
        if (db->type != BT_DB || !plc_ieq(db->name, name)) continue;
        const ty_t *t = plc_block_type(p, db);
        if (!t) CERR(n, "Data block \"%s\": %s", db->name, db->ty_err ? db->ty_err : "?");
        mem_t *m = plc_db_mem(p, db);
        pl_t *r = pl_new(cx);
        r->pk = PK_LOC;
        r->base = B_DB;
        r->ptr = m->buf;
        r->ty = t;
        return r;
    }
    return NULL;
}
static pl_t *cell_place(cx_t *cx, const char *raw)
{
    ref_t rr = plc_resolve(cx->p, NULL, raw);
    pl_t *r = pl_new(cx);
    r->pk = PK_CELL;
    r->cell = rr.c;
    r->cbit = rr.bit;
    r->ty = &TY_NUM;
    return r;
}
static pl_t *place_of(cx_t *cx, an_t *n);
static pl_t *dotted_legacy(cx_t *cx, an_t *n)
{
    an_t *x = n;
    int depth = 0;
    while (x->n == AN_MEM) x = x->a, depth++;
    if (x->n != AN_NAME || x->local || x->quoted) return NULL;
    if (local_field(cx, x->s) || global_place(cx, x->s, x)) return NULL;
    char key[192];
    size_t o = (size_t)snprintf(key, sizeof key, "%s", x->s);
    /* names in source order */
    an_t *chain[64];
    int k = 0;
    for (an_t *y = n; y->n == AN_MEM && k < 64; y = y->a) chain[k++] = y;
    for (int i = k - 1; i >= 0 && o < sizeof key; i--) o += (size_t)snprintf(key + o, sizeof key - o, ".%s", chain[i]->s);
    (void)depth;
    return cell_place(cx, key);
}
static pl_t *name_place(cx_t *cx, an_t *n)
{
    if (n->local) {
        const fld_t *f = local_field(cx, n->s);
        if (!f) CERR(n, "Unknown local variable #%s", n->s);
        return self_field(cx, f);
    }
    if (n->quoted) {
        pl_t *g = global_place(cx, n->s, n);
        if (g) return g;
        CERR(n, "Unknown global \"%s\" (no tag or data block of that name)", n->s);
    }
    const fld_t *f = local_field(cx, n->s);
    if (f) return self_field(cx, f);
    pl_t *g = global_place(cx, n->s, n);
    if (g) return g;
    return cell_place(cx, n->s);
}
static pl_t *addr_place(cx_t *cx, an_t *n)
{
    ref_t rr = plc_resolve(cx->p, NULL, n->s);
    if (rr.c.k == CK_NONE || rr.c.k == CK_LIT) CERR(n, "Bad address %%%s", n->s);
    pl_t *r = pl_new(cx);
    r->pk = PK_CELL;
    r->cell = rr.c;
    r->cbit = rr.bit;
    r->ty = rr.bit ? &TY_BOOL : (n->s[1] == 'B' ? &TY_BYTE : n->s[1] == 'W' ? &TY_WORD : &TY_DWORD);
    return r;
}
static sx_t *expr_c(cx_t *cx, an_t *n);
static pl_t *place_of(cx_t *cx, an_t *n)
{
    char b1[96];
    switch (n->n) {
    case AN_NAME: return name_place(cx, n);
    case AN_ADDR: return addr_place(cx, n);
    case AN_MEM: {
        pl_t *lg = dotted_legacy(cx, n);
        if (lg) return lg;
        pl_t *b = place_of(cx, n->a);
        const ty_t *t = b->ty;
        if (t->k != TK_STRUCT && t->k != TK_FB) CERR(n, "\"%s\": %s has no members", n->s, tn(t, b1));
        const fld_t *f = ty_field(t, n->s);
        if (!f) CERR(n, "Unknown member \"%s\" in %s", n->s, tn(t, b1));
        if (f->t->k == TK_VARIANT) CERR(n, "\"%s\" is a reference parameter of %s", n->s, tn(t, b1));
        return step_field(cx, b, f, n);
    }
    case AN_IDX: {
        pl_t *b = place_of(cx, n->a);
        const ty_t *t = b->ty;
        if (t->k != TK_ARR) CERR(n, "Not an array: %s", tn(t, b1));
        if (n->nlist != t->ndim) CERR(n, "Array needs %d index(es)", t->ndim);
        sx_t **idx = (sx_t **)aa(cx, sizeof(sx_t *) * n->nlist);
        bool cst = true;
        for (uint16_t i = 0; i < n->nlist; i++) {
            idx[i] = expr_c(cx, n->list[i]);
            if (!is_intlike(idx[i]->ty) && !is_num(idx[i]->ty)) CERR(n->list[i], "Array index must be an integer, not %s", tn(idx[i]->ty, b1));
            if (idx[i]->op != X_K) cst = false;
        }
        if (b->pk != PK_LOC) CERR(n, "Cannot index this");
        pl_t *r = pl_copy(cx, b, 1);
        if (cst) {
            uint32_t lin = 0;
            for (uint16_t d = 0; d < t->ndim; d++) {
                double x = idx[d]->v;
                if (x != floor(x) || x < t->lo[d] || x > t->hi[d]) CERR(n, "Array index out of range");
                lin = lin * (uint32_t)(t->hi[d] - t->lo[d] + 1) + (uint32_t)(x - t->lo[d]);
            }
            uint32_t off;
            uint8_t bit;
            if (t->el->k == TK_EL && t->el->cls == TC_BOOL) off = lin >> 3, bit = (uint8_t)(lin & 7);
            else off = lin * t->stride, bit = 0;
            r->st[r->nst].k = 0;
            r->st[r->nst].off = off;
            r->st[r->nst].bit = bit;
        } else {
            r->st[r->nst].k = 1;
            r->st[r->nst].arr = t;
            r->st[r->nst].idx = idx;
            r->dyn = 1;
        }
        r->nst++;
        r->ty = t->el;
        r->field = NULL;
        return r;
    }
    case AN_SLICE: {
        pl_t *b = place_of(cx, n->a);
        if (!(is_intlike(b->ty) || (b->pk == PK_CELL && is_num(b->ty)))) CERR(n, "Slices need a bit string or integer, not %s", tn(b->ty, b1));
        int width = b->ty->bits ? b->ty->bits : 32;
        int per = n->slk == 'X' ? 1 : n->slk == 'B' ? 8 : n->slk == 'W' ? 16 : 32;
        if (per > width || n->sidx < 0 || (n->sidx + 1) * per > width) CERR(n, "Slice %%%c%d is outside %s", n->slk, n->sidx, tn(b->ty, b1));
        pl_t *r = pl_new(cx);
        r->pk = PK_SLICE;
        r->sbase = b;
        r->per = (uint8_t)per;
        r->sli = (uint8_t)n->sidx;
        r->width = (uint8_t)width;
        r->ty = per == 1 ? &TY_BOOL : per == 8 ? &TY_BYTE : per == 16 ? &TY_WORD : &TY_DWORD;
        return r;
    }
    case AN_CALL: CERR(n, "A call result cannot be assigned or indexed");
    }
    CERR(n, "Not a variable");
    return NULL;
}

/* ---- expressions ---- */
static sx_t *bin_c(cx_t *cx, an_t *n, an_t *na, an_t *nb, const char *op);
static scall_t *call_c(cx_t *cx, an_t *n, bool as_expr, sx_t **special);
static sx_t *expr_c(cx_t *cx, an_t *n)
{
    char b1[96];
    switch (n->n) {
    case AN_NUM:
        if (n->ty) return K(cx, n->ty->cls == TC_BOOL ? (n->v != 0) : n->ty->cls == TC_REAL ? n->v : ty_conv(n->v, n->ty), n->ty);
        return K(cx, n->v, n->lit == LIT_REAL ? &TY_ANYREAL : &TY_ANYINT);
    case AN_BOOL: return K(cx, n->v, &TY_BOOL);
    case AN_STR: {
        sx_t *x = X(cx, X_KS, &TY_STRV);
        x->s = plc_ar_strdup(cx->p, n->s, n->sl);
        x->sl = (uint16_t)n->sl;
        return x;
    }
    case AN_UN: {
        sx_t *a = expr_c(cx, n->a);
        if (!is_value(a->ty) || a->ty->k == TK_STRV) CERR(n, "Operator %s needs a value, not %s", n->op, tn(a->ty, b1));
        if (!strcmp(n->op, "NOT")) {
            sx_t *x = X(cx, is_intlike(a->ty) ? X_BNOT : X_NOT, is_intlike(a->ty) ? a->ty : &TY_BOOL);
            x->a = a;
            return fold(cx, x);
        }
        sx_t *x = X(cx, X_NEG, is_bool(a->ty) ? &TY_NUM : a->ty);
        x->a = a;
        return fold(cx, x);
    }
    case AN_BIN: return bin_c(cx, n, n->a, n->b, n->op);
    case AN_CALL: {
        sx_t *sp = NULL;
        scall_t *c = call_c(cx, n, true, &sp);
        if (sp) return sp;
        sx_t *x = X(cx, X_CALL, c->ty);
        x->call = c;
        return x;
    }
    default: {
        pl_t *pl = place_of(cx, n);
        if (pl->ty->k == TK_STR) {
            sx_t *x = X(cx, X_RDS, &TY_STRV);
            x->p = pl;
            return x;
        }
        if (pl->ty->k != TK_EL) CERR(n, "%s cannot be used as a value here", tn(pl->ty, b1));
        sx_t *x = X(cx, X_RD, pl->ty);
        x->p = pl;
        return x;
    }
    }
}
static uint8_t op_code(const char *op)
{
    static const char *const O[] = {"+", "-", "*", "/", "MOD", "**", "=", "<>", "<", ">", "<=", ">=", "AND", "OR", "XOR"};
    for (uint8_t i = 0; i < sizeof O / sizeof O[0]; i++)
        if (!strcmp(O[i], op)) return i;
    return 0;
}
static sx_t *bin_parts(cx_t *cx, an_t *n, sx_t *a, sx_t *b, const char *op)
{
    char b1[96];
    if (!is_value(a->ty)) CERR(n, "Operator %s cannot take %s", op, tn(a->ty, b1));
    if (!is_value(b->ty)) CERR(n, "Operator %s cannot take %s", op, tn(b->ty, b1));
    uint8_t o = op_code(op);
    if (o >= O_EQ && o <= O_GE) {
        bool sa_ = a->ty->k == TK_STRV, sb_ = b->ty->k == TK_STRV;
        if (sa_ != sb_) {
            char b2[96];
            CERR(n, "Cannot compare %s with %s", tn(a->ty, b1), tn(b->ty, b2));
        }
        sx_t *x = X(cx, X_CMP, &TY_BOOL);
        x->o = o, x->a = a, x->b = b, x->flag = sa_;
        return sa_ ? x : fold(cx, x);
    }
    if (a->ty->k == TK_STRV) CERR(n, "Operator %s cannot take %s", op, tn(a->ty, b1));
    if (b->ty->k == TK_STRV) CERR(n, "Operator %s cannot take %s", op, tn(b->ty, b1));
    if (o == O_BAND || o == O_BOR || o == O_BXOR) {
        if (is_intlike(a->ty) && is_intlike(b->ty)) {
            sx_t *x = X(cx, X_BIT, int_result(a->ty, b->ty));
            x->o = o, x->a = a, x->b = b;
            return fold(cx, x);
        }
        sx_t *x = X(cx, o == O_BAND ? X_AND : o == O_BOR ? X_OR : X_XOR, &TY_BOOL);
        x->a = a, x->b = b;
        return fold(cx, x);
    }
    if (o == O_POW) {
        sx_t *x = X(cx, X_AR, &TY_LREAL);
        x->o = o, x->a = a, x->b = b, x->mode = M_FLT;
        return fold(cx, x);
    }
    const ty_t *ty = num_result(a->ty, b->ty);
    uint8_t mode = is_num(ty) ? M_NUM : is_real(ty) ? M_FLT : M_INT;
    if (mode == M_INT && ty->cls == TC_TIME && o == O_DIV && a->ty->cls == TC_TIME && b->ty->cls == TC_TIME) ty = &TY_DINT;
    sx_t *x = X(cx, X_AR, ty);
    x->o = o, x->a = a, x->b = b, x->mode = mode;
    return fold(cx, x);
}
static sx_t *bin_c(cx_t *cx, an_t *n, an_t *na, an_t *nb, const char *op)
{
    sx_t *a = expr_c(cx, na);
    sx_t *b = expr_c(cx, nb);
    return bin_parts(cx, n, a, b, op);
}

/* ---- calls ---- */
static sx_t *val_arg(cx_t *cx, sx_t *x, an_t *n)
{
    if (!x || !is_value(x->ty) || x->ty->k == TK_STRV) CERR(n, "Argument must be a number or Bool");
    return x;
}
static const ty_t *real_of(const ty_t *t) { return is_real(t) && !t->any ? t : &TY_LREAL; }
static const ty_t *conv_dst(const char *up)
{
    /* <SRC>_TO_<DST>: both elementary names (TOD / TIME_OF_DAY) */
    const char *to = strstr(up, "_TO_");
    while (to) {
        char src[24], dst[24];
        size_t sl = (size_t)(to - up);
        if (sl && sl < sizeof src && strlen(to + 4) < sizeof dst) {
            memcpy(src, up, sl);
            src[sl] = 0;
            snprintf(dst, sizeof dst, "%s", to + 4);
            static const char *const N[] = {"BOOL", "BYTE", "WORD", "DWORD", "SINT", "USINT", "INT", "UINT", "DINT", "UDINT",
                                            "REAL", "LREAL", "TIME", "DATE", "TIME_OF_DAY", "TOD", "CHAR"};
            static const ty_t *const TT[] = {&TY_BOOL, &TY_BYTE, &TY_WORD, &TY_DWORD, &TY_SINT, &TY_USINT, &TY_INT, &TY_UINT,
                                             &TY_DINT, &TY_UDINT, &TY_REAL, &TY_LREAL, &TY_TIME, &TY_DATE, &TY_TOD, &TY_TOD, &TY_CHAR};
            const ty_t *s_ = NULL, *d_ = NULL;
            for (size_t i = 0; i < sizeof N / sizeof N[0]; i++) {
                if (!strcmp(N[i], src)) s_ = TT[i];
                if (!strcmp(N[i], dst)) d_ = TT[i];
            }
            if (s_ && d_) return d_;
        }
        to = strstr(to + 1, "_TO_");
    }
    return NULL;
}
typedef struct {
    const char *name;
    uint8_t fn;
    const char *params[3];
    uint8_t np;    /* 0xFF: variadic */
} bfn_t;
static const bfn_t BF[] = {
    {"ABS", F_ABS, {"IN"}, 1}, {"SQRT", F_SQRT, {"IN"}, 1}, {"LN", F_LN, {"IN"}, 1}, {"LOG", F_LOG, {"IN"}, 1},
    {"EXP", F_EXP, {"IN"}, 1}, {"SIN", F_SIN, {"IN"}, 1}, {"COS", F_COS, {"IN"}, 1}, {"TAN", F_TAN, {"IN"}, 1},
    {"ASIN", F_ASIN, {"IN"}, 1}, {"ACOS", F_ACOS, {"IN"}, 1}, {"ATAN", F_ATAN, {"IN"}, 1}, {"SQR", F_SQR, {"IN"}, 1},
    {"EXPT", F_SQR, {"IN1", "IN2"}, 2}, {"TRUNC", F_TRUNC, {"IN"}, 1}, {"ROUND", F_ROUND, {"IN"}, 1},
    {"CEIL", F_CEIL, {"IN"}, 1}, {"FLOOR", F_FLOOR, {"IN"}, 1}, {"INT", F_TRUNC, {"IN"}, 1}, {"REAL", F_REAL, {"IN"}, 1},
    {"MIN", F_MIN, {NULL}, 0xFF}, {"MAX", F_MAX, {NULL}, 0xFF}, {"LIMIT", F_LIMIT, {"MN", "IN", "MX"}, 3},
    {"SEL", F_SEL, {"G", "IN0", "IN1"}, 3}, {"SHL", F_SHL, {"IN", "N"}, 2}, {"SHR", F_SHR, {"IN", "N"}, 2},
    {"ROL", F_ROL, {"IN", "N"}, 2}, {"ROR", F_ROR, {"IN", "N"}, 2}, {"NORM_X", F_NORM_X, {"MIN", "VALUE", "MAX"}, 3},
    {"SCALE_X", F_SCALE_X, {"MIN", "VALUE", "MAX"}, 3},
};
static const bfn_t *bfn(const char *up)
{
    for (size_t i = 0; i < sizeof BF / sizeof BF[0]; i++)
        if (!strcmp(BF[i].name, up)) return &BF[i];
    return NULL;
}
static bool is_special(const char *up)
{
    return !strcmp(up, "COUNTOFELEMENTS") || !strcmp(up, "MAX_LEN") || !strcmp(up, "LEN") || !strcmp(up, "RD_SYS_T") ||
           !strcmp(up, "RD_LOC_T");
}
/* positional or named arguments of a function -> one IR per parameter slot */
static sx_t **arg_list(cx_t *cx, an_t *n, const bfn_t *B, const char *fname, uint16_t *count)
{
    uint16_t np = B && B->np != 0xFF ? B->np : n->nlist;
    sx_t **out = (sx_t **)aa(cx, sizeof(sx_t *) * (np + 1u));
    for (uint16_t i = 0; i < n->nlist; i++) {
        an_t *ar = n->list[i];
        if (ar->out) CERR(ar, "%s: output \"%s\" is not a parameter of this function", fname, ar->s);
        int slot = i;
        if (ar->s) {
            if (!B || B->np == 0xFF) CERR(ar, "%s takes positional arguments", fname);
            slot = -1;
            for (int k = 0; k < B->np; k++)
                if (plc_ieq(B->params[k], ar->s)) slot = k;
            if (slot < 0) CERR(ar, "%s has no parameter %s", fname, ar->s);
        } else if (B && B->np != 0xFF && i >= B->np) CERR(ar, "Too many arguments for %s", fname);
        out[slot] = expr_c(cx, ar->a);
    }
    if (B && B->np != 0xFF)
        for (uint16_t i = 0; i < np; i++)
            if (!out[i]) CERR(n, "%s: missing parameter %s", fname, B->params[i]);
    *count = np;
    return out;
}
static pl_t *arg_place(cx_t *cx, an_t *ar, const char *what)
{
    an_t *e = ar->a;
    if (e->n == AN_NUM || e->n == AN_STR || e->n == AN_BOOL || e->n == AN_BIN || e->n == AN_UN || e->n == AN_CALL)
        CERR(ar, "%s needs a variable", what);
    return place_of(cx, e);
}
static sx_t *builtin_c(cx_t *cx, an_t *n, const bfn_t *B, const char *up)
{
    uint16_t na;
    sx_t **a = arg_list(cx, n, B, up, &na);
    sx_t *x;
    if (!strcmp(up, "EXPT")) {
        x = X(cx, X_AR, &TY_LREAL);
        x->o = O_POW, x->mode = M_FLT, x->a = val_arg(cx, a[0], n), x->b = val_arg(cx, a[1], n);
        return fold(cx, x);
    }
    for (uint16_t i = 0; i < na; i++) val_arg(cx, a[i], n);
    const ty_t *ty;
    switch (B->fn) {
    case F_ABS: ty = is_bool(a[0]->ty) ? &TY_NUM : a[0]->ty; break;
    case F_TRUNC: case F_ROUND: case F_CEIL: case F_FLOOR: ty = &TY_DINT; break;
    case F_REAL: ty = &TY_LREAL; break;
    case F_MIN: case F_MAX:
        if (na < 1) CERR(n, "%s needs arguments", up);
        ty = a[0]->ty;
        for (uint16_t i = 1; i < na; i++) ty = num_result(ty, a[i]->ty);
        if (na == 1 && is_bool(ty)) ty = &TY_NUM;
        break;
    case F_LIMIT: ty = num_result(num_result(a[0]->ty, a[1]->ty), a[2]->ty); break;
    case F_SEL: ty = num_result(a[1]->ty, a[2]->ty); break;
    case F_SHL: case F_SHR: case F_ROL: case F_ROR:
        if (!is_intlike(a[0]->ty)) CERR(n, "%s needs a bit string or integer", up);
        ty = a[0]->ty->any ? &TY_DWORD : a[0]->ty;
        break;
    case F_NORM_X: ty = &TY_REAL; break;
    case F_SCALE_X:
        ty = num_result(a[0]->ty, a[2]->ty);
        if (ty->any || is_num(ty)) ty = &TY_ANYREAL;
        break;
    default: ty = real_of(a[0]->ty);
    }
    x = X(cx, X_FN, ty);
    x->fn = B->fn;
    x->args = a;
    x->nargs = na;
    return x;
}
static sx_t *special_c(cx_t *cx, an_t *n, const char *up)
{
    char b1[96];
    if (!strcmp(up, "COUNTOFELEMENTS")) {
        if (n->nlist != 1 || n->list[0]->out) CERR(n, "CountOfElements takes one array");
        pl_t *pl = arg_place(cx, n->list[0], "CountOfElements");
        if (pl->variant) {
            sx_t *x = X(cx, X_CNT, &TY_UDINT);
            x->p = pl;
            return x;
        }
        return K(cx, pl->ty->k == TK_ARR ? pl->ty->count : 0, &TY_UDINT);
    }
    if (!strcmp(up, "MAX_LEN")) {
        if (n->nlist != 1 || n->list[0]->out) CERR(n, "MAX_LEN takes one String");
        pl_t *pl = arg_place(cx, n->list[0], "MAX_LEN");
        if (pl->ty->k != TK_STR) CERR(n, "MAX_LEN needs a String");
        return K(cx, pl->ty->len, &TY_DINT);
    }
    if (!strcmp(up, "LEN")) {
        if (n->nlist != 1 || n->list[0]->out) CERR(n, "LEN takes one String");
        sx_t *a = expr_c(cx, n->list[0]->a);
        if (a->ty->k != TK_STRV) CERR(n, "LEN needs a String");
        if (a->op == X_KS) return K(cx, a->sl, &TY_INT);
        sx_t *x = X(cx, X_FN, &TY_INT);
        x->fn = F_LEN;
        x->args = (sx_t **)aa(cx, sizeof(sx_t *));
        x->args[0] = a;
        x->nargs = 1;
        return x;
    }
    bool local = !strcmp(up, "RD_LOC_T");
    if (n->nlist != 1) CERR(n, "RD_%s_T needs OUT => a DTL", local ? "LOC" : "SYS");
    an_t *ar = n->list[0];
    if (ar->s && !plc_ieq(ar->s, "OUT")) CERR(ar, "Unknown parameter %s", ar->s);
    pl_t *pl = arg_place(cx, ar, "OUT");
    if (!ty_same(cx->p, pl->ty, ty_builtin_struct(cx->p, "DTL"))) CERR(ar, "OUT must be a DTL");
    (void)b1;
    sx_t *x = X(cx, X_RDT, &TY_INT);
    x->p = pl;
    x->flag = local;
    return x;
}
static bind_t bind_c(cx_t *cx, const fld_t *fp, uint16_t fi, an_t *ar)
{
    char b1[96], b2[96];
    bind_t b;
    memset(&b, 0, sizeof b);
    b.f = fp;
    b.fi = fi;
    const ty_t *ft = fp->ref ? fp->reft : fp->t;
    if (fp->ref) {
        pl_t *pl = arg_place(cx, ar, fp->name);
        if (ft->k != TK_VARIANT && !ty_same(cx->p, pl->ty, ft)) CERR(ar, "%s needs %s, not %s", fp->name, tn(ft, b1), tn(pl->ty, b2));
        if (pl->pk == PK_SLICE) CERR(ar, "%s: a slice cannot be passed by reference", fp->name);
        b.mode = BM_REF;
        b.p = pl;
        return b;
    }
    if (fp->sec == SEC_IN) {
        if (ft->k == TK_EL) {
            sx_t *x = expr_c(cx, ar->a);
            if (!is_value(x->ty) || x->ty->k == TK_STRV) CERR(ar, "%s needs %s, not %s", fp->name, tn(ft, b1), tn(x->ty, b2));
            b.mode = BM_IN;
            b.e = x;
            return b;
        }
        if (ft->k == TK_STR) {
            sx_t *x = expr_c(cx, ar->a);
            if (x->ty->k != TK_STRV) CERR(ar, "%s needs a String", fp->name);
            b.mode = BM_INS;
            b.e = x;
            return b;
        }
        pl_t *pl = arg_place(cx, ar, fp->name);
        if (!ty_same(cx->p, pl->ty, ft)) CERR(ar, "%s needs %s, not %s", fp->name, tn(ft, b1), tn(pl->ty, b2));
        b.mode = BM_INCOPY;
        b.p = pl;
        return b;
    }
    pl_t *pl = arg_place(cx, ar, fp->name);
    if (pl->is_const) CERR(ar, "%s: cannot write to a constant", fp->name);
    if (ft->k == TK_EL) {
        if (pl->ty->k != TK_EL) CERR(ar, "%s needs %s, not %s", fp->name, tn(ft, b1), tn(pl->ty, b2));
        b.mode = fp->sec == SEC_OUT ? BM_OUT : BM_INOUT;
        b.p = pl;
        return b;
    }
    if (!ty_same(cx->p, pl->ty, ft)) CERR(ar, "%s needs %s, not %s", fp->name, tn(ft, b1), tn(pl->ty, b2));
    b.mode = fp->sec == SEC_OUT ? BM_OUTCOPY : BM_INOUTCOPY;
    b.p = pl;
    return b;
}
/* the unit an SCL call runs: an FC frame, an FB multi-instance or instance DB */
static unit_t *callee_unit(cx_t *cx, blk_t *b, const char *inst, uint8_t *view)
{
    return plc_unit_for(cx->p, b, inst, view, cx->u);
}
static void canon_path(an_t *n, char *out, size_t cap, size_t *o)
{
    if (n->n == AN_MEM) {
        canon_path(n->a, out, cap, o);
        if (*o < cap) *o += (size_t)snprintf(out + *o, cap - *o, ".%s", n->s);
    } else if (n->n == AN_IDX) {
        canon_path(n->a, out, cap, o);
        for (uint16_t i = 0; i < n->nlist && *o < cap; i++) {
            char nb[32];
            snprintf(nb, sizeof nb, "%s%g", i ? "," : "[", n->list[i]->v);
            *o += (size_t)snprintf(out + *o, cap - *o, "%s", nb);
        }
        if (*o < cap) *o += (size_t)snprintf(out + *o, cap - *o, "]");
    } else if (*o < cap) *o += (size_t)snprintf(out + *o, cap - *o, "%s", n->s ? n->s : "");
}
static uint8_t *const_ptr(const pl_t *pl)
{
    uint8_t *ptr = pl->ptr;
    for (uint16_t i = 0; i < pl->nst; i++) ptr += pl->st[i].off;
    return ptr;
}
static scall_t *call_c(cx_t *cx, an_t *n, bool as_expr, sx_t **special)
{
    plc_t *p = cx->p;
    char b1[96];
    an_t *f = n->a;
    scall_t *c = (scall_t *)aa(cx, sizeof(scall_t));
    c->ty = &TY_VOID;
    const ty_t *it = NULL;       /* the callee's instance / frame type */
    const fld_t *lf = (f->n == AN_NAME && !f->local && !f->quoted) ? local_field(cx, f->s) : NULL;
    if (f->n == AN_NAME && !f->local && !(lf && lf->t->k == TK_FB)) {
        char up[64];
        size_t k = 0;
        for (; f->s[k] && k + 1 < sizeof up; k++) up[k] = upc(f->s[k]);
        up[k] = 0;
        blk_t *bn = plc_find_block_name(p, f->s);
        const bfn_t *B = bfn(up);
        if (f->quoted || (bn && !B && !conv_dst(up) && !is_special(up))) {
            if (!bn) CERR(f, "Unknown block \"%s\"", f->s);
            if (bn->type == BT_FC) {
                char inst[256];
                snprintf(inst, sizeof inst, "%s/%u", cx->u->inst, (unsigned)cx->ncalls);
                c->cu = callee_unit(cx, bn, inst, NULL);
                c->is_fc = 1;
            } else if (bn->type == BT_DB && jd_get(p->doc, bn->json, "instanceOf") >= 0) {
                char idb[160];
                int iv = jd_get(p->doc, bn->json, "instanceOf");
                jd_str(p->doc, iv, idb, sizeof idb);
                blk_t *fb = plc_find_block_id(p, idb);
                if (!fb || fb->type != BT_FB) CERR(f, "\"%s\" is an instance DB of a missing FB", f->s);
                if (!plc_block_type(p, bn)) CERR(f, "Data block \"%s\": %s", bn->name, bn->ty_err ? bn->ty_err : "?");
                c->cu = callee_unit(cx, fb, bn->name, plc_db_mem(p, bn)->buf);
            } else if (bn->type == BT_FB) {
                CERR(f, "FB \"%s\" must be called through an instance (#inst(...) or \"InstanceDB\"(...))", f->s);
            } else CERR(f, "\"%s\" cannot be called", f->s);
            if (!c->cu) CERR(f, "\"%s\": %s", f->s, bn->ty_err ? bn->ty_err : "interface error");
            it = c->cu->mem.t;
        } else if (is_special(up)) {
            *special = special_c(cx, n, up);
            return NULL;
        } else if (B) {
            *special = builtin_c(cx, n, B, up);
            return NULL;
        } else {
            const ty_t *dst = conv_dst(up);
            if (dst) {
                static const bfn_t CB = {"", 0, {"IN"}, 1};
                uint16_t na;
                sx_t **a = arg_list(cx, n, &CB, up, &na);
                val_arg(cx, a[0], n);
                sx_t *x = X(cx, X_CONV, dst);
                x->a = a[0];
                x->flag = is_bool(a[0]->ty);
                *special = fold(cx, x);
                return NULL;
            }
            CERR(f, "Unknown function %s", f->s);
        }
    } else {
        an_t *target = f;
        const char *method = NULL;
        if (f->n == AN_MEM) {
            pl_t *head = place_of(cx, f->a);
            if (head->ty->k == TK_FB && head->ty->sys && head->ty->sys->kind == SK_IEC_TIMER &&
                (plc_ieq(f->s, "TON") || plc_ieq(f->s, "TOF") || plc_ieq(f->s, "TP"))) {
                method = f->s;
                target = f->a;
            }
        }
        pl_t *ip = place_of(cx, target);
        if (ip->ty->k != TK_FB) CERR(f, "Not a function block instance: %s", tn(ip->ty, b1));
        if (ip->pk != PK_LOC || ip->base == B_REF) CERR(f, "This FB instance cannot be called");
        if (ip->ty->sys) {
            c->sys = method ? plc_sysfb_type(p, method) : ip->ty;
            c->inst = ip;
            it = c->sys;
            c->srefs = (vref_t *)aa(cx, sizeof(vref_t) * (it->nf + 1u));
        } else {
            if (ip->dyn) CERR(f, "Arrays of FB instances need a constant index");
            char inst[256];
            size_t o = (size_t)snprintf(inst, sizeof inst, "%s.", cx->u->inst);
            canon_path(target, inst, sizeof inst, &o);
            c->cu = callee_unit(cx, ip->ty->blk, inst, const_ptr(ip));
            if (!c->cu) CERR(f, "This FB instance cannot be called");
            it = c->cu->mem.t;
        }
    }
    cx->ncalls++;
    if (!it) CERR(f, "This block has interface errors");
    bind_t *bs = (bind_t *)aa(cx, sizeof(bind_t) * (n->nlist + 1u));
    uint16_t nb = 0, pos = 0;
    uint8_t *used = (uint8_t *)sa(cx, it->nf + 1u);
    for (uint16_t i = 0; i < n->nlist; i++) {
        an_t *ar = n->list[i];
        if (ar->s && plc_ieq(ar->s, "EN") && !ar->out) {
            c->en = expr_c(cx, ar->a);
            continue;
        }
        if (ar->s && plc_ieq(ar->s, "ENO") && ar->out) {
            c->eno = arg_place(cx, ar, "ENO");
            if (!is_bool(c->eno->ty)) CERR(ar, "ENO needs a Bool");
            continue;
        }
        int fi = -1;
        if (!ar->s) {
            if (c->is_fc) {
                uint16_t k = 0;
                for (uint16_t j = 0; j < it->nf; j++) {
                    uint8_t sc = it->f[j].sec;
                    if (sc != SEC_IN && sc != SEC_OUT && sc != SEC_INOUT) continue;
                    if (k++ == pos) {
                        fi = j;
                        break;
                    }
                }
                pos++;
            }
            if (fi < 0) CERR(ar, "Parameters must be named (NAME := value)");
        } else {
            for (uint16_t j = 0; j < it->nf; j++) {
                uint8_t sc = it->f[j].sec;
                if ((sc == SEC_IN || sc == SEC_OUT || sc == SEC_INOUT) && plc_ieq(it->f[j].name, ar->s)) {
                    fi = j;
                    break;
                }
            }
            if (fi < 0) {
                if (c->cu) CERR(ar, "\"%s\" has no parameter %s", c->cu->blk->name, ar->s);
                CERR(ar, "%s has no parameter %s", c->sys->name, ar->s);
            }
        }
        const fld_t *fp = &it->f[fi];
        if (used[fi]) CERR(ar, "Parameter %s given twice", fp->name);
        used[fi] = 1;
        if (fp->sec == SEC_OUT && !ar->out && ar->s) CERR(ar, "Output %s is assigned with =>", fp->name);
        if (fp->sec != SEC_OUT && ar->out) CERR(ar, "%s is an input: use :=", fp->name);
        bs[nb++] = bind_c(cx, fp, (uint16_t)fi, ar);
    }
    c->b = bs;
    c->nb = nb;
    if (c->is_fc) {
        const fld_t *rv = ty_field(it, "RET_VAL");
        if (rv && rv->sec != SEC_RET) rv = NULL;
        if (rv) {
            if (rv->t->k != TK_EL && rv->t->k != TK_STR) CERR(n, "FC return types must be elementary or String");
            c->ret = rv;
            c->ty = rv->t->k == TK_EL ? rv->t : &TY_STRV;
            c->ret_str = rv->t->k == TK_STR;
        }
    }
    if (as_expr && c->ty->k == TK_VOID) {
        if (c->cu) CERR(n, "\"%s\" returns no value", c->cu->blk->name);
        CERR(n, "This call returns no value");
    }
    return c;
}

/* ---- statements ---- */
static ss_t *list_c(cx_t *cx, an_t **v, uint16_t n);
static sx_t *cond_c(cx_t *cx, an_t *n)
{
    sx_t *x = expr_c(cx, n);
    if (!is_value(x->ty) || x->ty->k == TK_STRV) CERR(n, "Condition must be Bool");
    return x;
}
static sx_t *num_e(cx_t *cx, an_t *n)
{
    sx_t *x = expr_c(cx, n);
    if (!is_value(x->ty) || x->ty->k == TK_STRV) CERR(n, "Expected a number");
    return x;
}
static double case_lab(cx_t *cx, double v, const char *c, an_t *n)
{
    if (!c) return v;
    const fld_t *f = local_field(cx, c);
    if (!f || f->sec != SEC_CONST || f->t->k != TK_EL) CERR(n, "CASE label #%s is not a constant", c);
    double x;
    return (f->def && ty_literal(f->def, &x, NULL, 0) == 1) ? x : 0;
}
static ss_t *stmt_c(cx_t *cx, an_t *s)
{
    char b1[96], b2[96];
    ss_t *r = (ss_t *)aa(cx, sizeof(ss_t));
    switch (s->n) {
    case AN_ASSIGN: {
        pl_t *lhs = place_of(cx, s->a);
        if (lhs->is_const) CERR(s, "Cannot assign to the constant %s", lhs->field ? lhs->field->name : "");
        if (strcmp(s->op, ":=")) {
            if (lhs->ty->k != TK_EL) CERR(s, "%s needs a number", s->op);
            char op[2] = {s->op[0], 0};
            r->s = S_SET;
            r->p = lhs;
            r->e = bin_c(cx, s, s->a, s->b, op);
            return r;
        }
        if (lhs->ty->k == TK_EL) {
            sx_t *e = expr_c(cx, s->b);
            if (!is_value(e->ty) || e->ty->k == TK_STRV) CERR(s, "Cannot assign %s to %s", tn(e->ty, b1), tn(lhs->ty, b2));
            r->s = S_SET, r->p = lhs, r->e = e;
            return r;
        }
        if (lhs->ty->k == TK_STR) {
            sx_t *e = expr_c(cx, s->b);
            if (e->ty->k != TK_STRV) CERR(s, "Cannot assign %s to a String", tn(e->ty, b1));
            r->s = S_SETS, r->p = lhs, r->e = e;
            return r;
        }
        if (lhs->ty->k == TK_VARIANT) CERR(s, "Cannot assign to a Variant");
        an_t *rhs = s->b;
        if (rhs->n == AN_NUM || rhs->n == AN_BOOL || rhs->n == AN_STR || rhs->n == AN_BIN || rhs->n == AN_UN || rhs->n == AN_CALL)
            CERR(s, "Cannot assign a value to %s", tn(lhs->ty, b1));
        pl_t *src = place_of(cx, rhs);
        if (!ty_same(cx->p, src->ty, lhs->ty)) CERR(s, "Cannot assign %s to %s", tn(src->ty, b1), tn(lhs->ty, b2));
        r->s = S_COPY, r->p = lhs, r->src = src, r->size = lhs->ty->size;
        return r;
    }
    case AN_CALLST: {
        sx_t *sp = NULL;
        scall_t *c = call_c(cx, s->a, false, &sp);
        if (sp) {
            /* a function used as a statement (RD_SYS_T(OUT => ..)): evaluate, drop the value */
            r->s = S_SET;
            r->p = NULL;
            r->e = sp;
            return r;
        }
        r->s = S_CALL, r->call = c;
        return r;
    }
    case AN_IF: {
        r->s = S_IF;
        r->narms = s->nlist;
        r->arms = (sarm_t *)aa(cx, sizeof(sarm_t) * (s->nlist + 1u));
        for (uint16_t i = 0; i < s->nlist; i++) {
            r->arms[i].c = cond_c(cx, s->list[i]->a);
            r->arms[i].body = list_c(cx, s->list[i]->body, s->list[i]->nbody);
        }
        if (s->has_els) r->els = list_c(cx, s->els, s->nels);
        return r;
    }
    case AN_CASE: {
        sx_t *sel = expr_c(cx, s->a);
        if (!is_value(sel->ty) || sel->ty->k == TK_STRV) CERR(s, "CASE needs an integer");
        r->s = S_CASE, r->e = sel;
        r->narms = s->nlist;
        r->arms = (sarm_t *)aa(cx, sizeof(sarm_t) * (s->nlist + 1u));
        for (uint16_t i = 0; i < s->nlist; i++) {
            an_t *arm = s->list[i];
            sarm_t *a = &r->arms[i];
            a->nlab = arm->nlist;
            a->lo = (double *)aa(cx, sizeof(double) * (arm->nlist + 1u));
            a->hi = (double *)aa(cx, sizeof(double) * (arm->nlist + 1u));
            for (uint16_t j = 0; j < arm->nlist; j++) {
                an_t *lb = arm->list[j];
                a->lo[j] = case_lab(cx, lb->lo, lb->loc, lb);
                a->hi[j] = case_lab(cx, lb->hi, lb->hic, lb);
            }
            a->body = list_c(cx, arm->body, arm->nbody);
        }
        if (s->has_els) r->els = list_c(cx, s->els, s->nels);
        return r;
    }
    case AN_FOR: {
        pl_t *v = place_of(cx, s->a);
        if (!(is_intlike(v->ty) || is_num(v->ty))) CERR(s, "FOR needs an integer variable");
        r->s = S_FOR, r->p = v;
        r->from = num_e(cx, s->b);
        r->to = num_e(cx, s->c);
        r->by = s->d ? num_e(cx, s->d) : NULL;
        r->body = list_c(cx, s->body, s->nbody);
        return r;
    }
    case AN_WHILE:
        r->s = S_WHILE, r->e = cond_c(cx, s->a), r->body = list_c(cx, s->body, s->nbody);
        return r;
    case AN_REPEAT:
        r->s = S_REPEAT, r->e = cond_c(cx, s->a), r->body = list_c(cx, s->body, s->nbody);
        return r;
    case AN_REGION: r->s = S_BLOCK, r->body = list_c(cx, s->body, s->nbody); return r;
    case AN_EXIT: r->s = S_EXIT; return r;
    case AN_CONTINUE: r->s = S_CONT; return r;
    case AN_RETURN: r->s = S_RET; return r;
    }
    CERR(s, "Unexpected statement");
    return NULL;
}
static ss_t *list_c(cx_t *cx, an_t **v, uint16_t n)
{
    ss_t *head = NULL, **tail = &head;
    for (uint16_t i = 0; i < n; i++) {
        ss_t *s = stmt_c(cx, v[i]);
        *tail = s;
        tail = &s->next;
    }
    return head;
}

/* ============================================================= evaluator */
#define MAX_ITER PLC_SCL_MAX_ITER
enum { SIG_NONE = 0, SIG_EXIT, SIG_CONT, SIG_RET };

static double numx(double v) { return isfinite(v) ? v : 0.0; }
static bool tb(double v) { return numx(v) != 0; }

/* a location for a loc place: false when out of range / unbound */
static bool loc_of(plc_t *p, const pl_t *pl, uint8_t **ptr, uint8_t *bit)
{
    uint8_t *b;
    uint8_t bt = 0;
    if (pl->base == B_REF) {
        if (!pl->ref->ptr) return false;
        b = pl->ref->ptr;
        bt = pl->ref->bit;
    } else b = pl->ptr;
    for (uint16_t i = 0; i < pl->nst; i++) {
        const plst_t *s = &pl->st[i];
        if (s->k == 0) {
            b += s->off;
            bt = s->bit;
            continue;
        }
        const ty_t *t = s->arr;
        uint32_t lin = 0;
        for (uint8_t d = 0; d < t->ndim; d++) {
            double x = numx(ev(p, s->idx[d]));
            if (x != floor(x) || x < t->lo[d] || x > t->hi[d]) {
                plc_errorf(p, "array index %g out of range %ld..%ld", x, (long)t->lo[d], (long)t->hi[d]);
                return false;
            }
            lin = lin * (uint32_t)(t->hi[d] - t->lo[d] + 1) + (uint32_t)(x - t->lo[d]);
        }
        if (t->el->k == TK_EL && t->el->cls == TC_BOOL) b += lin >> 3, bt = (uint8_t)(lin & 7);
        else b += lin * t->stride, bt = 0;
    }
    *ptr = b;
    *bit = bt;
    return true;
}
static double unsigned_of(double v, int width)
{
    double x = floor(numx(v));
    double m = ldexp(1.0, width);
    return x - floor(x / m) * m;
}
static double coerce_read(pv_t v, const ty_t *t)
{
    if (t->cls == TC_NUM) return v.n;
    if (t->cls == TC_BOOL) return truthy(v) ? 1 : 0;
    if (t->cls == TC_REAL) return numv(v);
    return ty_conv(numv(v), t);
}
static double read_p(plc_t *p, const pl_t *pl)
{
    if (pl->pk == PK_CELL) return coerce_read(plc_rd(p, pl->cell), pl->ty);
    if (pl->pk == PK_LOC) {
        uint8_t *b, bit;
        if (!loc_of(p, pl, &b, &bit)) return 0;
        return ty_read(b, bit, pl->ty);
    }
    double u = unsigned_of(read_p(p, pl->sbase), pl->width);
    if (pl->per == 32) return u;
    double v = fmod(floor(u / ldexp(1.0, pl->sli * pl->per)), ldexp(1.0, pl->per));
    return v;
}
static void write_p(plc_t *p, const pl_t *pl, double v)
{
    if (pl->pk == PK_CELL) {
        if (pl->ty->cls == TC_NUM) {
            if (pl->cbit) plc_wr(p, pl->cell, pvb(tb(v)));
            else plc_wr(p, pl->cell, pvn(numx(v)));
        } else if (pl->cbit) plc_wr(p, pl->cell, pvb(tb(v)));
        else plc_wr(p, pl->cell, pvn(ty_conv(v, pl->ty)));
        return;
    }
    if (pl->pk == PK_LOC) {
        uint8_t *b, bit;
        if (loc_of(p, pl, &b, &bit)) ty_write(b, bit, pl->ty, ty_conv(v, pl->ty));
        return;
    }
    double u = unsigned_of(read_p(p, pl->sbase), pl->width);
    double scale = ldexp(1.0, pl->sli * pl->per), m = ldexp(1.0, pl->per);
    double old = fmod(floor(u / scale), m);
    double nv = pl->per == 1 ? (tb(v) ? 1 : 0) : unsigned_of(ty_conv(v, pl->ty), pl->per);
    write_p(p, pl->sbase, u + (nv - old) * scale);
}

static double wrap_to(double x, const ty_t *ty)
{
    if (ty->any || !ty->bits || ty->cls == TC_REAL || ty->cls == TC_NUM) return x;
    return ty_wrap(x, ty->bits, ty->sign);
}
static double int_op(uint8_t o, double a, double b)
{
    switch (o) {
    case O_ADD: return a + b;
    case O_SUB: return a - b;
    case O_MUL: return a * b;
    case O_DIV: return b == 0 ? 0 : trunc(a / b);
    case O_MOD: return b == 0 ? 0 : fmod(a, b);
    }
    return 0;
}
static double flt_op(uint8_t o, double a, double b)
{
    switch (o) {
    case O_ADD: return a + b;
    case O_SUB: return a - b;
    case O_MUL: return a * b;
    case O_DIV: return b == 0 ? 0 : a / b;
    case O_MOD: return b == 0 ? 0 : fmod(a, b);
    case O_POW: return pow(a, b);
    }
    return 0;
}
static uint32_t u32_of(double x) { return (uint32_t)ty_wrap(floor(numx(x)), 32, false); }

static size_t evs(plc_t *p, sx_t *x, char *out, size_t cap);
static double run_call(plc_t *p, scall_t *c);
static __attribute__((noinline)) double cmp_str(plc_t *p, sx_t *x)
{
    char a[256], b[256];
    size_t la = evs(p, x->a, a, sizeof a), lb = evs(p, x->b, b, sizeof b);
    size_t m = la < lb ? la : lb;
    int r = memcmp(a, b, m);
    if (!r) r = la < lb ? -1 : la > lb ? 1 : 0;
    switch (x->o) {
    case O_EQ: return r == 0;
    case O_NE: return r != 0;
    case O_LT: return r < 0;
    case O_GT: return r > 0;
    case O_LE: return r <= 0;
    case O_GE: return r >= 0;
    }
    return 0;
}
static __attribute__((noinline)) double str_len(plc_t *p, sx_t *x)
{
    char a[256];
    return (double)evs(p, x, a, sizeof a);
}
static double eval_fn(plc_t *p, sx_t *x);

static double ev(plc_t *p, sx_t *x)
{
    switch (x->op) {
    case X_K: return x->v;
    case X_RD: return read_p(p, x->p);
    case X_NOT: return !tb(ev(p, x->a));
    case X_BNOT: {
        double v = numx(ev(p, x->a));
        if (x->ty->any) return -v - 1;
        return ty_wrap(-v - 1, x->ty->bits, x->ty->sign);
    }
    case X_NEG: return wrap_to(-numx(ev(p, x->a)), x->ty);
    case X_AND: return tb(ev(p, x->a)) && tb(ev(p, x->b));
    case X_OR: return tb(ev(p, x->a)) || tb(ev(p, x->b));
    case X_XOR: return tb(ev(p, x->a)) != tb(ev(p, x->b));
    case X_BIT: {
        uint32_t a = u32_of(ev(p, x->a)), b = u32_of(ev(p, x->b));
        uint32_t r = x->o == O_BAND ? (a & b) : x->o == O_BOR ? (a | b) : (a ^ b);
        return x->ty->any ? (double)r : ty_wrap((double)r, x->ty->bits, x->ty->sign);
    }
    case X_CMP: {
        if (x->flag) return cmp_str(p, x);
        double a = numx(ev(p, x->a)), b = numx(ev(p, x->b));
        switch (x->o) {
        case O_EQ: return a == b;
        case O_NE: return a != b;
        case O_LT: return a < b;
        case O_GT: return a > b;
        case O_LE: return a <= b;
        case O_GE: return a >= b;
        }
        return 0;
    }
    case X_AR: {
        double a = numx(ev(p, x->a)), b = numx(ev(p, x->b));
        if (x->mode == M_INT) return wrap_to(int_op(x->o, a, b), x->ty);
        return flt_op(x->o, a, b);
    }
    case X_CONV: {
        double v = ev(p, x->a);
        const ty_t *t = x->ty;
        if (t->cls == TC_BOOL) return x->flag ? tb(v) : fmod(floor(numx(v)), 2.0) != 0;
        if (t->cls == TC_REAL) return numx(v);
        return ty_conv(v, t);
    }
    case X_FN: return eval_fn(p, x);
    case X_CNT: {
        const vref_t *r = x->p->ref;
        return (r->ptr || r->is_cell) && r->t && r->t->k == TK_ARR ? r->t->count : 0;
    }
    case X_RDT: {
        uint8_t *b, bit;
        if (loc_of(p, x->p, &b, &bit)) {
            double ms = p->env.wall_ms ? p->env.wall_ms(p->env.user, x->flag != 0) : p->now;
            ty_write_dtl(b, ms);
        }
        return 0;
    }
    case X_CALL: return run_call(p, x->call);
    }
    return 0;
}

static double eval_fn(plc_t *p, sx_t *x)
{
    double a0 = 0, a1 = 0, a2 = 0;
    if (x->fn == F_LEN) return str_len(p, x->args[0]);
    if (x->nargs > 0) a0 = ev(p, x->args[0]);
    if (x->nargs > 1) a1 = ev(p, x->args[1]);
    if (x->nargs > 2) a2 = ev(p, x->args[2]);
    double n0 = numx(a0);
    switch (x->fn) {
    case F_ABS: return wrap_to(fabs(n0), x->ty);
    case F_SQRT: return sqrt(n0);
    case F_SQR: return n0 * n0;
    case F_LN: return log(n0);
    case F_LOG: return log(n0) / 2.302585092994046; /* Math.LN10 */
    case F_EXP: return exp(n0);
    case F_SIN: return sin(n0);
    case F_COS: return cos(n0);
    case F_TAN: return tan(n0);
    case F_ASIN: return asin(n0);
    case F_ACOS: return acos(n0);
    case F_ATAN: return atan(n0);
    case F_TRUNC: return ty_wrap(trunc(n0), 32, true);
    case F_ROUND: return ty_wrap(ty_rhe(n0), 32, true);
    case F_CEIL: return ty_wrap(ceil(n0), 32, true);
    case F_FLOOR: return ty_wrap(floor(n0), 32, true);
    case F_REAL: return n0;
    case F_MIN:
    case F_MAX: {
        double r = n0;
        for (uint16_t i = 1; i < x->nargs; i++) {
            double v = numx(i == 1 ? a1 : i == 2 ? a2 : ev(p, x->args[i]));
            r = x->fn == F_MIN ? fmin(r, v) : fmax(r, v);
        }
        return r;
    }
    case F_LIMIT: return fmax(n0, fmin(numx(a1), numx(a2)));
    case F_SEL: return tb(a0) ? numx(a2) : numx(a1);
    case F_NORM_X: {
        double den = numx(a2) - n0;
        return den == 0 ? 0 : (numx(a1) - n0) / den;
    }
    case F_SCALE_X: return numx(a1) * (numx(a2) - n0) + n0;
    case F_SHL: case F_SHR: case F_ROL: case F_ROR: {
        const ty_t *t = x->ty;
        int w = t->bits;
        double u = unsigned_of(n0, w);
        double sh = floor(numx(a1));
        if (sh < 0) sh = 0;
        double m = ldexp(1.0, w), r;
        if (x->fn == F_SHL) r = sh >= w ? 0 : fmod(u * ldexp(1.0, (int)sh), m);
        else if (x->fn == F_SHR) {
            if (t->sign && u >= m / 2) {
                double sv = u - m;
                r = sh >= w ? (sv < 0 ? -1 : 0) : floor(sv / ldexp(1.0, (int)sh));
            } else r = sh >= w ? 0 : floor(u / ldexp(1.0, (int)sh));
        } else {
            int k = (int)fmod(sh, w);
            if (x->fn == F_ROL) r = fmod(u * ldexp(1.0, k), m) + floor(u / ldexp(1.0, w - k));
            else r = floor(u / ldexp(1.0, k)) + fmod(u * ldexp(1.0, w - k), m);
            if (k == 0) r = u;
        }
        return ty_wrap(r, w, t->sign);
    }
    }
    return 0;
}

/* string value of a String expression into out (Latin-1, may hold NUL) */
static size_t evs(plc_t *p, sx_t *x, char *out, size_t cap)
{
    switch (x->op) {
    case X_KS: {
        size_t n = x->sl < cap - 1 ? x->sl : cap - 1;
        memcpy(out, x->s, n);
        out[n] = 0;
        return n;
    }
    case X_RDS: {
        uint8_t *b, bit;
        if (!loc_of(p, x->p, &b, &bit)) return out[0] = 0, 0;
        size_t n = b[1] < x->p->ty->len ? b[1] : x->p->ty->len;
        if (n > cap - 1) n = cap - 1;
        memcpy(out, b + 2, n);
        out[n] = 0;
        return n;
    }
    case X_CALL: {
        run_call(p, x->call);
        scall_t *c = x->call;
        if (!c->ret || !c->cu) return out[0] = 0, 0;
        const uint8_t *b = c->cu->mem.m->buf + c->ret->off;
        size_t n = b[1] < c->ret->t->len ? b[1] : c->ret->t->len;
        if (n > cap - 1) n = cap - 1;
        memcpy(out, b + 2, n);
        out[n] = 0;
        return n;
    }
    }
    return out[0] = 0, 0;
}

static vref_t ref_of_place(plc_t *p, const pl_t *pl, const vref_t *fallback)
{
    vref_t r;
    memset(&r, 0, sizeof r);
    if (pl->variant) return pl->ref->ptr || pl->ref->is_cell ? *pl->ref : r;
    (void)fallback;
    if (pl->pk == PK_CELL) {
        r.is_cell = 1;
        r.cell = pl->cell;
        r.cbit = pl->cbit;
        r.t = pl->ty;
        return r;
    }
    uint8_t *b, bit;
    if (!loc_of(p, pl, &b, &bit)) return r;
    r.ptr = b;
    r.bit = bit;
    r.t = pl->ty;
    return r;
}

static __attribute__((noinline)) void bind_str(plc_t *p, sx_t *e, uint8_t *dst, const ty_t *t)
{
    char s[256];
    size_t n = evs(p, e, s, sizeof s);
    ty_str_write(dst, t, s, n);
}

static void run_unit_scl(plc_t *p, unit_t *u);
static double run_call(plc_t *p, scall_t *c)
{
    if (c->en && !tb(ev(p, c->en))) {
        if (c->eno) write_p(p, c->eno, 0);
        return 0;
    }
    uint8_t *base;
    vref_t *refs;
    if (c->sys) {
        uint8_t bit;
        if (!loc_of(p, c->inst, &base, &bit)) return 0;
        refs = c->srefs;
        memset(refs, 0, sizeof(vref_t) * c->sys->nf);
    } else {
        base = c->cu->mem.m->buf;
        refs = c->cu->mem.m->refs;
    }
    const ty_t *it = c->sys ? c->sys : c->cu->mem.t;
    for (uint16_t i = 0; i < c->nb; i++) {
        bind_t *b = &c->b[i];
        const fld_t *f = b->f;
        switch (b->mode) {
        case BM_IN: ty_write(base + f->off, f->bit, f->t, ty_conv(ev(p, b->e), f->t)); break;
        case BM_INOUT: ty_write(base + f->off, f->bit, f->t, ty_conv(read_p(p, b->p), f->t)); break;
        case BM_INS: bind_str(p, b->e, base + f->off, f->t); break;
        case BM_INCOPY:
        case BM_INOUTCOPY: {
            uint8_t *s, bit;
            if (loc_of(p, b->p, &s, &bit)) memmove(base + f->off, s, f->t->size);
            break;
        }
        case BM_REF: refs[b->fi] = ref_of_place(p, b->p, NULL); break;
        }
    }
    if (c->is_fc)
        for (uint16_t j = 0; j < it->nf; j++) {
            if (!it->f[j].ref) continue;
            bool given = false;
            for (uint16_t i = 0; i < c->nb; i++) given = given || c->b[i].fi == j;
            if (!given) memset(&refs[j], 0, sizeof(vref_t));
        }
    if (c->sys) plc_sysfb_exec(p, c->sys, base, refs);
    else run_unit_scl(p, c->cu);
    for (uint16_t i = 0; i < c->nb; i++) {
        bind_t *b = &c->b[i];
        const fld_t *f = b->f;
        switch (b->mode) {
        case BM_OUT:
        case BM_INOUT: write_p(p, b->p, ty_read(base + f->off, f->bit, f->t)); break;
        case BM_OUTCOPY:
        case BM_INOUTCOPY: {
            uint8_t *t, bit;
            if (loc_of(p, b->p, &t, &bit)) memmove(t, base + f->off, f->t->size);
            break;
        }
        }
    }
    if (c->eno) write_p(p, c->eno, 1);
    if (c->ret && !c->ret_str) return ty_read(base + c->ret->off, c->ret->bit, c->ret->t);
    return 0;
}

static int run_list(plc_t *p, ss_t *s);
static __attribute__((noinline)) void set_str(plc_t *p, ss_t *s)
{
    uint8_t *b, bit;
    if (!loc_of(p, s->p, &b, &bit)) return;
    char v[256];
    size_t n = evs(p, s->e, v, sizeof v);
    ty_str_write(b, s->p->ty, v, n);
}
static int run_s(plc_t *p, ss_t *s)
{
    switch (s->s) {
    case S_SET: {
        double v = ev(p, s->e);
        if (s->p) write_p(p, s->p, v);
        return 0;
    }
    case S_SETS: set_str(p, s); return 0;
    case S_COPY: {
        uint8_t *a, *b, ab, bb;
        if (loc_of(p, s->src, &a, &ab) && loc_of(p, s->p, &b, &bb)) memmove(b, a, s->size);
        return 0;
    }
    case S_CALL: run_call(p, s->call); return 0;
    case S_IF:
        for (uint16_t i = 0; i < s->narms; i++)
            if (tb(ev(p, s->arms[i].c))) return run_list(p, s->arms[i].body);
        return s->els ? run_list(p, s->els) : 0;
    case S_CASE: {
        double v = numx(ev(p, s->e));
        for (uint16_t i = 0; i < s->narms; i++) {
            sarm_t *a = &s->arms[i];
            for (uint16_t j = 0; j < a->nlab; j++)
                if (v >= a->lo[j] && v <= a->hi[j]) return run_list(p, a->body);
        }
        return s->els ? run_list(p, s->els) : 0;
    }
    case S_FOR: {
        double i = numx(ev(p, s->from));
        double to = numx(ev(p, s->to));
        double by = s->by ? numx(ev(p, s->by)) : 1;
        if (by == 0) return 0;
        long guard = 0;
        for (; by > 0 ? i <= to : i >= to; i += by) {
            if (++guard > MAX_ITER) {
                plc_errorf(p, "FOR loop stopped after %d iterations", MAX_ITER);
                break;
            }
            write_p(p, s->p, i);
            int sig = run_list(p, s->body);
            if (sig == SIG_EXIT) break;
            if (sig == SIG_RET) return SIG_RET;
        }
        return 0;
    }
    case S_WHILE: {
        long guard = 0;
        while (tb(ev(p, s->e))) {
            if (++guard > MAX_ITER) {
                plc_errorf(p, "WHILE loop stopped after %d iterations", MAX_ITER);
                break;
            }
            int sig = run_list(p, s->body);
            if (sig == SIG_EXIT) break;
            if (sig == SIG_RET) return SIG_RET;
        }
        return 0;
    }
    case S_REPEAT: {
        long guard = 0;
        do {
            if (++guard > MAX_ITER) {
                plc_errorf(p, "REPEAT loop stopped after %d iterations", MAX_ITER);
                break;
            }
            int sig = run_list(p, s->body);
            if (sig == SIG_EXIT) break;
            if (sig == SIG_RET) return SIG_RET;
        } while (!tb(ev(p, s->e)));
        return 0;
    }
    case S_BLOCK: return run_list(p, s->body);
    case S_EXIT: return SIG_EXIT;
    case S_CONT: return SIG_CONT;
    case S_RET: return SIG_RET;
    }
    return 0;
}
static int run_list(plc_t *p, ss_t *s)
{
    for (; s; s = s->next) {
        int sig = run_s(p, s);
        if (sig) return sig;
    }
    return 0;
}

/* =================================================================== API */
static void cx_free(cx_t *cx)
{
    pchunk_t *c = cx->scratch;
    while (c) {
        pchunk_t *n = c->next;
        free(c);
        c = n;
    }
    cx->scratch = NULL;
    free(cx->toks);
    cx->toks = NULL;
}

bool plc_scl_compile(plc_t *p, unit_t *u, const char *src, ss_t **out, char *err, size_t errlen)
{
    cx_t *cx = (cx_t *)calloc(1, sizeof(cx_t));
    if (!cx) {
        if (err && errlen) snprintf(err, errlen, "out of memory");
        return false;
    }
    cx->p = p;
    cx->u = u;
    cx->t = u->mem.t;
    cx->src = src;
    cx->err = err;
    cx->errlen = errlen;
    *out = NULL;
    if (u->blk->type == BT_FC && cx->t) {
        const fld_t *rv = ty_field(cx->t, "RET_VAL");
        if (rv && rv->sec == SEC_RET) snprintf(cx->fcret, sizeof cx->fcret, "%s", u->blk->name);
    }
    if (setjmp(cx->jb)) {
        cx_free(cx);
        free(cx);
        return false;
    }
    if (!cx->t) fail_at(cx, 0, "%s", u->blk->ty_err ? u->blk->ty_err : "interface error");
    tokenize(cx);
    an_t **body;
    uint16_t nbody;
    p_stmts(cx, stop_eof, &body, &nbody);
    if (peek(cx)->t != T_EOF) perr(cx, "Unexpected token");
    *out = list_c(cx, body, nbody);
    cx_free(cx);
    free(cx);
    return true;
}

static void called_walk(an_t *a, void (*cb)(void *ctx, const char *name), void *ctx, int depth)
{
    if (!a || depth > 200) return;
    if (a->n == AN_CALL && a->a && a->a->n == AN_NAME && !a->a->local) cb(ctx, a->a->s);
    an_t *kids[4] = {a->a, a->b, a->c, a->d};
    for (int i = 0; i < 4; i++) called_walk(kids[i], cb, ctx, depth + 1);
    for (uint16_t i = 0; i < a->nlist; i++) called_walk(a->list[i], cb, ctx, depth + 1);
    for (uint16_t i = 0; i < a->nbody; i++) called_walk(a->body[i], cb, ctx, depth + 1);
    for (uint16_t i = 0; i < a->nels; i++) called_walk(a->els[i], cb, ctx, depth + 1);
}

void plc_scl_called(const char *src, void (*cb)(void *ctx, const char *name), void *ctx)
{
    cx_t *cx = (cx_t *)calloc(1, sizeof(cx_t));
    if (!cx) return;
    cx->src = src;
    if (setjmp(cx->jb)) {
        cx_free(cx);
        free(cx);
        return;
    }
    tokenize(cx);
    an_t **body;
    uint16_t nbody;
    p_stmts(cx, stop_eof, &body, &nbody);
    if (peek(cx)->t == T_EOF)
        for (uint16_t i = 0; i < nbody; i++) called_walk(body[i], cb, ctx, 0);
    cx_free(cx);
    free(cx);
}

/* run one unit's code (an SCL call of an FB / FC): the engine's block runner */
void plc_run_unit(plc_t *p, unit_t *u);
static void run_unit_scl(plc_t *p, unit_t *u) { plc_run_unit(p, u); }

void plc_scl_run(plc_t *p, unit_t *u)
{
    if (u->scl) run_list(p, u->scl);
}
