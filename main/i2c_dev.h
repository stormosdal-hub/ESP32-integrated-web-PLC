/* ============================================================================
 * i2c_dev — the register-level protocols of the PLC's I2C I/O modules.
 *
 * No ESP-IDF includes: the bus comes in through i2c_ops_t, so the same code
 * runs against simulated chips in test/host/test_i2c_dev.c.
 *
 *   PCF8574 (0x20-0x27, PCF8574A 0x38-0x3F): 8 quasi-bidirectional pins. A
 *     pin written 1 is weakly pulled high and can be read as an input; a pin
 *     written 0 sinks current. Channel n = P<n>.
 *   MCP23017 (0x20-0x27): 16 pins, channel 0..7 = GPA0..7, 8..15 = GPB0..7;
 *     register map of IOCON.BANK = 0 (its power-up default).
 *   ADS1115 (0x48-0x4B): 4 single-ended inputs AIN0..3 against GND, one
 *     single-shot conversion at a time (250 SPS: 4 ms each).
 * ==========================================================================*/
#pragma once

#include <stddef.h>
#include <stdint.h>

typedef struct {
    /* one transaction with module `dev`: write w[0..nw), then (repeated
     * start) read r[0..nr). nr = 0: write only, nw = 0: read only.
     * Returns 0 when the module acknowledged, else nonzero. */
    int (*xfer)(void *ctx, int dev, const uint8_t *w, size_t nw, uint8_t *r, size_t nr);
    void *ctx;
} i2c_ops_t;

int pcf8574_write(const i2c_ops_t *o, int dev, uint8_t pins);
int pcf8574_read(const i2c_ops_t *o, int dev, uint8_t *pins);

/* inputs / pullups / olat: one bit per channel (1 = input / 100k pull-up on /
 * output high). The output latch is written first, so outputs start in it. */
int mcp23017_init(const i2c_ops_t *o, int dev, uint16_t inputs, uint16_t pullups, uint16_t olat);
int mcp23017_read(const i2c_ops_t *o, int dev, uint16_t *pins);
int mcp23017_write(const i2c_ops_t *o, int dev, uint16_t olat);

#define ADS1115_CONV_MS 5 /* one conversion at 250 SPS (4 ms) + margin */
int ads1115_pga(int range_mv);        /* PGA code for a range of 6144 4096 2048 1024 512 256 mV */
int ads1115_range_mv(int pga);        /* ... and back */
uint16_t ads1115_config(int ch, int pga); /* config word: start, AINch vs GND, single-shot, 250 SPS */
int ads1115_start(const i2c_ops_t *o, int dev, int ch, int pga);
int ads1115_read(const i2c_ops_t *o, int dev, int16_t *raw); /* -32768..32767 = -range..+range */
