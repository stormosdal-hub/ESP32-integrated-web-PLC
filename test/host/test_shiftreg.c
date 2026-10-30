/* Host test for main/shiftreg.c against simulated 74HC595 / 74HC165 chains
 * that follow the datasheets, not shiftreg.c's own assumptions:
 *   74HC595: SRCLK rising edge: SER -> QA, QA -> QB ... QG -> QH, QH' = QH;
 *            RCLK rising edge: shift register -> output latches.
 *            chip k's SER = chip k-1's QH' (chip 0's SER = the ESP pin).
 *   74HC165: SH/LD low: A..H -> register (QH = H); CLK rising edge with SH/LD
 *            high: SER -> A-stage, ..., G -> H. chip k's SER = chip k+1's QH.
 * Checks that channel c*8+b is pin Q<b>/D<b> of chip c for 1..8 chips. */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "shiftreg.h"

enum { P_DATA = 1, P_CLOCK, P_LATCH, NPINS = 8 };
#define MAXC 8

typedef struct {
    int chips, is165;
    int level[NPINS];
    uint8_t stage[MAXC][8]; /* [chip][0 = A-stage .. 7 = H-stage] */
    uint8_t out[MAXC][8];   /* 595 output latches */
    uint8_t in[MAXC][8];    /* 165 parallel inputs A..H */
    long edges;
} sim_t;

static void sim_set(void *ctx, int pin, int lv)
{
    sim_t *s = (sim_t *)ctx;
    int was = s->level[pin];
    s->level[pin] = lv ? 1 : 0;
    if (!s->is165) {
        if (pin == P_CLOCK && !was && lv) {
            uint8_t qh[MAXC];
            for (int c = 0; c < s->chips; c++) qh[c] = s->stage[c][7];
            for (int c = 0; c < s->chips; c++) {
                memmove(&s->stage[c][1], &s->stage[c][0], 7);
                s->stage[c][0] = c == 0 ? (uint8_t)s->level[P_DATA] : qh[c - 1];
            }
            s->edges++;
        }
        if (pin == P_LATCH && !was && lv) memcpy(s->out, s->stage, sizeof s->out);
    } else {
        if (pin == P_LATCH && !lv) memcpy(s->stage, s->in, sizeof s->stage); /* SH/LD low: parallel load */
        if (pin == P_CLOCK && !was && lv && s->level[P_LATCH]) {
            uint8_t qh[MAXC];
            for (int c = 0; c < s->chips; c++) qh[c] = s->stage[c][7];
            for (int c = 0; c < s->chips; c++) {
                memmove(&s->stage[c][1], &s->stage[c][0], 7);
                s->stage[c][0] = c + 1 < s->chips ? qh[c + 1] : 0;
            }
            s->edges++;
        }
    }
}

static int sim_get(void *ctx, int pin)
{
    sim_t *s = (sim_t *)ctx;
    return pin == P_DATA ? s->stage[0][7] : 0; /* chip 0's QH */
}

static void sim_delay(void *ctx) { (void)ctx; }

int main(void)
{
    int fails = 0;
    srand(1234);
    for (int chips = 1; chips <= MAXC; chips++) {
        for (int round = 0; round < 50; round++) {
            /* 595: what we shift must appear on Q<b> of chip c */
            sim_t s = {.chips = chips};
            sr_ops_t o = {sim_set, sim_get, sim_delay, &s};
            uint8_t q[MAXC];
            for (int c = 0; c < chips; c++) q[c] = (uint8_t)rand();
            sr595_write(&o, P_DATA, P_CLOCK, P_LATCH, chips, q);
            for (int c = 0; c < chips; c++)
                for (int b = 0; b < 8; b++)
                    if (s.out[c][b] != ((q[c] >> b) & 1)) {
                        if (fails++ < 10) printf("595 x%d: chip %d Q%c = %d, wanted %d\n", chips, c, 'A' + b, s.out[c][b], (q[c] >> b) & 1);
                    }
            if (s.edges != chips * 8 || s.level[P_CLOCK] || s.level[P_LATCH]) {
                fails++;
                printf("595 x%d: %ld clock edges, clock %d latch %d left\n", chips, s.edges, s.level[P_CLOCK], s.level[P_LATCH]);
            }

            /* 165: D<b> of chip c must come back as bit b of q[c] */
            sim_t r = {.chips = chips, .is165 = 1};
            r.level[P_LATCH] = 1;
            sr_ops_t ro = {sim_set, sim_get, sim_delay, &r};
            for (int c = 0; c < chips; c++)
                for (int b = 0; b < 8; b++) r.in[c][b] = (uint8_t)(rand() & 1);
            uint8_t got[MAXC];
            sr165_read(&ro, P_DATA, P_CLOCK, P_LATCH, chips, got);
            for (int c = 0; c < chips; c++)
                for (int b = 0; b < 8; b++)
                    if (((got[c] >> b) & 1) != r.in[c][b]) {
                        if (fails++ < 10) printf("165 x%d: chip %d D%c read %d, input %d\n", chips, c, 'A' + b, (got[c] >> b) & 1, r.in[c][b]);
                    }
            if (!r.level[P_LATCH] || r.level[P_CLOCK]) {
                fails++;
                printf("165 x%d: load %d clock %d left\n", chips, r.level[P_LATCH], r.level[P_CLOCK]);
            }
        }
    }
    printf(fails ? "shiftreg: %d FAILURE(S)\n" : "shiftreg: 595 + 165 chains of 1..8 chips, all channels in place\n", fails);
    return fails != 0;
}
