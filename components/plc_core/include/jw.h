/* ============================================================================
 * jw.h — tiny streaming JSON writer into a growable buffer.
 * Comma placement is automatic: call jw_key() before an object member value,
 * nothing before an array element.
 * ==========================================================================*/
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define JW_MAX_DEPTH 32

typedef struct {
    char *buf;
    size_t len, cap;
    bool oom;                 /* an allocation failed; output is truncated */
    uint8_t depth;
    bool after_key;
    uint32_t need_comma;      /* bit per depth */
    void *(*realloc_fn)(void *p, size_t n);
} jw_t;

void jw_init(jw_t *w, void *(*realloc_fn)(void *p, size_t n));
void jw_reset(jw_t *w);                 /* empty the buffer, keep its memory */
void jw_release(jw_t *w, void (*free_fn)(void *p));

void jw_obj(jw_t *w);
void jw_obj_end(jw_t *w);
void jw_arr(jw_t *w);
void jw_arr_end(jw_t *w);
void jw_key(jw_t *w, const char *k);
void jw_str(jw_t *w, const char *s);
void jw_strn(jw_t *w, const char *s, size_t n);
void jw_num(jw_t *w, double v);
void jw_int(jw_t *w, long long v);
void jw_bool(jw_t *w, bool b);
void jw_null(jw_t *w);
void jw_rawval(jw_t *w, const char *json, size_t n);  /* pre-serialized value */

static inline void jw_kstr(jw_t *w, const char *k, const char *s) { jw_key(w, k); if (s) jw_str(w, s); else jw_null(w); }
static inline void jw_knum(jw_t *w, const char *k, double v) { jw_key(w, k); jw_num(w, v); }
static inline void jw_kint(jw_t *w, const char *k, long long v) { jw_key(w, k); jw_int(w, v); }
static inline void jw_kbool(jw_t *w, const char *k, bool b) { jw_key(w, k); jw_bool(w, b); }
static inline void jw_knull(jw_t *w, const char *k) { jw_key(w, k); jw_null(w); }

/* format a double the way the browser expects (integers without ".0",
 * non-finite -> 0); returns length written into out (cap >= 32) */
int jw_fmt_num(char *out, size_t cap, double v);

#ifdef __cplusplus
}
#endif
