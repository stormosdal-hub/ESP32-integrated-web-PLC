/* ============================================================================
 * shiftreg — bit-banged 74HC595 (outputs) / 74HC165 (inputs) chains.
 *
 * No ESP-IDF includes: the pin operations come in through sr_ops_t, so the
 * same code runs against simulated chips in test/host/test_shiftreg.c.
 *
 * A chain's state is one byte per chip, chip 0 being the chip wired to the
 * ESP32 (595: its SER, 165: its QH). Bit b of byte c = channel c*8 + b =
 * pin Q<b> (595: QA..QH = bit 0..7) / D<b> (165: A..H = bit 0..7).
 *
 *   595 wiring:  ESP SER -> chip0 SER, chip0 QH' -> chip1 SER, ...; SRCLK and
 *                RCLK to every chip; /SRCLR to VCC; /OE to GND or a GPIO
 *   165 wiring:  chip0 QH -> ESP data; chip1 QH -> chip0 SER, ...; CLK and
 *                SH/LD to every chip; CLK INH to GND or a GPIO
 * ==========================================================================*/
#pragma once

#include <stdint.h>

typedef struct {
    void (*set)(void *ctx, int pin, int level);
    int (*get)(void *ctx, int pin);
    void (*delay)(void *ctx); /* half a clock period */
    void *ctx;
} sr_ops_t;

/* shift q[0..chips-1] into a 595 chain and latch it onto the outputs.
 * Leaves clock and latch low. */
void sr595_write(const sr_ops_t *o, int data, int clock, int latch, int chips, const uint8_t *q);

/* load a 165 chain's inputs and shift them in: q[0..chips-1].
 * Leaves load high and clock low. */
void sr165_read(const sr_ops_t *o, int data, int clock, int load, int chips, uint8_t *q);
