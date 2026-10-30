/* ouc_net.c — see ouc_net.h */
#if !defined(_WIN32) && !defined(_DEFAULT_SOURCE)
#define _DEFAULT_SOURCE /* glibc under -std=c11: clock_gettime, usleep */
#endif

#include "ouc_net.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---------------------------------------------------------- sockets: Winsock / BSD (incl. lwIP) */
#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
typedef SOCKET sock_t;
#define NO_SOCK INVALID_SOCKET
#define sock_close(s) closesocket(s)
#define sock_errno() WSAGetLastError()
#define SOCK_AGAIN(e) ((e) == WSAEWOULDBLOCK || (e) == WSAEINTR)
#define SOCK_PENDING(e) ((e) == WSAEWOULDBLOCK || (e) == WSAEINPROGRESS)
#define SOCK_INUSE(e) ((e) == WSAEADDRINUSE || (e) == WSAEACCES) /* WSAEACCES: held exclusively */
#else
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>
typedef int sock_t;
#define NO_SOCK (-1)
#define sock_close(s) close(s)
#define sock_errno() errno
#define SOCK_AGAIN(e) ((e) == EAGAIN || (e) == EWOULDBLOCK || (e) == EINTR)
#define SOCK_PENDING(e) ((e) == EINPROGRESS || (e) == EINTR)
#define SOCK_INUSE(e) ((e) == EADDRINUSE)
#endif

/* a send to a connection the partner reset must not raise SIGPIPE (it would
 * kill the emulator); lwIP has no signals, macOS uses SO_NOSIGPIPE */
#if defined(__linux__) && defined(MSG_NOSIGNAL)
#define SEND_FLAGS MSG_NOSIGNAL
#else
#define SEND_FLAGS 0
#endif

_Static_assert(PLC_MAX_CONNS <= 16, "a handle keeps the slot in 4 bits");

#define CONNECT_TIMEOUT_MS 3000 /* a connect that hangs (no ARP answer, SYN lost) is restarted */

static int set_nonblock(sock_t s)
{
#ifdef _WIN32
    u_long on = 1;
    return ioctlsocket(s, FIONBIO, &on) == 0 ? 0 : -1;
#else
    int fl = fcntl(s, F_GETFL, 0);
    return fl < 0 || fcntl(s, F_SETFL, fl | O_NONBLOCK) < 0 ? -1 : 0;
#endif
}

static void set_opt(sock_t s, int level, int name, int v)
{
    (void)setsockopt(s, level, name, (const char *)&v, (socklen_t)sizeof v); /* best effort */
}

static void sleep_ms(int ms)
{
#ifdef _WIN32
    Sleep((DWORD)ms);
#else
    usleep((useconds_t)ms * 1000u);
#endif
}

double ouc_net_now_ms(void)
{
#ifdef _WIN32
    static LARGE_INTEGER f;
    LARGE_INTEGER c;
    if (!f.QuadPart) QueryPerformanceFrequency(&f);
    QueryPerformanceCounter(&c);
    return (double)c.QuadPart * 1000.0 / (double)f.QuadPart;
#else
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec * 1000.0 + (double)ts.tv_nsec / 1e6;
#endif
}

/* ---------------------------------------------------------- state */
enum { U_FREE = 0, U_OPEN, U_RELEASED };

typedef struct {
    /* shared with the callbacks: only under the lock */
    uint8_t use;                /* U_*: FREE -> OPEN (open) -> RELEASED (close) -> FREE (poll) */
    uint8_t st;                 /* PLC_NET_* */
    bool tx_busy, tx_fail;      /* a message is being sent / the connection broke while it was */
    uint16_t gen;
    int err;                    /* sticky -status (port in use), 0 = none */
    plc_conn_cfg_t cfg;
    uint8_t *rx;                /* ring: rx_len bytes from rx_head (only ever advanced modulo rx_cap) */
    uint32_t rx_head, rx_len;
    uint8_t *tx;                /* the message: tx_off of tx_len bytes sent */
    uint32_t tx_cap, tx_len, tx_off;
    uint8_t peer[4];
    uint16_t peer_port, local_port;
    uint32_t attempts;
    uint64_t rx_bytes, tx_bytes;
    /* poll only (reset by open while the slot is FREE, which poll ignores) */
    sock_t ls, fd;              /* listening socket (passive) / the connection */
    bool connecting;            /* fd: non-blocking connect in progress */
    double t_retry, t_conn;     /* next listen / connect / accept attempt; connect start */
} slot_t;

struct ouc_net {
    slot_t s[PLC_MAX_CONNS];
    uint32_t rx_cap, retry_ms;
    uint16_t gen;
    void (*lock)(void *ctx);
    void (*unlock)(void *ctx);
    void *lock_ctx;
    plc_net_t ops;
};

static void lock(ouc_net_t *n)
{
    if (n->lock) n->lock(n->lock_ctx);
}
static void unlock(ouc_net_t *n)
{
    if (n->unlock) n->unlock(n->lock_ctx);
}

/* lock held: the open slot behind handle h (generation << 4 | slot), or NULL */
static slot_t *slot_of(ouc_net_t *n, int h)
{
    if (h < 0 || (h & 15) >= PLC_MAX_CONNS) return NULL;
    slot_t *s = &n->s[h & 15];
    return s->use == U_OPEN && s->gen == (uint16_t)(h >> 4) ? s : NULL;
}

/* ---------------------------------------------------------- plc_net_t (scan side: memory only) */
static int cb_open(void *user, const plc_conn_cfg_t *c)
{
    ouc_net_t *n = (ouc_net_t *)user;
    if (!c || c->type != 11) return -0x80B6;
    if (c->active ? !c->rport : !c->lport) return -0x80B7;
    if (c->active) {
        uint32_t a = (uint32_t)c->rip[0] << 24 | (uint32_t)c->rip[1] << 16 | (uint32_t)c->rip[2] << 8 | c->rip[3];
        if (a == 0 || a == 0xFFFFFFFFu) return -0x80A4;
    }
    uint8_t *rx = (uint8_t *)malloc(n->rx_cap);
    int r = -0x80C3;
    lock(n);
    slot_t *f = NULL;
    for (int i = 0; i < PLC_MAX_CONNS; i++) {
        slot_t *s = &n->s[i];
        if (s->use == U_OPEN && !c->active && !s->cfg.active && s->cfg.lport == c->lport) {
            r = -0x80B3; /* one passive connection per local port */
            f = NULL;
            break;
        }
        if (s->use == U_FREE && !f) f = s;
    }
    if (f && rx) {
        uint16_t old = f->gen;
        do n->gen = n->gen >= 0x7FFF ? 1 : (uint16_t)(n->gen + 1); /* never the slot's last one */
        while (n->gen == old);
        memset(f, 0, sizeof *f);
        f->gen = n->gen;
        f->use = U_OPEN;
        f->st = PLC_NET_CONNECTING;
        f->cfg = *c;
        f->rx = rx;
        f->ls = f->fd = NO_SOCK;
        if (c->active) {
            memcpy(f->peer, c->rip, 4);
            f->peer_port = c->rport;
        }
        r = (int)f->gen << 4 | (int)(f - n->s);
        rx = NULL;
    }
    unlock(n);
    free(rx);
    return r;
}

static int cb_state(void *user, int h)
{
    ouc_net_t *n = (ouc_net_t *)user;
    lock(n);
    slot_t *s = slot_of(n, h);
    int r = !s ? PLC_NET_CLOSED : s->err ? s->err : s->st;
    unlock(n);
    return r;
}

static int cb_send(void *user, int h, const uint8_t *data, uint32_t len)
{
    ouc_net_t *n = (ouc_net_t *)user;
    int r = 0;
    lock(n);
    slot_t *s = slot_of(n, h);
    if (!s) r = -0x80A1;
    else if (len > OUC_MAX_MSG) r = -0x8088;
    else if (s->err || s->st != PLC_NET_CONNECTED) r = -0x80A1;
    else if (s->tx_busy) r = -0x80C4; /* the previous message is still going out */
    else if (len) {
        if (len > s->tx_cap) { /* grows to the largest message (poll only reads it while busy) */
            uint32_t cap = (len + 1023u) & ~1023u;
            uint8_t *b = (uint8_t *)malloc(cap);
            if (b) {
                free(s->tx);
                s->tx = b;
                s->tx_cap = cap;
            }
        }
        if (len > s->tx_cap) {
            r = -0x80C4; /* out of memory: try again */
        } else {
            memcpy(s->tx, data, len);
            s->tx_len = len;
            s->tx_off = 0;
            s->tx_busy = true;
            s->tx_fail = false;
        }
    } else {
        s->tx_fail = false; /* an empty message is sent at once */
    }
    unlock(n);
    return r;
}

static int cb_send_done(void *user, int h)
{
    ouc_net_t *n = (ouc_net_t *)user;
    lock(n);
    slot_t *s = slot_of(n, h);
    int r = !s || s->tx_fail ? -0x80A1 : !s->tx_busy ? 1 : s->err || s->st == PLC_NET_CLOSED ? -0x80A1 : 0;
    unlock(n);
    return r;
}

static uint32_t cb_rx_avail(void *user, int h)
{
    ouc_net_t *n = (ouc_net_t *)user;
    lock(n);
    slot_t *s = slot_of(n, h);
    uint32_t r = s ? s->rx_len : 0;
    unlock(n);
    return r;
}

/* buf may be NULL: the bytes are dropped */
static uint32_t cb_rx_take(void *user, int h, uint8_t *buf, uint32_t want)
{
    ouc_net_t *n = (ouc_net_t *)user;
    uint32_t got = 0;
    lock(n);
    slot_t *s = slot_of(n, h);
    if (s) {
        if (want > s->rx_len) want = s->rx_len;
        while (got < want) {
            uint32_t k = n->rx_cap - s->rx_head; /* up to the end of the ring */
            if (k > want - got) k = want - got;
            if (buf) memcpy(buf + got, s->rx + s->rx_head, k);
            s->rx_head = (s->rx_head + k) % n->rx_cap;
            s->rx_len -= k;
            got += k;
        }
    }
    unlock(n);
    return got;
}

static void cb_close(void *user, int h)
{
    ouc_net_t *n = (ouc_net_t *)user;
    lock(n);
    slot_t *s = slot_of(n, h);
    if (s) s->use = U_RELEASED; /* poll closes its sockets and frees its buffers */
    unlock(n);
}

/* ---------------------------------------------------------- poll side: every socket call */
static void close_socks(slot_t *s)
{
    if (s->ls != NO_SOCK) sock_close(s->ls);
    if (s->fd != NO_SOCK) sock_close(s->fd);
    s->ls = s->fd = NO_SOCK;
    s->connecting = false;
}

static void set_err(ouc_net_t *n, slot_t *s, int status)
{
    lock(n);
    s->err = status;
    unlock(n);
}

/* the connection is gone (partner closed / reset, send failed): received bytes stay takeable */
static void broken(ouc_net_t *n, slot_t *s)
{
    close_socks(s);
    lock(n);
    s->st = PLC_NET_CLOSED;
    if (s->tx_busy) {
        s->tx_busy = false;
        s->tx_fail = true;
    }
    unlock(n);
}

static void established(ouc_net_t *n, slot_t *s)
{
    s->connecting = false;
    set_opt(s->fd, IPPROTO_TCP, TCP_NODELAY, 1);
    set_opt(s->fd, SOL_SOCKET, SO_KEEPALIVE, 1);
    /* a partner that vanished (cable, power) is noticed in about 45 s, not hours */
#if defined(TCP_KEEPIDLE) && defined(TCP_KEEPINTVL) && defined(TCP_KEEPCNT)
    set_opt(s->fd, IPPROTO_TCP, TCP_KEEPIDLE, 30);
    set_opt(s->fd, IPPROTO_TCP, TCP_KEEPINTVL, 5);
    set_opt(s->fd, IPPROTO_TCP, TCP_KEEPCNT, 3);
#endif
#ifdef SO_NOSIGPIPE
    set_opt(s->fd, SOL_SOCKET, SO_NOSIGPIPE, 1);
#endif
    struct sockaddr_in me, peer;
    socklen_t ml = sizeof me, pl = sizeof peer;
    memset(&me, 0, sizeof me);
    memset(&peer, 0, sizeof peer);
    bool have_me = getsockname(s->fd, (struct sockaddr *)&me, &ml) == 0;
    bool have_peer = getpeername(s->fd, (struct sockaddr *)&peer, &pl) == 0;
    lock(n);
    s->st = PLC_NET_CONNECTED;
    if (have_me) s->local_port = ntohs(me.sin_port);
    if (have_peer) {
        memcpy(s->peer, &peer.sin_addr.s_addr, 4);
        s->peer_port = ntohs(peer.sin_port);
    }
    unlock(n);
}

static void start_listen(ouc_net_t *n, slot_t *s, const plc_conn_cfg_t *c, double now)
{
    sock_t ls = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (ls == NO_SOCK) { /* out of sockets: later */
        s->t_retry = now + n->retry_ms;
        return;
    }
#ifndef _WIN32 /* (on Windows it would let us share a port another program listens on) */
    set_opt(ls, SOL_SOCKET, SO_REUSEADDR, 1);
#endif
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    a.sin_port = htons(c->lport);
    a.sin_addr.s_addr = htonl(INADDR_ANY);
    if (set_nonblock(ls) != 0 || bind(ls, (struct sockaddr *)&a, sizeof a) != 0 || listen(ls, 1) != 0) {
        int e = sock_errno();
        sock_close(ls);
        if (SOCK_INUSE(e)) set_err(n, s, -0x80B3); /* (lwIP reports it at listen) */
        else s->t_retry = now + n->retry_ms;
        return;
    }
    s->ls = ls;
    lock(n);
    s->local_port = c->lport;
    unlock(n);
}

static void start_connect(ouc_net_t *n, slot_t *s, const plc_conn_cfg_t *c, double now)
{
    s->t_retry = now + n->retry_ms; /* the next attempt, should this one fail */
    lock(n);
    s->attempts++;
    unlock(n);
    sock_t fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (fd == NO_SOCK) return;
    if (set_nonblock(fd) != 0) {
        sock_close(fd);
        return;
    }
    struct sockaddr_in a;
    memset(&a, 0, sizeof a);
    a.sin_family = AF_INET;
    if (c->lport) {
#ifndef _WIN32
        set_opt(fd, SOL_SOCKET, SO_REUSEADDR, 1);
#endif
        a.sin_port = htons(c->lport);
        a.sin_addr.s_addr = htonl(INADDR_ANY);
        if (bind(fd, (struct sockaddr *)&a, sizeof a) != 0) {
            int e = sock_errno();
            sock_close(fd);
            if (SOCK_INUSE(e)) set_err(n, s, -0x80B3);
            return;
        }
    }
    a.sin_port = htons(c->rport);
    memcpy(&a.sin_addr.s_addr, c->rip, 4); /* rip[0] is the first octet: network order */
    s->fd = fd;
    if (connect(fd, (struct sockaddr *)&a, sizeof a) == 0) {
        established(n, s);
        return;
    }
    int e = sock_errno();
    if (SOCK_PENDING(e)) {
        s->connecting = true;
        s->t_conn = now;
        return;
    }
    close_socks(s); /* refused / unreachable: again at t_retry */
}

static void finish_connect(ouc_net_t *n, slot_t *s, bool failed)
{
    int err = 0;
    socklen_t l = sizeof err;
    if (getsockopt(s->fd, SOL_SOCKET, SO_ERROR, (char *)&err, &l) != 0) err = -1;
    if (failed || err) close_socks(s); /* again at t_retry */
    else established(n, s);
}

static void do_accept(ouc_net_t *n, slot_t *s, double now)
{
    struct sockaddr_in a;
    socklen_t al = sizeof a;
    sock_t fd = accept(s->ls, (struct sockaddr *)&a, &al);
    if (fd == NO_SOCK) {
        if (!SOCK_AGAIN(sock_errno())) s->t_retry = now + n->retry_ms; /* e.g. out of sockets: don't spin on it */
        return;
    }
    if (set_nonblock(fd) != 0) {
        sock_close(fd);
        return;
    }
    sock_close(s->ls); /* one client per connection ID */
    s->ls = NO_SOCK;
    s->fd = fd;
    established(n, s);
}

static void do_recv(ouc_net_t *n, slot_t *s)
{
    for (int k = 0; k < 2; k++) { /* the free part of the ring may wrap once */
        lock(n);
        uint32_t len = s->rx_len, w = (s->rx_head + len) % n->rx_cap;
        uint8_t *rx = s->rx;
        unlock(n);
        /* TRCV only removes bytes, so [w, w + room) stays free while unlocked */
        uint32_t room = n->rx_cap - len;
        if (room > n->rx_cap - w) room = n->rx_cap - w;
        if (!room || !rx) return;
        long got = (long)recv(s->fd, (char *)rx + w, (int)room, 0);
        if (got > 0) {
            lock(n);
            s->rx_len += (uint32_t)got;
            s->rx_bytes += (uint64_t)got;
            unlock(n);
            if ((uint32_t)got < room) return;
            continue;
        }
        if (got < 0 && SOCK_AGAIN(sock_errno())) return;
        broken(n, s); /* 0: the partner closed it; < 0: reset / error */
        return;
    }
}

static void do_send(ouc_net_t *n, slot_t *s)
{
    for (;;) {
        lock(n);
        bool busy = s->tx_busy;
        const uint8_t *p = busy ? s->tx + s->tx_off : NULL;
        uint32_t left = busy ? s->tx_len - s->tx_off : 0;
        unlock(n);
        if (!busy) return;
        long k = (long)send(s->fd, (const char *)p, (int)left, SEND_FLAGS);
        if (k > 0) {
            lock(n);
            s->tx_off += (uint32_t)k;
            s->tx_bytes += (uint64_t)k;
            if (s->tx_off >= s->tx_len) s->tx_busy = false; /* send_done: 1 */
            unlock(n);
            continue;
        }
        if (k < 0 && SOCK_AGAIN(sock_errno())) return; /* socket buffer full: when writable */
        broken(n, s);
        return;
    }
}

int ouc_net_poll(ouc_net_t *n, int timeout_ms)
{
    double now = ouc_net_now_ms();

    /* 1. released slots: close their sockets, free their buffers (first, so a
     *    port given up here can be listened on again in this pass) */
    for (int i = 0; i < PLC_MAX_CONNS; i++) {
        slot_t *s = &n->s[i];
        lock(n);
        bool rel = s->use == U_RELEASED;
        unlock(n);
        if (!rel) continue;
        close_socks(s);
        lock(n);
        uint8_t *rx = s->rx, *tx = s->tx;
        s->rx = s->tx = NULL;
        s->use = U_FREE;
        unlock(n);
        free(rx);
        free(tx);
    }

    /* 2. start listening / connecting */
    for (int i = 0; i < PLC_MAX_CONNS; i++) {
        slot_t *s = &n->s[i];
        lock(n);
        bool want = s->use == U_OPEN && !s->err && s->st == PLC_NET_CONNECTING;
        plc_conn_cfg_t c = s->cfg;
        unlock(n);
        if (!want) continue;
        if (s->connecting && now - s->t_conn >= CONNECT_TIMEOUT_MS) {
            close_socks(s);
            s->t_retry = now; /* a fresh SYN right away */
        }
        if (s->ls != NO_SOCK || s->fd != NO_SOCK || now < s->t_retry) continue;
        if (c.active) start_connect(n, s, &c, now);
        else start_listen(n, s, &c, now);
    }

    /* 3. wait for any of them */
    fd_set rd, wr, ex;
    FD_ZERO(&rd);
    FD_ZERO(&wr);
    FD_ZERO(&ex);
    int watched = 0;
    sock_t maxfd = 0;
#define WATCH(fd, set)                     \
    do {                                   \
        FD_SET(fd, set);                   \
        if ((fd) > maxfd) maxfd = (fd);    \
    } while (0)
    for (int i = 0; i < PLC_MAX_CONNS; i++) {
        slot_t *s = &n->s[i];
        lock(n);
        bool open = s->use == U_OPEN, rx_room = s->rx_len < n->rx_cap, tx = s->tx_busy;
        unlock(n);
        if (!open) continue;
        if (s->ls != NO_SOCK && now >= s->t_retry) {
            WATCH(s->ls, &rd);
            watched++;
        }
        if (s->fd == NO_SOCK) continue;
        if (s->connecting) {
            WATCH(s->fd, &wr);
#ifdef _WIN32
            FD_SET(s->fd, &ex); /* Winsock reports a failed connect here */
#endif
            watched++;
        } else if (rx_room || tx) {
            if (rx_room) WATCH(s->fd, &rd); /* ring full: stop reading (flow control) */
            if (tx) WATCH(s->fd, &wr);
            watched++;
        }
    }
#undef WATCH
    if (!watched) {
        if (timeout_ms > 0) sleep_ms(timeout_ms);
        return 0;
    }
    struct timeval tv;
    tv.tv_sec = timeout_ms > 0 ? timeout_ms / 1000 : 0;
    tv.tv_usec = timeout_ms > 0 ? (timeout_ms % 1000) * 1000 : 0;
    if (select((int)maxfd + 1, &rd, &wr, &ex, &tv) < 0) {
        if (timeout_ms > 0) sleep_ms(timeout_ms); /* (never spin on an error) */
        return watched;
    }

    /* 4. serve them */
    now = ouc_net_now_ms();
    for (int i = 0; i < PLC_MAX_CONNS; i++) {
        slot_t *s = &n->s[i];
        lock(n);
        bool open = s->use == U_OPEN;
        unlock(n);
        if (!open) continue; /* released meanwhile: closed in the next pass */
        if (s->ls != NO_SOCK && FD_ISSET(s->ls, &rd)) do_accept(n, s, now);
        if (s->fd == NO_SOCK) continue;
        if (s->connecting) {
            bool failed = FD_ISSET(s->fd, &ex);
            if (failed || FD_ISSET(s->fd, &wr)) finish_connect(n, s, failed);
            continue;
        }
        if (FD_ISSET(s->fd, &rd)) do_recv(n, s);
        if (s->fd != NO_SOCK) do_send(n, s); /* also a message queued since step 3 */
    }
    return watched;
}

/* ---------------------------------------------------------- lifecycle */
ouc_net_t *ouc_net_create(const ouc_net_cfg_t *cfg)
{
#ifdef _WIN32
    WSADATA wd;
    if (WSAStartup(MAKEWORD(2, 2), &wd) != 0) return NULL;
#endif
    ouc_net_t *n = (ouc_net_t *)calloc(1, sizeof *n);
    if (!n) {
#ifdef _WIN32
        WSACleanup();
#endif
        return NULL;
    }
    n->rx_cap = cfg && cfg->rx_buf ? cfg->rx_buf : OUC_RX_DEFAULT;
    if (n->rx_cap < 256) n->rx_cap = 256;
    n->retry_ms = cfg && cfg->retry_ms ? cfg->retry_ms : 1000;
    if (cfg && cfg->lock && cfg->unlock) {
        n->lock = cfg->lock;
        n->unlock = cfg->unlock;
        n->lock_ctx = cfg->lock_ctx;
    }
    for (int i = 0; i < PLC_MAX_CONNS; i++) n->s[i].ls = n->s[i].fd = NO_SOCK;
    n->ops.user = n;
    n->ops.open = cb_open;
    n->ops.state = cb_state;
    n->ops.send = cb_send;
    n->ops.send_done = cb_send_done;
    n->ops.rx_avail = cb_rx_avail;
    n->ops.rx_take = cb_rx_take;
    n->ops.close = cb_close;
    return n;
}

void ouc_net_destroy(ouc_net_t *n)
{
    if (!n) return;
    for (int i = 0; i < PLC_MAX_CONNS; i++) {
        close_socks(&n->s[i]);
        free(n->s[i].rx);
        free(n->s[i].tx);
    }
    free(n);
#ifdef _WIN32
    WSACleanup();
#endif
}

const plc_net_t *ouc_net_ops(ouc_net_t *n) { return n ? &n->ops : NULL; }

/* ---------------------------------------------------------- monitoring */
static void fill_info(ouc_net_t *n, const slot_t *s, ouc_info_t *o)
{
    memset(o, 0, sizeof *o);
    o->open = s->use == U_OPEN;
    if (!o->open) return;
    o->state = s->err ? s->err : s->st;
    o->cfg = s->cfg;
    memcpy(o->peer, s->peer, 4);
    o->peer_port = s->peer_port;
    o->local_port = s->local_port;
    o->attempts = s->attempts;
    o->rx_queued = s->rx_len;
    o->rx_bytes = s->rx_bytes;
    o->tx_bytes = s->tx_bytes;
    (void)n;
}

bool ouc_net_info(ouc_net_t *n, int h, ouc_info_t *out)
{
    lock(n);
    slot_t *s = slot_of(n, h);
    if (s) fill_info(n, s, out);
    unlock(n);
    return s != NULL;
}

bool ouc_net_slot_info(ouc_net_t *n, int i, ouc_info_t *out)
{
    if (i < 0 || i >= PLC_MAX_CONNS) return false;
    lock(n);
    fill_info(n, &n->s[i], out);
    unlock(n);
    return true;
}

void ouc_net_json(ouc_net_t *n, jw_t *w)
{
    jw_arr(w);
    for (int i = 0; n && i < PLC_MAX_CONNS; i++) {
        ouc_info_t in;
        if (!ouc_net_slot_info(n, i, &in) || !in.open) continue;
        char txt[24];
        jw_obj(w);
        jw_kint(w, "id", in.cfg.id);
        if (in.state < 0) {
            jw_kstr(w, "state", "error");
            snprintf(txt, sizeof txt, "16#%04X", (unsigned)-in.state);
            jw_kstr(w, "status", txt);
        } else {
            jw_kstr(w, "state", in.state == PLC_NET_CONNECTED ? "connected" : in.state == PLC_NET_CLOSED ? "closed" : "connecting");
        }
        jw_kbool(w, "active", in.cfg.active);
        if (in.local_port) jw_kint(w, "localPort", in.local_port);
        else jw_knull(w, "localPort");
        if (in.peer_port) {
            snprintf(txt, sizeof txt, "%u.%u.%u.%u", in.peer[0], in.peer[1], in.peer[2], in.peer[3]);
            jw_kstr(w, "remoteAddress", txt);
            jw_kint(w, "remotePort", in.peer_port);
        } else {
            jw_knull(w, "remoteAddress");
            jw_knull(w, "remotePort");
        }
        jw_kint(w, "attempts", in.attempts);
        jw_kint(w, "rxQueued", in.rx_queued);
        jw_kint(w, "rxBytes", (long long)in.rx_bytes);
        jw_kint(w, "txBytes", (long long)in.tx_bytes);
        jw_obj_end(w);
    }
    jw_arr_end(w);
}
