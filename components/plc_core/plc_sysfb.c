/* ============================================================================
 * plc_sysfb.c — system function blocks called from SCL: IEC timers, R_TRIG /
 * F_TRIG, counters and Open User Communication (TCON, TDISCON, TSEND, TRCV).
 * The C port of web/js/sysfb.js. Instance layouts come from plc_types.c.
 *
 * OUC runs over plc_env_t.net (real TCP on the ESP32 / PC emulator) or, when
 * there is none, over the same virtual network as the simulator: an active
 * TCON reaches a passive TCON of this program listening on its RemotePort.
 * ==========================================================================*/
#include <stdio.h>
#include <stdlib.h>

#include "plc_internal.h"

/* field access by name */
static const fld_t *F(const ty_t *t, const char *name) { return ty_field(t, name); }
static double g(const ty_t *t, uint8_t *b, const char *name)
{
    const fld_t *f = F(t, name);
    return f ? ty_read(b + f->off, f->bit, f->t) : 0;
}
static void s(const ty_t *t, uint8_t *b, const char *name, double v)
{
    const fld_t *f = F(t, name);
    if (f) ty_write(b + f->off, f->bit, f->t, ty_conv(v, f->t));
}
static double jround(double x) { return floor(x + 0.5); }

/* ------------------------------------------------------------ timers */
static void timer(plc_t *p, uint8_t kind, const ty_t *t, uint8_t *b)
{
    bool in = g(t, b, "IN") != 0;
    double pt = g(t, b, "PT");
    if (pt < 0) pt = 0;
    bool run = g(t, b, "_run") != 0;
    double t0 = g(t, b, "_t0");
    bool prev = g(t, b, "_prev") != 0;
    double now = p->now;
    bool q = false;
    double elapsed = 0, et;
    if (kind == SK_TON) {
        if (in) {
            if (!run) run = true, t0 = now;
            elapsed = now - t0;
        } else {
            run = false;
            elapsed = 0;
        }
        q = run && elapsed >= pt;
        et = jround(elapsed < pt ? elapsed : pt);
    } else if (kind == SK_TOF) {
        if (in) {
            run = false;
            q = true;
            elapsed = 0;
        } else {
            if (prev) run = true, t0 = now;
            if (run) {
                elapsed = now - t0;
                if (elapsed >= pt) q = false, elapsed = pt;
                else q = true;
            } else q = false;
        }
        et = jround(elapsed);
    } else {
        if (in && !prev && !run) run = true, t0 = now;
        if (run) {
            elapsed = now - t0;
            if (elapsed < pt) q = true;
            else {
                q = false;
                elapsed = pt;
                if (!in) run = false;
            }
        }
        et = jround(elapsed < pt ? elapsed : pt);
    }
    s(t, b, "_run", run);
    s(t, b, "_t0", t0);
    s(t, b, "_prev", in);
    s(t, b, "Q", q);
    s(t, b, "ET", et);
}

/* ---------------------------------------------------------- counters */
static void counter(uint8_t kind, const ty_t *cvt, const ty_t *t, uint8_t *b)
{
    double m = cvt->bits == 32 ? 4294967296.0 : cvt->bits == 16 ? 65536.0 : 256.0;
    double mn = cvt->sign ? -m / 2 : 0, mx = cvt->sign ? m / 2 - 1 : m - 1;
    double cv = g(t, b, "CV"), pv = g(t, b, "PV");
    if (kind == SK_CTU) {
        bool cu = g(t, b, "CU") != 0;
        if (g(t, b, "R") != 0) cv = 0;
        else if (cu && g(t, b, "_prev") == 0 && cv < mx) cv++;
        s(t, b, "_prev", cu);
        s(t, b, "CV", cv);
        s(t, b, "Q", cv >= pv);
    } else if (kind == SK_CTD) {
        bool cd = g(t, b, "CD") != 0;
        if (g(t, b, "LD") != 0) cv = pv;
        else if (cd && g(t, b, "_prev") == 0 && cv > mn) cv--;
        s(t, b, "_prev", cd);
        s(t, b, "CV", cv);
        s(t, b, "Q", cv <= 0);
    } else {
        bool cu = g(t, b, "CU") != 0, cd = g(t, b, "CD") != 0;
        bool eu = cu && g(t, b, "_pu") == 0, ed = cd && g(t, b, "_pd") == 0;
        if (g(t, b, "R") != 0) cv = 0;
        else if (g(t, b, "LD") != 0) cv = pv;
        else if (eu && !ed) {
            if (cv < mx) cv++;
        } else if (ed && !eu) {
            if (cv > mn) cv--;
        }
        s(t, b, "_pu", cu);
        s(t, b, "_pd", cd);
        s(t, b, "CV", cv);
        s(t, b, "QU", cv >= pv);
        s(t, b, "QD", cv <= 0);
    }
}

/* ======================================================== OUC connections */
#define RX_CAP 16384u
#define MAX_SEND 8192u

typedef struct conn {
    uint16_t id;
    uint8_t active, state;     /* virtual network: PLC_NET_* */
    uint16_t lport, rport;
    uint8_t rip[4];
    struct conn *peer;         /* virtual network */
    uint8_t *rx;               /* virtual network receive queue */
    uint32_t rxn;
    int h;                     /* transport handle */
} conn_t;

static conn_t *conn_get(plc_t *p, double id)
{
    for (int i = 0; i < PLC_MAX_CONNS; i++)
        if (p->conns[i] && p->conns[i]->id == id) return p->conns[i];
    return NULL;
}
static int conn_count(plc_t *p)
{
    int n = 0;
    for (int i = 0; i < PLC_MAX_CONNS; i++) n += p->conns[i] != NULL;
    return n;
}
static void h_free(plc_t *p, void *x)
{
    if (!x) return;
    if (p->env.free) p->env.free(x);
    else free(x);
}
static void conn_close(plc_t *p, conn_t *c)
{
    const plc_net_t *net = p->env.net;
    if (net) net->close(net->user, c->h);
    else if (c->peer) {
        c->peer->state = PLC_NET_CLOSED;
        c->peer->peer = NULL;
    }
    for (int i = 0; i < PLC_MAX_CONNS; i++)
        if (p->conns[i] == c) p->conns[i] = NULL;
    h_free(p, c->rx);
    h_free(p, c);
}
void plc_conns_close(plc_t *p)
{
    for (int i = 0; i < PLC_MAX_CONNS; i++)
        if (p->conns[i]) conn_close(p, p->conns[i]);
}
/* state: PLC_NET_* (a transport error reads as CLOSED) */
static int conn_state(plc_t *p, conn_t *c)
{
    const plc_net_t *net = p->env.net;
    if (!net) return c->state;
    int st = net->state(net->user, c->h);
    return st < 0 ? PLC_NET_CLOSED : st;
}
static void try_pair(plc_t *p, conn_t *c)
{
    if (p->env.net || !c->active || c->state != PLC_NET_CONNECTING) return;
    for (int i = 0; i < PLC_MAX_CONNS; i++) {
        conn_t *l = p->conns[i];
        if (c->state != PLC_NET_CONNECTING || !l || l == c || l->active || l->state != PLC_NET_CONNECTING || l->lport != c->rport) continue;
        c->state = l->state = PLC_NET_CONNECTED;
        c->peer = l;
        l->peer = c;
    }
}

/* ---- reference parameters ---- */
static int32_t ref_size(const vref_t *r)
{
    if (!r || !r->t || (!r->ptr && !r->is_cell)) return -1;
    if (r->t->k == TK_EL) return r->t->cls == TC_BOOL ? 1 : r->t->cls == TC_NUM ? 8 : (int32_t)r->t->size;
    return (int32_t)r->t->size;
}
static const ty_t *cell_type(const vref_t *r) { return r->t->cls == TC_NUM ? &TY_LREAL : r->t; }
/* the bytes to send: points into the buffer, or into tmp for a cell / Bool */
static const uint8_t *ref_bytes(plc_t *p, const vref_t *r, uint8_t *tmp)
{
    if (r->is_cell) {
        const ty_t *t = cell_type(r);
        pv_t v = plc_rd(p, r->cell);
        memset(tmp, 0, 8);
        if (t->cls == TC_BOOL) tmp[0] = truthy(v) ? 1 : 0;
        else ty_write(tmp, 0, t, ty_conv(numv(v), t));
        return tmp;
    }
    if (r->t->k == TK_EL && r->t->cls == TC_BOOL) {
        tmp[0] = (uint8_t)((r->ptr[0] >> r->bit) & 1);
        return tmp;
    }
    return r->ptr;
}
static void ref_write(plc_t *p, const vref_t *r, const uint8_t *data, uint32_t n)
{
    if (r->is_cell) {
        const ty_t *t = cell_type(r);
        uint8_t tmp[8] = {0};
        memcpy(tmp, data, n < 8 ? n : 8);
        if (t->cls == TC_BOOL) plc_wr(p, r->cell, pvb(tmp[0] & 1));
        else plc_wr(p, r->cell, pvn(ty_read(tmp, 0, t)));
        return;
    }
    if (r->t->k == TK_EL && r->t->cls == TC_BOOL) {
        if (data[0] & 1) r->ptr[0] = (uint8_t)(r->ptr[0] | (1u << r->bit));
        else r->ptr[0] = (uint8_t)(r->ptr[0] & ~(1u << r->bit));
        return;
    }
    memcpy(r->ptr, data, n);
}
static vref_t *ref_of(const ty_t *t, vref_t *refs, const char *name)
{
    for (uint16_t i = 0; i < t->nf; i++)
        if (t->f[i].ref && plc_ieq(t->f[i].name, name)) return &refs[i];
    return NULL;
}

/* ---- TCON ---- */
static void tcon(plc_t *p, const ty_t *t, uint8_t *b, vref_t *refs)
{
    bool req = g(t, b, "REQ") != 0;
    double id = g(t, b, "ID");
    bool edge = req && g(t, b, "_prev") == 0;
    s(t, b, "_prev", req);
    s(t, b, "DONE", 0);
    s(t, b, "ERROR", 0);
#define FAIL(st)                     \
    do {                             \
        s(t, b, "ERROR", 1);         \
        s(t, b, "BUSY", 0);          \
        s(t, b, "STATUS", (st));     \
    } while (0)
    const plc_net_t *net = p->env.net;
    if (g(t, b, "_job") != 0) {
        conn_t *c = conn_get(p, id);
        if (!c) {
            s(t, b, "_job", 0);
            FAIL(0x80A7);
            return;
        }
        try_pair(p, c);
        int st = net ? net->state(net->user, c->h) : c->state;
        if (st < 0) {
            s(t, b, "_job", 0);
            FAIL(-st);
            conn_close(p, c);
        } else if (st != PLC_NET_CONNECTING) {
            s(t, b, "_job", 0);
            s(t, b, "BUSY", 0);
            s(t, b, "DONE", 1);
            s(t, b, "STATUS", 0);
        } else {
            s(t, b, "BUSY", 1);
            s(t, b, "STATUS", 0x7002);
        }
        return;
    }
    if (!edge) {
        s(t, b, "BUSY", 0);
        s(t, b, "STATUS", 0x7000);
        return;
    }
    if (id < 1 || id > 4095) {
        FAIL(0x8086);
        return;
    }
    vref_t *r = ref_of(t, refs, "CONNECT");
    if (!r || r->is_cell || !r->ptr || !r->t || r->t->k == TK_EL || r->t->size < 14) {
        FAIL(0x80B6);
        return;
    }
    const uint8_t *cb = r->ptr;
    plc_conn_cfg_t cfg;
    memset(&cfg, 0, sizeof cfg);
    unsigned cid = (unsigned)((cb[2] << 8) | cb[3]);
    cfg.id = (uint16_t)id;
    cfg.type = cb[4];
    cfg.active = (cb[5] & 1) != 0;
    memcpy(cfg.rip, cb + 6, 4);
    cfg.rport = (uint16_t)((cb[10] << 8) | cb[11]);
    cfg.lport = (uint16_t)((cb[12] << 8) | cb[13]);
    if (cid != (unsigned)id || cfg.type != 11) {
        FAIL(0x80B6);
        return;
    }
    if (conn_get(p, id)) {
        FAIL(0x80A3);
        return;
    }
    if (conn_count(p) >= PLC_MAX_CONNS) {
        FAIL(0x80C3);
        return;
    }
    if ((!cfg.active && cfg.lport == 0) || (cfg.active && cfg.rport == 0)) {
        FAIL(0x80B7);
        return;
    }
    bool all0 = true, all1 = true;
    for (int i = 0; i < 4; i++) all0 = all0 && cfg.rip[i] == 0, all1 = all1 && cfg.rip[i] == 255;
    if (cfg.active && (all0 || all1)) {
        FAIL(0x80A4);
        return;
    }
    if (!net && !cfg.active)
        for (int i = 0; i < PLC_MAX_CONNS; i++)
            if (p->conns[i] && !p->conns[i]->active && p->conns[i]->lport == cfg.lport) {
                FAIL(0x80B3);
                return;
            }
    int h = -1;
    if (net) {
        h = net->open(net->user, &cfg);
        if (h < 0) {
            FAIL(-h);
            return;
        }
    }
    conn_t *c = (conn_t *)(p->env.alloc ? p->env.alloc(sizeof(conn_t)) : malloc(sizeof(conn_t)));
    if (!c) {
        if (net) net->close(net->user, h);
        FAIL(0x80C3);
        return;
    }
    memset(c, 0, sizeof *c);
    c->id = (uint16_t)id;
    c->active = cfg.active;
    c->lport = cfg.lport;
    c->rport = cfg.rport;
    memcpy(c->rip, cfg.rip, 4);
    c->state = PLC_NET_CONNECTING;
    c->h = h;
    for (int i = 0; i < PLC_MAX_CONNS; i++)
        if (!p->conns[i]) {
            p->conns[i] = c;
            break;
        }
    try_pair(p, c);
    s(t, b, "_job", 1);
    s(t, b, "BUSY", 1);
    s(t, b, "STATUS", 0x7001);
}

/* ---- TDISCON ---- */
static void tdiscon(plc_t *p, const ty_t *t, uint8_t *b)
{
    bool req = g(t, b, "REQ") != 0;
    bool edge = req && g(t, b, "_prev") == 0;
    s(t, b, "_prev", req);
    s(t, b, "DONE", 0);
    s(t, b, "ERROR", 0);
    s(t, b, "BUSY", 0);
    if (!edge) {
        s(t, b, "STATUS", 0x7000);
        return;
    }
    conn_t *c = conn_get(p, g(t, b, "ID"));
    if (!c) {
        s(t, b, "ERROR", 1);
        s(t, b, "STATUS", 0x80A3);
        return;
    }
    conn_close(p, c);
    s(t, b, "DONE", 1);
    s(t, b, "STATUS", 0);
}

/* ---- TSEND ---- */
static void tsend(plc_t *p, const ty_t *t, uint8_t *b, vref_t *refs)
{
    bool req = g(t, b, "REQ") != 0;
    bool edge = req && g(t, b, "_prev") == 0;
    s(t, b, "_prev", req);
    s(t, b, "DONE", 0);
    s(t, b, "ERROR", 0);
    const plc_net_t *net = p->env.net;
    conn_t *c = conn_get(p, g(t, b, "ID"));
    if (g(t, b, "_job") != 0) {
        if (!net) {
            s(t, b, "_job", 0);
            if (!c || c->state != PLC_NET_CONNECTED) FAIL(0x80A1);
            else {
                s(t, b, "BUSY", 0);
                s(t, b, "DONE", 1);
                s(t, b, "STATUS", 0);
            }
            return;
        }
        int sd = c ? net->send_done(net->user, c->h) : -0x80A1;
        if (sd == 0) {
            s(t, b, "BUSY", 1);
            s(t, b, "STATUS", 0x7002);
            return;
        }
        s(t, b, "_job", 0);
        if (sd < 0) FAIL(-sd);
        else {
            s(t, b, "BUSY", 0);
            s(t, b, "DONE", 1);
            s(t, b, "STATUS", 0);
        }
        return;
    }
    if (!edge) {
        s(t, b, "BUSY", 0);
        s(t, b, "STATUS", 0x7000);
        return;
    }
    if (!c || conn_state(p, c) != PLC_NET_CONNECTED) {
        FAIL(0x80A1);
        return;
    }
    vref_t *r = ref_of(t, refs, "DATA");
    int32_t size = ref_size(r);
    double lenp = g(t, b, "LEN");
    double len = lenp == 0 ? size : lenp;
    if (size <= 0 || len <= 0 || len > size || len > MAX_SEND) {
        FAIL(0x8088);
        return;
    }
    uint8_t tmp[8];
    const uint8_t *data = ref_bytes(p, r, tmp);
    if (net) {
        int rc = net->send(net->user, c->h, data, (uint32_t)len);
        if (rc < 0) {
            FAIL(-rc);
            return;
        }
    } else {
        conn_t *peer = c->peer;
        if (!peer) {
            FAIL(0x80A1);
            return;
        }
        if (peer->rxn + (uint32_t)len > RX_CAP) {
            FAIL(0x80C4);
            return;
        }
        if (!peer->rx) {
            peer->rx = (uint8_t *)(p->env.alloc ? p->env.alloc(RX_CAP) : malloc(RX_CAP));
            if (!peer->rx) {
                FAIL(0x80C4);
                return;
            }
        }
        memcpy(peer->rx + peer->rxn, data, (size_t)len);
        peer->rxn += (uint32_t)len;
    }
    s(t, b, "_job", 1);
    s(t, b, "BUSY", 1);
    s(t, b, "STATUS", 0x7001);
}

/* ---- TRCV ---- */
static void trcv(plc_t *p, const ty_t *t, uint8_t *b, vref_t *refs)
{
    s(t, b, "NDR", 0);
    s(t, b, "ERROR", 0);
    s(t, b, "RCVD_LEN", 0);
#define RFAIL(st)                \
    do {                         \
        FAIL(st);                \
        s(t, b, "_busy", 0);     \
    } while (0)
    if (g(t, b, "EN_R") == 0) {
        s(t, b, "BUSY", 0);
        s(t, b, "STATUS", 0x7000);
        s(t, b, "_busy", 0);
        return;
    }
    const plc_net_t *net = p->env.net;
    conn_t *c = conn_get(p, g(t, b, "ID"));
    int st = c ? conn_state(p, c) : PLC_NET_CONNECTING;
    if (!c || st == PLC_NET_CONNECTING) {
        RFAIL(0x80A1);
        return;
    }
    vref_t *r = ref_of(t, refs, "DATA");
    int32_t size = ref_size(r);
    double lenp = g(t, b, "LEN");
    double want = lenp == 0 ? size : lenp;
    if (size <= 0 || want > size) {
        RFAIL(0x8088);
        return;
    }
    uint32_t avail = net ? net->rx_avail(net->user, c->h) : c->rxn;
    uint32_t n = 0;
    if (g(t, b, "ADHOC") != 0) n = avail < (uint32_t)size ? avail : (uint32_t)size;
    else if (avail >= want) n = (uint32_t)want;
    if (n > 0) {
        uint8_t small[8];
        uint8_t *tmp = small;
        bool heap = false;
        if (net) {
            if (n > sizeof small) {
                tmp = (uint8_t *)(p->env.alloc ? p->env.alloc(n) : malloc(n));
                heap = true;
            }
            if (!tmp) {
                RFAIL(0x80C4);
                return;
            }
            n = net->rx_take(net->user, c->h, tmp, n);
        } else tmp = c->rx;
        ref_write(p, r, tmp, n);
        if (heap) h_free(p, tmp);
        if (!net) {
            memmove(c->rx, c->rx + n, c->rxn - n);
            c->rxn -= n;
        }
        s(t, b, "NDR", 1);
        s(t, b, "RCVD_LEN", n);
        s(t, b, "BUSY", 0);
        s(t, b, "STATUS", 0);
        s(t, b, "_busy", 0);
        return;
    }
    if (st == PLC_NET_CLOSED) {
        RFAIL(0x80A1);
        return;
    }
    s(t, b, "BUSY", 1);
    s(t, b, "STATUS", g(t, b, "_busy") != 0 ? 0x7002 : 0x7001);
    s(t, b, "_busy", 1);
}

void plc_sysfb_exec(plc_t *p, const ty_t *t, uint8_t *b, vref_t *refs)
{
    switch (t->sys->kind) {
    case SK_TON: case SK_TOF: case SK_TP: timer(p, t->sys->kind, t, b); break;
    case SK_IEC_TIMER: timer(p, SK_TON, t, b); break;
    case SK_R_TRIG: {
        bool clk = g(t, b, "CLK") != 0;
        s(t, b, "Q", clk && g(t, b, "_prev") == 0);
        s(t, b, "_prev", clk);
        break;
    }
    case SK_F_TRIG: {
        bool clk = g(t, b, "CLK") != 0;
        s(t, b, "Q", !clk && g(t, b, "_prev") != 0);
        s(t, b, "_prev", clk);
        break;
    }
    case SK_CTU: case SK_CTD: case SK_CTUD: counter(t->sys->kind, t->sys->cv, t, b); break;
    case SK_TCON: tcon(p, t, b, refs); break;
    case SK_TDISCON: tdiscon(p, t, b); break;
    case SK_TSEND: tsend(p, t, b, refs); break;
    case SK_TRCV: trcv(p, t, b, refs); break;
    }
}

/* ---------------------------------------------------------- public */
void plc_comm_reset(plc_t *p)
{
    if (p) plc_conns_close(p);
}

void plc_conns_json(plc_t *p, jw_t *w)
{
    jw_arr(w);
    if (p) {
        /* by connection ID, like sysfb.js T.ouc.list() */
        conn_t *v[PLC_MAX_CONNS];
        int n = 0;
        for (int i = 0; i < PLC_MAX_CONNS; i++)
            if (p->conns[i]) v[n++] = p->conns[i];
        for (int i = 1; i < n; i++)
            for (int j = i; j > 0 && v[j - 1]->id > v[j]->id; j--) {
                conn_t *x = v[j];
                v[j] = v[j - 1];
                v[j - 1] = x;
            }
        static const char *const ST[] = {"connecting", "connected", "closed"};
        for (int i = 0; i < n; i++) {
            conn_t *c = v[i];
            char ip[20];
            snprintf(ip, sizeof ip, "%u.%u.%u.%u", c->rip[0], c->rip[1], c->rip[2], c->rip[3]);
            jw_obj(w);
            jw_kint(w, "id", c->id);
            jw_kstr(w, "state", ST[conn_state(p, c) % 3]);
            jw_kbool(w, "active", c->active);
            jw_kint(w, "localPort", c->lport);
            jw_kstr(w, "remoteAddress", ip);
            jw_kint(w, "remotePort", c->rport);
            jw_obj_end(w);
        }
    }
    jw_arr_end(w);
}
