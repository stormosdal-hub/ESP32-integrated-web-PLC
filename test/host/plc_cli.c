/* Host test driver for the portable PLC core.
 *   plc_cli <project.json> <steps.json>
 * Runs the same step script as test/parity/js_ref.js and prints
 * {"warnings":[...],"steps":[<snapshot>, ...]} on stdout. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "jdom.h"
#include "jw.h"
#include "plc_engine.h"

static double g_now = 0;
static double now_ms(void *u)
{
    (void)u;
    return g_now;
}
/* the same deterministic wall clock as js_ref.js (RD_SYS_T / RD_LOC_T) */
static double wall_ms(void *u, bool local)
{
    (void)u;
    return 1700000000000.0 + g_now + (local ? 3600000.0 : 0.0);
}

/* Poisoning allocator: freed blocks are overwritten with 0xFE so any
 * use-after-free in the engine fails loudly in the fuzz/parity runs instead
 * of silently reading stale-but-intact memory. */
typedef struct {
    size_t n;
    size_t pad;
} hdr_t;

static void *dbg_alloc(size_t n)
{
    hdr_t *h = (hdr_t *)malloc(sizeof(hdr_t) + n);
    if (!h) return NULL;
    h->n = n;
    memset(h + 1, 0xCD, n); /* garbage, like a real heap */
    return h + 1;
}

static void dbg_free(void *p)
{
    if (!p) return;
    hdr_t *h = (hdr_t *)p - 1;
    memset(h, 0xFE, sizeof(hdr_t) + h->n);
    free(h);
}

static char *read_file(const char *path, size_t *len)
{
    FILE *f = fopen(path, "rb");
    if (!f) return NULL;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *b = (char *)malloc((size_t)n + 1);
    if (fread(b, 1, (size_t)n, f) != (size_t)n) {
        fclose(f);
        free(b);
        return NULL;
    }
    fclose(f);
    b[n] = 0;
    *len = (size_t)n;
    return b;
}

int main(int argc, char **argv)
{
    if (argc < 3) {
        fprintf(stderr, "usage: plc_cli project.json steps.json\n");
        return 2;
    }
    size_t plen, slen;
    char *proj = read_file(argv[1], &plen);
    char *steps = read_file(argv[2], &slen);
    if (!proj || !steps) {
        fprintf(stderr, "cannot read input\n");
        return 2;
    }
    plc_env_t env = {now_ms, NULL, dbg_alloc, dbg_alloc, dbg_free, wall_ms, NULL};
    char err[256];
    plc_t *p = plc_load(proj, plen, &env, err, sizeof err);
    if (!p) {
        printf("{\"error\":\"%s\"}", err);
        free(proj);
        free(steps);
        return 1;
    }
    jd_doc_t d;
    if (!jd_parse(&d, steps, slen, NULL)) {
        fprintf(stderr, "bad steps json: %s\n", d.err);
        return 2;
    }
    int arr = jd_get(&d, 0, "steps");
    jw_t w;
    jw_init(&w, NULL);
    jw_obj(&w);
    jw_key(&w, "warnings");
    jw_arr(&w);
    for (size_t i = 0; i < plc_warning_count(p); i++) jw_str(&w, plc_warning(p, i));
    jw_arr_end(&w);
    jw_key(&w, "steps");
    jw_arr(&w);
    for (int st = jd_first(&d, arr); st >= 0; st = jd_next(&d, st)) {
        int tv = jd_get(&d, st, "t");
        if (jd_type(&d, tv) == JD_NUM) g_now = jd_num(&d, tv, 0);
        double dt = jd_num(&d, jd_get(&d, st, "dt"), 10);
        int set = jd_get(&d, st, "set");
        for (int k = jd_first(&d, set); k >= 0; k = jd_next(&d, k)) {
            char key[200];
            jd_str(&d, k, key, sizeof key);
            int v = k + 1;
            int ty = jd_type(&d, v);
            if (ty == JD_TRUE || ty == JD_FALSE) plc_force(p, key, PLC_V_BOOL, ty == JD_TRUE);
            else plc_force(p, key, PLC_V_NUM, jd_num(&d, v, 0));
        }
        int scans = (int)jd_num(&d, jd_get(&d, st, "scans"), 1);
        for (int i = 0; i < scans; i++) {
            plc_scan(p);
            g_now += dt;
        }
        jw_obj(&w);
        plc_snapshot_json(p, &w);
        jw_key(&w, "dbs");
        plc_dbs_json(p, &w, NULL);
        jw_key(&w, "conns");
        plc_conns_json(p, &w);
        jw_obj_end(&w);
    }
    jw_arr_end(&w);
    jw_obj_end(&w);
    fwrite(w.buf, 1, w.len, stdout);
    jw_release(&w, NULL);
    jd_release(&d, NULL);
    plc_free(p);
    free(proj);
    free(steps);
    return 0;
}
