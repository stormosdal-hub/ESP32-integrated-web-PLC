/* plc_runtime.c — see plc_runtime.h */
#include "plc_runtime.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "nvs.h"
#include "ouc_esp.h"
#include "plc_io_esp.h"
#include "plc_store.h"
#include "sdkconfig.h"
#include "soc/soc_caps.h"

static const char *TAG = "plc_rt";

static SemaphoreHandle_t s_lock;
static plc_t *s_eng;          /* never NULL after init (empty program when none) */
static bool s_running, s_has_program;
static uint32_t s_rev;
static char s_name[64];
static plc_rt_stats_t s_stats;
static plc_env_t s_env;

/* ---------------------------------------------------------- engine env */
static double env_now(void *u) { return (double)esp_timer_get_time() / 1000.0; }
/* program structures prefer fast internal RAM; the transient JSON DOM prefers PSRAM */
static void *env_alloc(size_t n)
{
    return heap_caps_malloc_prefer(n, 2, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
}
static void *env_alloc_big(size_t n)
{
    return heap_caps_malloc_prefer(n, 2, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
}
static void env_free(void *p) { heap_caps_free(p); }

/* days since 1970-01-01 of a proleptic Gregorian date (a timegm() without
 * the library: newlib has none) */
static int64_t days_from_civil(int64_t y, int m, int d)
{
    y -= m <= 2;
    int64_t era = (y >= 0 ? y : y - 399) / 400;
    int64_t yoe = y - era * 400;
    int64_t doy = (153 * (m + (m > 2 ? -3 : 9)) + 2) / 5 + d - 1;
    int64_t doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    return era * 146097 + doe - 719468;
}

/* RD_SYS_T / RD_LOC_T: the system clock (set by SNTP, see wifi_mgr.c) in ms
 * since 1970 — UTC, or the same instant as local wall time (CONFIG_PLC_TIMEZONE) */
static double env_wall(void *u, bool local)
{
    struct timeval tv;
    gettimeofday(&tv, NULL);
    double ms = (double)tv.tv_usec / 1000.0;
    if (!local) return (double)tv.tv_sec * 1000.0 + ms;
    time_t t = tv.tv_sec;
    struct tm lt;
    localtime_r(&t, &lt);
    int64_t s = days_from_civil(lt.tm_year + 1900LL, lt.tm_mon + 1, lt.tm_mday) * 86400 + lt.tm_hour * 3600 +
                lt.tm_min * 60 + lt.tm_sec;
    return (double)s * 1000.0 + ms;
}

/* ---------------------------------------------------------- lock */
void plc_rt_lock(void) { xSemaphoreTake(s_lock, portMAX_DELAY); }
void plc_rt_unlock(void) { xSemaphoreGive(s_lock); }
plc_t *plc_rt_engine(void) { return s_eng; }

/* ---------------------------------------------------------- RUN flag in NVS */
static void save_run_flag(bool run)
{
    nvs_handle_t h;
    if (nvs_open("plc", NVS_READWRITE, &h) != ESP_OK) return;
    nvs_set_u8(h, "run", run ? 1 : 0);
    nvs_commit(h);
    nvs_close(h);
}

#if CONFIG_PLC_AUTORUN
static bool load_run_flag(void)
{
    nvs_handle_t h;
    uint8_t v = 1;
    if (nvs_open("plc", NVS_READONLY, &h) == ESP_OK) {
        nvs_get_u8(h, "run", &v);
        nvs_close(h);
    }
    return v != 0;
}
#endif

/* ---------------------------------------------------------- helpers */
static void stats_reset(void)
{
    memset(&s_stats, 0, sizeof s_stats);
    s_stats.min_us = UINT32_MAX;
}

static void stats_add(uint32_t us)
{
    s_stats.last_us = us;
    if (us < s_stats.min_us) s_stats.min_us = us;
    if (us > s_stats.max_us) s_stats.max_us = us;
    s_stats.avg_us = s_stats.cycles ? s_stats.avg_us + (int32_t)(us - s_stats.avg_us) / 16 : us;
    s_stats.cycles++;
}

static void set_name(plc_t *p)
{
    const char *n = plc_project_name(p);
    snprintf(s_name, sizeof s_name, "%s", n ? n : "");
}

static plc_t *empty_engine(void)
{
    char err[64];
    return plc_load(NULL, 0, &s_env, err, sizeof err);
}

/* compile the program currently committed in flash (NULL if none / invalid) */
static plc_t *compile_stored(char *err, size_t errlen, plc_io_warn_t *warn)
{
    const char *text;
    size_t len;
    esp_partition_mmap_handle_t mh;
    if (plc_store_map(&text, &len, &mh) != ESP_OK) {
        snprintf(err, errlen, "no stored program");
        return NULL;
    }
    plc_t *p = plc_load(text, len, &s_env, err, errlen);
    plc_store_unmap(mh);
    if (p && plc_io_validate(p, err, errlen, warn) != ESP_OK) {
        plc_free(p);
        p = NULL;
    }
    return p;
}

/* install p (lock held); returns the engine it replaced */
static plc_t *install(plc_t *p, bool has_program, bool run)
{
    plc_t *old = s_eng;
    plc_io_release();
    s_eng = p;
    if (has_program) plc_io_apply(p);
    s_has_program = has_program;
    s_running = run && has_program;
    set_name(p);
    stats_reset();
    return old;
}

/* ---------------------------------------------------------- scan task */
static void scan_task(void *arg)
{
    TickType_t last = xTaskGetTickCount();
    for (;;) {
        TickType_t period = pdMS_TO_TICKS(50);
        plc_rt_lock();
        if (s_running && s_has_program) {
            int64_t t0 = esp_timer_get_time();
            plc_io_read_inputs(s_eng);
            plc_scan(s_eng);
            plc_io_write_outputs(s_eng);
            stats_add((uint32_t)(esp_timer_get_time() - t0));
            period = pdMS_TO_TICKS(plc_scan_ms(s_eng));
            if (!period) period = 1;
            /* counted under the lock: install() resets the stats concurrently */
            if ((TickType_t)(xTaskGetTickCount() - last) >= period) s_stats.overruns++;
        }
        plc_rt_unlock();

        TickType_t now = xTaskGetTickCount();
        if ((TickType_t)(now - last) >= period) {
            /* cycle overrun: resynchronise, but always give lower-priority
             * tasks (and the idle task's watchdog feed) a tick */
            last = now;
            vTaskDelay(1);
        } else {
            vTaskDelayUntil(&last, period);
        }
    }
}

/* ---------------------------------------------------------- public */
esp_err_t plc_rt_init(void)
{
    s_lock = xSemaphoreCreateMutex();
    if (!s_lock) return ESP_ERR_NO_MEM;
    s_env.now_ms = env_now;
    s_env.alloc = env_alloc;
    s_env.alloc_big = env_alloc_big;
    s_env.free = env_free;
    s_env.wall_ms = env_wall;
    s_env.net = ouc_esp_net(); /* NULL (ouc_esp_init failed): the engine's virtual network */
    /* every task that enters the engine has a 16 KB stack (main task, httpd,
     * scan task): the engine may use 10 KB below its entry point, leaving the
     * rest for the frames above it and the deepest leaf calls (printf). A
     * program nested deeper fails to compile / has the call skipped instead
     * of overflowing the stack (and boot-looping on the stored program). */
    s_env.stack_limit = 10 * 1024;
    if (!s_env.net) ESP_LOGE(TAG, "no TCP for TCON/TSEND/TRCV - they only reach the program's own connections");
    setenv("TZ", CONFIG_PLC_TIMEZONE, 1); /* RD_LOC_T */
    tzset();
    stats_reset();

    char err[200] = "";
    plc_io_warn_t warn;
    plc_t *p = NULL;
    if (plc_store_has_program(NULL, NULL)) {
        p = compile_stored(err, sizeof err, &warn);
        if (!p) ESP_LOGE(TAG, "stored program not loaded: %s", err);
    }
    bool run = false, loaded = p != NULL;
    if (loaded) {
#if CONFIG_PLC_AUTORUN /* a disabled bool is absent from sdkconfig.h: test it with #if */
        run = load_run_flag();
#endif
        s_rev = 1;
        for (size_t i = 0; i < plc_warning_count(p); i++) ESP_LOGW(TAG, "%s", plc_warning(p, i));
    } else {
        p = empty_engine();
        if (!p) return ESP_ERR_NO_MEM;
    }
    plc_rt_lock();
    install(p, loaded, run);
    plc_rt_unlock();
    if (s_has_program)
        ESP_LOGI(TAG, "program \"%s\" loaded, CPU %s, scan %u ms", s_name, s_running ? "RUN" : "STOP", (unsigned)plc_scan_ms(p));

    /* 16 KB: nested block calls (16 deep) + SCL expression recursion.
     * Single-core chips (C3, C6) have no core 1, whatever an old sdkconfig says. */
#if CONFIG_FREERTOS_UNICORE || SOC_CPU_CORES_NUM == 1
    const BaseType_t core = 0;
#else
    const BaseType_t core = CONFIG_PLC_SCAN_TASK_CORE;
#endif
    BaseType_t ok = xTaskCreatePinnedToCore(scan_task, "plc_scan", 16384, NULL, CONFIG_PLC_SCAN_TASK_PRIORITY, NULL, core);
    return ok == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}

bool plc_rt_running(void)
{
    plc_rt_lock();
    bool r = s_running;
    plc_rt_unlock();
    return r;
}

bool plc_rt_has_program(void)
{
    plc_rt_lock();
    bool r = s_has_program;
    plc_rt_unlock();
    return r;
}

uint32_t plc_rt_program_rev(void)
{
    plc_rt_lock();
    uint32_t r = s_rev;
    plc_rt_unlock();
    return r;
}

size_t plc_rt_forced_count(void)
{
    plc_rt_lock();
    size_t n = plc_forced_count(s_eng);
    plc_rt_unlock();
    return n;
}

void plc_rt_project_name(char *out, size_t cap)
{
    plc_rt_lock();
    snprintf(out, cap, "%s", s_name);
    plc_rt_unlock();
}

void plc_rt_stats(plc_rt_stats_t *out)
{
    plc_rt_lock();
    *out = s_stats;
    if (out->min_us == UINT32_MAX) out->min_us = 0;
    plc_rt_unlock();
}

void plc_rt_status_locked(plc_rt_status_t *out)
{
    out->running = s_running;
    out->has_program = s_has_program;
    out->rev = s_rev;
    snprintf(out->name, sizeof out->name, "%s", s_name);
    out->stats = s_stats;
    if (out->stats.min_us == UINT32_MAX) out->stats.min_us = 0;
}

bool plc_rt_set_running(bool run)
{
    plc_rt_lock();
    bool was = s_running;
    s_running = run && s_has_program;
    if (was && !s_running) {
        plc_io_outputs_off(s_eng); /* real PLC STOP: de-energize */
        plc_comm_reset(s_eng);     /* ... and drop the TCP connections (TCON again on RUN) */
    }
    if (!was && s_running) stats_reset();
    bool now = s_running;
    plc_rt_unlock();
    if (was != now) {
        save_run_flag(now);
        ESP_LOGI(TAG, "CPU %s", now ? "RUN" : "STOP");
    }
    return now;
}

/* ---------------------------------------------------------- download */
static int reply_error(jw_t *w, int status, const char *msg)
{
    jw_reset(w);
    jw_obj(w);
    jw_kbool(w, "ok", false);
    jw_kstr(w, "error", msg);
    jw_obj_end(w);
    ESP_LOGW(TAG, "download rejected: %s", msg);
    return status;
}

/* bring back the program that is still committed in flash */
static void restore_previous(bool was_running)
{
    char err[200];
    plc_t *p = compile_stored(err, sizeof err, NULL);
    bool has = p != NULL;
    if (!p) p = empty_engine();
    if (!p) return;
    plc_rt_lock();
    plc_t *old = install(p, has, was_running);
    plc_rt_unlock();
    plc_free(old);
}

int plc_rt_download(size_t len, plc_rt_reader_t rd, void *ctx, jw_t *w)
{
    char err[200];
    size_t max = (size_t)CONFIG_PLC_MAX_PROGRAM_KB * 1024;
    if (plc_store_max_len() < max) max = plc_store_max_len();
    if (len == 0) return reply_error(w, 400, "empty program");
    if (len > max) {
        snprintf(err, sizeof err, "program too large (%u bytes, limit %u)", (unsigned)len, (unsigned)max);
        return reply_error(w, 413, err);
    }

    /* STOP for the duration of the download, like TIA */
    plc_rt_lock();
    bool was_running = s_running;
    s_running = false;
    plc_io_outputs_off(s_eng);
    plc_rt_unlock();

    /* 1. stream the body into the inactive flash slot */
    plc_store_tx_t tx;
    if (plc_store_begin(&tx, len) != ESP_OK) {
        plc_rt_set_running(was_running);
        return reply_error(w, 500, "flash erase failed");
    }
    char *buf = (char *)malloc(4096);
    if (!buf) {
        plc_rt_set_running(was_running);
        return reply_error(w, 500, "out of memory");
    }
    size_t left = len;
    while (left) {
        size_t got = 0;
        if (rd(ctx, buf, left < 4096 ? left : 4096, &got) != ESP_OK || !got) {
            free(buf);
            plc_rt_set_running(was_running);
            return reply_error(w, 400, "upload interrupted");
        }
        if (plc_store_write(&tx, buf, got) != ESP_OK) {
            free(buf);
            plc_rt_set_running(was_running);
            return reply_error(w, 500, "flash write failed");
        }
        left -= got;
    }
    free(buf);

    /* 2. unload the old program (frees its memory for the compile) */
    plc_t *emp = empty_engine();
    if (!emp) {
        plc_rt_set_running(was_running);
        return reply_error(w, 500, "out of memory");
    }
    plc_rt_lock();
    plc_t *old = install(emp, false, false);
    plc_rt_unlock();
    plc_free(old);

    /* 3. compile straight out of flash and check the I/O map */
    const char *text;
    esp_partition_mmap_handle_t mh;
    plc_t *neu = NULL;
    plc_io_warn_t iow = {0};
    err[0] = 0;
    if (plc_store_map_tx(&tx, &text, &mh) == ESP_OK) {
        int64_t t0 = esp_timer_get_time();
        neu = plc_load(text, len, &s_env, err, sizeof err);
        plc_store_unmap(mh);
        if (neu) ESP_LOGI(TAG, "compiled %u bytes in %u ms", (unsigned)len, (unsigned)((esp_timer_get_time() - t0) / 1000));
    } else {
        snprintf(err, sizeof err, "flash map failed");
    }
    if (neu && plc_io_validate(neu, err, sizeof err, &iow) != ESP_OK) {
        plc_free(neu);
        neu = NULL;
    }
    if (!neu) {
        char msg[220];
        snprintf(msg, sizeof msg, "%s", err[0] ? err : "compile failed");
        restore_previous(was_running);
        return reply_error(w, 400, msg);
    }

    /* 4. commit to flash, install, RUN */
    if (plc_store_commit(&tx) != ESP_OK) {
        plc_free(neu);
        restore_previous(was_running);
        return reply_error(w, 500, "flash commit failed");
    }
    plc_rt_lock();
    s_rev++;
    plc_t *prev = install(neu, true, true);
    uint32_t rev = s_rev;
    jw_reset(w);
    jw_obj(w);
    jw_kbool(w, "ok", true);
    jw_kint(w, "programRev", rev);
    jw_key(w, "warnings");
    jw_arr(w);
    for (size_t i = 0; i < plc_warning_count(neu); i++) jw_str(w, plc_warning(neu, i));
    for (int i = 0; i < iow.n; i++) jw_str(w, iow.msg[i]);
    jw_arr_end(w);
    jw_obj_end(w);
    plc_rt_unlock();
    plc_free(prev);
    save_run_flag(true);
    ESP_LOGI(TAG, "program downloaded (rev %u), CPU RUN", (unsigned)rev);
    return 200;
}

esp_err_t plc_rt_erase_program(void)
{
    plc_t *emp = empty_engine();
    if (!emp) return ESP_ERR_NO_MEM;
    plc_rt_lock();
    plc_t *old = install(emp, false, false);
    s_rev++;
    plc_rt_unlock();
    plc_free(old);
    save_run_flag(false);
    ESP_LOGI(TAG, "program erased");
    return plc_store_erase();
}
