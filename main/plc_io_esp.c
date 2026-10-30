/* plc_io_esp.c — see plc_io_esp.h */
#include "plc_io_esp.h"

#include <math.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/gpio.h"
#include "driver/i2c_master.h"
#include "driver/ledc.h"
#include "esp_adc/adc_cali.h"
#include "esp_adc/adc_cali_scheme.h"
#include "esp_adc/adc_oneshot.h"
#include "esp_log.h"
#include "esp_private/esp_gpio_reserve.h"
#include "esp_rom_sys.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "i2c_dev.h"
#include "sdkconfig.h"
#include "shiftreg.h"
#include "soc/soc_caps.h"
#if CONFIG_IDF_TARGET_ESP32S3
#include "esp_efuse.h"
#include "esp_efuse_table.h"
#endif
#if CONFIG_SPIRAM
#include "esp_psram.h"
#endif
#if CONFIG_IDF_TARGET_ESP32P4
#include "esp_ldo_regulator.h"
#endif

static const char *TAG = "plc_io";

/* Everything chip-specific about pins lives in this file: CHIP_NAME,
 * PSRAM_PINS, BOOT_PIN, BOARD_LAYOUT (the IDE's drawing; "" = by chip) and
 * board_classify() / board_warnings() / board_power() below. */
#if CONFIG_IDF_TARGET_ESP32S3
#define CHIP_NAME "ESP32-S3"
#define PSRAM_PINS "GPIO33-37"
#define BOOT_PIN 0
#define BOARD_LAYOUT ""
#elif CONFIG_IDF_TARGET_ESP32
#define CHIP_NAME "ESP32"
#define PSRAM_PINS "GPIO16-17"
#define BOOT_PIN 0
#define BOARD_LAYOUT ""
#elif CONFIG_IDF_TARGET_ESP32P4
#define CHIP_NAME "ESP32-P4"
#define PSRAM_PINS "none" /* in-package PSRAM and flash have their own pads */
#define BOOT_PIN 35
#if CONFIG_PLC_P4_BOARD_WS_NANO
#define BOARD_LAYOUT "ws-p4-nano"
#elif CONFIG_PLC_P4_BOARD_WS_MODULE
#define BOARD_LAYOUT "ws-p4-module-devkit"
#elif CONFIG_PLC_P4_BOARD_WS_WIFI6
#define BOARD_LAYOUT "ws-p4-wifi6"
#else
#define BOARD_LAYOUT ""
#endif
#elif CONFIG_IDF_TARGET_ESP32C3
#define CHIP_NAME "ESP32-C3"
#define PSRAM_PINS "none"
#define BOOT_PIN 9
#define BOARD_LAYOUT "" /* drawn as the C3 SuperMini */
#elif CONFIG_IDF_TARGET_ESP32C6
#define CHIP_NAME "ESP32-C6"
#define PSRAM_PINS "none"
#define BOOT_PIN 9
#define BOARD_LAYOUT "" /* drawn as the ESP32-C6-DevKitC-1 */
#else
#error "No pin knowledge for this chip yet: add it to main/plc_io_esp.c"
#endif

#define NGPIO SOC_GPIO_PIN_COUNT
#define LEDC_MODE LEDC_LOW_SPEED_MODE /* the one mode every chip has */
#define N_LEDC_TIMERS SOC_LEDC_TIMER_NUM
#define N_LEDC_CHANNELS SOC_LEDC_CHANNEL_NUM
#define PWM_MIN_HZ 5
#define PWM_MAX_HZ 40000
#define PWM_FULL_ON UINT32_MAX /* duty marker: channel stopped with its output held HIGH */
#define ADC_ATTEN ADC_ATTEN_DB_12

/* ------------------------------------------------------- board knowledge */
static const char *s_reserved[NGPIO]; /* why a pin can't be used */
static const char *s_warn[NGPIO];     /* usable, but mind this */
static bool s_psram_pins;             /* PSRAM_PINS belong to the module's PSRAM */
static int s_led_pin = -1;
static char s_adc_pins[48];           /* where analog inputs may go, e.g. "GPIO1-10" */

const char *plc_io_chip_name(void) { return CHIP_NAME; }

/* input-only pads (ESP32 GPIO34-39) have no pull resistors either */
static bool has_pulls(int g) { return GPIO_IS_VALID_OUTPUT_GPIO(g); }

/* a board table's more specific note wins over these generic ones */
static void warn_pin(int g, const char *msg)
{
    if (g >= 0 && g < NGPIO && !s_reserved[g] && !s_warn[g]) s_warn[g] = msg;
}

static bool detect_psram_pins(void)
{
#if CONFIG_PLC_PSRAM_PINS_RESERVED
    return true;
#elif CONFIG_PLC_PSRAM_PINS_FREE
    return false;
#elif CONFIG_IDF_TARGET_ESP32P4 || CONFIG_IDF_TARGET_ESP32C3 || CONFIG_IDF_TARGET_ESP32C6
    return false; /* no PSRAM on GPIOs (P4: own pads; C3/C6: none) */
#elif CONFIG_IDF_TARGET_ESP32S3
#if CONFIG_SPIRAM_MODE_OCT || CONFIG_ESPTOOLPY_OCT_FLASH
    return true;
#else
    /* in-package PSRAM: 8 MB and 16 MB parts (S3R8 / S3R16V) are octal */
    uint8_t cap = 0;
    if (esp_efuse_read_field_blob(ESP_EFUSE_PSRAM_CAP, &cap, 3) != ESP_OK) return false;
    return cap == 1 || cap == 3;
#endif
#else
    /* ESP32: WROVER's PSRAM chip is not in eFuse; it is only known once the
     * firmware has PSRAM enabled and found it */
#if CONFIG_SPIRAM
    return esp_psram_is_initialized();
#else
    return false;
#endif
#endif
}

#if CONFIG_IDF_TARGET_ESP32S3
static void board_classify(void)
{
    for (int g = 0; g < NGPIO; g++) {
        if (!GPIO_IS_VALID_GPIO(g)) s_reserved[g] = "does not exist on the " CHIP_NAME;
        else if (g >= 26 && g <= 32) s_reserved[g] = "SPI flash/PSRAM bus";
        else if (g >= 33 && g <= 37) {
            if (s_psram_pins) s_reserved[g] = "octal PSRAM/flash on this module";
            else s_warn[g] = "wired to PSRAM on octal (N8R8/N16R8) modules";
        }
#if CONFIG_ESP_CONSOLE_UART_DEFAULT || (CONFIG_ESP_CONSOLE_UART_CUSTOM && CONFIG_ESP_CONSOLE_UART_NUM == 0)
        else if (g == 43) s_reserved[g] = "UART0 TX (console / USB-UART port)";
        else if (g == 44) s_reserved[g] = "UART0 RX (console / USB-UART port)";
#endif
    }
}

static void board_warnings(void)
{
    warn_pin(0, "BOOT button + strapping pin: must not be held low at reset (fine as a button input)");
    warn_pin(3, "strapping pin (JTAG select): don't drive it during reset");
    warn_pin(45, "strapping pin (flash voltage): must be low at reset");
    warn_pin(46, "strapping pin (boot mode): keep low at reset");
    warn_pin(19, "USB D- : the native USB port stops working");
    warn_pin(20, "USB D+ : the native USB port stops working");
    for (int g = 39; g <= 42; g++) warn_pin(g, "JTAG pin: free unless you debug over external JTAG");
}
#elif CONFIG_IDF_TARGET_ESP32
static void board_classify(void)
{
    for (int g = 0; g < NGPIO; g++) {
        if (!GPIO_IS_VALID_GPIO(g)) s_reserved[g] = "does not exist on the " CHIP_NAME;
        else if (g >= 6 && g <= 11) s_reserved[g] = "SPI flash (inside the module)";
        else if (g == 37 || g == 38) s_reserved[g] = "not brought out on WROOM/WROVER modules";
        else if (g == 16 || g == 17) {
            if (s_psram_pins) s_reserved[g] = "PSRAM (WROVER module)";
            else s_warn[g] = "PSRAM on WROVER modules, flash on PICO-D4 (free on WROOM)";
        }
#if CONFIG_ESP_CONSOLE_UART_DEFAULT || (CONFIG_ESP_CONSOLE_UART_CUSTOM && CONFIG_ESP_CONSOLE_UART_NUM == 0)
        else if (g == 1) s_reserved[g] = "UART0 TX (console / USB-UART chip)";
        else if (g == 3) s_reserved[g] = "UART0 RX (console / USB-UART chip)";
#endif
    }
}

static void board_warnings(void)
{
    warn_pin(0, "BOOT button + strapping pin: must not be held low at reset (fine as a button input)");
    warn_pin(2, "strapping pin: must be low or open while flashing (on-board LED on many boards)");
    warn_pin(5, "strapping pin: must be high at reset; outputs a short PWM burst at boot");
    warn_pin(12, "strapping pin (flash voltage): high at reset = 1.8 V flash, the board won't boot");
    warn_pin(14, "outputs a short PWM burst at boot");
    warn_pin(15, "strapping pin: outputs a short PWM burst at boot");
}
#elif CONFIG_IDF_TARGET_ESP32C3
/* ESP32-C3 SuperMini: its only USB port is the chip's own USB (GPIO18/19),
 * which also carries the console (sdkconfig.defaults.esp32c3), so UART0
 * (GPIO20/21) is free unless the console was moved back there */
static void board_classify(void)
{
    for (int g = 0; g < NGPIO; g++) {
        if (!GPIO_IS_VALID_GPIO(g)) s_reserved[g] = "does not exist on the " CHIP_NAME;
        else if (g >= 11 && g <= 17) s_reserved[g] = "SPI flash (inside the chip / module)";
        else if (g == 18) s_reserved[g] = "USB D- (the USB port: flashing and console)";
        else if (g == 19) s_reserved[g] = "USB D+ (the USB port: flashing and console)";
#if CONFIG_ESP_CONSOLE_UART_DEFAULT || (CONFIG_ESP_CONSOLE_UART_CUSTOM && CONFIG_ESP_CONSOLE_UART_NUM == 0)
        else if (g == 21) s_reserved[g] = "UART0 TX (console)";
        else if (g == 20) s_reserved[g] = "UART0 RX (console)";
#endif
    }
}

static void board_warnings(void)
{
    warn_pin(9, "BOOT button + strapping pin: must not be held low at reset (fine as a button input)");
    warn_pin(8, "strapping pin: must be high at reset (on-board LED on SuperMini boards)");
    warn_pin(2, "strapping pin: must be high or open at reset");
    for (int g = 4; g <= 7; g++) warn_pin(g, "JTAG pin: free unless you debug over external JTAG");
}
#elif CONFIG_IDF_TARGET_ESP32C6
static void board_classify(void)
{
    for (int g = 0; g < NGPIO; g++) {
        if (!GPIO_IS_VALID_GPIO(g)) s_reserved[g] = "does not exist on the " CHIP_NAME;
        else if (g >= 24 && g <= 30) s_reserved[g] = "SPI flash (inside the module)";
#if CONFIG_ESP_CONSOLE_UART_DEFAULT || (CONFIG_ESP_CONSOLE_UART_CUSTOM && CONFIG_ESP_CONSOLE_UART_NUM == 0)
        else if (g == 16) s_reserved[g] = "UART0 TX (console / USB-UART port)";
        else if (g == 17) s_reserved[g] = "UART0 RX (console / USB-UART port)";
#endif
    }
}

static void board_warnings(void)
{
    warn_pin(9, "BOOT button + strapping pin: must not be held low at reset (fine as a button input)");
    warn_pin(8, "strapping pin: must be high at reset (RGB LED on the DevKitC-1)");
    warn_pin(15, "strapping pin (JTAG source select)");
    warn_pin(4, "strapping pin + JTAG (MTMS): don't drive it during reset");
    warn_pin(5, "strapping pin + JTAG (MTDI): don't drive it during reset");
    warn_pin(6, "JTAG pin: free unless you debug over external JTAG");
    warn_pin(7, "JTAG pin: free unless you debug over external JTAG");
    warn_pin(12, "USB D- : the native USB port (flashing / second console) stops working");
    warn_pin(13, "USB D+ : the native USB port (flashing / second console) stops working");
}
#endif
#if !CONFIG_IDF_TARGET_ESP32P4
static void board_power(void) {}
#endif
#if CONFIG_IDF_TARGET_ESP32P4
/* Waveshare's P4 boards all follow Espressif's reference design: the ESP32-C6
 * on esp_hosted's default SDIO pins, a 32 kHz crystal, a CH343 USB-UART on
 * UART0, microSD on SDMMC slot 0, an ES8311 codec on I2S, and GPIO39-48 powered
 * from the P4's LDO VO4. Each board adds its own extras (Ethernet, I3C ...). */
typedef struct {
    int8_t g;
    bool reserved; /* else: a warning */
    const char *why;
} pinnote_t;

#define PN_END {-1, false, NULL}
#if CONFIG_PLC_P4_BOARD_WS_NANO || CONFIG_PLC_P4_BOARD_WS_MODULE || CONFIG_PLC_P4_BOARD_WS_WIFI6
#define P4_WAVESHARE 1
static const pinnote_t P4_WS_COMMON[] = {
    {0, true, "32.768 kHz crystal"},
    {1, true, "32.768 kHz crystal"},
    {6, true, "wired to the ESP32-C6 (its IO2)"},
    {9, true, "I2S to the ES8311 audio codec"},
    {10, true, "I2S to the ES8311 audio codec"},
    {11, true, "I2S to the ES8311 audio codec"},
    {12, true, "I2S to the ES8311 audio codec"},
    {13, true, "I2S to the ES8311 audio codec"},
    {39, true, "microSD card slot"},
    {40, true, "microSD card slot"},
    {41, true, "microSD card slot"},
    {42, true, "microSD card slot"},
    {43, true, "microSD card slot"},
    {44, true, "microSD card slot"},
    {7, false, "I2C bus of the audio codec and camera/display connectors (2.2 k pull-up)"},
    {8, false, "I2C bus of the audio codec and camera/display connectors (2.2 k pull-up)"},
    {45, false, "switches the microSD card's power (10 k pull-down)"},
    {53, false, "enables the on-board speaker amplifier (10 k pull-down)"},
    PN_END,
};
#endif

#if CONFIG_PLC_P4_BOARD_WS_NANO || CONFIG_PLC_P4_BOARD_WS_MODULE
/* IP101 Ethernet PHY on RMII (same pins on both) */
static const pinnote_t P4_BOARD[] = {
    {28, true, "Ethernet (IP101 PHY: CRS_DV)"},
    {29, true, "Ethernet (IP101 PHY: RXD0)"},
    {30, true, "Ethernet (IP101 PHY: RXD1)"},
    {31, true, "Ethernet (IP101 PHY: MDC)"},
    {34, true, "Ethernet (IP101 PHY: TXD0)"},
    /* the PLC doesn't run Ethernet, and the PHY only listens on TXD1: the
     * BOOT button stays usable as an input */
    {35, false, "BOOT button + strapping pin (also Ethernet TXD1): fine as a button input"},
    {49, true, "Ethernet (IP101 PHY: TX_EN)"},
    {50, true, "Ethernet (IP101 PHY: REF_CLK)"},
    {51, true, "Ethernet (IP101 PHY: reset)"},
    {52, true, "Ethernet (IP101 PHY: MDIO)"},
#if CONFIG_PLC_P4_BOARD_WS_MODULE
    {32, false, "I3C connector J9 (2.2 k pull-up)"},
    {33, false, "I3C connector J9 (2.2 k pull-up)"},
#endif
    PN_END,
};
#elif CONFIG_PLC_P4_BOARD_WS_WIFI6
static const pinnote_t P4_BOARD[] = {PN_END};
#endif

/* the ESP32-C6 link, wherever esp_hosted is configured to put it */
static const int C6_LINK[] = {
#ifdef CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_CLK_SLOT_1
    CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_CLK_SLOT_1, CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_CMD_SLOT_1,
    CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_D0_SLOT_1,
#endif
#ifdef CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_CLK_SLOT_0
    CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_CLK_SLOT_0, CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_CMD_SLOT_0,
    CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_D0_SLOT_0,
#endif
#ifdef CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_D1_4BIT_BUS_SLOT_1
    CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_D1_4BIT_BUS_SLOT_1, CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_D2_4BIT_BUS_SLOT_1,
    CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_D3_4BIT_BUS_SLOT_1,
#endif
#ifdef CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_D1_4BIT_BUS_SLOT_0
    CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_D1_4BIT_BUS_SLOT_0, CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_D2_4BIT_BUS_SLOT_0,
    CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_D3_4BIT_BUS_SLOT_0,
#endif
#ifdef CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_D1_1BIT_BUS_SLOT_1
    CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_D1_1BIT_BUS_SLOT_1,
#endif
#ifdef CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_D1_1BIT_BUS_SLOT_0
    CONFIG_ESP_HOSTED_PRIV_SDIO_PIN_D1_1BIT_BUS_SLOT_0,
#endif
    -1,
};

#if P4_WAVESHARE
static void apply_notes(const pinnote_t *n)
{
    for (; n->g >= 0; n++) {
        if (n->g >= NGPIO || s_reserved[n->g]) continue;
        if (n->reserved) s_reserved[n->g] = n->why;
        else s_warn[n->g] = n->why;
    }
}
#endif

static void board_classify(void)
{
    for (int g = 0; g < NGPIO; g++) {
        if (!GPIO_IS_VALID_GPIO(g)) s_reserved[g] = "does not exist on the " CHIP_NAME;
#if CONFIG_ESP_CONSOLE_UART_DEFAULT || (CONFIG_ESP_CONSOLE_UART_CUSTOM && CONFIG_ESP_CONSOLE_UART_NUM == 0)
        else if (g == 37) s_reserved[g] = "UART0 TX (console / USB-UART port)";
        else if (g == 38) s_reserved[g] = "UART0 RX (console / USB-UART port)";
#endif
    }
    for (const int *c = C6_LINK; *c >= 0; c++)
        if (*c < NGPIO) s_reserved[*c] = "SDIO link to the ESP32-C6 (Wi-Fi)";
#ifdef CONFIG_ESP_HOSTED_GPIO_SLAVE_RESET_SLAVE
    if (CONFIG_ESP_HOSTED_GPIO_SLAVE_RESET_SLAVE >= 0 && CONFIG_ESP_HOSTED_GPIO_SLAVE_RESET_SLAVE < NGPIO)
        s_reserved[CONFIG_ESP_HOSTED_GPIO_SLAVE_RESET_SLAVE] = "resets the ESP32-C6 (Wi-Fi)";
#endif
#if P4_WAVESHARE
    apply_notes(P4_WS_COMMON);
    apply_notes(P4_BOARD);
#endif
}

static void board_warnings(void)
{
    warn_pin(35, "BOOT button + strapping pin: must not be held low at reset (fine as a button input)");
    warn_pin(34, "strapping pin (JTAG source select)");
    warn_pin(36, "strapping pin: must not be held low at reset");
    for (int g = 2; g <= 5; g++) warn_pin(g, "JTAG pin: free unless you debug over external JTAG");
    warn_pin(24, "USB-Serial-JTAG D- (second console / debug port): that USB port stops working");
    warn_pin(25, "USB-Serial-JTAG D+ (second console / debug port): that USB port stops working");
}

/* GPIO39-48 take their I/O supply from the P4's LDO channel 4 (VO4) on these
 * boards, which comes up at 1.8 V: run it at the 3.3 V rail so header pins
 * GPIO45-48 have normal logic levels */
static void board_power(void)
{
#if P4_WAVESHARE
    static esp_ldo_channel_handle_t s_vo4;
    esp_ldo_channel_config_t c = {.chan_id = 4, .voltage_mv = 3300};
    esp_err_t err = esp_ldo_acquire_channel(&c, &s_vo4);
    if (err != ESP_OK) ESP_LOGW(TAG, "GPIO39-48 supply (LDO VO4) not set to 3.3 V: %s", esp_err_to_name(err));
#endif
}
#endif

/* ADC channel of a pin, -1 if it has none we may use. ADC2 shares hardware
 * with an on-chip Wi-Fi radio, so it only counts on chips without one (the P4:
 * its Wi-Fi lives on the companion C6). */
static int adc_channel(int g, int *unit)
{
    adc_unit_t u;
    adc_channel_t ch;
    if (g < 0 || g >= NGPIO || adc_oneshot_io_to_channel(g, &u, &ch) != ESP_OK) return -1;
#if SOC_WIFI_SUPPORTED
    if (u != ADC_UNIT_1) return -1;
#endif
    if (u != ADC_UNIT_1 && u != ADC_UNIT_2) return -1;
    if (unit) *unit = u == ADC_UNIT_1 ? 0 : 1;
    return (int)ch;
}

/* "GPIO1-10" / "GPIO32-36, GPIO39": the usable analog pins, for messages */
static void make_adc_text(void)
{
    char *o = s_adc_pins;
    size_t left = sizeof s_adc_pins;
    int start = -1;
    s_adc_pins[0] = 0;
    for (int g = 0; g <= NGPIO; g++) {
        bool ok = g < NGPIO && !s_reserved[g] && adc_channel(g, NULL) >= 0;
        if (ok && start < 0) start = g;
        if (ok || start < 0) continue;
        int n = g - 1 > start ? snprintf(o, left, "%sGPIO%d-%d", o != s_adc_pins ? ", " : "", start, g - 1)
                              : snprintf(o, left, "%sGPIO%d", o != s_adc_pins ? ", " : "", start);
        if (n < 0 || (size_t)n >= left) break;
        o += n;
        left -= (size_t)n;
        start = -1;
    }
}

void plc_io_board_init(int status_led_pin)
{
    board_power();
    s_psram_pins = detect_psram_pins();
    s_led_pin = status_led_pin;
    for (int g = 0; g < NGPIO; g++) {
        s_reserved[g] = NULL;
        s_warn[g] = NULL;
    }
    board_classify();
    if (status_led_pin >= 0 && status_led_pin < NGPIO && !s_reserved[status_led_pin]) {
        s_reserved[status_led_pin] = "status LED (menuconfig: ESP32 Web PLC > Status LED)";
        s_warn[status_led_pin] = NULL;
    }
    board_warnings();
    make_adc_text();
#if CONFIG_IDF_TARGET_ESP32P4
    ESP_LOGI(TAG, CHIP_NAME " (%s): analog inputs on %s", BOARD_LAYOUT[0] ? BOARD_LAYOUT : "generic board", s_adc_pins);
#elif CONFIG_IDF_TARGET_ESP32C3 || CONFIG_IDF_TARGET_ESP32C6
    ESP_LOGI(TAG, CHIP_NAME ": analog inputs on %s", s_adc_pins);
#else
    ESP_LOGI(TAG, CHIP_NAME ": " PSRAM_PINS " %s, analog inputs on %s", s_psram_pins ? "reserved for PSRAM" : "usable",
             s_adc_pins);
#endif
}

const char *plc_io_pin_reserved(int g)
{
    if (g < 0 || g >= NGPIO) return "does not exist on the " CHIP_NAME;
    return s_reserved[g];
}

void plc_io_pins_json(jw_t *w)
{
    jw_key(w, "board");
    jw_obj(w);
    jw_kstr(w, "chip", CHIP_NAME);
    jw_kstr(w, "layout", BOARD_LAYOUT[0] ? BOARD_LAYOUT : NULL);
    jw_kint(w, "bootPin", BOOT_PIN);
    jw_kbool(w, "psramReserved", s_psram_pins);
    jw_kstr(w, "psramPins", PSRAM_PINS);
    jw_kstr(w, "adcPins", s_adc_pins);
    jw_kint(w, "statusLed", s_led_pin);
    jw_kint(w, "pwmChannels", N_LEDC_CHANNELS);
    jw_kint(w, "pwmFrequencies", N_LEDC_TIMERS);
    jw_kint(w, "pwmMinHz", PWM_MIN_HZ);
    jw_kint(w, "pwmMaxHz", PWM_MAX_HZ);
    jw_obj_end(w);
    jw_key(w, "pins");
    jw_arr(w);
    for (int g = 0; g < NGPIO; g++) {
        if (!GPIO_IS_VALID_GPIO(g)) continue;
        jw_obj(w);
        jw_kint(w, "gpio", g);
        int unit = 0;
        int ch = adc_channel(g, &unit);
        if (ch >= 0) {
            char b[24];
            snprintf(b, sizeof b, "ADC%d_CH%d", unit + 1, ch);
            jw_kstr(w, "adc", b);
        } else {
            jw_knull(w, "adc");
        }
        jw_kbool(w, "output", GPIO_IS_VALID_OUTPUT_GPIO(g));
        jw_kbool(w, "pulls", has_pulls(g));
        jw_kstr(w, "reserved", s_reserved[g]);
        jw_kstr(w, "warn", s_warn[g]);
        jw_obj_end(w);
    }
    jw_arr_end(w);
}

/* ------------------------------------------------------- validation */
static void add_warn(plc_io_warn_t *wn, const char *fmt, ...)
{
    if (!wn || wn->n >= PLC_IO_MAX_WARN) return;
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(wn->msg[wn->n++], sizeof wn->msg[0], fmt, ap);
    va_end(ap);
}

/* one pin of a shift-register chain: exists, free, able to drive if it must */
static esp_err_t check_sr_pin(const char *id, const char *role, int g, bool optional, bool output, const char **owner,
                              char (*names)[24], char *err, size_t errlen, plc_io_warn_t *warn)
{
    if (g < 0 && optional) return ESP_OK;
    if (g < 0 || g >= NGPIO || !GPIO_IS_VALID_GPIO(g)) {
        snprintf(err, errlen, "%s: choose a GPIO for %s", id, role);
        return ESP_FAIL;
    }
    if (s_reserved[g]) {
        snprintf(err, errlen, "%s %s: GPIO%d is reserved (%s)", id, role, g, s_reserved[g]);
        return ESP_FAIL;
    }
    if (owner[g]) {
        snprintf(err, errlen, "GPIO%d is used twice (%s and %s %s)", g, owner[g], id, role);
        return ESP_FAIL;
    }
    snprintf(names[g], sizeof names[g], "%s %s", id, role);
    owner[g] = names[g];
    if (output && !GPIO_IS_VALID_OUTPUT_GPIO(g)) {
        snprintf(err, errlen, "%s %s: GPIO%d is input-only", id, role, g);
        return ESP_FAIL;
    }
    if (s_warn[g]) add_warn(warn, "%s %s on GPIO%d: %s", id, role, g, s_warn[g]);
    return ESP_OK;
}

static const char *i2c_type_name(plc_i2c_type_t t)
{
    return t == PLC_I2C_PCF8574 ? "PCF8574" : t == PLC_I2C_MCP23017 ? "MCP23017" : "ADS1115";
}

esp_err_t plc_io_validate(plc_t *e, char *err, size_t errlen, plc_io_warn_t *warn)
{
    const char *owner[NGPIO] = {0};
    static char names[NGPIO][24]; /* "SR1 SRCLK" owners (only under the runtime lock) */
    uint64_t used[16] = {0};      /* channels taken, per chain */
    uint32_t freqs[N_LEDC_TIMERS];
    int nfreq = 0, npwm = 0;
    if (warn) warn->n = 0;
    for (size_t k = 0; k < plc_sr_count(e) && k < 16; k++) {
        const plc_sr_t *s = plc_sr(e, k);
        bool o595 = s->type == PLC_SR_595;
        if (check_sr_pin(s->id, o595 ? "SER" : "QH", s->data, false, o595, owner, names, err, errlen, warn) ||
            check_sr_pin(s->id, o595 ? "SRCLK" : "CLK", s->clock, false, true, owner, names, err, errlen, warn) ||
            check_sr_pin(s->id, o595 ? "RCLK" : "SH/LD", s->latch, false, true, owner, names, err, errlen, warn) ||
            check_sr_pin(s->id, o595 ? "/OE" : "CLK INH", s->enable, true, true, owner, names, err, errlen, warn))
            return ESP_FAIL;
    }
    /* the I2C bus and its modules */
    uint16_t xused[16] = {0};
    if (plc_i2c_count(e)) {
        const plc_i2c_bus_t *bus = plc_i2c_bus(e);
        if (check_sr_pin("I2C", "SDA", bus->sda, false, true, owner, names, err, errlen, warn) ||
            check_sr_pin("I2C", "SCL", bus->scl, false, true, owner, names, err, errlen, warn))
            return ESP_FAIL;
        for (size_t k = 0; k < plc_i2c_count(e) && k < 16; k++) {
            const plc_i2c_dev_t *d = plc_i2c_dev(e, k);
            int a = d->addr;
            bool ok = d->type == PLC_I2C_PCF8574    ? ((a >= 0x20 && a <= 0x27) || (a >= 0x38 && a <= 0x3F))
                      : d->type == PLC_I2C_MCP23017 ? (a >= 0x20 && a <= 0x27)
                                                    : (a >= 0x48 && a <= 0x4B);
            if (!ok) {
                snprintf(err, errlen, "I2C module %s: 0x%02X is not a %s address", d->id, a, i2c_type_name(d->type));
                return ESP_FAIL;
            }
            for (size_t j = 0; j < k; j++)
                if (plc_i2c_dev(e, j)->addr == a) {
                    snprintf(err, errlen, "I2C modules %s and %s both use address 0x%02X", plc_i2c_dev(e, j)->id, d->id, a);
                    return ESP_FAIL;
                }
        }
    }
    for (size_t i = 0; i < plc_io_count(e); i++) {
        plc_io_t *io = plc_io(e, i);
        if (io->i2c >= 0) {
            const plc_i2c_dev_t *d = plc_i2c_dev(e, (size_t)io->i2c);
            if (!d || io->i2c >= 16 || io->bit >= plc_i2c_channels(d->type)) {
                snprintf(err, errlen, "Tag \"%s\": no such I2C module channel", io->tag);
                return ESP_FAIL;
            }
            bool adc = d->type == PLC_I2C_ADS1115;
            if (adc ? io->dir != PLC_IO_AIN : (io->dir != PLC_IO_IN && io->dir != PLC_IO_OUT)) {
                snprintf(err, errlen, "Tag \"%s\": %s (%s) has %s", io->tag, d->id, i2c_type_name(d->type),
                         adc ? "analog inputs only" : "digital inputs / outputs only");
                return ESP_FAIL;
            }
            if (xused[io->i2c] & (1u << io->bit)) {
                snprintf(err, errlen, "%s channel %d is assigned to two tags (one is \"%s\")", d->id, io->bit, io->tag);
                return ESP_FAIL;
            }
            xused[io->i2c] |= (uint16_t)(1u << io->bit);
            if (d->type == PLC_I2C_MCP23017 && io->dir == PLC_IO_IN && io->pull == PLC_PULL_DOWN)
                add_warn(warn, "Tag \"%s\" on %s: the MCP23017 has pull-ups only - fit an external pull-down", io->tag, d->id);
            continue;
        }
        if (io->sr >= 0) {
            const plc_sr_t *s = plc_sr(e, (size_t)io->sr);
            if (!s || io->sr >= 16 || io->bit >= s->chips * 8) {
                snprintf(err, errlen, "Tag \"%s\": no such shift-register channel", io->tag);
                return ESP_FAIL;
            }
            bool o595 = s->type == PLC_SR_595;
            if (io->dir != (o595 ? PLC_IO_OUT : PLC_IO_IN)) {
                snprintf(err, errlen, "Tag \"%s\": %s is a 74HC%s - its channels are digital %s only", io->tag, s->id,
                         o595 ? "595" : "165", o595 ? "outputs" : "inputs");
                return ESP_FAIL;
            }
            uint64_t m = 1ULL << io->bit;
            if (used[io->sr] & m) {
                snprintf(err, errlen, "%s %c%d is assigned to two tags (one is \"%s\")", s->id, o595 ? 'Q' : 'I', io->bit,
                         io->tag);
                return ESP_FAIL;
            }
            used[io->sr] |= m;
            continue;
        }
        int g = io->pin;
        if (g < 0 || g >= NGPIO || !GPIO_IS_VALID_GPIO(g)) {
            snprintf(err, errlen, "Tag \"%s\": GPIO%d does not exist on the " CHIP_NAME, io->tag, g);
            return ESP_FAIL;
        }
        if (s_reserved[g]) {
            snprintf(err, errlen, "Tag \"%s\": GPIO%d is reserved (%s)", io->tag, g, s_reserved[g]);
            return ESP_FAIL;
        }
        if (owner[g]) {
            snprintf(err, errlen, "GPIO%d is used twice (\"%s\" and \"%s\")", g, owner[g], io->tag);
            return ESP_FAIL;
        }
        owner[g] = io->tag;
        if ((io->dir == PLC_IO_OUT || io->dir == PLC_IO_PWM) && !GPIO_IS_VALID_OUTPUT_GPIO(g)) {
            snprintf(err, errlen, "Tag \"%s\": GPIO%d is input-only and cannot drive an output", io->tag, g);
            return ESP_FAIL;
        }
        if (io->dir == PLC_IO_AIN && adc_channel(g, NULL) < 0) {
            snprintf(err, errlen, "Tag \"%s\": GPIO%d has no usable ADC channel - analog inputs must use %s", io->tag, g,
                     s_adc_pins);
            return ESP_FAIL;
        }
        if (io->dir == PLC_IO_PWM) {
            if (++npwm > N_LEDC_CHANNELS) {
                snprintf(err, errlen, "Too many PWM outputs (the " CHIP_NAME " has %d LEDC channels)", N_LEDC_CHANNELS);
                return ESP_FAIL;
            }
            if (io->freq_hz < PWM_MIN_HZ || io->freq_hz > PWM_MAX_HZ) {
                snprintf(err, errlen, "Tag \"%s\": PWM frequency must be %d..%d Hz", io->tag, PWM_MIN_HZ, PWM_MAX_HZ);
                return ESP_FAIL;
            }
            bool have = false;
            for (int k = 0; k < nfreq; k++) have |= freqs[k] == io->freq_hz;
            if (!have) {
                if (nfreq >= N_LEDC_TIMERS) {
                    snprintf(err, errlen, "PWM outputs may use at most %d different frequencies", N_LEDC_TIMERS);
                    return ESP_FAIL;
                }
                freqs[nfreq++] = io->freq_hz;
            }
        }
        /* the BOOT button's pin as an input is exactly its job: no warning there */
        if (s_warn[g] && !(g == BOOT_PIN && io->dir == PLC_IO_IN)) add_warn(warn, "Tag \"%s\" on GPIO%d: %s", io->tag, g, s_warn[g]);
        if (io->dir == PLC_IO_IN && io->pull != PLC_PULL_NONE && !has_pulls(g))
            add_warn(warn, "Tag \"%s\" on GPIO%d: this pin has no internal pull resistor - fit an external one", io->tag, g);
    }
    return ESP_OK;
}

/* ------------------------------------------------------- runtime state */
typedef struct {
    int pin;                /* -1 on a shift register / I2C module */
    int8_t sr;              /* shift-register chain (index into s_sr), -1 = none */
    int8_t xd;              /* I2C module (index into s_x), -1 = none */
    uint16_t bit;           /* its channel */
    uint16_t range_mv;      /* ADS1115 full scale */
    plc_io_dir_t dir;
    bool active_low;
    /* digital in */
    uint8_t last_raw, stable;
    int64_t t_change;
    uint16_t deb_ms;
    /* digital out */
    int8_t level;
    /* pwm */
    int8_t ch;
    uint8_t bits;
    uint32_t duty;
    /* analog in */
    int8_t adc_unit, adc_ch; /* unit 0 = ADC1, 1 = ADC2 */
    adc_cali_handle_t cali;
    float filt;
    bool filt_ok;
    uint8_t smooth;
    plc_ain_mode_t mode;
} hw_t;

static hw_t *s_hw;
static size_t s_nhw;
static adc_oneshot_unit_handle_t s_adc[2]; /* ADC1, ADC2 */

/* shift-register chains: a copy of the program's settings (the program may be
 * freed before plc_io_release runs) plus the chain's I/O image */
typedef struct {
    plc_sr_type_t type;
    uint8_t chips;
    int data, clock, latch, enable;
    uint8_t q[PLC_SR_MAX_CHIPS];       /* 595: wanted this scan / 165: last read */
    uint8_t shown[PLC_SR_MAX_CHIPS];   /* 595: latched on the outputs now */
    uint8_t idle[PLC_SR_MAX_CHIPS];    /* 595: safe state (mapped active-low channels high) */
} sr_rt_t;
static sr_rt_t *s_sr;
static size_t s_nsr;

static void sr_set(void *ctx, int pin, int level) { (void)ctx; gpio_set_level((gpio_num_t)pin, level); }
static int sr_get(void *ctx, int pin) { (void)ctx; return gpio_get_level((gpio_num_t)pin); }
/* ~1 us half period: well inside 74HC timing at 3.3 V, and kind to long jumper
 * wires; 64 channels take ~0.2 ms */
static void sr_delay(void *ctx) { (void)ctx; esp_rom_delay_us(1); }
static const sr_ops_t SR_OPS = {sr_set, sr_get, sr_delay, NULL};

static void sr_flush(sr_rt_t *s, bool force)
{
    if (s->type != PLC_SR_595 || (!force && !memcmp(s->q, s->shown, s->chips))) return;
    sr595_write(&SR_OPS, s->data, s->clock, s->latch, s->chips, s->q);
    memcpy(s->shown, s->q, s->chips);
}

/* configure the chains' pins; 595 outputs start in their safe state */
static void sr_apply(plc_t *e)
{
    s_nsr = plc_sr_count(e);
    if (!s_nsr) return;
    s_sr = (sr_rt_t *)calloc(s_nsr, sizeof(sr_rt_t));
    if (!s_sr) {
        s_nsr = 0;
        ESP_LOGE(TAG, "out of memory for shift registers");
        return;
    }
    for (size_t k = 0; k < s_nsr; k++) {
        const plc_sr_t *c = plc_sr(e, k);
        sr_rt_t *s = &s_sr[k];
        s->type = c->type;
        s->chips = c->chips;
        s->data = c->data;
        s->clock = c->clock;
        s->latch = c->latch;
        s->enable = c->enable;
        for (size_t i = 0; i < plc_io_count(e); i++) {
            plc_io_t *io = plc_io(e, i);
            if (io->sr == (int)k && io->active_low) s->idle[io->bit / 8] |= (uint8_t)(1u << (io->bit % 8));
        }
        uint64_t outs = BIT64(s->clock) | BIT64(s->latch);
        if (s->type == PLC_SR_595) outs |= BIT64(s->data);
        /* /OE (595) starts high = outputs off until the safe state is latched;
         * CLK INH (165) stays low = clock enabled */
        if (s->enable >= 0) {
            gpio_set_level((gpio_num_t)s->enable, s->type == PLC_SR_595 ? 1 : 0);
            outs |= BIT64(s->enable);
        }
        gpio_set_level((gpio_num_t)s->clock, 0);
        gpio_set_level((gpio_num_t)s->latch, s->type == PLC_SR_595 ? 0 : 1); /* 165 SH/LD idles high */
        gpio_config_t oc = {.pin_bit_mask = outs, .mode = GPIO_MODE_OUTPUT, .intr_type = GPIO_INTR_DISABLE};
        gpio_config(&oc);
        if (s->type == PLC_SR_595) {
            memcpy(s->q, s->idle, s->chips);
            sr_flush(s, true);
            if (s->enable >= 0) gpio_set_level((gpio_num_t)s->enable, 0);
        } else {
            /* QH: pulled down so a missing chip reads as all-off */
            gpio_config_t ic = {.pin_bit_mask = BIT64(s->data), .mode = GPIO_MODE_INPUT,
                                .pull_down_en = GPIO_PULLDOWN_ENABLE, .intr_type = GPIO_INTR_DISABLE};
            gpio_config(&ic);
            sr165_read(&SR_OPS, s->data, s->clock, s->latch, s->chips, s->q); /* inputs' start state */
        }
        ESP_LOGI(TAG, "shift register %s: %d x 74HC%s (%d %s)", c->id, c->chips, s->type == PLC_SR_595 ? "595" : "165",
                 c->chips * 8, s->type == PLC_SR_595 ? "outputs" : "inputs");
    }
}

/* safe state, outputs off, pins parked like released GPIO outputs */
static void sr_release(void)
{
    for (size_t k = 0; k < s_nsr; k++) {
        sr_rt_t *s = &s_sr[k];
        if (s->type == PLC_SR_595) {
            memcpy(s->q, s->idle, s->chips);
            sr_flush(s, true);
            gpio_set_pull_mode((gpio_num_t)s->data, GPIO_PULLDOWN_ONLY);
            gpio_set_direction((gpio_num_t)s->data, GPIO_MODE_INPUT);
            if (s->enable >= 0) { /* pulled high: outputs stay off while no program owns them */
                gpio_set_pull_mode((gpio_num_t)s->enable, GPIO_PULLUP_ONLY);
                gpio_set_direction((gpio_num_t)s->enable, GPIO_MODE_INPUT);
            }
        } else {
            gpio_reset_pin((gpio_num_t)s->data);
            if (s->enable >= 0) gpio_reset_pin((gpio_num_t)s->enable);
        }
        gpio_set_pull_mode((gpio_num_t)s->clock, GPIO_PULLDOWN_ONLY);
        gpio_set_direction((gpio_num_t)s->clock, GPIO_MODE_INPUT);
        gpio_set_pull_mode((gpio_num_t)s->latch, s->type == PLC_SR_595 ? GPIO_PULLDOWN_ONLY : GPIO_PULLUP_ONLY);
        gpio_set_direction((gpio_num_t)s->latch, GPIO_MODE_INPUT);
    }
    free(s_sr);
    s_sr = NULL;
    s_nsr = 0;
}

/* ------------------------------------------------------- I2C modules
 * A background task owns the bus: it writes the outputs the scan asked for,
 * reads inputs and runs the ADS1115 conversions (4 ms each), so I2C never
 * stretches the scan cycle. Scan and task swap values under s_xlock. */
typedef struct {
    plc_i2c_type_t type;
    uint8_t addr;
    char id[16];
    i2c_master_dev_handle_t h;
    uint16_t ins, outs, pulls; /* channel masks */
    uint16_t idle;             /* outputs' safe state (active-low outputs high) */
    uint16_t want;             /* scan -> task: output levels */
    uint16_t shown;            /* task: what the module holds */
    uint16_t in;               /* task -> scan: input levels */
    uint8_t ach, adc_ok;       /* ADS1115: channels in use / with a value */
    uint8_t pga[4];
    int16_t adc[4];
    int8_t cur;                /* ADS1115: channel converting, -1 none */
    int64_t t_conv, retry_at;
    bool online, fresh;        /* fresh: needs (re)initialisation */
    uint32_t errors;
} xdev_t;
static xdev_t *s_x;
static size_t s_nx;
static i2c_master_bus_handle_t s_bus;
static TaskHandle_t s_i2c_task;
static SemaphoreHandle_t s_i2c_done;
static volatile bool s_i2c_stop;
static portMUX_TYPE s_xlock = portMUX_INITIALIZER_UNLOCKED;

static int x_xfer(void *ctx, int dev, const uint8_t *w, size_t nw, uint8_t *r, size_t nr)
{
    (void)ctx;
    i2c_master_dev_handle_t h = s_x[dev].h;
    esp_err_t err = nw && nr ? i2c_master_transmit_receive(h, w, nw, r, nr, 20)
                    : nr     ? i2c_master_receive(h, r, nr, 20)
                             : i2c_master_transmit(h, w, nw, 20);
    return err == ESP_OK ? 0 : -1;
}
static const i2c_ops_t X_OPS = {x_xfer, NULL};

/* one pass over a module; false = it did not answer */
static bool x_service(int k, int64_t now)
{
    xdev_t *x = &s_x[k];
    taskENTER_CRITICAL(&s_xlock);
    uint16_t want = x->want;
    taskEXIT_CRITICAL(&s_xlock);
    switch (x->type) {
    case PLC_I2C_PCF8574: {
        /* inputs and unused pins written 1 (weak high, readable), outputs their level */
        uint8_t v = (uint8_t)((want & x->outs) | (uint16_t)~x->outs);
        if ((x->fresh || v != x->shown) && pcf8574_write(&X_OPS, k, v)) return false;
        x->shown = v;
        if (x->ins) {
            uint8_t r;
            if (pcf8574_read(&X_OPS, k, &r)) return false;
            taskENTER_CRITICAL(&s_xlock);
            x->in = r;
            taskEXIT_CRITICAL(&s_xlock);
        }
        break;
    }
    case PLC_I2C_MCP23017:
        if (x->fresh) {
            if (mcp23017_init(&X_OPS, k, (uint16_t)~x->outs, x->pulls, want)) return false;
            x->shown = want;
        } else if (want != x->shown) {
            if (mcp23017_write(&X_OPS, k, want)) return false;
            x->shown = want;
        }
        if (x->ins) {
            uint16_t r;
            if (mcp23017_read(&X_OPS, k, &r)) return false;
            taskENTER_CRITICAL(&s_xlock);
            x->in = r;
            taskEXIT_CRITICAL(&s_xlock);
        }
        break;
    case PLC_I2C_ADS1115:
        if (!x->ach) break;
        if (x->cur >= 0 && now - x->t_conv < ADS1115_CONV_MS * 1000) break; /* still converting */
        if (x->cur >= 0) {
            int16_t raw;
            if (ads1115_read(&X_OPS, k, &raw)) return false;
            taskENTER_CRITICAL(&s_xlock);
            x->adc[x->cur] = raw;
            x->adc_ok |= (uint8_t)(1u << x->cur);
            taskEXIT_CRITICAL(&s_xlock);
        }
        int next = x->cur;
        do next = (next + 1) & 3;
        while (!(x->ach & (1u << next)));
        if (ads1115_start(&X_OPS, k, next, x->pga[next])) return false;
        x->cur = (int8_t)next;
        x->t_conv = now;
        break;
    }
    x->fresh = false;
    return true;
}

static void i2c_task(void *arg)
{
    (void)arg;
    while (!s_i2c_stop) {
        int64_t now = esp_timer_get_time();
        for (size_t k = 0; k < s_nx; k++) {
            xdev_t *x = &s_x[k];
            if (!x->online && now < x->retry_at) continue;
            if (x_service((int)k, now)) {
                if (!x->online) ESP_LOGI(TAG, "I2C module %s (%s at 0x%02X) online", x->id, i2c_type_name(x->type), x->addr);
                x->online = true;
                continue;
            }
            /* no answer: inputs fall back to 0 (as on an S7 with a failed
             * module), try again in half a second from scratch */
            if (x->online || !x->errors)
                ESP_LOGW(TAG, "I2C module %s (%s at 0x%02X) not responding", x->id, i2c_type_name(x->type), x->addr);
            x->errors++;
            taskENTER_CRITICAL(&s_xlock);
            x->online = false;
            x->adc_ok = 0;
            taskEXIT_CRITICAL(&s_xlock);
            x->fresh = true;
            x->cur = -1;
            x->retry_at = now + 500000;
        }
        vTaskDelay(pdMS_TO_TICKS(2));
    }
    /* leaving: outputs to their safe state */
    for (size_t k = 0; k < s_nx; k++) {
        xdev_t *x = &s_x[k];
        if (!x->online || x->type == PLC_I2C_ADS1115) continue;
        x->want = x->idle;
        x_service((int)k, esp_timer_get_time());
    }
    xSemaphoreGive(s_i2c_done);
    vTaskDelete(NULL);
}

static void i2c_apply(plc_t *e)
{
    s_nx = plc_i2c_count(e);
    if (!s_nx) return;
    const plc_i2c_bus_t *bus = plc_i2c_bus(e);
    s_x = (xdev_t *)calloc(s_nx, sizeof(xdev_t));
    i2c_master_bus_config_t bc = {
        .i2c_port = -1,
        .sda_io_num = bus->sda,
        .scl_io_num = bus->scl,
        .clk_source = I2C_CLK_SRC_DEFAULT,
        .glitch_ignore_cnt = 7,
        .flags.enable_internal_pullup = true, /* weak: modules bring their own 4.7-10 k */
    };
    if (!s_x || i2c_new_master_bus(&bc, &s_bus) != ESP_OK) {
        ESP_LOGE(TAG, "I2C bus on SDA GPIO%d / SCL GPIO%d could not be set up", bus->sda, bus->scl);
        free(s_x);
        s_x = NULL;
        s_nx = 0;
        s_bus = NULL;
        return;
    }
    for (size_t k = 0; k < s_nx; k++) {
        const plc_i2c_dev_t *d = plc_i2c_dev(e, k);
        xdev_t *x = &s_x[k];
        x->type = d->type;
        x->addr = d->addr;
        snprintf(x->id, sizeof x->id, "%s", d->id);
        x->cur = -1;
        x->fresh = true;
        for (size_t i = 0; i < plc_io_count(e); i++) {
            plc_io_t *io = plc_io(e, i);
            if (io->i2c != (int)k) continue;
            uint16_t m = (uint16_t)(1u << io->bit);
            if (io->dir == PLC_IO_IN) {
                x->ins |= m;
                if (io->pull == PLC_PULL_UP) x->pulls |= m;
            } else if (io->dir == PLC_IO_OUT) {
                x->outs |= m;
                if (io->active_low) x->idle |= m;
            } else if (io->dir == PLC_IO_AIN && io->bit < 4) {
                x->ach |= (uint8_t)m;
                x->pga[io->bit] = (uint8_t)ads1115_pga(io->range_mv);
            }
        }
        x->want = x->idle;
        i2c_device_config_t dc = {
            .dev_addr_length = I2C_ADDR_BIT_LEN_7,
            .device_address = d->addr,
            .scl_speed_hz = bus->khz * 1000,
        };
        if (i2c_master_bus_add_device(s_bus, &dc, &x->h) != ESP_OK) x->h = NULL;
        ESP_LOGI(TAG, "I2C module %s: %s at 0x%02X", d->id, i2c_type_name(d->type), d->addr);
    }
    for (size_t k = 0; k < s_nx; k++)
        if (!s_x[k].h) s_x[k].retry_at = INT64_MAX; /* could not be added: never polled */
    if (!s_i2c_done) s_i2c_done = xSemaphoreCreateBinary();
    s_i2c_stop = false;
    if (xTaskCreatePinnedToCore(i2c_task, "plc_i2c", 4096, NULL, 6, &s_i2c_task, 0) != pdPASS) s_i2c_task = NULL;
}

static void i2c_release(void)
{
    if (s_i2c_task) {
        s_i2c_stop = true;
        xSemaphoreTake(s_i2c_done, pdMS_TO_TICKS(2000));
        s_i2c_task = NULL;
    }
    for (size_t k = 0; k < s_nx; k++)
        if (s_x[k].h) i2c_master_bus_rm_device(s_x[k].h);
    if (s_bus) i2c_del_master_bus(s_bus);
    s_bus = NULL;
    free(s_x);
    s_x = NULL;
    s_nx = 0;
}

void plc_io_status_json(jw_t *w)
{
    jw_key(w, "i2c");
    jw_arr(w);
    for (size_t k = 0; k < s_nx; k++) {
        const xdev_t *x = &s_x[k];
        jw_obj(w);
        jw_kstr(w, "id", x->id);
        jw_kstr(w, "type", i2c_type_name(x->type));
        jw_kint(w, "addr", x->addr);
        jw_kbool(w, "online", x->online);
        jw_kint(w, "errors", x->errors);
        jw_obj_end(w);
    }
    jw_arr_end(w);
}

static uint8_t pwm_bits(uint32_t hz)
{
    /* finest resolution the 80 MHz LEDC clock allows at this frequency */
    uint8_t bits = SOC_LEDC_TIMER_BIT_WIDTH < 14 ? SOC_LEDC_TIMER_BIT_WIDTH : 14;
    while (bits > 1 && (80000000.0 / (double)(1u << bits)) < (double)hz) bits--;
    return bits;
}

/* ADC calibration (raw -> mV): curve fitting where the chip has it (S3, P4),
 * line fitting on the classic ESP32. NULL = uncalibrated, use the nominal scale. */
static adc_cali_handle_t cali_new(adc_unit_t unit, adc_channel_t ch)
{
    adc_cali_handle_t h = NULL;
#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
    adc_cali_curve_fitting_config_t c = {
        .unit_id = unit, .chan = ch, .atten = ADC_ATTEN, .bitwidth = ADC_BITWIDTH_12};
    if (adc_cali_create_scheme_curve_fitting(&c, &h) != ESP_OK) h = NULL;
#elif ADC_CALI_SCHEME_LINE_FITTING_SUPPORTED
    (void)ch;
    adc_cali_line_fitting_config_t c = {
        .unit_id = unit, .atten = ADC_ATTEN, .bitwidth = ADC_BITWIDTH_12,
#if CONFIG_IDF_TARGET_ESP32
        .default_vref = 1100, /* used when the eFuse holds no Vref / two-point values */
#endif
    };
    if (adc_cali_create_scheme_line_fitting(&c, &h) != ESP_OK) h = NULL;
#else
    (void)unit;
    (void)ch;
#endif
    return h;
}

static void cali_del(adc_cali_handle_t h)
{
    if (!h) return;
#if ADC_CALI_SCHEME_CURVE_FITTING_SUPPORTED
    adc_cali_delete_scheme_curve_fitting(h);
#elif ADC_CALI_SCHEME_LINE_FITTING_SUPPORTED
    adc_cali_delete_scheme_line_fitting(h);
#endif
}

void plc_io_release(void)
{
    i2c_release();
    sr_release();
    for (size_t i = 0; i < s_nhw; i++) {
        hw_t *h = &s_hw[i];
        if (h->sr >= 0 || h->xd >= 0 || h->pin < 0) continue; /* chain / module channel: no pin of its own */
        gpio_num_t g = (gpio_num_t)h->pin;
        if (h->dir == PLC_IO_OUT || h->dir == PLC_IO_PWM) {
            /* Safe state while no program owns the pin: not driven, weakly pulled
             * to the INACTIVE level. (gpio_reset_pin would enable the pull-UP,
             * which can half-switch a MOSFET-driven load.) Pull first, then let
             * go of the driver, so there is no glitch. */
            if (h->dir == PLC_IO_PWM && h->ch >= 0) ledc_stop(LEDC_MODE, (ledc_channel_t)h->ch, 0);
            gpio_set_pull_mode(g, h->active_low ? GPIO_PULLUP_ONLY : GPIO_PULLDOWN_ONLY);
            gpio_set_direction(g, GPIO_MODE_INPUT);
            /* LEDC reserved the pin; free it so the next program may claim it
             * (gpio_reset_pin would do this, but also turns the pull-up on) */
            if (h->dir == PLC_IO_PWM) esp_gpio_revoke(BIT64(h->pin));
        } else {
            if (h->dir == PLC_IO_AIN) cali_del(h->cali);
            gpio_reset_pin(g);
        }
    }
    for (int u = 0; u < 2; u++) {
        if (s_adc[u]) adc_oneshot_del_unit(s_adc[u]);
        s_adc[u] = NULL;
    }
    free(s_hw);
    s_hw = NULL;
    s_nhw = 0;
}

void plc_io_apply(plc_t *e)
{
    plc_io_release();
    sr_apply(e);
    i2c_apply(e);
    size_t n = plc_io_count(e);
    if (!n) return;
    s_hw = (hw_t *)calloc(n, sizeof(hw_t));
    if (!s_hw) {
        ESP_LOGE(TAG, "out of memory for I/O state");
        return;
    }
    s_nhw = n;
    uint32_t tfreq[N_LEDC_TIMERS] = {0};
    uint8_t tbits[N_LEDC_TIMERS] = {0};
    int ntimer = 0, nch = 0;
    int64_t now = esp_timer_get_time();

    for (size_t i = 0; i < n; i++) {
        plc_io_t *io = plc_io(e, i);
        hw_t *h = &s_hw[i];
        h->pin = io->pin;
        h->dir = io->dir;
        h->active_low = io->active_low;
        h->ch = -1;
        h->adc_ch = -1;
        h->level = -1;
        h->sr = (int8_t)(io->sr >= 0 && (size_t)io->sr < s_nsr ? io->sr : -1);
        h->xd = (int8_t)(io->i2c >= 0 && (size_t)io->i2c < s_nx ? io->i2c : -1);
        h->bit = io->bit;
        if (io->i2c >= 0) {
            /* a module channel: the I2C task does the talking */
            h->deb_ms = io->debounce_ms;
            h->last_raw = h->stable = 0; /* FALSE until the module has answered */
            h->t_change = now;
            h->range_mv = io->range_mv;
            h->mode = io->ain_mode;
            h->smooth = io->smooth;
            if (h->xd >= 0)
                ESP_LOGI(TAG, "%-16s %s channel %d", io->tag, s_x[h->xd].id, io->bit);
            continue;
        }
        if (io->sr >= 0) {
            /* a chain channel: sr_apply() set the chain up and read the 165s once */
            if (h->sr >= 0 && io->dir == PLC_IO_IN) {
                const sr_rt_t *s = &s_sr[h->sr];
                h->deb_ms = io->debounce_ms;
                h->last_raw = h->stable = (uint8_t)(((s->q[h->bit / 8] >> (h->bit % 8)) & 1) ^ (io->active_low ? 1 : 0));
                h->t_change = now;
            }
            ESP_LOGI(TAG, "%-16s %s %c%d", io->tag, plc_sr(e, (size_t)io->sr)->id, io->dir == PLC_IO_IN ? 'I' : 'Q', io->bit);
            continue;
        }
        gpio_num_t g = (gpio_num_t)io->pin;
        switch (io->dir) {
        case PLC_IO_IN: {
            gpio_config_t c = {
                .pin_bit_mask = 1ULL << io->pin,
                .mode = GPIO_MODE_INPUT,
                .pull_up_en = io->pull == PLC_PULL_UP && has_pulls(io->pin) ? GPIO_PULLUP_ENABLE : GPIO_PULLUP_DISABLE,
                .pull_down_en = io->pull == PLC_PULL_DOWN && has_pulls(io->pin) ? GPIO_PULLDOWN_ENABLE : GPIO_PULLDOWN_DISABLE,
                .intr_type = GPIO_INTR_DISABLE,
            };
            gpio_config(&c);
            h->deb_ms = io->debounce_ms;
            h->last_raw = h->stable = (uint8_t)(gpio_get_level(g) ^ (io->active_low ? 1 : 0));
            h->t_change = now;
            break;
        }
        case PLC_IO_OUT: {
            int idle = io->active_low ? 1 : 0;
            gpio_set_level(g, idle); /* inactive before the driver turns on */
            gpio_config_t c = {
                .pin_bit_mask = 1ULL << io->pin,
                .mode = GPIO_MODE_OUTPUT,
                .pull_up_en = GPIO_PULLUP_DISABLE,
                .pull_down_en = GPIO_PULLDOWN_DISABLE,
                .intr_type = GPIO_INTR_DISABLE,
            };
            gpio_config(&c);
            gpio_set_level(g, idle);
            h->level = (int8_t)idle;
            break;
        }
        case PLC_IO_PWM: {
            int t = -1;
            for (int k = 0; k < ntimer; k++)
                if (tfreq[k] == io->freq_hz) t = k;
            if (t < 0 && ntimer < N_LEDC_TIMERS) {
                t = ntimer++;
                tfreq[t] = io->freq_hz;
                tbits[t] = pwm_bits(io->freq_hz);
                ledc_timer_config_t tc = {
                    .speed_mode = LEDC_MODE,
                    .duty_resolution = (ledc_timer_bit_t)tbits[t],
                    .timer_num = (ledc_timer_t)t,
                    .freq_hz = io->freq_hz,
                    .clk_cfg = LEDC_AUTO_CLK,
                };
                if (ledc_timer_config(&tc) != ESP_OK) {
                    ESP_LOGE(TAG, "PWM %u Hz not possible", (unsigned)io->freq_hz);
                    tfreq[t] = 0;
                    t = -1;
                }
            }
            if (t < 0 || nch >= N_LEDC_CHANNELS) break;
            ledc_channel_config_t cc = {
                .gpio_num = io->pin,
                .speed_mode = LEDC_MODE,
                .channel = (ledc_channel_t)nch,
                .intr_type = LEDC_INTR_DISABLE,
                .timer_sel = (ledc_timer_t)t,
                .duty = 0,
                .hpoint = 0,
            };
            if (ledc_channel_config(&cc) == ESP_OK) {
                h->ch = (int8_t)nch++;
                h->bits = tbits[t];
                h->duty = 0;
            }
            break;
        }
        case PLC_IO_AIN: {
            int u = 0;
            int ch = adc_channel(io->pin, &u);
            if (ch < 0) break;
            adc_unit_t unit = u ? ADC_UNIT_2 : ADC_UNIT_1;
            if (has_pulls(io->pin)) gpio_set_pull_mode(g, GPIO_FLOATING); /* a pull would bias the reading */
            if (!s_adc[u]) {
                adc_oneshot_unit_init_cfg_t uc = {.unit_id = unit, .ulp_mode = ADC_ULP_MODE_DISABLE};
                if (adc_oneshot_new_unit(&uc, &s_adc[u]) != ESP_OK) {
                    s_adc[u] = NULL;
                    break;
                }
            }
            adc_oneshot_chan_cfg_t cc = {.atten = ADC_ATTEN, .bitwidth = ADC_BITWIDTH_12};
            if (adc_oneshot_config_channel(s_adc[u], (adc_channel_t)ch, &cc) != ESP_OK) break;
            h->cali = cali_new(unit, (adc_channel_t)ch);
            h->adc_unit = (int8_t)u;
            h->adc_ch = (int8_t)ch;
            h->mode = io->ain_mode;
            h->smooth = io->smooth;
            break;
        }
        }
        ESP_LOGI(TAG, "%-16s GPIO%-2d %s", io->tag, io->pin,
                 io->dir == PLC_IO_IN ? "digital in" : io->dir == PLC_IO_OUT ? "digital out"
                 : io->dir == PLC_IO_PWM ? "PWM" : "analog in");
    }
}

/* ------------------------------------------------------- cyclic I/O */
void plc_io_read_inputs(plc_t *e)
{
    int64_t now = esp_timer_get_time();
    static const float K[4] = {1.0f, 4.0f, 16.0f, 32.0f}; /* S7 smoothing: none/weak/medium/strong */
    for (size_t k = 0; k < s_nsr; k++) {
        sr_rt_t *s = &s_sr[k];
        if (s->type == PLC_SR_165) sr165_read(&SR_OPS, s->data, s->clock, s->latch, s->chips, s->q);
    }
    for (size_t i = 0; i < s_nhw; i++) {
        hw_t *h = &s_hw[i];
        if (h->pin < 0 && h->sr < 0 && h->xd < 0) continue;
        bool on = false, aok = false;
        uint16_t xin = 0;
        int16_t araw = 0;
        if (h->xd >= 0) {
            const xdev_t *x = &s_x[h->xd];
            taskENTER_CRITICAL(&s_xlock);
            on = x->online;
            xin = x->in;
            araw = x->adc[h->bit & 3];
            aok = (x->adc_ok >> (h->bit & 3)) & 1;
            taskEXIT_CRITICAL(&s_xlock);
        }
        if (h->xd >= 0 && h->dir == PLC_IO_AIN) {
            if (!on || !aok) { /* module gone / no conversion yet: 0, like a failed S7 module */
                h->filt_ok = false;
                plc_io_set_input(e, i, 0);
                continue;
            }
            if (!h->filt_ok) {
                h->filt = (float)araw;
                h->filt_ok = true;
            } else {
                h->filt += ((float)araw - h->filt) / K[h->smooth & 3];
            }
            /* raw: -32768..32767 = -range..+range */
            double v = h->mode == PLC_AIN_RAW ? lroundf(h->filt)
                       : h->mode == PLC_AIN_MV ? lroundf(h->filt * (float)h->range_mv / 32768.0f)
                                               : lroundf(h->filt * 27648.0f / 32768.0f); /* S7: 0..27648 = 0..range */
            plc_io_set_input(e, i, v);
            continue;
        }
        if (h->dir == PLC_IO_IN) {
            int level = h->xd >= 0   ? (on ? (xin >> h->bit) & 1 : (h->active_low ? 1 : 0)) /* gone: FALSE */
                        : h->sr >= 0 ? (s_sr[h->sr].q[h->bit / 8] >> (h->bit % 8)) & 1
                                     : gpio_get_level((gpio_num_t)h->pin);
            uint8_t raw = (uint8_t)(level ^ (h->active_low ? 1 : 0));
            if (raw != h->last_raw) {
                h->last_raw = raw;
                h->t_change = now;
            }
            if (!h->deb_ms || now - h->t_change >= (int64_t)h->deb_ms * 1000) h->stable = raw;
            plc_io_set_input(e, i, h->stable);
        } else if (h->dir == PLC_IO_AIN && h->adc_ch >= 0 && s_adc[h->adc_unit]) {
            int raw;
            if (adc_oneshot_read(s_adc[h->adc_unit], (adc_channel_t)h->adc_ch, &raw) != ESP_OK) continue;
            if (!h->filt_ok) {
                h->filt = (float)raw;
                h->filt_ok = true;
            } else {
                h->filt += ((float)raw - h->filt) / K[h->smooth & 3];
            }
            double v;
            if (h->mode == PLC_AIN_RAW) {
                v = lroundf(h->filt);
            } else if (h->mode == PLC_AIN_MV) {
                int mv;
                if (h->cali && adc_cali_raw_to_voltage(h->cali, (int)lroundf(h->filt), &mv) == ESP_OK) v = mv;
                else v = lroundf(h->filt * 3100.0f / 4095.0f);
            } else {
                v = lroundf(h->filt * 27648.0f / 4095.0f); /* S7 analog input: 0..27648 */
            }
            plc_io_set_input(e, i, v);
        }
    }
}

void plc_io_write_outputs(plc_t *e)
{
    uint16_t xw[16];
    for (size_t k = 0; k < s_nx && k < 16; k++) xw[k] = s_x[k].idle;
    for (size_t k = 0; k < s_nsr; k++) memcpy(s_sr[k].q, s_sr[k].idle, s_sr[k].chips);
    for (size_t i = 0; i < s_nhw; i++) {
        hw_t *h = &s_hw[i];
        if (h->pin < 0 && h->sr < 0 && h->xd < 0) continue;
        if (h->dir == PLC_IO_OUT) {
            int level = (plc_io_get_output(e, i) != 0) ^ (h->active_low ? 1 : 0);
            if (h->xd >= 0) {
                uint16_t m = (uint16_t)(1u << h->bit);
                xw[h->xd] = level ? (uint16_t)(xw[h->xd] | m) : (uint16_t)(xw[h->xd] & ~m);
            } else if (h->sr >= 0) {
                uint8_t *q = &s_sr[h->sr].q[h->bit / 8], m = (uint8_t)(1u << (h->bit % 8));
                *q = level ? (uint8_t)(*q | m) : (uint8_t)(*q & ~m);
            } else if (level != h->level) {
                gpio_set_level((gpio_num_t)h->pin, level);
                h->level = (int8_t)level;
            }
        } else if (h->dir == PLC_IO_PWM && h->ch >= 0) {
            double d = plc_io_get_output(e, i);
            if (!(d > 0)) d = 0; /* also catches NaN */
            uint32_t duty;
            if (d >= 1) {
                duty = PWM_FULL_ON;
            } else {
                /* 2^bits (= 100 %) is broken in the S3's LEDC at its maximum
                 * resolution (see ledc_channel_config in IDF), so on every chip
                 * full-on is a stopped channel held HIGH and the PWM duty stays
                 * below it */
                uint32_t max = (1u << h->bits) - 1;
                duty = (uint32_t)lround(d * (double)(1u << h->bits));
                if (duty > max) duty = max;
            }
            if (duty != h->duty) {
                if (duty == PWM_FULL_ON) {
                    ledc_stop(LEDC_MODE, (ledc_channel_t)h->ch, 1);
                } else {
                    ledc_set_duty(LEDC_MODE, (ledc_channel_t)h->ch, duty);
                    ledc_update_duty(LEDC_MODE, (ledc_channel_t)h->ch); /* also re-enables a stopped output */
                }
                h->duty = duty;
            }
        }
    }
    for (size_t k = 0; k < s_nsr; k++) sr_flush(&s_sr[k], false); /* shift only what changed */
    taskENTER_CRITICAL(&s_xlock); /* the I2C task sends them */
    for (size_t k = 0; k < s_nx && k < 16; k++) s_x[k].want = xw[k];
    taskEXIT_CRITICAL(&s_xlock);
}

void plc_io_outputs_off(plc_t *e)
{
    (void)e;
    taskENTER_CRITICAL(&s_xlock);
    for (size_t k = 0; k < s_nx; k++) s_x[k].want = s_x[k].idle;
    taskEXIT_CRITICAL(&s_xlock);
    for (size_t k = 0; k < s_nsr; k++) {
        memcpy(s_sr[k].q, s_sr[k].idle, s_sr[k].chips);
        sr_flush(&s_sr[k], false);
    }
    for (size_t i = 0; i < s_nhw; i++) {
        hw_t *h = &s_hw[i];
        if (h->sr >= 0 || h->xd >= 0 || h->pin < 0) continue;
        if (h->dir == PLC_IO_OUT) {
            int idle = h->active_low ? 1 : 0;
            gpio_set_level((gpio_num_t)h->pin, idle);
            h->level = (int8_t)idle;
        } else if (h->dir == PLC_IO_PWM && h->ch >= 0) {
            ledc_set_duty(LEDC_MODE, (ledc_channel_t)h->ch, 0);
            ledc_update_duty(LEDC_MODE, (ledc_channel_t)h->ch);
            h->duty = 0;
        }
    }
}
