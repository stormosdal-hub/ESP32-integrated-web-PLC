/* ============================================================================
 * plc_scl.c — Structured Control Language: tokenizer, recursive-descent parser
 * and evaluator. A port of web/js/scl.js (same grammar, precedence, built-in
 * functions, loop guard and error messages). Variables are resolved to memory
 * cells at compile time, per block instance, so the evaluator never looks up
 * names.
 *
 *   precedence (low -> high): OR, XOR, AND, comparison, + -, * / MOD, unary
 * ==========================================================================*/
#include <setjmp.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>

#include "plc_internal.h"

/* ------------------------------------------------------------- AST */
enum { SE_NUM, SE_BOOL, SE_VAR, SE_CALL, SE_NOT, SE_NEG, SE_BIN };
enum { SO_AND, SO_OR, SO_XOR, SO_ADD, SO_SUB, SO_MUL, SO_DIV, SO_MOD, SO_EQ, SO_NE, SO_LT, SO_GT, SO_LE, SO_GE };
enum { SF_ABS, SF_SQRT, SF_SQR, SF_MIN, SF_MAX, SF_LIMIT, SF_TRUNC, SF_ROUND, SF_INT, SF_REAL,
       SF_LN, SF_EXP, SF_SIN, SF_COS, SF_TAN, SF_UNKNOWN };

typedef struct sx {
    uint8_t n, op, fn, bit;
    uint16_t nargs;
    double v;
    cref_t var;
    struct sx *a, *b;
    struct sx **args;
} sx_t;

enum { SS_ASSIGN, SS_IF, SS_CASE, SS_FOR, SS_WHILE, SS_REPEAT, SS_EXIT, SS_CONTINUE, SS_RETURN };

typedef struct {
    double lo, hi;
} slab_t;

struct scl_stmt;
typedef struct {
    sx_t *cond;
    slab_t *labs;
    uint16_t nlabs;
    struct scl_stmt *body;
} sarm_t;

typedef struct scl_stmt {
    uint8_t n, bit;
    bool has_els;
    cref_t var;            /* assign target / FOR variable */
    sx_t *e1, *e2, *e3;    /* assign expr | FOR from,to,by | WHILE/REPEAT cond | CASE selector */
    struct scl_stmt *body; /* FOR / WHILE / REPEAT */
    sarm_t *arms;          /* IF / CASE */
    uint16_t narms;
    struct scl_stmt *els;  /* IF / CASE else branch */
    struct scl_stmt *next;
} ss_t;

/* ---------------------------------------------------------- tokens */
enum { T_NUM, T_KW, T_ID, T_OP, T_EOF };
enum {
    KW_IF, KW_THEN, KW_ELSIF, KW_ELSE, KW_END_IF, KW_CASE, KW_OF, KW_END_CASE, KW_FOR, KW_TO, KW_BY, KW_DO,
    KW_END_FOR, KW_WHILE, KW_END_WHILE, KW_REPEAT, KW_UNTIL, KW_END_REPEAT, KW_EXIT, KW_CONTINUE, KW_RETURN,
    KW_AND, KW_OR, KW_XOR, KW_NOT, KW_MOD, KW_TRUE, KW_FALSE, KW__N
};
static const char *const KWS[KW__N] = {
    "IF", "THEN", "ELSIF", "ELSE", "END_IF", "CASE", "OF", "END_CASE", "FOR", "TO", "BY", "DO",
    "END_FOR", "WHILE", "END_WHILE", "REPEAT", "UNTIL", "END_REPEAT", "EXIT", "CONTINUE", "RETURN",
    "AND", "OR", "XOR", "NOT", "MOD", "TRUE", "FALSE"};

typedef struct {
    uint8_t t;
    uint8_t kw;      /* T_KW */
    char op[3];      /* T_OP */
    double v;        /* T_NUM */
    const char *s;   /* T_ID / T_NUM: start in source (for messages) */
    uint32_t slen;
    int line, col;
} tok_t;

/* ---------------------------------------------------------- parser state */
typedef struct pchunk {
    struct pchunk *next;
    size_t used;
} pchunk_t;
#define PCHUNK 4096

typedef struct {
    plc_t *p;              /* NULL = syntax check only */
    const members_t *mem;
    const char *src;
    tok_t *toks;
    size_t ntok, ctok, pos;
    pchunk_t *scratch;     /* check-mode node storage */
    char *err;
    size_t errlen;
    int edepth, sdepth;    /* expression / statement nesting */
    char name[192];        /* last parsed (dotted) name — consumed before recursing */
    jmp_buf jb;
} ps_t;

/* Recursive descent costs stack per level; these limits keep a hostile or
 * runaway program well inside the 16 KB task stacks on the ESP32 while being
 * far beyond what real SCL code nests. */
#define MAX_EXPR_DEPTH 32 /* counts parse_expr + unary entries: ~16 nested parentheses */
#define MAX_STMT_DEPTH 24

static void fail_at(ps_t *ps, int line, int col, const char *fmt, ...)
{
    char msg[120];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(msg, sizeof msg, fmt, ap);
    va_end(ap);
    (void)col;
    if (ps->err && ps->errlen) snprintf(ps->err, ps->errlen, "line %d: %s", line, msg);
    longjmp(ps->jb, 1);
}

static void *pa(ps_t *ps, size_t n)
{
    n = (n + 7) & ~(size_t)7;
    if (ps->p) return plc_ar_alloc(ps->p, n);
    pchunk_t *c = ps->scratch;
    size_t hdr = (sizeof(pchunk_t) + 7) & ~(size_t)7;
    size_t cap = n > PCHUNK ? n : PCHUNK;
    if (!c || c->used + n > PCHUNK || n > PCHUNK) {
        c = (pchunk_t *)malloc(hdr + cap);
        if (!c) fail_at(ps, 0, 0, "out of memory");
        c->next = ps->scratch;
        c->used = 0;
        ps->scratch = c;
    }
    void *r = (uint8_t *)c + hdr + c->used;
    c->used += n;
    memset(r, 0, n);
    return r;
}

/* ---------------------------------------------------------- tokenizer */
static bool is_alpha_(char c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_'; }
static bool is_dig(char c) { return c >= '0' && c <= '9'; }
static char upc(char c) { return (c >= 'a' && c <= 'z') ? (char)(c - 32) : c; }

static tok_t *push_tok(ps_t *ps)
{
    if (ps->ntok + 1 > ps->ctok) {
        size_t nc = ps->ctok ? ps->ctok * 2 : 64;
        tok_t *nt = (tok_t *)realloc(ps->toks, nc * sizeof(tok_t));
        if (!nt) fail_at(ps, 0, 0, "out of memory");
        ps->toks = nt;
        ps->ctok = nc;
    }
    tok_t *t = &ps->toks[ps->ntok++];
    memset(t, 0, sizeof *t);
    return t;
}

static void tokenize(ps_t *ps)
{
    const char *s = ps->src;
    size_t i = 0, n = strlen(s);
    int line = 1, col = 1;
#define ADV(k)                         \
    do {                               \
        for (int _j = 0; _j < (k); _j++) { \
            if (s[i] == '\n') line++, col = 1; \
            else col++;                \
            i++;                       \
        }                              \
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
        if (c == '(' && s[i + 1] == '*') {
            ADV(2);
            while (i < n && !(s[i] == '*' && s[i + 1] == ')')) ADV(1);
            if (i >= n) fail_at(ps, line, col, "Unterminated (* comment *)");
            ADV(2);
            continue;
        }
        int sl = line, sc = col;
        if (is_dig(c)) {
            size_t st = i;
            while (i < n && is_dig(s[i])) ADV(1);
            if (s[i] == '.' && is_dig(s[i + 1])) {
                ADV(1);
                while (i < n && is_dig(s[i])) ADV(1);
            }
            tok_t *t = push_tok(ps);
            t->t = T_NUM;
            t->v = strtod(s + st, NULL);
            t->s = s + st;
            t->slen = (uint32_t)(i - st);
            t->line = sl;
            t->col = sc;
            continue;
        }
        if (is_alpha_(c)) {
            size_t st = i;
            while (i < n && (is_alpha_(s[i]) || is_dig(s[i]))) ADV(1);
            size_t len = i - st;
            if (s[i] == '#') { /* typed literal PREFIX#rest (T#5s, INT#3 ...) */
                ADV(1);
                size_t rs = i;
                while (i < n && (is_alpha_(s[i]) || is_dig(s[i]) || s[i] == '.')) ADV(1);
                char pre[8] = {0};
                for (size_t k = 0; k < len && k < 7; k++) pre[k] = upc(s[st + k]);
                char rest[64];
                size_t rl = i - rs;
                if (rl > 60) rl = 60;
                double val;
                if (len <= 6 && (!strcmp(pre, "T") || !strcmp(pre, "TIME") || !strcmp(pre, "S5T") || !strcmp(pre, "S5TIME"))) {
                    rest[0] = 'T';
                    rest[1] = '#';
                    memcpy(rest + 2, s + rs, rl);
                    rest[2 + rl] = 0;
                    val = plc_parse_time_ms(rest);
                } else {
                    memcpy(rest, s + rs, rl);
                    rest[rl] = 0;
                    char *end = NULL;
                    val = strtod(rest, &end);
                    if (end == rest || isnan(val)) val = 0; /* parseFloat(rest) || 0 */
                }
                tok_t *t = push_tok(ps);
                t->t = T_NUM;
                t->v = val;
                t->s = s + st;
                t->slen = (uint32_t)(i - st);
                t->line = sl;
                t->col = sc;
                continue;
            }
            tok_t *t = push_tok(ps);
            t->line = sl;
            t->col = sc;
            t->s = s + st;
            t->slen = (uint32_t)len;
            t->t = T_ID;
            for (int k = 0; k < KW__N; k++) {
                size_t kl = strlen(KWS[k]);
                if (kl != len) continue;
                size_t m = 0;
                while (m < len && upc(s[st + m]) == KWS[k][m]) m++;
                if (m == len) {
                    t->t = T_KW;
                    t->kw = (uint8_t)k;
                    break;
                }
            }
            continue;
        }
        const char *two[] = {":=", "<=", ">=", "<>", ".."};
        bool done = false;
        for (int k = 0; k < 5; k++)
            if (c == two[k][0] && s[i + 1] == two[k][1]) {
                tok_t *t = push_tok(ps);
                t->t = T_OP;
                t->op[0] = two[k][0];
                t->op[1] = two[k][1];
                t->line = sl;
                t->col = sc;
                ADV(2);
                done = true;
                break;
            }
        if (done) continue;
        if (strchr("+-*/()<>=;:,.", c)) {
            tok_t *t = push_tok(ps);
            t->t = T_OP;
            t->op[0] = c;
            t->line = sl;
            t->col = sc;
            ADV(1);
            continue;
        }
        if ((unsigned char)c >= 0x80) fail_at(ps, line, col, "Unexpected character (non-ASCII)");
        fail_at(ps, line, col, "Unexpected character \"%c\"", c);
    }
    tok_t *t = push_tok(ps);
    t->t = T_EOF;
    t->line = line;
    t->col = col;
#undef ADV
}

/* ---------------------------------------------------------- helpers */
static tok_t *peek(ps_t *ps) { return &ps->toks[ps->pos]; }
static tok_t *nxt(ps_t *ps)
{
    tok_t *t = &ps->toks[ps->pos];
    if (t->t != T_EOF) ps->pos++;
    return t;
}

static void tok_text(const tok_t *t, char *out, size_t cap)
{
    switch (t->t) {
    case T_EOF: snprintf(out, cap, "<eof>"); break;
    case T_KW: snprintf(out, cap, "%s", KWS[t->kw]); break;
    case T_OP: snprintf(out, cap, "%s", t->op); break;
    default: {
        size_t l = t->slen < cap - 1 ? t->slen : cap - 1;
        memcpy(out, t->s, l);
        out[l] = 0;
    }
    }
}

static void perr(ps_t *ps, const char *msg)
{
    tok_t *t = peek(ps);
    char tx[48];
    tok_text(t, tx, sizeof tx);
    fail_at(ps, t->line, t->col, "%s near \"%s\"", msg, tx);
}

static bool is_op(ps_t *ps, const char *v) { tok_t *t = peek(ps); return t->t == T_OP && !strcmp(t->op, v); }
static bool is_kw(ps_t *ps, int k) { tok_t *t = peek(ps); return t->t == T_KW && t->kw == k; }
static bool accept_op(ps_t *ps, const char *v)
{
    if (is_op(ps, v)) {
        nxt(ps);
        return true;
    }
    return false;
}
static void eat_op(ps_t *ps, const char *v)
{
    if (!is_op(ps, v)) {
        char m[32];
        snprintf(m, sizeof m, "Expected \"%s\"", v);
        perr(ps, m);
    }
    nxt(ps);
}
static void eat_kw(ps_t *ps, int k)
{
    if (!is_kw(ps, k)) {
        char m[32];
        snprintf(m, sizeof m, "Expected %s", KWS[k]);
        perr(ps, m);
    }
    nxt(ps);
}

static void enter_expr(ps_t *ps)
{
    if (++ps->edepth > MAX_EXPR_DEPTH) perr(ps, "Expression nested too deeply");
}

static void enter_stmt(ps_t *ps)
{
    if (++ps->sdepth > MAX_STMT_DEPTH) perr(ps, "Statements nested too deeply");
}

/* resolve a (dotted) name; check mode creates nothing */
static ref_t resolve_name(ps_t *ps, const char *name)
{
    ref_t r;
    memset(&r, 0, sizeof r);
    if (!ps->p) return r;
    return plc_resolve(ps->p, ps->mem, name);
}

/* lvalue := ident ('.' ident)* */
static void parse_lvalue(ps_t *ps, char *out, size_t cap)
{
    tok_t *t = nxt(ps);
    size_t l = t->slen < cap - 1 ? t->slen : cap - 1;
    memcpy(out, t->s, l);
    out[l] = 0;
    while (is_op(ps, ".")) {
        nxt(ps);
        if (peek(ps)->t != T_ID) perr(ps, "Expected member name");
        tok_t *m = nxt(ps);
        size_t cur = strlen(out);
        if (cur + 1 + m->slen < cap) {
            out[cur] = '.';
            memcpy(out + cur + 1, m->s, m->slen);
            out[cur + 1 + m->slen] = 0;
        }
    }
}

/* ---------------------------------------------------------- expressions */
static sx_t *parse_expr(ps_t *ps);

static uint8_t fn_of(const char *name)
{
    static const char *const F[] = {"ABS", "SQRT", "SQR", "MIN", "MAX", "LIMIT", "TRUNC", "ROUND",
                                    "INT", "REAL", "LN", "EXP", "SIN", "COS", "TAN"};
    char up[16];
    size_t i = 0;
    for (; name[i] && i < sizeof up - 1; i++) up[i] = upc(name[i]);
    up[i] = 0;
    if (name[i]) return SF_UNKNOWN;
    for (int k = 0; k < (int)(sizeof F / sizeof F[0]); k++)
        if (!strcmp(up, F[k])) return (uint8_t)k;
    return SF_UNKNOWN;
}

static sx_t *parse_primary(ps_t *ps)
{
    tok_t *t = peek(ps);
    if (t->t == T_NUM) {
        nxt(ps);
        sx_t *x = (sx_t *)pa(ps, sizeof(sx_t));
        x->n = SE_NUM;
        x->v = t->v;
        return x;
    }
    if (t->t == T_KW && (t->kw == KW_TRUE || t->kw == KW_FALSE)) {
        nxt(ps);
        sx_t *x = (sx_t *)pa(ps, sizeof(sx_t));
        x->n = SE_BOOL;
        x->v = t->kw == KW_TRUE;
        return x;
    }
    if (is_op(ps, "(")) {
        nxt(ps);
        sx_t *e = parse_expr(ps);
        eat_op(ps, ")");
        return e;
    }
    if (t->t == T_ID) {
        parse_lvalue(ps, ps->name, sizeof ps->name);
        sx_t *x = (sx_t *)pa(ps, sizeof(sx_t));
        if (is_op(ps, "(")) {
            /* consume the shared name buffer before recursing into arguments */
            x->n = SE_CALL;
            x->fn = fn_of(ps->name);
            nxt(ps);
            size_t cap = 0;
            if (!is_op(ps, ")")) {
                do {
                    sx_t *a = parse_expr(ps);
                    if (x->nargs >= cap) {
                        size_t nc = cap ? cap * 2 : 4;
                        sx_t **na = (sx_t **)pa(ps, sizeof(sx_t *) * nc);
                        if (cap) memcpy(na, x->args, sizeof(sx_t *) * cap);
                        x->args = na;
                        cap = nc;
                    }
                    if (x->nargs < 0xFFFF) x->args[x->nargs++] = a;
                } while (accept_op(ps, ","));
            }
            eat_op(ps, ")");
            return x;
        }
        x->n = SE_VAR;
        ref_t r = resolve_name(ps, ps->name);
        x->var = r.c;
        x->bit = r.bit;
        return x;
    }
    perr(ps, "Unexpected token in expression");
    return NULL;
}

static sx_t *bin(ps_t *ps, uint8_t op, sx_t *a, sx_t *b)
{
    sx_t *x = (sx_t *)pa(ps, sizeof(sx_t));
    x->n = SE_BIN;
    x->op = op;
    x->a = a;
    x->b = b;
    return x;
}

static sx_t *parse_unary(ps_t *ps)
{
    enter_expr(ps);
    sx_t *r;
    if (is_kw(ps, KW_NOT)) {
        nxt(ps);
        r = (sx_t *)pa(ps, sizeof(sx_t));
        r->n = SE_NOT;
        r->a = parse_unary(ps);
    } else if (is_op(ps, "-")) {
        nxt(ps);
        r = (sx_t *)pa(ps, sizeof(sx_t));
        r->n = SE_NEG;
        r->a = parse_unary(ps);
    } else if (is_op(ps, "+")) {
        nxt(ps);
        r = parse_unary(ps);
    } else {
        r = parse_primary(ps);
    }
    ps->edepth--;
    return r;
}

static sx_t *parse_mul(ps_t *ps)
{
    sx_t *a = parse_unary(ps);
    for (;;) {
        uint8_t op;
        if (is_op(ps, "*")) op = SO_MUL;
        else if (is_op(ps, "/")) op = SO_DIV;
        else if (is_kw(ps, KW_MOD)) op = SO_MOD;
        else break;
        nxt(ps);
        a = bin(ps, op, a, parse_unary(ps));
    }
    return a;
}

static sx_t *parse_add(ps_t *ps)
{
    sx_t *a = parse_mul(ps);
    for (;;) {
        uint8_t op;
        if (is_op(ps, "+")) op = SO_ADD;
        else if (is_op(ps, "-")) op = SO_SUB;
        else break;
        nxt(ps);
        a = bin(ps, op, a, parse_mul(ps));
    }
    return a;
}

static sx_t *parse_cmp(ps_t *ps)
{
    sx_t *a = parse_add(ps);
    for (;;) {
        uint8_t op;
        if (is_op(ps, "=")) op = SO_EQ;
        else if (is_op(ps, "<>")) op = SO_NE;
        else if (is_op(ps, "<")) op = SO_LT;
        else if (is_op(ps, ">")) op = SO_GT;
        else if (is_op(ps, "<=")) op = SO_LE;
        else if (is_op(ps, ">=")) op = SO_GE;
        else break;
        nxt(ps);
        a = bin(ps, op, a, parse_add(ps));
    }
    return a;
}

static sx_t *parse_and(ps_t *ps)
{
    sx_t *a = parse_cmp(ps);
    while (is_kw(ps, KW_AND)) {
        nxt(ps);
        a = bin(ps, SO_AND, a, parse_cmp(ps));
    }
    return a;
}

static sx_t *parse_xor(ps_t *ps)
{
    sx_t *a = parse_and(ps);
    while (is_kw(ps, KW_XOR)) {
        nxt(ps);
        a = bin(ps, SO_XOR, a, parse_and(ps));
    }
    return a;
}

static sx_t *parse_expr(ps_t *ps)
{
    enter_expr(ps);
    sx_t *a = parse_xor(ps);
    while (is_kw(ps, KW_OR)) {
        nxt(ps);
        a = bin(ps, SO_OR, a, parse_xor(ps));
    }
    ps->edepth--;
    return a;
}

/* ---------------------------------------------------------- statements */
enum { ST_EOF, ST_IF_ARM, ST_END_IF, ST_CASE_ARM, ST_END_CASE, ST_END_FOR, ST_END_WHILE, ST_UNTIL };

/* lookahead: does a CASE label list (`1, 3..5:`) start here? */
static bool is_case_boundary(ps_t *ps)
{
    if (is_kw(ps, KW_END_CASE) || is_kw(ps, KW_ELSE)) return true;
    tok_t *t = peek(ps);
    if (t->t != T_NUM && !(t->t == T_OP && !strcmp(t->op, "-"))) return false;
    size_t q = ps->pos;
    const tok_t *T = ps->toks;
#define ISOP(i, s) (T[i].t == T_OP && !strcmp(T[i].op, s))
    for (;;) {
        if (ISOP(q, "-")) q++;
        if (T[q].t != T_NUM) return false;
        q++;
        if (ISOP(q, "..")) {
            q++;
            if (ISOP(q, "-")) q++;
            if (T[q].t != T_NUM) return false;
            q++;
        }
        if (ISOP(q, ",")) {
            q++;
            continue;
        }
        break;
    }
    return ISOP(q, ":");
#undef ISOP
}

static bool stop_at(ps_t *ps, int st)
{
    switch (st) {
    case ST_EOF: return peek(ps)->t == T_EOF;
    case ST_IF_ARM: return is_kw(ps, KW_ELSIF) || is_kw(ps, KW_ELSE) || is_kw(ps, KW_END_IF);
    case ST_END_IF: return is_kw(ps, KW_END_IF);
    case ST_CASE_ARM: return is_case_boundary(ps);
    case ST_END_CASE: return is_kw(ps, KW_END_CASE);
    case ST_END_FOR: return is_kw(ps, KW_END_FOR);
    case ST_END_WHILE: return is_kw(ps, KW_END_WHILE);
    case ST_UNTIL: return is_kw(ps, KW_UNTIL);
    }
    return true;
}

static ss_t *parse_stmt(ps_t *ps);

static ss_t *parse_stmts(ps_t *ps, int st)
{
    ss_t *head = NULL, **tail = &head;
    while (!stop_at(ps, st)) {
        if (peek(ps)->t == T_EOF) break;
        if (accept_op(ps, ";")) continue;
        ss_t *s = parse_stmt(ps);
        *tail = s;
        tail = &s->next;
    }
    return head;
}

static double parse_signed_num(ps_t *ps)
{
    double sign = 1;
    if (is_op(ps, "-")) {
        nxt(ps);
        sign = -1;
    }
    if (peek(ps)->t != T_NUM) perr(ps, "Expected number in CASE label");
    return sign * nxt(ps)->v;
}

static ss_t *new_stmt(ps_t *ps, uint8_t n)
{
    ss_t *s = (ss_t *)pa(ps, sizeof(ss_t));
    s->n = n;
    return s;
}

/* append to an arena-grown array (old copies are left in the arena) */
static void *grow(ps_t *ps, void *arr, size_t *cap, size_t n, size_t elsz)
{
    if (n < *cap) return arr;
    size_t nc = *cap ? *cap * 2 : 4;
    void *na = pa(ps, nc * elsz);
    if (*cap) memcpy(na, arr, *cap * elsz);
    *cap = nc;
    return na;
}

static ss_t *parse_if(ps_t *ps)
{
    eat_kw(ps, KW_IF);
    ss_t *s = new_stmt(ps, SS_IF);
    size_t cap = 0;
    for (;;) {
        sx_t *cond = parse_expr(ps);
        eat_kw(ps, KW_THEN);
        ss_t *body = parse_stmts(ps, ST_IF_ARM);
        s->arms = (sarm_t *)grow(ps, s->arms, &cap, s->narms, sizeof(sarm_t));
        sarm_t *a = &s->arms[s->narms++];
        a->cond = cond;
        a->body = body;
        if (!is_kw(ps, KW_ELSIF)) break;
        nxt(ps);
        if (s->narms >= 0xFFFF) perr(ps, "Too many ELSIF branches");
    }
    if (is_kw(ps, KW_ELSE)) {
        nxt(ps);
        s->has_els = true;
        s->els = parse_stmts(ps, ST_END_IF);
    }
    eat_kw(ps, KW_END_IF);
    accept_op(ps, ";");
    return s;
}

static ss_t *parse_case(ps_t *ps)
{
    eat_kw(ps, KW_CASE);
    ss_t *s = new_stmt(ps, SS_CASE);
    s->e1 = parse_expr(ps);
    eat_kw(ps, KW_OF);
    size_t cap = 0;
    while (!is_kw(ps, KW_END_CASE) && !is_kw(ps, KW_ELSE)) {
        s->arms = (sarm_t *)grow(ps, s->arms, &cap, s->narms, sizeof(sarm_t));
        sarm_t *a = &s->arms[s->narms];
        size_t lcap = 0;
        do {
            double lo = parse_signed_num(ps), hi = lo;
            if (is_op(ps, "..")) {
                nxt(ps);
                hi = parse_signed_num(ps);
            }
            a->labs = (slab_t *)grow(ps, a->labs, &lcap, a->nlabs, sizeof(slab_t));
            a->labs[a->nlabs].lo = lo;
            a->labs[a->nlabs].hi = hi;
            if (a->nlabs < 0xFFFF) a->nlabs++;
        } while (accept_op(ps, ","));
        eat_op(ps, ":");
        a->body = parse_stmts(ps, ST_CASE_ARM);
        if (s->narms < 0xFFFF) s->narms++;
    }
    if (is_kw(ps, KW_ELSE)) {
        nxt(ps);
        s->has_els = true;
        s->els = parse_stmts(ps, ST_END_CASE);
    }
    eat_kw(ps, KW_END_CASE);
    accept_op(ps, ";");
    return s;
}

static ss_t *parse_stmt(ps_t *ps)
{
    enter_stmt(ps);
    tok_t *t = peek(ps);
    ss_t *s = NULL;
    if (t->t == T_KW) {
        switch (t->kw) {
        case KW_IF: s = parse_if(ps); break;
        case KW_CASE: s = parse_case(ps); break;
        case KW_FOR: {
            eat_kw(ps, KW_FOR);
            if (peek(ps)->t != T_ID) perr(ps, "Expected loop variable");
            parse_lvalue(ps, ps->name, sizeof ps->name);
            s = new_stmt(ps, SS_FOR);
            ref_t r = resolve_name(ps, ps->name);
            s->var = r.c;
            s->bit = r.bit;
            eat_op(ps, ":=");
            s->e1 = parse_expr(ps);
            eat_kw(ps, KW_TO);
            s->e2 = parse_expr(ps);
            if (is_kw(ps, KW_BY)) {
                nxt(ps);
                s->e3 = parse_expr(ps);
            }
            eat_kw(ps, KW_DO);
            s->body = parse_stmts(ps, ST_END_FOR);
            eat_kw(ps, KW_END_FOR);
            accept_op(ps, ";");
            break;
        }
        case KW_WHILE:
            eat_kw(ps, KW_WHILE);
            s = new_stmt(ps, SS_WHILE);
            s->e1 = parse_expr(ps);
            eat_kw(ps, KW_DO);
            s->body = parse_stmts(ps, ST_END_WHILE);
            eat_kw(ps, KW_END_WHILE);
            accept_op(ps, ";");
            break;
        case KW_REPEAT:
            eat_kw(ps, KW_REPEAT);
            s = new_stmt(ps, SS_REPEAT);
            s->body = parse_stmts(ps, ST_UNTIL);
            eat_kw(ps, KW_UNTIL);
            s->e1 = parse_expr(ps);
            eat_kw(ps, KW_END_REPEAT);
            accept_op(ps, ";");
            break;
        case KW_EXIT: nxt(ps); accept_op(ps, ";"); s = new_stmt(ps, SS_EXIT); break;
        case KW_CONTINUE: nxt(ps); accept_op(ps, ";"); s = new_stmt(ps, SS_CONTINUE); break;
        case KW_RETURN: nxt(ps); accept_op(ps, ";"); s = new_stmt(ps, SS_RETURN); break;
        default: break;
        }
    } else if (t->t == T_ID) {
        parse_lvalue(ps, ps->name, sizeof ps->name);
        eat_op(ps, ":=");
        s = new_stmt(ps, SS_ASSIGN);
        ref_t r = resolve_name(ps, ps->name);
        s->var = r.c;
        s->bit = r.bit;
        s->e1 = parse_expr(ps);
        accept_op(ps, ";");
    }
    if (!s) perr(ps, "Unexpected statement");
    ps->sdepth--;
    return s;
}

static void free_scratch(ps_t *ps)
{
    pchunk_t *c = ps->scratch;
    while (c) {
        pchunk_t *n = c->next;
        free(c);
        c = n;
    }
    ps->scratch = NULL;
    free(ps->toks);
    ps->toks = NULL;
}

bool plc_scl_compile(plc_t *p, const members_t *mem, const char *src, struct scl_stmt **out,
                     char *err, size_t errlen, const char *blkname)
{
    (void)blkname;
    ps_t ps;
    memset(&ps, 0, sizeof ps);
    ps.p = p;
    ps.mem = mem;
    ps.src = src ? src : "";
    ps.err = err;
    ps.errlen = errlen;
    if (err && errlen) err[0] = 0;
    *out = NULL;
    if (setjmp(ps.jb)) {
        free_scratch(&ps);
        return false;
    }
    tokenize(&ps);
    ss_t *body = parse_stmts(&ps, ST_EOF);
    if (peek(&ps)->t != T_EOF) perr(&ps, "Unexpected token");
    *out = p ? body : NULL;
    free_scratch(&ps);
    return true;
}

/* ======================================================================== *
 *  Evaluator                                                                 *
 * ======================================================================== */
enum { SIG_NONE = 0, SIG_EXIT, SIG_CONT, SIG_RET };

static inline double to_num(pv_t v) { return numv(v); }                 /* scl.js toNum */
static inline bool to_bool(pv_t v) { return v.t == PV_BOOL ? v.n != 0 : to_num(v) != 0; }

static pv_t ev(plc_t *p, const sx_t *x);

static pv_t call_fn(plc_t *p, const sx_t *x)
{
    double a[3] = {0, 0, 0};
    for (int i = 0; i < x->nargs && i < 3; i++) a[i] = to_num(ev(p, x->args[i]));
    switch (x->fn) {
    case SF_ABS: return pvn(fabs(a[0]));
    case SF_SQRT: return pvn(sqrt(a[0]));
    case SF_SQR: return pvn(a[0] * a[0]);
    case SF_MIN:
    case SF_MAX: {
        double r = x->fn == SF_MIN ? INFINITY : -INFINITY;
        for (int i = 0; i < x->nargs; i++) {
            double v = i < 3 ? a[i] : to_num(ev(p, x->args[i]));
            if (x->fn == SF_MIN ? v < r : v > r) r = v;
        }
        return pvn(r);
    }
    case SF_LIMIT: return pvn(fmax(a[0], fmin(a[1], a[2])));
    case SF_TRUNC:
    case SF_INT: return pvn(trunc(a[0]));
    case SF_ROUND: return pvn(floor(a[0] + 0.5));
    case SF_REAL: return pvn(a[0]);
    case SF_LN: return pvn(log(a[0]));
    case SF_EXP: return pvn(exp(a[0]));
    case SF_SIN: return pvn(sin(a[0]));
    case SF_COS: return pvn(cos(a[0]));
    case SF_TAN: return pvn(tan(a[0]));
    default:
        for (int i = 3; i < x->nargs; i++) (void)ev(p, x->args[i]);
        return pvn(0); /* unknown call -> 0 (lenient, like scl.js) */
    }
}

static pv_t ev(plc_t *p, const sx_t *x)
{
    switch (x->n) {
    case SE_NUM: return pvn(x->v);
    case SE_BOOL: return pvb(x->v != 0);
    case SE_VAR: {
        pv_t v = plc_rd(p, x->var);
        return x->bit ? pvb(truthy(v)) : pvn(v.n);
    }
    case SE_CALL: return call_fn(p, x);
    case SE_NOT: return pvb(!to_bool(ev(p, x->a)));
    case SE_NEG: return pvn(-to_num(ev(p, x->a)));
    case SE_BIN: {
        if (x->op == SO_AND) return pvb(to_bool(ev(p, x->a)) && to_bool(ev(p, x->b)));
        if (x->op == SO_OR) return pvb(to_bool(ev(p, x->a)) || to_bool(ev(p, x->b)));
        if (x->op == SO_XOR) {
            bool a = to_bool(ev(p, x->a));
            bool b = to_bool(ev(p, x->b));
            return pvb(a != b);
        }
        double a = to_num(ev(p, x->a));
        double b = to_num(ev(p, x->b));
        switch (x->op) {
        case SO_ADD: return pvn(a + b);
        case SO_SUB: return pvn(a - b);
        case SO_MUL: return pvn(a * b);
        case SO_DIV: return pvn(b == 0 ? 0 : a / b);
        case SO_MOD: return pvn(b == 0 ? 0 : fmod(a, b));
        case SO_EQ: return pvb(a == b);
        case SO_NE: return pvb(a != b);
        case SO_LT: return pvb(a < b);
        case SO_GT: return pvb(a > b);
        case SO_LE: return pvb(a <= b);
        case SO_GE: return pvb(a >= b);
        }
        return pvn(0);
    }
    }
    return pvn(0);
}

static void write_var(plc_t *p, cref_t c, bool bit, pv_t v)
{
    if (bit) plc_wr(p, c, pvb(to_bool(v)));
    else plc_wr(p, c, pvn(to_num(v)));
}

typedef struct {
    plc_t *p;
    const char *blk;
} rctx_t;

static int run_list(rctx_t *r, const ss_t *s);

static void guard_hit(rctx_t *r)
{
    plc_errorf(r->p, "%s (SCL): loop stopped after %d iterations", r->blk && *r->blk ? r->blk : "?", PLC_SCL_MAX_ITER);
}

static int run_one(rctx_t *r, const ss_t *s)
{
    plc_t *p = r->p;
    switch (s->n) {
    case SS_ASSIGN: write_var(p, s->var, s->bit, ev(p, s->e1)); return SIG_NONE;
    case SS_IF:
        for (uint16_t i = 0; i < s->narms; i++)
            if (to_bool(ev(p, s->arms[i].cond))) return run_list(r, s->arms[i].body);
        if (s->has_els) return run_list(r, s->els);
        return SIG_NONE;
    case SS_CASE: {
        double v = to_num(ev(p, s->e1));
        for (uint16_t i = 0; i < s->narms; i++) {
            const sarm_t *a = &s->arms[i];
            for (uint16_t j = 0; j < a->nlabs; j++)
                if (v >= a->labs[j].lo && v <= a->labs[j].hi) return run_list(r, a->body);
        }
        if (s->has_els) return run_list(r, s->els);
        return SIG_NONE;
    }
    case SS_FOR: {
        double i = to_num(ev(p, s->e1));
        double to = to_num(ev(p, s->e2));
        double by = s->e3 ? to_num(ev(p, s->e3)) : 1;
        long guard = 0;
        if (by == 0) return SIG_NONE;
        for (; by > 0 ? i <= to : i >= to; i += by) {
            if (++guard > PLC_SCL_MAX_ITER) {
                guard_hit(r);
                break;
            }
            write_var(p, s->var, s->bit, pvn(i));
            int sig = run_list(r, s->body);
            if (sig == SIG_EXIT) break;
            if (sig == SIG_RET) return SIG_RET;
        }
        return SIG_NONE;
    }
    case SS_WHILE: {
        long guard = 0;
        while (to_bool(ev(p, s->e1))) {
            if (++guard > PLC_SCL_MAX_ITER) {
                guard_hit(r);
                break;
            }
            int sig = run_list(r, s->body);
            if (sig == SIG_EXIT) break;
            if (sig == SIG_RET) return SIG_RET;
        }
        return SIG_NONE;
    }
    case SS_REPEAT: {
        long guard = 0;
        do {
            if (++guard > PLC_SCL_MAX_ITER) {
                guard_hit(r);
                break;
            }
            int sig = run_list(r, s->body);
            if (sig == SIG_EXIT) break;
            if (sig == SIG_RET) return SIG_RET;
        } while (!to_bool(ev(p, s->e1)));
        return SIG_NONE;
    }
    case SS_EXIT: return SIG_EXIT;
    case SS_CONTINUE: return SIG_CONT;
    case SS_RETURN: return SIG_RET;
    }
    return SIG_NONE;
}

static int run_list(rctx_t *r, const ss_t *s)
{
    for (; s; s = s->next) {
        int sig = run_one(r, s);
        if (sig) return sig;
    }
    return SIG_NONE;
}

void plc_scl_run(plc_t *p, struct scl_stmt *prog, const char *blkname)
{
    rctx_t r = {p, blkname};
    (void)run_list(&r, prog);
}
