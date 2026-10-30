/* ============================================================================
 * jdom.h — a compact, read-only JSON DOM.
 *
 * Why not cJSON: cJSON mallocs every value and every key (~90 bytes/value),
 * so a 50 KB project needs ~600 KB of heap — far more than an ESP32-S3 without
 * PSRAM has free once Wi-Fi is up. jdom keeps one 8-byte node per value (keys
 * included) in a single array and never copies strings: nodes point into the
 * source text, which may be a flash-mapped (read-only) buffer. String lengths
 * and child counts are recomputed on demand. A project's DOM is about 1.1x the
 * size of its (compact) JSON text.
 *
 * Layout: nodes are stored in document order (pre-order). A container's first
 * child is the next node; siblings are linked through `next` (0 = last). For
 * objects the sibling chain runs through the KEY nodes and each value sits at
 * key + 1.
 * ==========================================================================*/
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

enum { JD_NULL = 0, JD_FALSE, JD_TRUE, JD_NUM, JD_STR, JD_ARR, JD_OBJ };

typedef struct {
    uint32_t off;   /* STR: first byte after '"'; others: first byte (bracket / digit / letter) */
    uint32_t meta;  /* bits 0-27: next sibling index (0 = none); 28-30: JD_* type; 31: STR has escapes */
} jd_node_t;

#define JD_MAX_NODES 0x0FFFFFFFu
#define JD_NODE_NEXT(n) ((n).meta & JD_MAX_NODES)
#define JD_NODE_TYPE(n) ((int)(((n).meta >> 28) & 7u))
#define JD_NODE_ESC(n) ((n).meta >> 31)

typedef struct {
    const char *text;
    size_t len;
    jd_node_t *nodes;
    uint32_t count;
    const char *err;  /* static message when parsing failed */
    size_t err_pos;   /* byte offset of the failure */
} jd_doc_t;

typedef void *(*jd_alloc_fn)(size_t n);
typedef void (*jd_free_fn)(void *p);

/* Parse `len` bytes of `text`. The text must stay valid while the doc is used.
 * Returns false on syntax error / out of memory (see d->err). */
bool jd_parse(jd_doc_t *d, const char *text, size_t len, jd_alloc_fn alloc);
void jd_release(jd_doc_t *d, jd_free_fn fr);

static inline int jd_type(const jd_doc_t *d, int i) { return i < 0 ? -1 : JD_NODE_TYPE(d->nodes[i]); }

/* value of member `key` of object `obj`, or -1 */
int jd_get(const jd_doc_t *d, int obj, const char *key);
/* first child of an array, first KEY of an object, or -1 */
int jd_first(const jd_doc_t *d, int container);
/* next sibling, or -1 */
int jd_next(const jd_doc_t *d, int i);
uint32_t jd_count(const jd_doc_t *d, int container);

/* Decoded text of a string (numbers -> their literal, true/false -> "true"/"false",
 * null/containers -> ""). Writes at most cap-1 bytes + NUL; returns the full
 * decoded length (>= cap means truncated). */
size_t jd_str(const jd_doc_t *d, int i, char *out, size_t cap);
/* string node equals s exactly */
bool jd_eq(const jd_doc_t *d, int i, const char *s);
/* number (also numeric strings / booleans), else def */
double jd_num(const jd_doc_t *d, int i, double def);
/* JS-ish truthiness of a value node, def when missing */
bool jd_bool(const jd_doc_t *d, int i, bool def);

#ifdef __cplusplus
}
#endif
