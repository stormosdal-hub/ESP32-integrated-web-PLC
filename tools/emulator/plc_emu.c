/* ctypes shim around the portable PLC core, used by tools/plc_emulator.py to
 * run the very same engine the ESP32 runs, on a PC. Strings returned by the
 * emu_*json functions are malloc'd: release them with emu_free_str().
 *
 * TCON / TSEND / TRCV get real TCP through main/ouc_net.c: one set of
 * connection slots for the process, its sockets served at the start of every
 * emu_cycle (and right after a STOP / unload, to close them). The Python side
 * calls everything here under its runtime lock, so no further locking. */
#include <stdlib.h>
#include <string.h>
#include <time.h>
#ifdef _WIN32
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <sys/time.h>
#endif

#include "jw.h"
#include "ouc_net.h"
#include "plc_engine.h"

#ifdef _WIN32
#define EXPORT __declspec(dllexport)
#else
#define EXPORT __attribute__((visibility("default")))
#endif

static double s_now;
static double now_ms(void *u)
{
    (void)u;
    return s_now;
}

/* days since 1970-01-01 of a Gregorian date (timegm() is not portable) */
static long long days_from_civil(long long y, int m, int d)
{
    y -= m <= 2;
    long long era = (y >= 0 ? y : y - 399) / 400, yoe = y - era * 400;
    long long doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    return era * 146097 + yoe * 365 + yoe / 4 - yoe / 100 + doy - 719468;
}

/* RD_SYS_T / RD_LOC_T: the PC's clock in ms since 1970, UTC or local wall time */
static double wall_ms(void *u, bool local)
{
    (void)u;
#ifdef _WIN32
    FILETIME ft; /* 100 ns since 1601 */
    GetSystemTimeAsFileTime(&ft);
    double ms = (double)(((unsigned long long)ft.dwHighDateTime << 32 | ft.dwLowDateTime) / 10000ULL) - 11644473600000.0;
#else
    struct timeval tv;
    gettimeofday(&tv, NULL);
    double ms = (double)tv.tv_sec * 1000.0 + (double)tv.tv_usec / 1000.0;
#endif
    if (!local) return ms;
    time_t t = (time_t)(ms / 1000.0);
    struct tm *lt = localtime(&t); /* (calls are serialised by the Python lock) */
    if (!lt) return ms;
    long long sec = days_from_civil(lt->tm_year + 1900LL, lt->tm_mon + 1, lt->tm_mday) * 86400 + lt->tm_hour * 3600 +
                    lt->tm_min * 60 + lt->tm_sec;
    return (double)sec * 1000.0 + (ms - (double)t * 1000.0);
}

static ouc_net_t *s_ouc;
static const plc_net_t *net(void)
{
    if (!s_ouc) s_ouc = ouc_net_create(NULL);
    return ouc_net_ops(s_ouc); /* NULL (no sockets): the engine's virtual network */
}
static void net_pass(void)
{
    if (s_ouc) ouc_net_poll(s_ouc, 0);
}

static char *finish(jw_t *w)
{
    if (w->oom || !w->buf) {
        jw_release(w, NULL);
        return NULL;
    }
    return w->buf;
}

EXPORT void *emu_load(const char *json, int len, char *err, int errlen)
{
    plc_env_t env = {now_ms, NULL, NULL, NULL, NULL, wall_ms, net()};
    return plc_load(json, (size_t)(len > 0 ? len : 0), &env, err, (size_t)errlen);
}

EXPORT void emu_free(void *p)
{
    plc_free((plc_t *)p); /* closes its connections ... */
    net_pass();           /* ... and their sockets now */
}
EXPORT void emu_free_str(char *s) { free(s); }

/* one cycle with mock I/O: every GPIO input reads as an unwired pin would —
 * FALSE / 0 — unless it is forced (plc_io_set_input applies the force value) */
EXPORT void emu_cycle(void *vp, double now)
{
    plc_t *p = (plc_t *)vp;
    s_now = now;
    net_pass(); /* accept / connect / recv / send, without waiting */
    for (size_t i = 0; i < plc_io_count(p); i++) {
        plc_io_t *io = plc_io(p, i);
        if (io->dir == PLC_IO_IN || io->dir == PLC_IO_AIN) plc_io_set_input(p, i, 0);
    }
    plc_scan(p);
    /* like plc_io_write_outputs(): forced OUTPUTS overwrite the output image */
    for (size_t i = 0; i < plc_io_count(p); i++) {
        plc_io_t *io = plc_io(p, i);
        if (io->dir == PLC_IO_OUT || io->dir == PLC_IO_PWM) (void)plc_io_get_output(p, i);
    }
}

EXPORT char *emu_snapshot(void *p)
{
    jw_t w;
    jw_init(&w, NULL);
    jw_obj(&w);
    plc_snapshot_json((plc_t *)p, &w);
    jw_obj_end(&w);
    return finish(&w);
}

EXPORT char *emu_tags(void *p)
{
    jw_t w;
    jw_init(&w, NULL);
    plc_tags_json((plc_t *)p, &w);
    return finish(&w);
}

EXPORT char *emu_modbus_map(void *p, int bank)
{
    jw_t w;
    jw_init(&w, NULL);
    plc_modbus_map_json((plc_t *)p, &w, (unsigned)bank);
    return finish(&w);
}

EXPORT char *emu_warnings(void *vp)
{
    plc_t *p = (plc_t *)vp;
    jw_t w;
    jw_init(&w, NULL);
    jw_arr(&w);
    for (size_t i = 0; i < plc_warning_count(p); i++) jw_str(&w, plc_warning(p, i));
    jw_arr_end(&w);
    return finish(&w);
}

EXPORT char *emu_io(void *vp)
{
    static const char *const DIRS[] = {"in", "out", "pwm", "ain"};
    plc_t *p = (plc_t *)vp;
    jw_t w;
    jw_init(&w, NULL);
    jw_arr(&w);
    for (size_t i = 0; i < plc_io_count(p); i++) {
        plc_io_t *io = plc_io(p, i);
        jw_obj(&w);
        jw_kstr(&w, "tag", io->tag);
        jw_kint(&w, "pin", io->pin);
        jw_kstr(&w, "dir", DIRS[io->dir & 3]);
        jw_kint(&w, "freq", io->freq_hz);
        jw_kbool(&w, "pull", io->pull != PLC_PULL_NONE);
        if (io->sr >= 0) jw_kstr(&w, "sr", plc_sr(p, (size_t)io->sr)->id);
        else jw_knull(&w, "sr");
        if (io->i2c >= 0) jw_kstr(&w, "i2c", plc_i2c_dev(p, (size_t)io->i2c)->id);
        else jw_knull(&w, "i2c");
        jw_kint(&w, "bit", io->bit);
        jw_kint(&w, "range", io->range_mv);
        jw_obj_end(&w);
    }
    jw_arr_end(&w);
    return finish(&w);
}

/* the I2C bus and its modules, for the I/O check (mirror of plc_io_validate) */
EXPORT char *emu_i2c(void *vp)
{
    static const char *const TYPES[] = {"pcf8574", "mcp23017", "ads1115"};
    plc_t *p = (plc_t *)vp;
    const plc_i2c_bus_t *b = plc_i2c_bus(p);
    jw_t w;
    jw_init(&w, NULL);
    jw_obj(&w);
    jw_kint(&w, "sda", b->sda);
    jw_kint(&w, "scl", b->scl);
    jw_kint(&w, "khz", b->khz);
    jw_key(&w, "devices");
    jw_arr(&w);
    for (size_t i = 0; i < plc_i2c_count(p); i++) {
        const plc_i2c_dev_t *d = plc_i2c_dev(p, i);
        jw_obj(&w);
        jw_kstr(&w, "id", d->id);
        jw_kstr(&w, "type", TYPES[d->type]);
        jw_kint(&w, "addr", d->addr);
        jw_obj_end(&w);
    }
    jw_arr_end(&w);
    jw_obj_end(&w);
    return finish(&w);
}

/* shift-register chains, for the I/O check (mirror of plc_io_validate) */
EXPORT char *emu_srs(void *vp)
{
    plc_t *p = (plc_t *)vp;
    jw_t w;
    jw_init(&w, NULL);
    jw_arr(&w);
    for (size_t i = 0; i < plc_sr_count(p); i++) {
        const plc_sr_t *s = plc_sr(p, i);
        jw_obj(&w);
        jw_kstr(&w, "id", s->id);
        jw_kstr(&w, "type", s->type == PLC_SR_595 ? "595" : "165");
        jw_kint(&w, "chips", s->chips);
        jw_kint(&w, "data", s->data);
        jw_kint(&w, "clock", s->clock);
        jw_kint(&w, "latch", s->latch);
        jw_kint(&w, "enable", s->enable);
        jw_obj_end(&w);
    }
    jw_arr_end(&w);
    return finish(&w);
}

/* CPU STOP: drop the program's TCP connections (TCON again on RUN) */
EXPORT void emu_comm_reset(void *p)
{
    plc_comm_reset((plc_t *)p);
    net_pass();
}

/* the program's connections (engine view) */
EXPORT char *emu_conns(void *p)
{
    jw_t w;
    jw_init(&w, NULL);
    plc_conns_json((plc_t *)p, &w);
    return finish(&w);
}

/* the sockets behind them, with their actual partners */
EXPORT char *emu_sockets(void)
{
    jw_t w;
    jw_init(&w, NULL);
    ouc_net_json(s_ouc, &w);
    return finish(&w);
}

EXPORT int emu_force(void *p, const char *key, int type, double v) { return plc_force((plc_t *)p, key, (plc_vtype_t)type, v); }
EXPORT void emu_unforce(void *p) { plc_unforce_all((plc_t *)p); }
EXPORT int emu_forced(void *p) { return (int)plc_forced_count((plc_t *)p); }
EXPORT int emu_scan_ms(void *p) { return (int)plc_scan_ms((plc_t *)p); }
EXPORT unsigned emu_scan_count(void *p) { return plc_scan_count((plc_t *)p); }
EXPORT int emu_has_logic(void *p) { return plc_has_logic((plc_t *)p); }
EXPORT int emu_io_count(void *p) { return (int)plc_io_count((plc_t *)p); }
EXPORT unsigned emu_errors(void *p) { return plc_error_count((plc_t *)p); }
EXPORT const char *emu_last_error(void *p) { return plc_last_error((plc_t *)p); }
EXPORT const char *emu_name(void *p) { return plc_project_name((plc_t *)p); }
