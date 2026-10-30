/* jdom.c — see jdom.h. Two passes over the text: the first counts nodes, the
 * second fills an exactly-sized array, so peak memory is one allocation. */
#include "jdom.h"

#include <stdlib.h>
#include <string.h>

#define JD_MAX_DEPTH 64

typedef struct {
    uint32_t last; /* last linked child (key for objects), UINT32_MAX = none */
    uint8_t obj;
} jd_frame_t;

static bool is_ws(char c) { return c == ' ' || c == '\t' || c == '\n' || c == '\r'; }

static void set_next(jd_node_t *n, uint32_t next) { n->meta = (n->meta & ~JD_MAX_NODES) | (next & JD_MAX_NODES); }

/* One pass. nodes == NULL -> count only. Returns false on error. */
static bool jd_pass(jd_doc_t *d, jd_node_t *nodes, uint32_t *out_count)
{
    const char *s = d->text;
    const size_t n = d->len;
    size_t i = 0;
    uint32_t cnt = 0;
    jd_frame_t st[JD_MAX_DEPTH];
    int sp = -1;
    enum { S_VALUE, S_VALUE_OR_END, S_KEY_OR_END, S_KEY, S_AFTER } state = S_VALUE;

#define FAIL(msg)          \
    do {                   \
        d->err = (msg);    \
        d->err_pos = i;    \
        return false;      \
    } while (0)
#define NEWNODE(t, o, esc)                                                         \
    do {                                                                           \
        if (cnt >= JD_MAX_NODES) FAIL("JSON too large");                           \
        if (nodes) {                                                               \
            nodes[cnt].off = (uint32_t)(o);                                        \
            nodes[cnt].meta = ((uint32_t)(t) << 28) | ((uint32_t)((esc) ? 1 : 0) << 31); \
        }                                                                          \
    } while (0)
#define LINK()                                                                \
    do {                                                                      \
        if (nodes && st[sp].last != UINT32_MAX) set_next(&nodes[st[sp].last], cnt); \
        st[sp].last = cnt;                                                    \
    } while (0)

    for (;;) {
        while (i < n && is_ws(s[i])) i++;
        if (state == S_AFTER) {
            if (sp < 0) {
                if (i != n) FAIL("trailing characters after JSON value");
                break;
            }
            if (i >= n) FAIL("unexpected end of JSON");
            char c = s[i];
            if (c == ',') {
                i++;
                state = st[sp].obj ? S_KEY : S_VALUE;
                continue;
            }
            if ((c == ']' && !st[sp].obj) || (c == '}' && st[sp].obj)) {
                i++;
                sp--;
                continue;
            }
            FAIL("expected ',' or closing bracket");
        }
        if (i >= n) FAIL("unexpected end of JSON");
        if ((state == S_VALUE_OR_END && s[i] == ']') || (state == S_KEY_OR_END && s[i] == '}')) {
            i++;
            sp--;
            state = S_AFTER;
            continue;
        }
        bool key = (state == S_KEY || state == S_KEY_OR_END);
        if (key) {
            if (s[i] != '"') FAIL("expected object key");
            LINK(); /* the key joins the object's sibling chain */
        } else if (sp >= 0 && !st[sp].obj) {
            LINK(); /* array element joins the array's sibling chain */
        }

        char c = s[i];
        if (c == '"') {
            size_t start = ++i;
            bool esc = false;
            while (i < n && s[i] != '"') {
                if (s[i] == '\\') {
                    esc = true;
                    i += 2;
                    continue;
                }
                i++;
            }
            if (i >= n) FAIL("unterminated string");
            NEWNODE(JD_STR, start, esc);
            cnt++;
            i++; /* closing quote */
            if (key) {
                while (i < n && is_ws(s[i])) i++;
                if (i >= n || s[i] != ':') FAIL("expected ':' after key");
                i++;
                state = S_VALUE;
            } else {
                state = S_AFTER;
            }
            continue;
        }
        if (c == '{' || c == '[') {
            if (sp + 1 >= JD_MAX_DEPTH) FAIL("JSON nested too deeply");
            NEWNODE(c == '{' ? JD_OBJ : JD_ARR, i, false);
            sp++;
            st[sp].last = UINT32_MAX;
            st[sp].obj = (c == '{');
            cnt++;
            i++;
            state = (c == '{') ? S_KEY_OR_END : S_VALUE_OR_END;
            continue;
        }
        if (c == '-' || (c >= '0' && c <= '9')) {
            size_t start = i;
            bool digit = false;
            while (i < n) {
                char ch = s[i];
                if (ch >= '0' && ch <= '9') digit = true;
                else if (!(ch == '-' || ch == '+' || ch == '.' || ch == 'e' || ch == 'E')) break;
                i++;
            }
            if (!digit) FAIL("malformed number");
            NEWNODE(JD_NUM, start, false);
            cnt++;
            state = S_AFTER;
            continue;
        }
        if (c == 't' && i + 4 <= n && memcmp(s + i, "true", 4) == 0) {
            NEWNODE(JD_TRUE, i, false);
            cnt++;
            i += 4;
            state = S_AFTER;
            continue;
        }
        if (c == 'f' && i + 5 <= n && memcmp(s + i, "false", 5) == 0) {
            NEWNODE(JD_FALSE, i, false);
            cnt++;
            i += 5;
            state = S_AFTER;
            continue;
        }
        if (c == 'n' && i + 4 <= n && memcmp(s + i, "null", 4) == 0) {
            NEWNODE(JD_NULL, i, false);
            cnt++;
            i += 4;
            state = S_AFTER;
            continue;
        }
        FAIL("unexpected character in JSON");
    }
#undef FAIL
#undef NEWNODE
#undef LINK
    *out_count = cnt;
    return true;
}

bool jd_parse(jd_doc_t *d, const char *text, size_t len, jd_alloc_fn alloc)
{
    d->text = text;
    d->len = len;
    d->nodes = NULL;
    d->count = 0;
    d->err = NULL;
    d->err_pos = 0;
    /* tolerate a UTF-8 BOM */
    if (len >= 3 && (uint8_t)text[0] == 0xEF && (uint8_t)text[1] == 0xBB && (uint8_t)text[2] == 0xBF) {
        d->text = text + 3;
        d->len = len - 3;
    }
    uint32_t cnt = 0;
    if (!jd_pass(d, NULL, &cnt)) return false;
    if (cnt == 0) {
        d->err = "empty JSON";
        return false;
    }
    d->nodes = (jd_node_t *)(alloc ? alloc : malloc)(sizeof(jd_node_t) * cnt);
    if (!d->nodes) {
        d->err = "out of memory";
        return false;
    }
    uint32_t cnt2 = 0;
    if (!jd_pass(d, d->nodes, &cnt2) || cnt2 != cnt) {
        if (!d->err) d->err = "internal JSON parser error";
        return false;
    }
    d->count = cnt;
    return true;
}

void jd_release(jd_doc_t *d, jd_free_fn fr)
{
    if (d->nodes) (fr ? fr : free)(d->nodes);
    d->nodes = NULL;
    d->count = 0;
}

int jd_first(const jd_doc_t *d, int c)
{
    if (c < 0 || (uint32_t)c >= d->count) return -1;
    int t = JD_NODE_TYPE(d->nodes[c]);
    if (t != JD_ARR && t != JD_OBJ) return -1;
    /* empty container: the bracket is followed (after spaces) by its closer */
    const char *p = d->text + d->nodes[c].off + 1, *end = d->text + d->len;
    while (p < end && is_ws(*p)) p++;
    if (p >= end || *p == ']' || *p == '}') return -1;
    return c + 1;
}

int jd_next(const jd_doc_t *d, int i)
{
    if (i < 0) return -1;
    uint32_t nx = JD_NODE_NEXT(d->nodes[i]);
    return nx ? (int)nx : -1;
}

uint32_t jd_count(const jd_doc_t *d, int c)
{
    uint32_t n = 0;
    for (int k = jd_first(d, c); k >= 0; k = jd_next(d, k)) n++;
    return n;
}

/* raw byte length of a STR (between the quotes) or NUM node */
static uint32_t raw_len(const jd_doc_t *d, int i)
{
    const jd_node_t *nd = &d->nodes[i];
    const char *p = d->text + nd->off, *end = d->text + d->len;
    const char *q = p;
    if (JD_NODE_TYPE(*nd) == JD_STR) {
        while (q < end && *q != '"') q += (*q == '\\') ? 2 : 1;
    } else {
        while (q < end && ((*q >= '0' && *q <= '9') || *q == '-' || *q == '+' || *q == '.' || *q == 'e' || *q == 'E')) q++;
    }
    if (q > end) q = end;
    return (uint32_t)(q - p);
}

static int hexv(char c)
{
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static uint32_t rd_hex4(const char *p, size_t avail, bool *ok)
{
    uint32_t v = 0;
    *ok = false;
    if (avail < 4) return 0;
    for (int k = 0; k < 4; k++) {
        int h = hexv(p[k]);
        if (h < 0) return 0;
        v = (v << 4) | (uint32_t)h;
    }
    *ok = true;
    return v;
}

static size_t put_byte(char *out, size_t cap, size_t pos, char b)
{
    if (out && pos + 1 < cap) out[pos] = b;
    return pos + 1;
}

static size_t put_utf8(char *out, size_t cap, size_t pos, uint32_t cp)
{
    if (cp < 0x80) return put_byte(out, cap, pos, (char)cp);
    if (cp < 0x800) {
        pos = put_byte(out, cap, pos, (char)(0xC0 | (cp >> 6)));
        return put_byte(out, cap, pos, (char)(0x80 | (cp & 0x3F)));
    }
    if (cp < 0x10000) {
        pos = put_byte(out, cap, pos, (char)(0xE0 | (cp >> 12)));
        pos = put_byte(out, cap, pos, (char)(0x80 | ((cp >> 6) & 0x3F)));
        return put_byte(out, cap, pos, (char)(0x80 | (cp & 0x3F)));
    }
    pos = put_byte(out, cap, pos, (char)(0xF0 | (cp >> 18)));
    pos = put_byte(out, cap, pos, (char)(0x80 | ((cp >> 12) & 0x3F)));
    pos = put_byte(out, cap, pos, (char)(0x80 | ((cp >> 6) & 0x3F)));
    return put_byte(out, cap, pos, (char)(0x80 | (cp & 0x3F)));
}

size_t jd_str(const jd_doc_t *d, int i, char *out, size_t cap)
{
    size_t pos = 0;
    if (out && cap) out[0] = 0;
    if (i < 0 || (uint32_t)i >= d->count) return 0;
    const jd_node_t *nd = &d->nodes[i];
    const char *p = d->text + nd->off;
    int type = JD_NODE_TYPE(*nd);
    if (type == JD_NUM) {
        uint32_t len = raw_len(d, i);
        for (uint32_t k = 0; k < len; k++) pos = put_byte(out, cap, pos, p[k]);
    } else if (type == JD_TRUE || type == JD_FALSE) {
        const char *lit = type == JD_TRUE ? "true" : "false";
        while (*lit) pos = put_byte(out, cap, pos, *lit++);
    } else if (type == JD_STR) {
        uint32_t len = raw_len(d, i), k = 0;
        bool esc = JD_NODE_ESC(*nd);
        while (k < len) {
            char c = p[k];
            if (c != '\\' || !esc) {
                pos = put_byte(out, cap, pos, c);
                k++;
                continue;
            }
            if (k + 1 >= len) break;
            char e = p[k + 1];
            k += 2;
            switch (e) {
            case 'n': pos = put_byte(out, cap, pos, '\n'); break;
            case 't': pos = put_byte(out, cap, pos, '\t'); break;
            case 'r': pos = put_byte(out, cap, pos, '\r'); break;
            case 'b': pos = put_byte(out, cap, pos, '\b'); break;
            case 'f': pos = put_byte(out, cap, pos, '\f'); break;
            case 'u': {
                bool ok;
                uint32_t cp = rd_hex4(p + k, len - k, &ok);
                if (!ok) break;
                k += 4;
                if (cp >= 0xD800 && cp <= 0xDBFF && k + 6 <= len && p[k] == '\\' && p[k + 1] == 'u') {
                    bool ok2;
                    uint32_t lo = rd_hex4(p + k + 2, len - k - 2, &ok2);
                    if (ok2 && lo >= 0xDC00 && lo <= 0xDFFF) {
                        cp = 0x10000 + ((cp - 0xD800) << 10) + (lo - 0xDC00);
                        k += 6;
                    }
                }
                pos = put_utf8(out, cap, pos, cp);
                break;
            }
            default: pos = put_byte(out, cap, pos, e); break; /* \" \\ \/ */
            }
        }
    }
    if (out && cap) out[pos < cap ? pos : cap - 1] = 0;
    return pos;
}

bool jd_eq(const jd_doc_t *d, int i, const char *s)
{
    if (i < 0 || JD_NODE_TYPE(d->nodes[i]) != JD_STR) return false;
    const jd_node_t *nd = &d->nodes[i];
    size_t sl = strlen(s);
    if (!JD_NODE_ESC(*nd)) {
        /* compare in place: equal iff the text matches and the string ends there */
        const char *p = d->text + nd->off;
        if (nd->off + sl >= d->len) return false;
        return memcmp(p, s, sl) == 0 && p[sl] == '"';
    }
    char buf[128];
    size_t l = jd_str(d, i, buf, sizeof buf);
    return l == sl && l < sizeof buf && memcmp(buf, s, sl) == 0;
}

int jd_get(const jd_doc_t *d, int obj, const char *key)
{
    if (obj < 0 || JD_NODE_TYPE(d->nodes[obj]) != JD_OBJ) return -1;
    for (int k = jd_first(d, obj); k >= 0; k = jd_next(d, k)) {
        if (jd_eq(d, k, key)) return k + 1;
    }
    return -1;
}

double jd_num(const jd_doc_t *d, int i, double def)
{
    if (i < 0) return def;
    switch (JD_NODE_TYPE(d->nodes[i])) {
    case JD_TRUE: return 1;
    case JD_FALSE: return 0;
    case JD_NUM:
    case JD_STR: {
        char buf[64];
        size_t l = jd_str(d, i, buf, sizeof buf);
        if (l == 0 || l >= sizeof buf) return def;
        char *end = NULL;
        double v = strtod(buf, &end);
        while (end && (*end == ' ' || *end == '\t')) end++;
        if (!end || end == buf || *end) return def;
        return v;
    }
    default: return def;
    }
}

bool jd_bool(const jd_doc_t *d, int i, bool def)
{
    if (i < 0) return def;
    switch (JD_NODE_TYPE(d->nodes[i])) {
    case JD_TRUE: return true;
    case JD_FALSE:
    case JD_NULL: return false;
    case JD_NUM: return jd_num(d, i, 0) != 0;
    case JD_STR: return raw_len(d, i) > 0;
    default: return true;
    }
}
