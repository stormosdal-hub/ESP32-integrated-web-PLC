/* i2c_dev.c — see i2c_dev.h */
#include "i2c_dev.h"

/* MCP23017 registers, IOCON.BANK = 0 (A/B pairs at consecutive addresses) */
enum { MCP_IODIRA = 0x00, MCP_IOCON = 0x0A, MCP_GPPUA = 0x0C, MCP_GPIOA = 0x12, MCP_OLATA = 0x14 };
/* ADS1115 registers */
enum { ADS_CONV = 0x00, ADS_CONFIG = 0x01 };

int pcf8574_write(const i2c_ops_t *o, int dev, uint8_t pins) { return o->xfer(o->ctx, dev, &pins, 1, NULL, 0); }
int pcf8574_read(const i2c_ops_t *o, int dev, uint8_t *pins) { return o->xfer(o->ctx, dev, NULL, 0, pins, 1); }

static int mcp_pair(const i2c_ops_t *o, int dev, uint8_t reg, uint16_t v)
{
    uint8_t w[3] = {reg, (uint8_t)(v & 0xFF), (uint8_t)(v >> 8)};
    return o->xfer(o->ctx, dev, w, 3, NULL, 0);
}

int mcp23017_init(const i2c_ops_t *o, int dev, uint16_t inputs, uint16_t pullups, uint16_t olat)
{
    /* sequential addressing, no mirrored/open-drain interrupts; then latch
     * before direction so a pin never shows a stale level as an output */
    uint8_t iocon[2] = {MCP_IOCON, 0x00};
    if (o->xfer(o->ctx, dev, iocon, 2, NULL, 0)) return -1;
    if (mcp_pair(o, dev, MCP_OLATA, olat)) return -1;
    if (mcp_pair(o, dev, MCP_GPPUA, pullups)) return -1;
    return mcp_pair(o, dev, MCP_IODIRA, inputs);
}

int mcp23017_read(const i2c_ops_t *o, int dev, uint16_t *pins)
{
    uint8_t reg = MCP_GPIOA, r[2];
    if (o->xfer(o->ctx, dev, &reg, 1, r, 2)) return -1;
    *pins = (uint16_t)(r[0] | (r[1] << 8));
    return 0;
}

int mcp23017_write(const i2c_ops_t *o, int dev, uint16_t olat) { return mcp_pair(o, dev, MCP_OLATA, olat); }

static const int ADS_RANGES[6] = {6144, 4096, 2048, 1024, 512, 256}; /* PGA 0..5 */

/* the smallest range that still covers range_mv (a signal must not clip) */
int ads1115_pga(int range_mv)
{
    for (int i = 5; i > 0; i--)
        if (ADS_RANGES[i] >= range_mv) return i;
    return 0;
}

int ads1115_range_mv(int pga) { return ADS_RANGES[pga < 0 ? 0 : pga > 5 ? 5 : pga]; }

uint16_t ads1115_config(int ch, int pga)
{
    return (uint16_t)(1u << 15                  /* OS: start a conversion */
                      | (unsigned)(4 + (ch & 3)) << 12 /* MUX 100..111: AINch vs GND */
                      | (unsigned)(pga & 7) << 9 /* full-scale range */
                      | 1u << 8                 /* single-shot */
                      | 5u << 5                 /* 250 samples/s */
                      | 3u);                    /* comparator off */
}

int ads1115_start(const i2c_ops_t *o, int dev, int ch, int pga)
{
    uint16_t c = ads1115_config(ch, pga);
    uint8_t w[3] = {ADS_CONFIG, (uint8_t)(c >> 8), (uint8_t)(c & 0xFF)};
    return o->xfer(o->ctx, dev, w, 3, NULL, 0);
}

int ads1115_read(const i2c_ops_t *o, int dev, int16_t *raw)
{
    uint8_t reg = ADS_CONV, r[2];
    if (o->xfer(o->ctx, dev, &reg, 1, r, 2)) return -1;
    *raw = (int16_t)(uint16_t)((r[0] << 8) | r[1]);
    return 0;
}
