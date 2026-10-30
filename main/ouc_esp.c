/* ouc_esp.c — see ouc_esp.h */
#include "ouc_esp.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "ouc_net.h"
#include "sdkconfig.h"

static const char *TAG = "ouc";

static ouc_net_t *s_net;
static SemaphoreHandle_t s_mx; /* slot state: scan-side callbacks vs. the poll pass */

static void mx_lock(void *ctx) { xSemaphoreTake(s_mx, portMAX_DELAY); }
static void mx_unlock(void *ctx) { xSemaphoreGive(s_mx); }

static void ouc_task(void *arg)
{
    /* waits in select() (10 ms at most, so a TSEND goes out within that) and
     * sleeps the same while no connection is open */
    for (;;) ouc_net_poll(s_net, 10);
}

esp_err_t ouc_esp_init(void)
{
    if (s_net) return ESP_OK;
    s_mx = xSemaphoreCreateMutex();
    if (!s_mx) return ESP_ERR_NO_MEM;
    const ouc_net_cfg_t cfg = {.rx_buf = CONFIG_PLC_OUC_RX_BUF, .lock = mx_lock, .unlock = mx_unlock};
    s_net = ouc_net_create(&cfg);
    if (!s_net) return ESP_ERR_NO_MEM;
    /* core 0: there on every chip (C3 / C6 have no core 1), next to lwIP and
     * Wi-Fi; on dual-core chips the scan task keeps core 1 to itself */
    if (xTaskCreatePinnedToCore(ouc_task, "plc_ouc", 4096, NULL, CONFIG_PLC_OUC_TASK_PRIORITY, NULL, 0) != pdPASS) {
        ouc_net_destroy(s_net);
        s_net = NULL;
        return ESP_ERR_NO_MEM;
    }
    ESP_LOGI(TAG, "Open User Communication: %d TCP connections, %d-byte receive buffers", PLC_MAX_CONNS,
             CONFIG_PLC_OUC_RX_BUF);
    return ESP_OK;
}

const plc_net_t *ouc_esp_net(void) { return ouc_net_ops(s_net); }

void ouc_esp_json(jw_t *w) { ouc_net_json(s_net, w); }
