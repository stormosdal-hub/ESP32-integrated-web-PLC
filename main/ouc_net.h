/* ============================================================================
 * ouc_net — the TCP connections behind S7 Open User Communication
 * (TCON / TDISCON / TSEND / TRCV): the engine's plc_net_t over BSD sockets.
 *
 * No ESP-IDF / FreeRTOS includes: the same file builds into the firmware
 * (lwIP sockets, main/ouc_esp.c), into the PC emulator (tools/emulator) on
 * Linux and Windows (Winsock), and into its host test (test/host/test_ouc_net.c).
 *
 * Two sides, never one inside the other:
 *   - the plc_net_t callbacks (ouc_net_ops) run inside the PLC scan. They only
 *     touch memory: record an open/close, copy a message in, take received
 *     bytes out, report state. No socket call, nothing that waits.
 *   - ouc_net_poll() does every socket call: listen / accept, non-blocking
 *     connect (retried about every second while refused, like an S7 CPU),
 *     recv into each connection's receive ring, send from its send buffer,
 *     close. Every socket is non-blocking; poll waits only in select().
 * When they run on different tasks, cfg.lock/unlock serialise the short
 * memory sections of both (poll never holds the lock across a socket call).
 *
 * One slot per connection (PLC_MAX_CONNS). A handle carries a generation
 * count, so a handle kept after close() can never reach a later connection
 * in the same slot: it reads as CLOSED with no data.
 *
 *   passive: listens on cfg.lport (all interfaces), accepts ONE client, then
 *            closes the listening socket (one connection per ID, as on an S7).
 *   active:  connects to rip:rport (from lport when it is not 0).
 * The receive ring is allocated when a slot opens, the send buffer at the
 * first send (as large as the largest message so far); both are freed when
 * the slot closes. A full ring stops reading (TCP flow control): no byte is
 * ever dropped.
 * ==========================================================================*/
#pragma once

#include <stdbool.h>
#include <stdint.h>

#include "jw.h"
#include "plc_engine.h"

#ifdef __cplusplus
extern "C" {
#endif

#define OUC_MAX_MSG 8192        /* largest TSEND message (S7-1200), else -0x8088 */
#define OUC_RX_DEFAULT 4096     /* receive ring per connection */

typedef struct ouc_net ouc_net_t;

typedef struct {
    uint32_t rx_buf;            /* receive ring per connection (bytes); 0 = OUC_RX_DEFAULT */
    uint32_t retry_ms;          /* active: next connect attempt after a failure; 0 = 1000 */
    /* optional: serialise the scan-side callbacks and the poll pass when they
     * run on different tasks (held only for short memory-only sections) */
    void (*lock)(void *ctx);
    void (*unlock)(void *ctx);
    void *lock_ctx;
} ouc_net_cfg_t;

/* what a slot is doing, for monitoring (ouc_net_info / ouc_net_json) */
typedef struct {
    bool open;                  /* the slot belongs to a connection */
    int state;                  /* PLC_NET_* or -status, as plc_net_t.state reports it */
    plc_conn_cfg_t cfg;         /* as passed to open */
    uint8_t peer[4];            /* partner address once connected (passive: who connected) */
    uint16_t peer_port;
    uint16_t local_port;        /* our port once connected / listening */
    uint32_t attempts;          /* active: connect attempts so far */
    uint32_t rx_queued;         /* received, not yet taken by TRCV */
    uint64_t rx_bytes, tx_bytes;/* totals since open */
} ouc_info_t;

/* cfg may be NULL (defaults, no lock). NULL when out of memory (or, on
 * Windows, when Winsock cannot be started). */
ouc_net_t *ouc_net_create(const ouc_net_cfg_t *cfg);
/* close every socket and free everything; no other call may run meanwhile */
void ouc_net_destroy(ouc_net_t *n);

/* the transport for plc_env_t.net (its user is n); valid until destroy */
const plc_net_t *ouc_net_ops(ouc_net_t *n);

/* One pass of socket work: close released slots, start listens / connects,
 * wait up to timeout_ms in select() (0: just a pass), then accept / finish
 * connects / recv / send. With no socket to watch it sleeps timeout_ms.
 * Returns the number of sockets it watched. */
int ouc_net_poll(ouc_net_t *n, int timeout_ms);

/* the slot behind handle h (false: no such open connection) / slot i */
bool ouc_net_info(ouc_net_t *n, int h, ouc_info_t *out);
bool ouc_net_slot_info(ouc_net_t *n, int i, ouc_info_t *out);
/* array of the open slots: {id, state, active, localPort, remoteAddress,
 * remotePort, attempts, rxQueued, rxBytes, txBytes} — remoteAddress/Port are
 * the actual partner once connected (for a passive connection: the client) */
void ouc_net_json(ouc_net_t *n, jw_t *w);

/* the monotonic clock poll uses, in milliseconds (tests: deadlines) */
double ouc_net_now_ms(void);

#ifdef __cplusplus
}
#endif
