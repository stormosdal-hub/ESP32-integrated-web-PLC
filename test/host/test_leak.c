/* Leak test for the PLC core: a PLC is re-programmed many times without a
 * reboot, so load -> scan -> snapshot -> force -> free must return every byte.
 *   test_leak <project.json> [rounds]
 * Counts every allocation the engine makes through its env hooks. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "jw.h"
#include "plc_engine.h"

static long s_live, s_peak;
static size_t s_bytes, s_peak_bytes;

typedef struct {
    size_t n;
    size_t pad;
} hdr_t;

static void *c_alloc(size_t n)
{
    hdr_t *h = (hdr_t *)malloc(sizeof(hdr_t) + n);
    if (!h) return NULL;
    h->n = n;
    s_live++;
    s_bytes += n;
    if (s_live > s_peak) s_peak = s_live;
    if (s_bytes > s_peak_bytes) s_peak_bytes = s_bytes;
    return h + 1;
}

static void c_free(void *p)
{
    if (!p) return;
    hdr_t *h = (hdr_t *)p - 1;
    s_live--;
    s_bytes -= h->n;
    memset(h, 0xFE, sizeof(hdr_t) + h->n);
    free(h);
}

static double s_now;
static double now_ms(void *u)
{
    (void)u;
    return s_now;
}

int main(int argc, char **argv)
{
    if (argc < 2) return 2;
    FILE *f = fopen(argv[1], "rb");
    if (!f) return 2;
    fseek(f, 0, SEEK_END);
    long n = ftell(f);
    fseek(f, 0, SEEK_SET);
    char *txt = (char *)malloc((size_t)n);
    if (fread(txt, 1, (size_t)n, f) != (size_t)n) return 2;
    fclose(f);
    int rounds = argc > 2 ? atoi(argv[2]) : 200;

    plc_env_t env = {now_ms, NULL, c_alloc, c_alloc, c_free};
    size_t peak_one = 0;
    for (int r = 0; r < rounds; r++) {
        char err[200];
        plc_t *p = plc_load(txt, (size_t)n, &env, err, sizeof err);
        if (!p) {
            printf("load failed: %s\n", err);
            return 1;
        }
        for (int s = 0; s < 20; s++) {
            s_now += 37;
            plc_scan(p);
        }
        /* forces resolve operands at runtime and may create new cells */
        plc_force(p, "Start_PB", PLC_V_BOOL, 1);
        plc_force(p, "NoSuchTag_Created_At_Runtime", PLC_V_NUM, 5);
        plc_force(p, "MW100", PLC_V_NUM, 7);
        plc_scan(p);
        jw_t w;
        jw_init(&w, NULL);
        jw_obj(&w);
        plc_snapshot_json(p, &w);
        jw_obj_end(&w);
        jw_release(&w, NULL);
        if (r == 0) peak_one = s_peak_bytes;
        plc_free(p);
        if (s_live != 0) {
            printf("LEAK after round %d: %ld allocation(s), %zu bytes outstanding\n", r, s_live, s_bytes);
            return 1;
        }
    }
    /* also the compile-error path */
    char err[200];
    plc_t *bad = plc_load(txt, (size_t)n / 2, &env, err, sizeof err);
    if (bad) plc_free(bad);
    if (s_live != 0) {
        printf("LEAK on the error path: %ld allocation(s)\n", s_live);
        return 1;
    }
    printf("no leaks: %d load/scan/force/free rounds, peak %zu bytes (%.1fx the %ld-byte JSON)\n", rounds, peak_one,
           (double)peak_one / (double)n, n);
    free(txt);
    return 0;
}
