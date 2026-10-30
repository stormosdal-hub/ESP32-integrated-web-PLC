/* ============================================================================
 * wifi_mgr — network bring-up for the PLC.
 *
 *  - joins the configured network (credentials saved from the web UI in NVS,
 *    else the menuconfig defaults) and keeps reconnecting;
 *  - opens a setup access point "ESP32-PLC-XXXX" (http://192.168.4.1) when no
 *    network is configured or it cannot be joined, and closes it again once
 *    the station is connected and nobody uses the AP;
 *  - announces <hostname>.local over mDNS.
 * ==========================================================================*/
#pragma once

#include <stdbool.h>

#include "esp_err.h"
#include "jw.h"

esp_err_t wifi_mgr_start(void);
bool wifi_mgr_sta_connected(void);
bool wifi_mgr_ap_active(void);
const char *wifi_mgr_hostname(void);
/* station / AP IPv4 as text ("" when down) */
void wifi_mgr_ips(char sta[16], char ap[16]);
/* members describing the network state, into the object open in w */
void wifi_mgr_status_json(jw_t *w);
/* blocking scan (~2 s): emits an array of {ssid,rssi,secure,channel} */
esp_err_t wifi_mgr_scan_json(jw_t *w);
/* store new station credentials (applied after a restart) */
esp_err_t wifi_mgr_set_credentials(const char *ssid, const char *password);
