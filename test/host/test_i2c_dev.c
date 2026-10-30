/* Host test for main/i2c_dev.c against simulated chips that follow their
 * datasheets (not i2c_dev.c's assumptions):
 *   PCF8574  output latch (power-up 0xFF); a pin latched 1 is weakly high and
 *            reads what drives it from outside, a pin latched 0 reads 0
 *   MCP23017 IOCON.BANK=0 register map, address pointer that increments
 *            after every byte; GPIO reads inputs (IODIR=1: outside level, or
 *            1 through GPPU, else 0) and OLAT for outputs
 *   ADS1115  pointer register; writing the config with OS=1 converts the
 *            MUX-selected input at the PGA's full-scale range */
#include <math.h>
#include <stdio.h>
#include <string.h>

#include "i2c_dev.h"

static int fails;
#define CHECK(c, ...) do { if (!(c)) { if (fails++ < 15) printf(__VA_ARGS__); } } while (0)

/* -------- PCF8574 */
typedef struct { uint8_t latch; int ext[8]; /* -1 = not driven */ } pcf_t;
/* -------- MCP23017 */
typedef struct { uint8_t reg[0x16], ptr; int ext[16]; int bad; } mcp_t;
/* -------- ADS1115 */
typedef struct { uint16_t config; int16_t conv; uint8_t ptr; double volts[4]; int conversions, bad; } ads_t;

typedef struct { pcf_t pcf; mcp_t mcp; ads_t ads; } bus_t;
enum { DEV_PCF, DEV_MCP, DEV_ADS };

static uint8_t mcp_gpio(mcp_t *m, int port)
{
    uint8_t iodir = m->reg[0x00 + port], gppu = m->reg[0x0C + port], olat = m->reg[0x14 + port], v = 0;
    for (int b = 0; b < 8; b++) {
        int ch = port * 8 + b, lv;
        if (iodir & (1 << b)) lv = m->ext[ch] >= 0 ? m->ext[ch] : (gppu >> b) & 1;
        else lv = (olat >> b) & 1;
        v |= (uint8_t)(lv << b);
    }
    return v;
}

static int xfer(void *ctx, int dev, const uint8_t *w, size_t nw, uint8_t *r, size_t nr)
{
    bus_t *b = (bus_t *)ctx;
    if (dev == DEV_PCF) {
        if (nw) b->pcf.latch = w[nw - 1];
        for (size_t i = 0; i < nr; i++) {
            uint8_t v = 0;
            for (int p = 0; p < 8; p++) {
                int lv = !((b->pcf.latch >> p) & 1) ? 0 : b->pcf.ext[p] >= 0 ? b->pcf.ext[p] : 1;
                v |= (uint8_t)(lv << p);
            }
            r[i] = v;
        }
        return 0;
    }
    if (dev == DEV_MCP) {
        mcp_t *m = &b->mcp;
        if (nw) {
            m->ptr = w[0];
            for (size_t i = 1; i < nw; i++) {
                if (m->ptr == 0x0A || m->ptr == 0x0B) { if (w[i] & 0x80) m->bad = 1; /* BANK=1 would move every register */ }
                if (m->ptr == 0x12 || m->ptr == 0x13) m->reg[m->ptr + 2] = w[i]; /* GPIO write goes to OLAT */
                else m->reg[m->ptr] = w[i];
                m->ptr = (uint8_t)((m->ptr + 1) % 0x16);
            }
        }
        for (size_t i = 0; i < nr; i++) {
            r[i] = (m->ptr == 0x12 || m->ptr == 0x13) ? mcp_gpio(m, m->ptr - 0x12) : m->reg[m->ptr];
            m->ptr = (uint8_t)((m->ptr + 1) % 0x16);
        }
        return 0;
    }
    if (dev == DEV_ADS) {
        ads_t *a = &b->ads;
        if (nw) {
            a->ptr = w[0] & 3;
            if (nw == 3 && a->ptr == 1) {
                a->config = (uint16_t)(w[1] << 8 | w[2]);
                int mux = (a->config >> 12) & 7, pga = (a->config >> 9) & 7;
                static const double fsr[8] = {6.144, 4.096, 2.048, 1.024, 0.512, 0.256, 0.256, 0.256};
                if (!(a->config & 0x8000) || mux < 4 || !(a->config & 0x0100)) a->bad = 1;
                double v = a->volts[mux - 4] / fsr[pga] * 32768.0;
                a->conv = (int16_t)(v > 32767 ? 32767 : v < -32768 ? -32768 : lround(v));
                a->conversions++;
            }
        }
        for (size_t i = 0; i < nr; i += 2) {
            uint16_t v = a->ptr == 0 ? (uint16_t)a->conv : a->config;
            r[i] = (uint8_t)(v >> 8);
            if (i + 1 < nr) r[i + 1] = (uint8_t)v;
        }
        return 0;
    }
    return -1;
}

int main(void)
{
    bus_t bus;
    memset(&bus, 0, sizeof bus);
    i2c_ops_t o = {xfer, &bus};

    /* PCF8574: P0..P3 outputs (on, off, on, off), P4..P7 inputs: write 1 there */
    bus.pcf.latch = 0xFF;
    int ext[8] = {-1, -1, -1, -1, 0, 1, -1, 0};
    memcpy(bus.pcf.ext, ext, sizeof ext);
    CHECK(pcf8574_write(&o, DEV_PCF, 0xF5) == 0, "pcf write failed\n");
    uint8_t pins;
    CHECK(pcf8574_read(&o, DEV_PCF, &pins) == 0, "pcf read failed\n");
    CHECK(pins == 0x65, "pcf read 0x%02X, wanted 0x65\n", pins); /* P7=0 P6=1(weak) P5=1 P4=0 | P3..P0 = 0101 */

    /* MCP23017: A0..A7 outputs, B0..B7 inputs (B0..B3 with pull-ups) */
    memset(bus.mcp.reg, 0, sizeof bus.mcp.reg);
    bus.mcp.reg[0x00] = bus.mcp.reg[0x01] = 0xFF; /* power-up IODIR */
    for (int i = 0; i < 16; i++) bus.mcp.ext[i] = -1;
    bus.mcp.ext[8 + 4] = 1;
    bus.mcp.ext[8 + 5] = 0;
    CHECK(mcp23017_init(&o, DEV_MCP, 0xFF00, 0x0F00, 0x00A5) == 0, "mcp init failed\n");
    CHECK(bus.mcp.reg[0x00] == 0x00 && bus.mcp.reg[0x01] == 0xFF, "mcp IODIR %02X %02X\n", bus.mcp.reg[0], bus.mcp.reg[1]);
    CHECK(bus.mcp.reg[0x0C] == 0x00 && bus.mcp.reg[0x0D] == 0x0F, "mcp GPPU %02X %02X\n", bus.mcp.reg[0x0C], bus.mcp.reg[0x0D]);
    CHECK(bus.mcp.reg[0x14] == 0xA5, "mcp OLATA %02X\n", bus.mcp.reg[0x14]);
    CHECK(!bus.mcp.bad, "mcp: IOCON.BANK was set\n");
    CHECK(mcp23017_write(&o, DEV_MCP, 0x003C) == 0, "mcp write failed\n");
    uint16_t v16;
    CHECK(mcp23017_read(&o, DEV_MCP, &v16) == 0, "mcp read failed\n");
    /* A = OLAT 0x3C; B: B0..B3 pulled up = 1, B4 = 1 (ext), B5 = 0, B6/B7 floating = 0 */
    CHECK(v16 == 0x1F3C, "mcp read 0x%04X, wanted 0x1F3C\n", v16);

    /* ADS1115: every channel and range */
    static const int ranges[6] = {6144, 4096, 2048, 1024, 512, 256};
    for (int pg = 0; pg < 6; pg++) {
        CHECK(ads1115_pga(ranges[pg]) == pg && ads1115_range_mv(pg) == ranges[pg], "ads range %d\n", ranges[pg]);
        for (int ch = 0; ch < 4; ch++) {
            bus.ads.volts[ch] = 0.1 + 0.05 * ch + 0.01 * pg;
            int16_t raw;
            CHECK(ads1115_start(&o, DEV_ADS, ch, pg) == 0 && ads1115_read(&o, DEV_ADS, &raw) == 0, "ads xfer\n");
            double want = bus.ads.volts[ch] * 1000.0 / ranges[pg] * 32768.0;
            if (want > 32767) want = 32767;
            CHECK(fabs(raw - want) <= 1.0, "ads ch%d range %d: raw %d, wanted %.0f\n", ch, ranges[pg], raw, want);
        }
    }
    CHECK(!bus.ads.bad && bus.ads.conversions == 24, "ads: bad config or %d conversions\n", bus.ads.conversions);
    CHECK(ads1115_pga(3300) == 1 && ads1115_pga(100) == 5, "ads pga rounding\n");

    printf(fails ? "i2c_dev: %d FAILURE(S)\n" : "i2c_dev: PCF8574, MCP23017 and ADS1115 protocols check out\n", fails);
    return fails != 0;
}
