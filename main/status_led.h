/* ============================================================================
 * status_led — the CPU's RUN/STOP LED.
 *   WS2812 (DevKitC-1 RGB LED): green = RUN, orange = STOP, blue = no program,
 *   blinking yellow = I/O forced, purple flash = Wi-Fi setup AP active.
 *   Plain LED: on = RUN, slow blink = STOP, fast blink = no program.
 * ==========================================================================*/
#pragma once

#include "esp_err.h"

int status_led_pin(void); /* -1 when no status LED is configured */
esp_err_t status_led_start(void);
