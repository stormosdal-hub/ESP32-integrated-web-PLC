/* status_led.c — see status_led.h */
#include "status_led.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "plc_runtime.h"
#include "sdkconfig.h"
#include "wifi_mgr.h"

#if CONFIG_PLC_STATUS_LED_WS2812
#include "driver/rmt_encoder.h"
#include "driver/rmt_tx.h"
#include "soc/soc_caps.h"
#elif CONFIG_PLC_STATUS_LED_GPIO
#include "driver/gpio.h"
#endif

#if !CONFIG_PLC_STATUS_LED_NONE
static const char *TAG = "status_led";
#endif

int status_led_pin(void)
{
#if CONFIG_PLC_STATUS_LED_NONE
    return -1;
#else
    return CONFIG_PLC_STATUS_LED_PIN;
#endif
}

#if CONFIG_PLC_STATUS_LED_WS2812
static rmt_channel_handle_t s_ch;
static rmt_encoder_handle_t s_enc;

static void led_rgb(uint8_t r, uint8_t g, uint8_t b)
{
    /* static: the RMT driver reads the payload until the frame is out */
    static uint8_t grb[3];
    grb[0] = g;
    grb[1] = r;
    grb[2] = b;
    rmt_transmit_config_t tc = {.loop_count = 0};
    if (rmt_transmit(s_ch, s_enc, grb, sizeof grb, &tc) == ESP_OK) rmt_tx_wait_all_done(s_ch, -1); /* ~30 us */
}

static esp_err_t led_init(void)
{
    rmt_tx_channel_config_t cfg = {
        .gpio_num = CONFIG_PLC_STATUS_LED_PIN,
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10 * 1000 * 1000, /* 0.1 us ticks */
        .mem_block_symbols = SOC_RMT_MEM_WORDS_PER_CHANNEL, /* one block: 48 on the S3, 64 on the ESP32 */
        .trans_queue_depth = 2,
    };
    esp_err_t err = rmt_new_tx_channel(&cfg, &s_ch);
    if (err != ESP_OK) return err;
    rmt_bytes_encoder_config_t ec = {
        .bit0 = {.level0 = 1, .duration0 = 3, .level1 = 0, .duration1 = 9}, /* 0.3 us high, 0.9 us low */
        .bit1 = {.level0 = 1, .duration0 = 9, .level1 = 0, .duration1 = 3}, /* 0.9 us high, 0.3 us low */
        .flags.msb_first = 1,
    };
    err = rmt_new_bytes_encoder(&ec, &s_enc);
    if (err == ESP_OK) err = rmt_enable(s_ch);
    return err;
}
#elif CONFIG_PLC_STATUS_LED_GPIO
#ifdef CONFIG_PLC_STATUS_LED_ACTIVE_LOW /* a disabled bool is absent from sdkconfig.h */
#define LED_INVERT 1
#else
#define LED_INVERT 0
#endif
static void led_on(bool on)
{
    gpio_set_level(CONFIG_PLC_STATUS_LED_PIN, on ^ LED_INVERT);
}

static esp_err_t led_init(void)
{
    gpio_reset_pin(CONFIG_PLC_STATUS_LED_PIN);
    gpio_set_direction(CONFIG_PLC_STATUS_LED_PIN, GPIO_MODE_OUTPUT);
    led_on(false);
    return ESP_OK;
}
#endif

#if !CONFIG_PLC_STATUS_LED_NONE
static void led_task(void *arg)
{
    for (uint32_t tick = 0;; tick++) { /* 100 ms per tick */
        bool has = plc_rt_has_program();
        bool run = plc_rt_running();
        bool forced = plc_rt_forced_count() > 0;
#if CONFIG_PLC_STATUS_LED_WS2812
        bool setup = wifi_mgr_ap_active() && !wifi_mgr_sta_connected();
        const uint8_t B = 24; /* brightness: a WS2812 is blinding at full */
        if (setup && (tick % 20) < 3) led_rgb(B, 0, B);                       /* purple flash */
        else if (forced && (tick % 5) < 2) led_rgb(B, B, 0);                  /* yellow blink */
        else if (!has) led_rgb(0, 0, B);                                      /* blue */
        else if (run) led_rgb(0, B, 0);                                       /* green */
        else led_rgb(B, B / 3, 0);                                            /* orange */
#else
        if (!has) led_on((tick % 2) == 0);      /* fast blink */
        else if (run) led_on(!forced || (tick % 5) >= 2);
        else led_on((tick % 10) < 5);           /* slow blink */
#endif
        vTaskDelay(pdMS_TO_TICKS(100));
    }
}
#endif

esp_err_t status_led_start(void)
{
#if CONFIG_PLC_STATUS_LED_NONE
    return ESP_OK;
#else
    esp_err_t err = led_init();
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "status LED on GPIO%d unavailable (%s)", CONFIG_PLC_STATUS_LED_PIN, esp_err_to_name(err));
        return err;
    }
    xTaskCreatePinnedToCore(led_task, "status_led", 3072, NULL, 2, NULL, 0);
    return ESP_OK;
#endif
}
