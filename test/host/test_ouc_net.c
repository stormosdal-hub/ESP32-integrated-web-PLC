/* Host test for main/ouc_net.c over real sockets on 127.0.0.1: the plc_net_t
 * callbacks as the engine's TCON / TSEND / TRCV use them, with ouc_net_poll()
 * doing the socket work in between (like the firmware's poll task).
 *   - open() parameter / resource errors
 *   - a passive and an active slot of the same net find each other
 *   - messages both ways, one bigger than the receive ring (several recvs,
 *     ring wrap), fixed-length style partial reads, flow control with a full
 *     ring (nothing dropped)
 *   - partner close -> CLOSED, the bytes received before still takeable
 *   - stale handle after close, also when the slot is reused
 *   - port in use (another net listens there) -> -0x80B3
 *   - active connect retried until a listener appears
 * The lock hooks of net A check that no lock is ever taken twice (the
 * firmware's mutex is not recursive). */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "ouc_net.h"

static int fails;
#define CHECK(c, ...)                                         \
    do {                                                      \
        if (!(c)) {                                           \
            if (fails++ < 30) {                               \
                printf("FAIL (line %d) ", __LINE__);          \
                printf(__VA_ARGS__);                          \
                printf("\n");                                 \
            }                                                 \
        }                                                     \
    } while (0)

static ouc_net_t *A, *B;
static const plc_net_t *na, *nb;
static int depth, locks;

static void lk(void *ctx)
{
    (void)ctx;
    CHECK(depth == 0, "lock taken while held");
    depth++;
    locks++;
}
static void ulk(void *ctx)
{
    (void)ctx;
    CHECK(depth == 1, "unlock without lock");
    depth--;
}

/* one round of socket work in both nets; false once the deadline passed */
static double deadline;
static void start_wait(double ms) { deadline = ouc_net_now_ms() + ms; }
static int pump(void)
{
    ouc_net_poll(A, 1);
    if (B) ouc_net_poll(B, 0);
    return ouc_net_now_ms() < deadline;
}
/* pump until cond holds or ms pass */
#define WAIT(cond, ms)                \
    do {                              \
        start_wait(ms);               \
        while (!(cond) && pump()) {}  \
    } while (0)

static plc_conn_cfg_t passive(uint16_t id, uint16_t port)
{
    plc_conn_cfg_t c;
    memset(&c, 0, sizeof c);
    c.id = id;
    c.type = 11;
    c.lport = port;
    return c;
}

static plc_conn_cfg_t active(uint16_t id, uint16_t port)
{
    plc_conn_cfg_t c;
    memset(&c, 0, sizeof c);
    c.id = id;
    c.type = 11;
    c.active = true;
    c.rip[0] = 127, c.rip[3] = 1;
    c.rport = port;
    return c;
}

/* send one whole message and wait until it has been handed to TCP */
static int send_all(const plc_net_t *n, int h, const uint8_t *d, uint32_t len)
{
    int r = n->send(n->user, h, d, len);
    if (r) return r;
    WAIT(n->send_done(n->user, h) != 0, 1000);
    return n->send_done(n->user, h) == 1 ? 0 : -1;
}

/* receive exactly len bytes, taking whatever has arrived as it comes */
static uint32_t recv_all(const plc_net_t *n, int h, uint8_t *buf, uint32_t len, uint32_t *max_queued)
{
    uint32_t got = 0;
    start_wait(2000);
    while (got < len) {
        uint32_t q = n->rx_avail(n->user, h);
        if (max_queued && q > *max_queued) *max_queued = q;
        got += n->rx_take(n->user, h, buf + got, len - got);
        if (got < len && !pump()) break;
    }
    return got;
}

int main(void)
{
    ouc_net_cfg_t ca = {4096, 200, lk, ulk, NULL}; /* short connect retry: a quick test */
    A = ouc_net_create(&ca);
    na = ouc_net_ops(A);
    CHECK(A && na && na->user == A, "create");
    if (!A) return 1;
    void *u = na->user;
    /* ports below the Linux / Windows ephemeral ranges, varying from run to run */
    uint16_t base = (uint16_t)(20000 + ((unsigned)ouc_net_now_ms() % 12000u) / 16u * 16u);

    /* ---- open(): parameter and resource errors */
    plc_conn_cfg_t c = passive(1, base);
    c.type = 17;
    CHECK(na->open(u, &c) == -0x80B6, "type 17");
    c = passive(1, 0);
    CHECK(na->open(u, &c) == -0x80B7, "passive without local port");
    c = active(1, 0);
    CHECK(na->open(u, &c) == -0x80B7, "active without remote port");
    c = active(1, base);
    memset(c.rip, 0, 4);
    CHECK(na->open(u, &c) == -0x80A4, "active to 0.0.0.0");
    memset(c.rip, 255, 4);
    CHECK(na->open(u, &c) == -0x80A4, "active to 255.255.255.255");
    int all[PLC_MAX_CONNS + 1];
    for (int i = 0; i <= PLC_MAX_CONNS; i++) {
        c = passive((uint16_t)(10 + i), (uint16_t)(base + 8 + i));
        all[i] = na->open(u, &c);
        CHECK(i < PLC_MAX_CONNS ? all[i] >= 0 : all[i] == -0x80C3, "slot %d: %d", i, all[i]);
    }
    for (int i = 0; i < PLC_MAX_CONNS; i++) na->close(u, all[i]);
    ouc_net_poll(A, 0);

    /* ---- passive + active in the same net connect */
    c = passive(1, base);
    int hp = na->open(u, &c);
    c = passive(5, base);
    CHECK(na->open(u, &c) == -0x80B3, "second passive connection on one port");
    c = active(2, base);
    int ha = na->open(u, &c);
    CHECK(hp >= 0 && ha >= 0 && hp != ha, "open: %d %d", hp, ha);
    CHECK(na->state(u, hp) == PLC_NET_CONNECTING && na->state(u, ha) == PLC_NET_CONNECTING, "connecting");
    CHECK(na->send(u, hp, (const uint8_t *)"x", 1) == -0x80A1, "send before connected");
    WAIT(na->state(u, hp) == PLC_NET_CONNECTED && na->state(u, ha) == PLC_NET_CONNECTED, 1000);
    CHECK(na->state(u, hp) == PLC_NET_CONNECTED && na->state(u, ha) == PLC_NET_CONNECTED, "connected: %d %d",
          na->state(u, hp), na->state(u, ha));
    ouc_info_t ip, ia;
    CHECK(ouc_net_info(A, hp, &ip) && ouc_net_info(A, ha, &ia), "info");
    CHECK(ip.peer[0] == 127 && ip.peer[3] == 1 && ip.peer_port == ia.local_port && ip.local_port == base,
          "passive sees its client: %u.%u.%u.%u:%u (active local %u)", ip.peer[0], ip.peer[1], ip.peer[2], ip.peer[3],
          ip.peer_port, ia.local_port);

    /* ---- messages both ways */
    CHECK(na->send(u, ha, (const uint8_t *)"hello", 5) == 0, "send");
    CHECK(na->send(u, ha, (const uint8_t *)"again", 5) == -0x80C4, "send while the last is still going out");
    CHECK(na->send_done(u, ha) == 0, "pending before poll");
    WAIT(na->send_done(u, ha) == 1 && na->rx_avail(u, hp) == 5, 1000);
    uint8_t buf[50000], ref[50000];
    memset(buf, 0, sizeof buf);
    CHECK(na->rx_take(u, hp, buf, sizeof buf) == 5 && !memcmp(buf, "hello", 5), "hello arrives");
    CHECK(na->rx_avail(u, hp) == 0 && na->rx_take(u, hp, buf, 10) == 0, "nothing more");

    for (int i = 0; i < (int)sizeof ref; i++) ref[i] = (uint8_t)(i * 7 + i / 251);
    CHECK(na->send(u, hp, ref, OUC_MAX_MSG + 1) == -0x8088, "message over 8192 bytes");
    CHECK(send_all(na, hp, ref, OUC_MAX_MSG) == 0, "8192-byte message sent");
    uint32_t maxq = 0;
    CHECK(recv_all(na, ha, buf, OUC_MAX_MSG, &maxq) == OUC_MAX_MSG && !memcmp(buf, ref, OUC_MAX_MSG),
          "8192 bytes through a 4096-byte ring");
    CHECK(maxq <= 4096, "ring holds at most its size (%u)", maxq);

    /* fixed length: wait for 4, take 4, then the rest */
    CHECK(send_all(na, ha, (const uint8_t *)"0123456789", 10) == 0, "10 bytes");
    WAIT(na->rx_avail(u, hp) == 10, 1000);
    CHECK(na->rx_avail(u, hp) == 10, "10 queued (%u)", na->rx_avail(u, hp));
    CHECK(na->rx_take(u, hp, buf, 4) == 4 && !memcmp(buf, "0123", 4), "first 4");
    CHECK(na->rx_avail(u, hp) == 6, "6 left");
    CHECK(na->rx_take(u, hp, buf, 100) == 6 && !memcmp(buf, "456789", 6), "the other 6");
    CHECK(na->rx_take(u, hp, NULL, 100) == 0, "empty");

    /* flow control: 40 KB while nobody reads -> the ring fills up, nothing is lost */
    uint32_t total = 5 * OUC_MAX_MSG;
    for (uint32_t off = 0; off < total; off += OUC_MAX_MSG)
        CHECK(send_all(na, hp, ref + off, OUC_MAX_MSG) == 0, "chunk at %u", off);
    WAIT(na->rx_avail(u, ha) == 4096, 1000);
    CHECK(na->rx_avail(u, ha) == 4096, "ring full (%u)", na->rx_avail(u, ha));
    for (int k = 0; k < 20; k++) pump();
    CHECK(na->rx_avail(u, ha) == 4096, "a full ring stops reading (%u)", na->rx_avail(u, ha));
    maxq = 0;
    memset(buf, 0, sizeof buf);
    CHECK(recv_all(na, ha, buf, total, &maxq) == total && !memcmp(buf, ref, total), "40 KB intact");

    /* ---- partner closes: CLOSED, received bytes stay takeable */
    CHECK(send_all(na, ha, ref, 100) == 0, "100 bytes before closing");
    int ha_old = ha;
    na->close(u, ha);
    WAIT(na->state(u, hp) == PLC_NET_CLOSED, 1000);
    CHECK(na->state(u, hp) == PLC_NET_CLOSED, "partner close seen (%d)", na->state(u, hp));
    CHECK(na->rx_avail(u, hp) == 100, "data kept after close (%u)", na->rx_avail(u, hp));
    CHECK(na->rx_take(u, hp, buf, 100) == 100 && !memcmp(buf, ref, 100), "and takeable");
    CHECK(na->send(u, hp, ref, 10) == -0x80A1, "send on a closed connection");

    /* ---- stale handle, also after its slot is reused */
    CHECK(na->state(u, ha_old) == PLC_NET_CLOSED && na->rx_avail(u, ha_old) == 0, "stale: closed, no data");
    CHECK(na->send(u, ha_old, ref, 1) == -0x80A1 && na->send_done(u, ha_old) == -0x80A1, "stale: no send");
    int hp_old = hp;
    na->close(u, hp);
    ouc_net_poll(A, 0);
    c = active(3, (uint16_t)(base + 1));
    int hn = na->open(u, &c); /* the first free slot: hp's */
    CHECK(hn >= 0 && (hn & 15) == (hp_old & 15) && hn != hp_old, "slot reused with a new handle (%d / %d)", hn, hp_old);
    CHECK(na->state(u, hp_old) == PLC_NET_CLOSED && na->state(u, hn) == PLC_NET_CONNECTING, "stale handle misses the new one");
    CHECK(na->rx_avail(u, hp_old) == 0 && na->send(u, hp_old, ref, 1) == -0x80A1, "stale: no data, no send");
    na->close(u, hp_old);
    CHECK(na->state(u, hn) == PLC_NET_CONNECTING, "closing a stale handle does nothing");

    /* ---- active connect retried until a listener appears (in another net) */
    ouc_net_cfg_t cb = {4096, 200, NULL, NULL, NULL};
    B = ouc_net_create(&cb);
    nb = ouc_net_ops(B);
    CHECK(B != NULL, "second net");
    if (!B) return 1;
    WAIT(0, 150); /* refused: retried every 200 ms */
    CHECK(na->state(u, hn) == PLC_NET_CONNECTING, "still connecting");
    c = passive(4, (uint16_t)(base + 1));
    int hb = nb->open(nb->user, &c);
    WAIT(na->state(u, hn) == PLC_NET_CONNECTED && nb->state(nb->user, hb) == PLC_NET_CONNECTED, 4000);
    CHECK(na->state(u, hn) == PLC_NET_CONNECTED && nb->state(nb->user, hb) == PLC_NET_CONNECTED, "connected after retry");
    CHECK(ouc_net_info(A, hn, &ia), "info");
#ifndef _WIN32 /* (Winsock retries a refused SYN itself for ~1 s) */
    CHECK(ia.attempts >= 2, "connect attempts: %u", ia.attempts);
#endif
    CHECK(send_all(nb, hb, (const uint8_t *)"ping", 4) == 0, "across nets");
    WAIT(na->rx_avail(u, hn) == 4, 1000);
    CHECK(na->rx_take(u, hn, buf, 4) == 4 && !memcmp(buf, "ping", 4), "ping");

    /* ---- port in use: B cannot listen where A listens */
    c = passive(6, (uint16_t)(base + 2));
    int hx = na->open(u, &c);
    ouc_net_poll(A, 0); /* A listens now */
    int hy = nb->open(nb->user, &c);
    CHECK(hx >= 0 && hy >= 0, "open both");
    WAIT(nb->state(nb->user, hy) < 0, 1000);
    CHECK(nb->state(nb->user, hy) == -0x80B3, "port in use: %d", nb->state(nb->user, hy));
    for (int k = 0; k < 5; k++) pump();
    CHECK(nb->state(nb->user, hy) == -0x80B3 && na->state(u, hx) == PLC_NET_CONNECTING, "sticky; A still listening");

    jw_t w;
    jw_init(&w, NULL);
    ouc_net_json(A, &w);
    CHECK(w.buf && strstr(w.buf, "\"state\":\"connected\"") && strstr(w.buf, "\"remoteAddress\":\"127.0.0.1\""),
          "json: %s", w.buf ? w.buf : "(none)");
    jw_release(&w, NULL);

    ouc_net_destroy(A);
    ouc_net_destroy(B);
    CHECK(depth == 0 && locks > 0, "lock balance (%d, %d)", depth, locks);
    if (fails) {
        printf("test_ouc_net: %d check(s) FAILED\n", fails);
        return 1;
    }
    printf("test_ouc_net: all checks pass (%d lock sections)\n", locks);
    return 0;
}
