/* ============================================================================
 * ESP32 Web PLC — a TIA-Portal-style PLC you program from the browser.
 *
 * The ESP32-S3 / ESP32 serves the IDE (LAD / FBD / SCL editors + simulator) and runs
 * the downloaded program on its own GPIO, like a small S7-1200:
 *
 *   browser ──HTTP──> web_server ──> plc_runtime ──> plc_core (the engine)
 *                                        │  scan task (core 1)
 *                                        └─> plc_io_esp (GPIO / PWM / ADC)
 *   SCADA  ──Modbus TCP──> modbus_tcp ──> same I/Q/M memory
 *   TCP partners <──TCON/TSEND/TRCV──> ouc_esp (socket task) <── scan
 *
 * Boot: NVS -> storage -> OUC sockets -> runtime (stored program, auto RUN)
 *       -> Wi-Fi -> web.
 * ==========================================================================*/
#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "modbus_tcp.h"
#include "nvs_flash.h"
#include "ouc_esp.h"
#include "plc_io_esp.h"
#include "plc_runtime.h"
#include "plc_store.h"
#include "status_led.h"
#include "web_server.h"
#include "wifi_mgr.h"

static const char *TAG = "main";

void app_main(void)
{
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    ESP_ERROR_CHECK(err);
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    plc_io_board_init(status_led_pin());
    if (plc_store_init() != ESP_OK) ESP_LOGE(TAG, "program storage unavailable - downloads will fail");
    /* before the runtime: a program loaded at boot gets the TCP transport */
    if (ouc_esp_init() != ESP_OK) ESP_LOGE(TAG, "Open User Communication unavailable (out of memory)");
    ESP_ERROR_CHECK(plc_rt_init());
    status_led_start();

    ESP_ERROR_CHECK(wifi_mgr_start());
    ESP_ERROR_CHECK(web_server_start());
    modbus_tcp_start();
    ESP_LOGI(TAG, "%s Web PLC ready - browse to http://%s.local (or the IP above)", plc_io_chip_name(), wifi_mgr_hostname());
}
