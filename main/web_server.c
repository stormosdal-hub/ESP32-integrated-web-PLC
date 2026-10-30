/* web_server.c — see web_server.h */
#include "web_server.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_app_desc.h"
#include "esp_chip_info.h"
#include "esp_flash.h"
#include "esp_heap_caps.h"
#include "esp_http_server.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_timer.h"
#include "jdom.h"
#include "jw.h"
#include "modbus_tcp.h"
#include "ouc_esp.h"
#include "plc_engine.h"
#include "plc_io_esp.h"
#include "plc_runtime.h"
#include "plc_store.h"
#include "sdkconfig.h"
#include "web_assets.h"
#include "wifi_mgr.h"

static const char *TAG = "web";

static httpd_handle_t s_server;
static jw_t s_state_w; /* /api/state reuses one buffer (handlers run on one task) */

/* ---------------------------------------------------------- helpers */
static void cors(httpd_req_t *req)
{
    /* Read-only data may be fetched cross-origin (dashboards, Automation Sim).
     * Changes are only accepted with Content-Type: application/json, which a
     * foreign web page cannot send without a preflight we never approve. */
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
}

static esp_err_t send_json(httpd_req_t *req, jw_t *w, const char *status)
{
    httpd_resp_set_type(req, "application/json; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    cors(req);
    if (w->oom || !w->buf) {
        httpd_resp_set_status(req, "500 Internal Server Error");
        return httpd_resp_sendstr(req, "{\"ok\":false,\"error\":\"out of memory\"}");
    }
    if (status) httpd_resp_set_status(req, status);
    return httpd_resp_send(req, w->buf, (ssize_t)w->len);
}

static const char *status_text(int code)
{
    switch (code) {
    case 200: return "200 OK";
    case 400: return "400 Bad Request";
    case 404: return "404 Not Found";
    case 413: return "413 Payload Too Large";
    case 415: return "415 Unsupported Media Type";
    default: return "500 Internal Server Error";
    }
}

static esp_err_t send_err(httpd_req_t *req, int code, const char *msg)
{
    jw_t w;
    jw_init(&w, NULL);
    jw_obj(&w);
    jw_kbool(&w, "ok", false);
    jw_kstr(&w, "error", msg);
    jw_obj_end(&w);
    esp_err_t r = send_json(req, &w, status_text(code));
    jw_release(&w, NULL);
    return r;
}

static esp_err_t send_ok_running(httpd_req_t *req, bool running)
{
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    cors(req);
    return httpd_resp_sendstr(req, running ? "{\"ok\":true,\"running\":true}" : "{\"ok\":true,\"running\":false}");
}

static esp_err_t send_ok(httpd_req_t *req)
{
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    cors(req);
    return httpd_resp_sendstr(req, "{\"ok\":true}");
}

/* State changes require a JSON content type (CSRF guard, see cors()). The MIME
 * essence must be exactly application/json: browsers send e.g.
 * "text/plain;application/json" cross-site without a preflight, because its
 * essence is text/plain — a substring test would let that through. */
static bool json_request(httpd_req_t *req)
{
    char ct[96];
    if (httpd_req_get_hdr_value_str(req, "Content-Type", ct, sizeof ct) != ESP_OK) return false;
    char *semi = strchr(ct, ';');
    if (semi) *semi = 0;
    char *s = ct;
    while (*s == ' ' || *s == '\t') s++;
    size_t n = strlen(s);
    while (n && (s[n - 1] == ' ' || s[n - 1] == '\t')) s[--n] = 0;
    return strcasecmp(s, "application/json") == 0;
}

#define REQUIRE_JSON(req)                                                                \
    do {                                                                                 \
        if (!json_request(req)) return send_err(req, 415, "Content-Type must be application/json"); \
    } while (0)

static int read_body(httpd_req_t *req, char *buf, size_t cap)
{
    size_t len = req->content_len;
    if (len >= cap) return -1;
    size_t got = 0;
    int idle = 0;
    while (got < len) {
        int r = httpd_req_recv(req, buf + got, len - got);
        if (r == HTTPD_SOCK_ERR_TIMEOUT && ++idle < 5) continue;
        if (r <= 0) return -2;
        got += (size_t)r;
    }
    buf[got] = 0;
    return (int)got;
}

static void restart_cb(void *arg) { esp_restart(); }

static void restart_later(void)
{
    static esp_timer_handle_t t;
    const esp_timer_create_args_t a = {.callback = restart_cb, .name = "restart"};
    if (!t && esp_timer_create(&a, &t) != ESP_OK) return;
    esp_timer_stop(t);
    esp_timer_start_once(t, 1500 * 1000); /* let the reply go out first */
}

static void cycle_json(jw_t *w, const plc_rt_stats_t *s, uint32_t scan_ms)
{
    jw_key(w, "cycle");
    jw_obj(w);
    jw_kint(w, "scanMs", scan_ms);
    jw_kint(w, "lastUs", s->last_us);
    jw_kint(w, "avgUs", s->avg_us);
    jw_kint(w, "minUs", s->min_us);
    jw_kint(w, "maxUs", s->max_us);
    jw_kint(w, "overruns", s->overruns);
    jw_kint(w, "cycles", s->cycles);
    jw_obj_end(w);
}

static size_t max_program_bytes(void)
{
    size_t m = (size_t)CONFIG_PLC_MAX_PROGRAM_KB * 1024;
    return plc_store_max_len() < m ? plc_store_max_len() : m;
}

/* ---------------------------------------------------------- GET handlers */
static esp_err_t api_info(httpd_req_t *req)
{
    jw_t w;
    jw_init(&w, NULL);
    jw_obj(&w);
    jw_kbool(&w, "ok", true);
    plc_rt_status_t st;
    plc_rt_lock();
    plc_t *e = plc_rt_engine();
    plc_rt_status_locked(&st);
    jw_kbool(&w, "running", st.running);
    jw_kbool(&w, "mock", false);
    jw_kint(&w, "scan", plc_scan_count(e));
    jw_kbool(&w, "hasProgram", st.has_program);
    jw_kstr(&w, "project", st.has_program ? st.name : NULL);
    jw_kint(&w, "programRev", st.rev);
    jw_kint(&w, "errors", plc_error_count(e));
    jw_kstr(&w, "lastError", plc_last_error(e));
    jw_kint(&w, "forced", (long long)plc_forced_count(e));
    jw_kint(&w, "ioPoints", (long long)plc_io_count(e));
    uint32_t scan_ms = plc_scan_ms(e);
    plc_io_status_json(&w); /* "i2c": module status (the list changes with a download) */
    plc_rt_unlock();
    int mp = modbus_tcp_port();
    if (mp) jw_kint(&w, "modbusPort", mp);
    else jw_knull(&w, "modbusPort");
    cycle_json(&w, &st.stats, scan_ms);

    jw_key(&w, "device");
    jw_obj(&w);
    esp_chip_info_t ci;
    esp_chip_info(&ci);
    jw_kstr(&w, "chip", plc_io_chip_name());
    jw_kint(&w, "revision", ci.revision);
    jw_kint(&w, "cores", ci.cores);
    uint32_t fsize = 0;
    esp_flash_get_size(NULL, &fsize);
    jw_kint(&w, "flashMB", fsize >> 20);
    jw_kint(&w, "psramKB", (long long)(heap_caps_get_total_size(MALLOC_CAP_SPIRAM) / 1024));
    const esp_app_desc_t *ad = esp_app_get_description();
    jw_kstr(&w, "firmware", ad->version);
    jw_kstr(&w, "idf", ad->idf_ver);
    char built[40];
    snprintf(built, sizeof built, "%s %s", ad->date, ad->time);
    jw_kstr(&w, "built", built);
    jw_kint(&w, "uptimeS", esp_timer_get_time() / 1000000);
    jw_kint(&w, "heapFree", esp_get_free_heap_size());
    jw_kint(&w, "heapMin", esp_get_minimum_free_heap_size());
    jw_kint(&w, "heapLargest", (long long)heap_caps_get_largest_free_block(MALLOC_CAP_8BIT));
    size_t plen = 0;
    plc_store_has_program(&plen, NULL);
    jw_kint(&w, "storedBytes", (long long)plen);
    jw_kint(&w, "maxProgramBytes", (long long)max_program_bytes());
    jw_obj_end(&w);

    jw_key(&w, "wifi");
    jw_obj(&w);
    wifi_mgr_status_json(&w);
    jw_obj_end(&w);
    jw_obj_end(&w);
    esp_err_t r = send_json(req, &w, NULL);
    jw_release(&w, NULL);
    return r;
}

/* in-place %XX / '+' decoding of a query value */
static void url_decode(char *s)
{
    char *d = s;
    for (; *s; s++) {
        if (*s == '%' && isxdigit((unsigned char)s[1]) && isxdigit((unsigned char)s[2])) {
            char h[3] = {s[1], s[2], 0};
            *d++ = (char)strtol(h, NULL, 16);
            s += 2;
        } else *d++ = *s == '+' ? ' ' : *s;
    }
    *d = 0;
}

/* GET /api/state[?dbs=Name1,Name2]: the snapshot, plus the bytes of the named
 * data blocks (hex) for the IDE's DB view, which decodes them itself */
static esp_err_t api_state(httpd_req_t *req)
{
    jw_t *w = &s_state_w;
    char q[CONFIG_HTTPD_MAX_URI_LEN], dbs[CONFIG_HTTPD_MAX_URI_LEN];
    dbs[0] = 0;
    if (httpd_req_get_url_query_str(req, q, sizeof q) == ESP_OK && httpd_query_key_value(q, "dbs", dbs, sizeof dbs) == ESP_OK)
        url_decode(dbs);
    jw_reset(w);
    jw_obj(w);
    plc_rt_status_t st;
    plc_rt_lock();
    plc_t *e = plc_rt_engine();
    plc_rt_status_locked(&st);
    jw_kbool(w, "running", st.running);
    plc_snapshot_json(e, w);
    if (dbs[0]) {
        jw_key(w, "dbs");
        plc_dbs_json(e, w, dbs);
    }
    uint32_t scan_ms = plc_scan_ms(e);
    plc_rt_unlock();
    jw_kint(w, "programRev", st.rev);
    cycle_json(w, &st.stats, scan_ms);
    jw_obj_end(w);
    return send_json(req, w, NULL);
}

static esp_err_t api_tags(httpd_req_t *req)
{
    jw_t w;
    jw_init(&w, NULL);
    jw_obj(&w);
    jw_kbool(&w, "ok", true);
    plc_rt_status_t st;
    plc_rt_lock();
    plc_rt_status_locked(&st);
    jw_kint(&w, "programRev", st.rev);
    jw_key(&w, "tags");
    plc_tags_json(plc_rt_engine(), &w);
    plc_rt_unlock();
    jw_obj_end(&w);
    esp_err_t r = send_json(req, &w, NULL);
    jw_release(&w, NULL);
    return r;
}

static esp_err_t api_netinfo(httpd_req_t *req)
{
    char sta[16], ap[16], url[64];
    wifi_mgr_ips(sta, ap);
    const char *host = wifi_mgr_hostname();
    jw_t w;
    jw_init(&w, NULL);
    jw_obj(&w);
    jw_kbool(&w, "ok", true);
    jw_kstr(&w, "hostname", host);
    snprintf(url, sizeof url, "%s.local", host);
    jw_kstr(&w, "mdns", url);
    jw_kint(&w, "port", 80);
    int mp = modbus_tcp_port();
    if (mp) jw_kint(&w, "modbusPort", mp);
    else jw_knull(&w, "modbusPort");
    jw_key(&w, "addresses");
    jw_arr(&w);
    if (sta[0]) jw_str(&w, sta);
    if (ap[0]) jw_str(&w, ap);
    jw_arr_end(&w);
    jw_key(&w, "urls");
    jw_arr(&w);
    if (sta[0]) {
        snprintf(url, sizeof url, "http://%s", sta);
        jw_str(&w, url);
        snprintf(url, sizeof url, "http://%s.local", host);
        jw_str(&w, url);
    }
    if (ap[0]) {
        snprintf(url, sizeof url, "http://%s", ap);
        jw_str(&w, url);
    }
    jw_arr_end(&w);
    jw_obj_end(&w);
    esp_err_t r = send_json(req, &w, NULL);
    jw_release(&w, NULL);
    return r;
}

static esp_err_t api_modbus_map(httpd_req_t *req)
{
    jw_t w;
    jw_init(&w, NULL);
    jw_obj(&w);
    jw_kbool(&w, "ok", true);
    int mp = modbus_tcp_port();
    if (mp) jw_kint(&w, "port", mp);
    else jw_knull(&w, "port");
    jw_kint(&w, "bank", MODBUS_BANK);
    jw_key(&w, "map");
    plc_rt_lock();
    plc_modbus_map_json(plc_rt_engine(), &w, MODBUS_BANK);
    plc_rt_unlock();
    jw_obj_end(&w);
    esp_err_t r = send_json(req, &w, NULL);
    jw_release(&w, NULL);
    return r;
}

/* the program's TCON connections (engine view) + the sockets behind them */
static esp_err_t api_ouc(httpd_req_t *req)
{
    jw_t w;
    jw_init(&w, NULL);
    jw_obj(&w);
    jw_kbool(&w, "ok", true);
    jw_key(&w, "conns");
    plc_rt_lock();
    plc_conns_json(plc_rt_engine(), &w);
    plc_rt_unlock();
    jw_key(&w, "sockets");
    ouc_esp_json(&w); /* its own mutex only */
    jw_obj_end(&w);
    esp_err_t r = send_json(req, &w, NULL);
    jw_release(&w, NULL);
    return r;
}

static esp_err_t api_pins(httpd_req_t *req)
{
    jw_t w;
    jw_init(&w, NULL);
    jw_obj(&w);
    jw_kbool(&w, "ok", true);
    plc_io_pins_json(&w);
    jw_obj_end(&w);
    esp_err_t r = send_json(req, &w, NULL);
    jw_release(&w, NULL);
    return r;
}

/* GET /api/program: the stored project, straight out of flash */
static esp_err_t api_program_get(httpd_req_t *req)
{
    const char *text;
    size_t len;
    esp_partition_mmap_handle_t mh;
    if (plc_store_map(&text, &len, &mh) != ESP_OK) return send_err(req, 404, "no program stored on the PLC");
    httpd_resp_set_type(req, "application/json; charset=utf-8");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    cors(req);
    esp_err_t r = ESP_OK;
    for (size_t off = 0; off < len && r == ESP_OK; off += 4096) {
        size_t n = len - off < 4096 ? len - off : 4096;
        r = httpd_resp_send_chunk(req, text + off, (ssize_t)n);
    }
    if (r == ESP_OK) r = httpd_resp_send_chunk(req, NULL, 0);
    plc_store_unmap(mh);
    return r;
}

static esp_err_t api_wifi_get(httpd_req_t *req)
{
    jw_t w;
    jw_init(&w, NULL);
    jw_obj(&w);
    jw_kbool(&w, "ok", true);
    wifi_mgr_status_json(&w);
    jw_obj_end(&w);
    esp_err_t r = send_json(req, &w, NULL);
    jw_release(&w, NULL);
    return r;
}

static esp_err_t api_wifi_scan(httpd_req_t *req)
{
    jw_t w;
    jw_init(&w, NULL);
    jw_obj(&w);
    jw_kbool(&w, "ok", true);
    jw_key(&w, "networks");
    if (wifi_mgr_scan_json(&w) != ESP_OK) {
        jw_release(&w, NULL);
        return send_err(req, 500, "Wi-Fi scan failed - try again");
    }
    jw_obj_end(&w);
    esp_err_t r = send_json(req, &w, NULL);
    jw_release(&w, NULL);
    return r;
}

static esp_err_t api_unknown(httpd_req_t *req) { return send_err(req, 404, "unknown endpoint"); }

/* ---------------------------------------------------------- POST handlers */
static esp_err_t http_reader(void *ctx, char *buf, size_t cap, size_t *got)
{
    httpd_req_t *req = (httpd_req_t *)ctx;
    for (int idle = 0; idle < 6; idle++) {
        int r = httpd_req_recv(req, buf, cap);
        if (r > 0) {
            *got = (size_t)r;
            return ESP_OK;
        }
        if (r != HTTPD_SOCK_ERR_TIMEOUT) break;
    }
    return ESP_FAIL;
}

static esp_err_t api_program_post(httpd_req_t *req)
{
    REQUIRE_JSON(req);
    jw_t w;
    jw_init(&w, NULL);
    int code = plc_rt_download(req->content_len, http_reader, req, &w);
    esp_err_t r = send_json(req, &w, status_text(code));
    jw_release(&w, NULL);
    return r;
}

static esp_err_t api_program_delete(httpd_req_t *req)
{
    REQUIRE_JSON(req);
    if (plc_rt_erase_program() != ESP_OK) return send_err(req, 500, "erase failed");
    return send_ok(req);
}

static esp_err_t api_force(httpd_req_t *req)
{
    REQUIRE_JSON(req);
    char body[512];
    int n = read_body(req, body, sizeof body);
    if (n <= 0) return send_err(req, 400, "missing or oversized body");
    jd_doc_t d;
    if (!jd_parse(&d, body, (size_t)n, NULL) || jd_type(&d, 0) != JD_OBJ) {
        jd_release(&d, NULL);
        return send_err(req, 400, "expected a JSON object {key, value}");
    }
    char key[160];
    jd_str(&d, jd_get(&d, 0, "key"), key, sizeof key);
    int v = jd_get(&d, 0, "value");
    plc_vtype_t t = PLC_V_NULL;
    double val = 0;
    bool bad = false;
    switch (jd_type(&d, v)) {
    case -1:
    case JD_NULL: t = PLC_V_NULL; break; /* release a GPIO force */
    case JD_TRUE: t = PLC_V_BOOL, val = 1; break;
    case JD_FALSE: t = PLC_V_BOOL, val = 0; break;
    case JD_NUM: t = PLC_V_NUM, val = jd_num(&d, v, 0); break;
    case JD_STR: {
        char s[48];
        jd_str(&d, v, s, sizeof s);
        if (!strcasecmp(s, "true") || !strcasecmp(s, "false")) {
            t = PLC_V_BOOL;
            val = !strcasecmp(s, "true");
        } else {
            char *end = NULL;
            val = strtod(s, &end);
            if (!s[0] || !end || *end) bad = true;
            t = PLC_V_NUM;
        }
        break;
    }
    default: bad = true;
    }
    jd_release(&d, NULL);
    if (!key[0]) return send_err(req, 400, "missing key");
    if (bad) return send_err(req, 400, "value must be true/false, a number, or null");
    plc_rt_lock();
    int r = plc_force(plc_rt_engine(), key, t, val);
    plc_rt_unlock();
    if (r < 0) return send_err(req, 400, "not a writable operand");
    return send_ok(req);
}

static esp_err_t api_unforce(httpd_req_t *req)
{
    REQUIRE_JSON(req);
    plc_rt_lock();
    plc_unforce_all(plc_rt_engine());
    plc_rt_unlock();
    return send_ok(req);
}

static esp_err_t api_run(httpd_req_t *req)
{
    REQUIRE_JSON(req);
    return send_ok_running(req, plc_rt_set_running(true));
}

static esp_err_t api_stop(httpd_req_t *req)
{
    REQUIRE_JSON(req);
    return send_ok_running(req, plc_rt_set_running(false));
}

static esp_err_t api_wifi_post(httpd_req_t *req)
{
    REQUIRE_JSON(req);
    char body[256];
    int n = read_body(req, body, sizeof body);
    if (n <= 0) return send_err(req, 400, "missing body");
    jd_doc_t d;
    if (!jd_parse(&d, body, (size_t)n, NULL) || jd_type(&d, 0) != JD_OBJ) {
        jd_release(&d, NULL);
        return send_err(req, 400, "expected {ssid, password}");
    }
    char ssid[64], pass[96];
    size_t sl = jd_str(&d, jd_get(&d, 0, "ssid"), ssid, sizeof ssid);
    size_t pl = jd_str(&d, jd_get(&d, 0, "password"), pass, sizeof pass);
    jd_release(&d, NULL);
    if (sl > 32) return send_err(req, 400, "SSID is longer than 32 characters");
    if (pl > 63 || (pl > 0 && pl < 8)) return send_err(req, 400, "password must be empty or 8..63 characters");
    if (wifi_mgr_set_credentials(ssid, pass) != ESP_OK) return send_err(req, 500, "could not save credentials");
    httpd_resp_set_type(req, "application/json");
    cors(req);
    httpd_resp_sendstr(req, "{\"ok\":true,\"restarting\":true}");
    restart_later();
    return ESP_OK;
}

static esp_err_t api_reboot(httpd_req_t *req)
{
    REQUIRE_JSON(req);
    send_ok(req);
    restart_later();
    return ESP_OK;
}

/* CORS preflight: approve reads only (see cors()) */
static esp_err_t api_options(httpd_req_t *req)
{
    httpd_resp_set_status(req, "204 No Content");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Methods", "GET");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Headers", "Content-Type");
    httpd_resp_set_hdr(req, "Access-Control-Max-Age", "600");
    return httpd_resp_send(req, NULL, 0);
}

/* ---------------------------------------------------------- static IDE */
static esp_err_t static_get(httpd_req_t *req)
{
    char path[128];
    size_t i = 0;
    for (; req->uri[i] && req->uri[i] != '?' && req->uri[i] != '#' && i < sizeof path - 1; i++) path[i] = req->uri[i];
    path[i] = 0;
    if (!strcmp(path, "/")) snprintf(path, sizeof path, "/index.html");
    const web_asset_t *a = NULL;
    for (size_t k = 0; k < web_assets_count; k++)
        if (!strcmp(web_assets[k].path, path)) {
            a = &web_assets[k];
            break;
        }
    if (!a) {
        httpd_resp_set_status(req, "404 Not Found");
        httpd_resp_set_type(req, "text/plain");
        return httpd_resp_sendstr(req, "Not found");
    }
    char inm[48];
    if (httpd_req_get_hdr_value_str(req, "If-None-Match", inm, sizeof inm) == ESP_OK && !strcmp(inm, web_assets_etag)) {
        httpd_resp_set_status(req, "304 Not Modified");
        httpd_resp_set_hdr(req, "ETag", web_assets_etag);
        return httpd_resp_send(req, NULL, 0);
    }
    httpd_resp_set_type(req, a->mime);
    httpd_resp_set_hdr(req, "Content-Encoding", "gzip");
    httpd_resp_set_hdr(req, "Cache-Control", "no-cache");
    httpd_resp_set_hdr(req, "ETag", web_assets_etag);
    return httpd_resp_send(req, (const char *)a->data, (ssize_t)a->len);
}

/* ---------------------------------------------------------- start */
esp_err_t web_server_start(void)
{
    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.max_uri_handlers = 32;
    cfg.stack_size = 16384; /* a download compiles the program on this task */
    cfg.uri_match_fn = httpd_uri_match_wildcard;
    cfg.lru_purge_enable = true;
    cfg.max_open_sockets = 10;
    cfg.core_id = 0;
    cfg.recv_wait_timeout = 10;
    cfg.send_wait_timeout = 10;
    jw_init(&s_state_w, NULL);

    esp_err_t err = httpd_start(&s_server, &cfg);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start: %s", esp_err_to_name(err));
        return err;
    }
    static const struct {
        const char *uri;
        httpd_method_t method;
        esp_err_t (*fn)(httpd_req_t *);
    } routes[] = {
        {"/api/info", HTTP_GET, api_info},
        {"/api/state", HTTP_GET, api_state},
        {"/api/tags", HTTP_GET, api_tags},
        {"/api/netinfo", HTTP_GET, api_netinfo},
        {"/api/modbus-map", HTTP_GET, api_modbus_map},
        {"/api/ouc", HTTP_GET, api_ouc},
        {"/api/pins", HTTP_GET, api_pins},
        {"/api/program", HTTP_GET, api_program_get},
        {"/api/program", HTTP_POST, api_program_post},
        {"/api/program", HTTP_DELETE, api_program_delete},
        {"/api/force", HTTP_POST, api_force},
        {"/api/unforce", HTTP_POST, api_unforce},
        {"/api/run", HTTP_POST, api_run},
        {"/api/stop", HTTP_POST, api_stop},
        {"/api/wifi", HTTP_GET, api_wifi_get},
        {"/api/wifi/scan", HTTP_GET, api_wifi_scan},
        {"/api/wifi", HTTP_POST, api_wifi_post},
        {"/api/reboot", HTTP_POST, api_reboot},
        {"/api/*", HTTP_OPTIONS, api_options},
        {"/api/*", HTTP_GET, api_unknown},
        {"/*", HTTP_GET, static_get},
    };
    for (size_t i = 0; i < sizeof routes / sizeof routes[0]; i++) {
        httpd_uri_t u = {.uri = routes[i].uri, .method = routes[i].method, .handler = routes[i].fn};
        httpd_register_uri_handler(s_server, &u);
    }
    ESP_LOGI(TAG, "web IDE + API on port 80 (%u assets, etag %s)", (unsigned)web_assets_count, web_assets_etag);
    return ESP_OK;
}
