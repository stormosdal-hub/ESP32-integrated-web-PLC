/* shiftreg.c — see shiftreg.h */
#include "shiftreg.h"

static void pulse(const sr_ops_t *o, int pin)
{
    o->set(o->ctx, pin, 1);
    o->delay(o->ctx);
    o->set(o->ctx, pin, 0);
    o->delay(o->ctx);
}

void sr595_write(const sr_ops_t *o, int data, int clock, int latch, int chips, const uint8_t *q)
{
    /* every bit moves one stage on per clock and chip0's QH' feeds chip1:
     * the farthest chip goes first, and inside a chip QH (bit 7) first so it
     * ends up in the last stage */
    for (int c = chips - 1; c >= 0; c--) {
        for (int b = 7; b >= 0; b--) {
            o->set(o->ctx, data, (q[c] >> b) & 1);
            o->delay(o->ctx);
            pulse(o, clock);
        }
    }
    pulse(o, latch); /* storage register -> Q outputs on the rising edge */
}

void sr165_read(const sr_ops_t *o, int data, int clock, int load, int chips, uint8_t *q)
{
    /* SH/LD low copies A..H into the register; then QH shows H of chip0 and
     * every clock brings in the next bit (chip1's QH feeds chip0's SER) */
    o->set(o->ctx, load, 0);
    o->delay(o->ctx);
    o->set(o->ctx, load, 1);
    o->delay(o->ctx);
    for (int c = 0; c < chips; c++) {
        uint8_t v = 0;
        for (int b = 7; b >= 0; b--) {
            if (o->get(o->ctx, data)) v |= (uint8_t)(1u << b);
            pulse(o, clock);
        }
        q[c] = v;
    }
}
