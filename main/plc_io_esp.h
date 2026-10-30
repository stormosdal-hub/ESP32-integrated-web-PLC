/* ============================================================================
 * plc_io_esp — the PLC's I/O modules: GPIO, LEDC PWM and ADC1, bound to the
 * program's tag <-> pin map (project.gpio).
 *
 *   in   Bool tag   <- digital input (pull-up/down, active-low, debounce)
 *   out  Bool tag   -> digital output (active-low)
 *   pwm  num tag    -> LEDC PWM, duty = value clamped to 0.0 .. 1.0
 *   ain  num tag    <- ADC1 (S3: GPIO1-10, ESP32: GPIO32-36/39):
 *                      S7 range 0..27648, raw 0..4095 or mV
 *
 * Supports the ESP32-S3 and the classic ESP32; which pins are usable on each
 * is kept in plc_io_esp.c. All functions are called with the runtime lock held
 * (except plc_io_chip_name).
 * ==========================================================================*/
#pragma once

#include <stdbool.h>
#include <stddef.h>

#include "esp_err.h"
#include "jw.h"
#include "plc_engine.h"

#define PLC_IO_MAX_WARN 8

typedef struct {
    int n;
    char msg[PLC_IO_MAX_WARN][160];
} plc_io_warn_t;

/* "ESP32-S3" / "ESP32" */
const char *plc_io_chip_name(void);

/* classify the board's pins (call once at boot; status_led_pin < 0 = none) */
void plc_io_board_init(int status_led_pin);
/* NULL if the pin may be used, else why not */
const char *plc_io_pin_reserved(int gpio);
/* emits "board":{...},"pins":[...] into the object open in w */
void plc_io_pins_json(jw_t *w);
/* emits "i2c":[{id,type,addr,online,errors}] (module status) into the object open in w */
void plc_io_status_json(jw_t *w);

/* check a compiled program's I/O map against this board. On error returns
 * ESP_FAIL with a message; usable-but-special pins produce warnings. */
esp_err_t plc_io_validate(plc_t *e, char *err, size_t errlen, plc_io_warn_t *warn);
/* release the previous program's pins and configure this one's */
void plc_io_apply(plc_t *e);
void plc_io_release(void);

void plc_io_read_inputs(plc_t *e);   /* start of scan: pins -> I image */
void plc_io_write_outputs(plc_t *e); /* end of scan: Q image -> pins  */
void plc_io_outputs_off(plc_t *e);   /* STOP: de-energize every output */
