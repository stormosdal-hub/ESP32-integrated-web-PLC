/* ============================================================================
 * web_server — serves the IDE and the PLC's JSON API on port 80.
 *
 * API (compatible with plc_server.py from the Raspberry-Pi version):
 *   GET  /api/info         CPU / program / device / Wi-Fi status
 *   GET  /api/state        live snapshot for online monitoring
 *   GET  /api/tags         declared tags
 *   GET  /api/netinfo      how to reach this PLC
 *   GET  /api/modbus-map   tag -> Modbus address
 *   POST /api/program      download a project (JSON body) -> compile, store, RUN
 *   POST /api/force        {key, value}; value null releases a GPIO force
 *   POST /api/run | /api/stop
 * ESP32 additions:
 *   GET  /api/program      upload the stored project (TIA "upload from device")
 *   DELETE /api/program    erase it
 *   POST /api/unforce      release every force
 *   GET  /api/pins         this board's usable GPIOs
 *   GET  /api/wifi, GET /api/wifi/scan, POST /api/wifi {ssid,password}
 *   POST /api/reboot
 * ==========================================================================*/
#pragma once

#include "esp_err.h"

esp_err_t web_server_start(void);
