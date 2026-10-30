/* wifi_mgr.c — see wifi_mgr.h
 *
 * All Wi-Fi API calls happen on the default event loop task: the esp_timer
 * callbacks only post private events (esp_timer callbacks must not block, and
 * esp_wifi_set_mode / esp_wifi_connect wait on the Wi-Fi task). */
#include "wifi_mgr.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "esp_event.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "esp_netif.h"
#include "esp_timer.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "mdns.h"
#include "nvs.h"
#include "plc_io_esp.h"
#include "sdkconfig.h"
#include "soc/soc_caps.h"

static const char *TAG = "wifi";

ESP_EVENT_DEFINE_BASE(PLCWIFI_EVENT);
enum { EV_FALLBACK, EV_APOFF, EV_RETRY };

static esp_netif_t *s_sta_if, *s_ap_if;
static char s_ssid[33], s_pass[65], s_host[32], s_ap_ssid[33];
static wifi_config_t s_apcfg;
static volatile bool s_connected, s_ap_on;
static volatile int s_ap_clients;
static esp_ip4_addr_t s_ip;
static esp_timer_handle_t s_retry_t, s_fallback_t, s_apoff_t;
static int s_retry_ms = 1000;

/* ---------------------------------------------------------- credentials */
static void load_credentials(void)
{
    nvs_handle_t h;
    if (nvs_open("wifi", NVS_READONLY, &h) == ESP_OK) {
        size_t n = sizeof s_ssid;
        if (nvs_get_str(h, "ssid", s_ssid, &n) != ESP_OK) s_ssid[0] = 0;
        n = sizeof s_pass;
        if (nvs_get_str(h, "pass", s_pass, &n) != ESP_OK) s_pass[0] = 0;
        nvs_close(h);
    }
    if (!s_ssid[0]) {
        snprintf(s_ssid, sizeof s_ssid, "%s", CONFIG_PLC_WIFI_SSID);
        snprintf(s_pass, sizeof s_pass, "%s", CONFIG_PLC_WIFI_PASSWORD);
    }
}

esp_err_t wifi_mgr_set_credentials(const char *ssid, const char *password)
{
    nvs_handle_t h;
    esp_err_t err = nvs_open("wifi", NVS_READWRITE, &h);
    if (err != ESP_OK) return err;
    err = nvs_set_str(h, "ssid", ssid ? ssid : "");
    if (err == ESP_OK) err = nvs_set_str(h, "pass", password ? password : "");
    if (err == ESP_OK) err = nvs_commit(h);
    nvs_close(h);
    ESP_LOGI(TAG, "credentials saved for \"%s\"", ssid ? ssid : "");
    return err;
}

/* ---------------------------------------------------------- timers */
static void arm(esp_timer_handle_t t, uint32_t ms)
{
    esp_timer_stop(t);
    esp_timer_start_once(t, (uint64_t)ms * 1000);
}

/* esp_timer task: never block here, just hand over to the event loop */
static void timer_cb(void *arg)
{
    int32_t id = (int32_t)(intptr_t)arg;
    if (esp_event_post(PLCWIFI_EVENT, id, NULL, 0, 0) != ESP_OK) {
        esp_timer_handle_t t = id == EV_FALLBACK ? s_fallback_t : id == EV_APOFF ? s_apoff_t : s_retry_t;
        esp_timer_start_once(t, 1000 * 1000); /* event queue full: try again */
    }
}

/* ---------------------------------------------------------- AP on/off */
static void log_ap(void)
{
    ESP_LOGW(TAG, "setup access point \"%s\" up -> http://192.168.4.1  (password: %s)", s_ap_ssid,
             s_apcfg.ap.authmode == WIFI_AUTH_OPEN ? "none" : CONFIG_PLC_AP_PASSWORD);
}

/* event loop task. The AP was configured before esp_wifi_start(), so turning
 * it on is a mode switch and it never transmits the driver's default (open)
 * configuration. Returns false when the switch did not happen. */
static bool ap_enable(bool on)
{
    if (on == s_ap_on) return true;
    esp_err_t err = esp_wifi_set_mode(on ? WIFI_MODE_APSTA : WIFI_MODE_STA);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "could not %s the setup AP: %s", on ? "open" : "close", esp_err_to_name(err));
        return false;
    }
    s_ap_on = on;
    if (on) {
        /* refresh the stored AP settings; while the station is still
         * connecting this may be refused, and the boot-time config applies */
        esp_err_t e2 = esp_wifi_set_config(WIFI_IF_AP, &s_apcfg);
        if (e2 != ESP_OK) ESP_LOGD(TAG, "AP config refresh deferred: %s", esp_err_to_name(e2));
        log_ap();
    } else {
        ESP_LOGI(TAG, "setup access point closed");
    }
    return true;
}

/* ---------------------------------------------------------- events */
/* plain-language cause of a failed join (wifi_err_reason_t) */
static const char *why(int reason)
{
    switch (reason) {
    case WIFI_REASON_AUTH_EXPIRE:
        return "the router did not answer (weak signal at the router: antenna, power supply or distance?)";
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_MIC_FAILURE:
        return "wrong password?";
    case WIFI_REASON_AUTH_FAIL:
        return "login refused (wrong password, or a WPA3-only network?)";
    case WIFI_REASON_NO_AP_FOUND:
    case WIFI_REASON_NO_AP_FOUND_W_COMPATIBLE_SECURITY:
    case WIFI_REASON_NO_AP_FOUND_IN_AUTHMODE_THRESHOLD:
    case WIFI_REASON_NO_AP_FOUND_IN_RSSI_THRESHOLD:
        return "network not found (it must be 2.4 GHz; check the name)";
    case WIFI_REASON_BEACON_TIMEOUT:
        return "signal lost";
    case WIFI_REASON_ASSOC_FAIL:
    case WIFI_REASON_CONNECTION_FAIL:
        return "the router refused the connection";
    default:
        return "connection failed";
    }
}

static void on_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    if (base == PLCWIFI_EVENT) {
        switch (id) {
        case EV_FALLBACK:
            if (!s_connected && !s_ap_on) {
                ESP_LOGW(TAG, "no connection to \"%s\" - opening the setup access point", s_ssid);
                if (!ap_enable(true)) arm(s_fallback_t, 5000);
            }
            break;
        case EV_APOFF:
            if (s_connected && s_ap_on && s_ap_clients == 0 && s_ssid[0] && !ap_enable(false)) arm(s_apoff_t, 10000);
            break;
        case EV_RETRY:
            if (!s_connected && s_ssid[0] && esp_wifi_connect() != ESP_OK) arm(s_retry_t, 2000);
            break;
        }
    } else if (base == WIFI_EVENT) {
        switch (id) {
        case WIFI_EVENT_STA_START:
            if (s_ssid[0]) esp_wifi_connect();
            break;
        case WIFI_EVENT_STA_DISCONNECTED: {
            const wifi_event_sta_disconnected_t *ev = (const wifi_event_sta_disconnected_t *)data;
            if (s_ssid[0])
                ESP_LOGW(TAG, "%s \"%s\": %s (reason %d, signal %d dBm)", s_connected ? "lost" : "could not join", s_ssid,
                         why(ev->reason), ev->reason, ev->rssi);
            s_connected = false;
            s_ip.addr = 0;
            if (s_ssid[0]) {
                arm(s_retry_t, (uint32_t)s_retry_ms);
                /* back off; slower while the setup AP is serving someone */
                int cap = s_ap_on ? 30000 : 10000;
                s_retry_ms = s_retry_ms * 2 > cap ? cap : s_retry_ms * 2;
                /* also after a later outage: reopen the setup AP if this lasts */
                if (!s_ap_on && !esp_timer_is_active(s_fallback_t))
                    arm(s_fallback_t, (uint32_t)CONFIG_PLC_AP_FALLBACK_SEC * 1000);
            }
            break;
        }
        case WIFI_EVENT_AP_STACONNECTED:
            s_ap_clients++;
            esp_timer_stop(s_apoff_t);
            break;
        case WIFI_EVENT_AP_STADISCONNECTED:
            if (s_ap_clients > 0) s_ap_clients--;
            if (s_connected && s_ap_on && s_ap_clients == 0) arm(s_apoff_t, 10000);
            break;
        default: break;
        }
    } else if (base == IP_EVENT && id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *ev = (ip_event_got_ip_t *)data;
        s_ip = ev->ip_info.ip;
        s_connected = true;
        s_retry_ms = 1000;
        esp_timer_stop(s_fallback_t);
        ESP_LOGI(TAG, "connected to \"%s\" - open http://" IPSTR "  or  http://%s.local", s_ssid, IP2STR(&s_ip), s_host);
        if (s_ap_on && s_ap_clients == 0) arm(s_apoff_t, 10000);
    }
}

/* ---------------------------------------------------------- start */
esp_err_t wifi_mgr_start(void)
{
    load_credentials();
    snprintf(s_host, sizeof s_host, "%s", CONFIG_PLC_HOSTNAME);
    uint8_t mac[6] = {0};
#if SOC_WIFI_SUPPORTED
    esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
#else
    /* the radio is the companion C6 (esp_hosted); the P4's own MAC still
     * makes the setup AP's name unique */
    esp_read_mac(mac, ESP_MAC_BASE);
#endif
    snprintf(s_ap_ssid, sizeof s_ap_ssid, "%s-%02X%02X", CONFIG_PLC_AP_SSID, mac[4], mac[5]);

    s_sta_if = esp_netif_create_default_wifi_sta();
    s_ap_if = esp_netif_create_default_wifi_ap();
    esp_netif_set_hostname(s_sta_if, s_host);

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));
    ESP_ERROR_CHECK(esp_wifi_set_storage(WIFI_STORAGE_RAM));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_event, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(PLCWIFI_EVENT, ESP_EVENT_ANY_ID, on_event, NULL, NULL));

    const esp_timer_create_args_t r = {.callback = timer_cb, .arg = (void *)(intptr_t)EV_RETRY, .name = "wifi_retry"};
    const esp_timer_create_args_t f = {.callback = timer_cb, .arg = (void *)(intptr_t)EV_FALLBACK, .name = "wifi_fallback"};
    const esp_timer_create_args_t a = {.callback = timer_cb, .arg = (void *)(intptr_t)EV_APOFF, .name = "wifi_apoff"};
    ESP_ERROR_CHECK(esp_timer_create(&r, &s_retry_t));
    ESP_ERROR_CHECK(esp_timer_create(&f, &s_fallback_t));
    ESP_ERROR_CHECK(esp_timer_create(&a, &s_apoff_t));

    /* configure the setup AP once, before anything is on air */
    size_t sl = strnlen(s_ap_ssid, sizeof s_apcfg.ap.ssid);
    memcpy(s_apcfg.ap.ssid, s_ap_ssid, sl); /* 32-byte field, not NUL-terminated when full */
    s_apcfg.ap.ssid_len = (uint8_t)sl;
    size_t pl = strnlen(CONFIG_PLC_AP_PASSWORD, sizeof s_apcfg.ap.password - 1);
    memcpy(s_apcfg.ap.password, CONFIG_PLC_AP_PASSWORD, pl);
    s_apcfg.ap.authmode = pl >= 8 ? WIFI_AUTH_WPA2_PSK : WIFI_AUTH_OPEN;
    s_apcfg.ap.max_connection = 4;
    s_apcfg.ap.channel = 1;
    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_APSTA)); /* not started yet: nothing transmits */
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_AP, &s_apcfg));

    if (s_ssid[0]) {
        wifi_config_t sta = {0};
        memcpy(sta.sta.ssid, s_ssid, strnlen(s_ssid, sizeof sta.sta.ssid));
        memcpy(sta.sta.password, s_pass, strnlen(s_pass, sizeof sta.sta.password));
        sta.sta.threshold.authmode = s_pass[0] ? WIFI_AUTH_WPA_PSK : WIFI_AUTH_OPEN;
        sta.sta.pmf_cfg.capable = true;
        ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta));
        ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
        ESP_ERROR_CHECK(esp_wifi_start());
        arm(s_fallback_t, (uint32_t)CONFIG_PLC_AP_FALLBACK_SEC * 1000);
        ESP_LOGI(TAG, "joining \"%s\" ...", s_ssid);
    } else {
        /* setup mode: AP + idle station (the station lets the setup page scan) */
        ESP_ERROR_CHECK(esp_wifi_start());
        s_ap_on = true;
        ESP_LOGW(TAG, "no Wi-Fi configured");
        log_ap();
    }
    esp_wifi_set_ps(WIFI_PS_NONE); /* snappy monitoring beats the few mA saved */
#if CONFIG_PLC_WIFI_MAX_TX_POWER < 20
    /* boards with a poor antenna or supply can only talk at reduced power */
    if (esp_wifi_set_max_tx_power((int8_t)(CONFIG_PLC_WIFI_MAX_TX_POWER * 4)) == ESP_OK)
        ESP_LOGI(TAG, "transmit power limited to %d dBm", CONFIG_PLC_WIFI_MAX_TX_POWER);
#endif

    if (mdns_init() == ESP_OK) {
        mdns_hostname_set(s_host);
        char name[40];
        snprintf(name, sizeof name, "%s Web PLC", plc_io_chip_name());
        mdns_instance_name_set(name);
        mdns_service_add(name, "_http", "_tcp", 80, NULL, 0);
    }
    return ESP_OK;
}

bool wifi_mgr_sta_connected(void) { return s_connected; }
bool wifi_mgr_ap_active(void) { return s_ap_on; }
const char *wifi_mgr_hostname(void) { return s_host; }

void wifi_mgr_ips(char sta[16], char ap[16])
{
    sta[0] = ap[0] = 0;
    if (s_connected) snprintf(sta, 16, IPSTR, IP2STR(&s_ip));
    if (s_ap_on) {
        esp_netif_ip_info_t info;
        if (esp_netif_get_ip_info(s_ap_if, &info) == ESP_OK) snprintf(ap, 16, IPSTR, IP2STR(&info.ip));
    }
}

void wifi_mgr_status_json(jw_t *w)
{
    char sta[16], ap[16];
    wifi_mgr_ips(sta, ap);
    jw_kstr(w, "hostname", s_host);
    jw_kstr(w, "ssid", s_ssid);
    jw_kbool(w, "connected", s_connected);
    jw_kstr(w, "ip", sta[0] ? sta : NULL);
    int rssi = 0;
    if (s_connected) {
        wifi_ap_record_t rec;
        if (esp_wifi_sta_get_ap_info(&rec) == ESP_OK) rssi = rec.rssi;
    }
    if (s_connected) jw_kint(w, "rssi", rssi);
    else jw_knull(w, "rssi");
    jw_key(w, "ap");
    jw_obj(w);
    jw_kbool(w, "active", s_ap_on);
    jw_kstr(w, "ssid", s_ap_ssid);
    jw_kstr(w, "ip", ap[0] ? ap : NULL);
    jw_kint(w, "clients", s_ap_clients);
    jw_obj_end(w);
}

esp_err_t wifi_mgr_scan_json(jw_t *w)
{
    wifi_scan_config_t sc = {.show_hidden = false};
    esp_err_t err = ESP_FAIL;
    for (int tries = 0; tries < 4; tries++) {
        err = esp_wifi_scan_start(&sc, true);
        if (err == ESP_OK) break;
        vTaskDelay(pdMS_TO_TICKS(600)); /* station busy connecting: try again */
    }
    if (err != ESP_OK) return err;
    uint16_t n = 24;
    wifi_ap_record_t *recs = (wifi_ap_record_t *)calloc(n, sizeof *recs);
    if (!recs) {
        esp_wifi_clear_ap_list();
        return ESP_ERR_NO_MEM;
    }
    esp_wifi_scan_get_ap_records(&n, recs);
    jw_arr(w);
    for (int i = 0; i < n; i++) {
        if (!recs[i].ssid[0]) continue;
        bool dup = false; /* one row per SSID (strongest first in the list) */
        for (int k = 0; k < i; k++) dup |= strcmp((char *)recs[k].ssid, (char *)recs[i].ssid) == 0;
        if (dup) continue;
        jw_obj(w);
        jw_kstr(w, "ssid", (const char *)recs[i].ssid);
        jw_kint(w, "rssi", recs[i].rssi);
        jw_kbool(w, "secure", recs[i].authmode != WIFI_AUTH_OPEN);
        jw_kint(w, "channel", recs[i].primary);
        jw_obj_end(w);
    }
    jw_arr_end(w);
    free(recs);
    return ESP_OK;
}
