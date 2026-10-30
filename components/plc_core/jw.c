/* jw.c — see jw.h */
#include "jw.h"

#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

void jw_init(jw_t *w, void *(*realloc_fn)(void *p, size_t n))
{
    memset(w, 0, sizeof *w);
    w->realloc_fn = realloc_fn ? realloc_fn : realloc;
}

void jw_reset(jw_t *w)
{
    w->len = 0;
    w->oom = false;
    w->depth = 0;
    w->after_key = false;
    w->need_comma = 0;
    if (w->buf) w->buf[0] = 0;
}

void jw_release(jw_t *w, void (*free_fn)(void *p))
{
    if (w->buf) (free_fn ? free_fn : free)(w->buf);
    w->buf = NULL;
    w->len = w->cap = 0;
}

static bool grow(jw_t *w, size_t extra)
{
    if (w->oom) return false;
    if (w->len + extra + 1 <= w->cap) return true;
    size_t nc = w->cap ? w->cap : 1024;
    while (nc < w->len + extra + 1) nc *= 2;
    char *nb = (char *)w->realloc_fn(w->buf, nc);
    if (!nb) {
        w->oom = true;
        return false;
    }
    w->buf = nb;
    w->cap = nc;
    return true;
}

static void put(jw_t *w, const char *s, size_t n)
{
    if (!grow(w, n)) return;
    memcpy(w->buf + w->len, s, n);
    w->len += n;
    w->buf[w->len] = 0;
}

static void putc_(jw_t *w, char c) { put(w, &c, 1); }

static void pre_value(jw_t *w)
{
    if (w->after_key) {
        w->after_key = false;
        return;
    }
    uint32_t bit = 1u << (w->depth & 31);
    if (w->need_comma & bit) putc_(w, ',');
    w->need_comma |= bit;
}

static void put_quoted(jw_t *w, const char *s, size_t n);

void jw_key(jw_t *w, const char *k)
{
    uint32_t bit = 1u << (w->depth & 31);
    if (w->need_comma & bit) putc_(w, ',');
    w->need_comma |= bit;
    put_quoted(w, k, strlen(k));
    putc_(w, ':');
    w->after_key = true;
}

static void open_(jw_t *w, char c)
{
    pre_value(w);
    putc_(w, c);
    if (w->depth < JW_MAX_DEPTH - 1) w->depth++;
    w->need_comma &= ~(1u << (w->depth & 31));
}

static void close_(jw_t *w, char c)
{
    if (w->depth) w->depth--;
    putc_(w, c);
}

void jw_obj(jw_t *w) { open_(w, '{'); }
void jw_obj_end(jw_t *w) { close_(w, '}'); }
void jw_arr(jw_t *w) { open_(w, '['); }
void jw_arr_end(jw_t *w) { close_(w, ']'); }

static void put_quoted(jw_t *w, const char *s, size_t n)
{
    putc_(w, '"');
    size_t run = 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        const char *esc = NULL;
        char ubuf[8];
        switch (c) {
        case '"': esc = "\\\""; break;
        case '\\': esc = "\\\\"; break;
        case '\n': esc = "\\n"; break;
        case '\r': esc = "\\r"; break;
        case '\t': esc = "\\t"; break;
        default:
            if (c < 0x20) {
                snprintf(ubuf, sizeof ubuf, "\\u%04x", c);
                esc = ubuf;
            }
        }
        if (esc) {
            if (run) put(w, s + i - run, run);
            run = 0;
            put(w, esc, strlen(esc));
        } else {
            run++;
        }
    }
    if (run) put(w, s + n - run, run);
    putc_(w, '"');
}

void jw_strn(jw_t *w, const char *s, size_t n)
{
    pre_value(w);
    put_quoted(w, s, n);
}

void jw_str(jw_t *w, const char *s)
{
    if (!s) {
        jw_null(w);
        return;
    }
    jw_strn(w, s, strlen(s));
}

int jw_fmt_num(char *out, size_t cap, double v)
{
    if (!isfinite(v)) v = 0;
    if (v == 0) return snprintf(out, cap, "0"); /* also folds -0 */
    if (v == floor(v) && fabs(v) < 1e15) return snprintf(out, cap, "%.0f", v);
    int n = snprintf(out, cap, "%.15g", v);
    return n;
}

void jw_num(jw_t *w, double v)
{
    char b[40];
    int n = jw_fmt_num(b, sizeof b, v);
    pre_value(w);
    put(w, b, (size_t)n);
}

void jw_int(jw_t *w, long long v)
{
    char b[32];
    int n = snprintf(b, sizeof b, "%lld", v);
    pre_value(w);
    put(w, b, (size_t)n);
}

void jw_bool(jw_t *w, bool b)
{
    pre_value(w);
    if (b) put(w, "true", 4);
    else put(w, "false", 5);
}

void jw_null(jw_t *w)
{
    pre_value(w);
    put(w, "null", 4);
}

void jw_rawval(jw_t *w, const char *json, size_t n)
{
    pre_value(w);
    put(w, json, n);
}
