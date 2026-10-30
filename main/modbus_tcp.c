/* modbus_tcp.c — see modbus_tcp.h */
#include "modbus_tcp.h"

#include <errno.h>
#include <string.h>

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "lwip/sockets.h"
#include "plc_runtime.h"
#include "sdkconfig.h"

static const char *TAG = "modbus";

#if CONFIG_PLC_MODBUS_ENABLE

#define MAX_CLIENTS CONFIG_PLC_MODBUS_MAX_CLIENTS
#define ADU_MAX 260
#define MAX_QTY_BITS 2000
#define MAX_QTY_REGS 125
#define IDLE_TIMEOUT_US (120LL * 1000 * 1000)

enum { EX_ILLEGAL_FUNCTION = 1, EX_ILLEGAL_ADDRESS = 2, EX_ILLEGAL_VALUE = 3, EX_DEVICE_FAILURE = 4 };

typedef struct {
    int fd;
    size_t len;
    uint8_t buf[ADU_MAX];
    int64_t last;
} client_t;

static client_t s_cli[MAX_CLIENTS];

static uint16_t rd16(const uint8_t *p) { return (uint16_t)((p[0] << 8) | p[1]); }
static void wr16(uint8_t *p, uint16_t v)
{
    p[0] = (uint8_t)(v >> 8);
    p[1] = (uint8_t)v;
}

/* Map a protocol address to (area, bit/byte offset). table: 'c' coil,
 * 'd' discrete, 'h' holding, 'i' input. Returns false if unreachable. */
static bool map_bit(plc_t *e, char table, unsigned addr, uint8_t **byte, uint8_t *bit)
{
    char area;
    if (table == 'c') {
        if (addr < MODBUS_BANK) area = 'M';
        else if (addr < 2 * MODBUS_BANK) area = 'Q', addr -= MODBUS_BANK;
        else return false;
    } else {
        area = 'I';
    }
    size_t size;
    uint8_t *mem = plc_area(e, area, &size);
    if (!mem || addr / 8 >= size) return false;
    *byte = mem + addr / 8;
    *bit = (uint8_t)(addr % 8);
    return true;
}

static uint8_t *map_reg(plc_t *e, char table, unsigned addr)
{
    char area;
    if (table == 'h') {
        if (addr < MODBUS_BANK) area = 'M';
        else if (addr < 2 * MODBUS_BANK) area = 'Q', addr -= MODBUS_BANK;
        else return NULL;
    } else {
        area = 'I';
    }
    size_t size;
    uint8_t *mem = plc_area(e, area, &size);
    if (!mem || (size_t)addr * 2 + 1 >= size) return NULL;
    return mem + (size_t)addr * 2;
}

/* Handle one PDU (fc + data). Writes the response PDU into out; returns its
 * length, or -exception. Called with the runtime lock held. */
static int handle_pdu(plc_t *e, const uint8_t *pdu, size_t n, uint8_t *out)
{
    uint8_t fc = pdu[0];
    const uint8_t *d = pdu + 1;
    size_t dn = n - 1;
    out[0] = fc;
    switch (fc) {
    case 0x01:
    case 0x02: {
        if (dn < 4) return -EX_ILLEGAL_VALUE;
        unsigned addr = rd16(d), qty = rd16(d + 2);
        if (qty < 1 || qty > MAX_QTY_BITS) return -EX_ILLEGAL_VALUE;
        unsigned nb = (qty + 7) / 8;
        out[1] = (uint8_t)nb;
        memset(out + 2, 0, nb);
        for (unsigned i = 0; i < qty; i++) {
            uint8_t *b, bit;
            if (!map_bit(e, fc == 1 ? 'c' : 'd', addr + i, &b, &bit)) return -EX_ILLEGAL_ADDRESS;
            if ((*b >> bit) & 1) out[2 + i / 8] |= (uint8_t)(1u << (i % 8));
        }
        return 2 + (int)nb;
    }
    case 0x03:
    case 0x04: {
        if (dn < 4) return -EX_ILLEGAL_VALUE;
        unsigned addr = rd16(d), qty = rd16(d + 2);
        if (qty < 1 || qty > MAX_QTY_REGS) return -EX_ILLEGAL_VALUE;
        out[1] = (uint8_t)(qty * 2);
        for (unsigned i = 0; i < qty; i++) {
            uint8_t *r = map_reg(e, fc == 3 ? 'h' : 'i', addr + i);
            if (!r) return -EX_ILLEGAL_ADDRESS;
            out[2 + i * 2] = r[0];
            out[3 + i * 2] = r[1];
        }
        return 2 + (int)qty * 2;
    }
    case 0x05: {
        if (dn < 4) return -EX_ILLEGAL_VALUE;
        unsigned addr = rd16(d), val = rd16(d + 2);
        if (val != 0x0000 && val != 0xFF00) return -EX_ILLEGAL_VALUE;
        uint8_t *b, bit;
        if (!map_bit(e, 'c', addr, &b, &bit)) return -EX_ILLEGAL_ADDRESS;
        if (val) *b |= (uint8_t)(1u << bit);
        else *b &= (uint8_t)~(1u << bit);
        memcpy(out + 1, d, 4);
        return 5;
    }
    case 0x06: {
        if (dn < 4) return -EX_ILLEGAL_VALUE;
        uint8_t *r = map_reg(e, 'h', rd16(d));
        if (!r) return -EX_ILLEGAL_ADDRESS;
        r[0] = d[2];
        r[1] = d[3];
        memcpy(out + 1, d, 4);
        return 5;
    }
    case 0x0F: {
        if (dn < 5) return -EX_ILLEGAL_VALUE;
        unsigned addr = rd16(d), qty = rd16(d + 2), nb = d[4];
        if (qty < 1 || qty > MAX_QTY_BITS || nb != (qty + 7) / 8 || dn < 5 + nb) return -EX_ILLEGAL_VALUE;
        for (unsigned i = 0; i < qty; i++) { /* validate first: all or nothing */
            uint8_t *b, bit;
            if (!map_bit(e, 'c', addr + i, &b, &bit)) return -EX_ILLEGAL_ADDRESS;
        }
        for (unsigned i = 0; i < qty; i++) {
            uint8_t *b = NULL, bit = 0;
            if (!map_bit(e, 'c', addr + i, &b, &bit)) return -EX_ILLEGAL_ADDRESS;
            if ((d[5 + i / 8] >> (i % 8)) & 1) *b |= (uint8_t)(1u << bit);
            else *b &= (uint8_t)~(1u << bit);
        }
        wr16(out + 1, (uint16_t)addr);
        wr16(out + 3, (uint16_t)qty);
        return 5;
    }
    case 0x10: {
        if (dn < 5) return -EX_ILLEGAL_VALUE;
        unsigned addr = rd16(d), qty = rd16(d + 2), nb = d[4];
        if (qty < 1 || qty > MAX_QTY_REGS || nb != qty * 2 || dn < 5 + nb) return -EX_ILLEGAL_VALUE;
        for (unsigned i = 0; i < qty; i++)
            if (!map_reg(e, 'h', addr + i)) return -EX_ILLEGAL_ADDRESS;
        for (unsigned i = 0; i < qty; i++) {
            uint8_t *r = map_reg(e, 'h', addr + i);
            r[0] = d[5 + i * 2];
            r[1] = d[6 + i * 2];
        }
        wr16(out + 1, (uint16_t)addr);
        wr16(out + 3, (uint16_t)qty);
        return 5;
    }
    default: return -EX_ILLEGAL_FUNCTION;
    }
}

/* process complete frames in the client's buffer; false = drop the client */
static bool serve(client_t *c)
{
    while (c->len >= 7) {
        uint16_t proto = rd16(c->buf + 2), len = rd16(c->buf + 4);
        size_t frame = 6u + len;
        if (proto != 0 || len < 2 || frame > ADU_MAX) return false;
        if (c->len < frame) break;
        uint8_t resp[ADU_MAX];
        int n;
        plc_rt_lock();
        n = handle_pdu(plc_rt_engine(), c->buf + 7, len - 1, resp + 7);
        plc_rt_unlock();
        if (n < 0) {
            resp[7] = (uint8_t)(c->buf[7] | 0x80);
            resp[8] = (uint8_t)(-n);
            n = 2;
        }
        memcpy(resp, c->buf, 4); /* transaction id + protocol id */
        wr16(resp + 4, (uint16_t)(n + 1));
        resp[6] = c->buf[6]; /* unit id */
        size_t tot = 7u + (size_t)n, sent = 0;
        while (sent < tot) {
            int s = send(c->fd, resp + sent, tot - sent, 0);
            if (s <= 0) return false;
            sent += (size_t)s;
        }
        memmove(c->buf, c->buf + frame, c->len - frame);
        c->len -= frame;
    }
    return true;
}

static void drop(client_t *c)
{
    if (c->fd >= 0) close(c->fd);
    c->fd = -1;
    c->len = 0;
}

static void modbus_task(void *arg)
{
    int ls = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (ls < 0) {
        ESP_LOGE(TAG, "socket failed");
        vTaskDelete(NULL);
        return;
    }
    int one = 1;
    setsockopt(ls, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons(CONFIG_PLC_MODBUS_PORT), .sin_addr.s_addr = htonl(INADDR_ANY)};
    if (bind(ls, (struct sockaddr *)&a, sizeof a) != 0 || listen(ls, 2) != 0) {
        ESP_LOGE(TAG, "cannot listen on port %d", CONFIG_PLC_MODBUS_PORT);
        close(ls);
        vTaskDelete(NULL);
        return;
    }
    for (int i = 0; i < MAX_CLIENTS; i++) s_cli[i].fd = -1;
    ESP_LOGI(TAG, "Modbus TCP server on port %d", CONFIG_PLC_MODBUS_PORT);

    for (;;) {
        fd_set rf;
        FD_ZERO(&rf);
        FD_SET(ls, &rf);
        int maxfd = ls;
        for (int i = 0; i < MAX_CLIENTS; i++)
            if (s_cli[i].fd >= 0) {
                FD_SET(s_cli[i].fd, &rf);
                if (s_cli[i].fd > maxfd) maxfd = s_cli[i].fd;
            }
        struct timeval tv = {.tv_sec = 5, .tv_usec = 0};
        int r = select(maxfd + 1, &rf, NULL, NULL, &tv);
        int64_t now = esp_timer_get_time();
        if (r < 0) {
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        if (r > 0 && FD_ISSET(ls, &rf)) {
            int fd = accept(ls, NULL, NULL);
            if (fd >= 0) {
                int slot = -1;
                for (int i = 0; i < MAX_CLIENTS; i++)
                    if (s_cli[i].fd < 0) slot = i;
                if (slot < 0) {
                    close(fd); /* full */
                } else {
                    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
                    /* lwIP sockets never time out a send by default: a client that
                     * stops reading would block this (single) server task forever */
                    struct timeval sto = {.tv_sec = 2, .tv_usec = 0};
                    setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &sto, sizeof sto);
                    s_cli[slot].fd = fd;
                    s_cli[slot].len = 0;
                    s_cli[slot].last = now;
                }
            }
        }
        for (int i = 0; i < MAX_CLIENTS; i++) {
            client_t *c = &s_cli[i];
            if (c->fd < 0) continue;
            if (r > 0 && FD_ISSET(c->fd, &rf)) {
                int n = recv(c->fd, c->buf + c->len, sizeof c->buf - c->len, 0);
                if (n <= 0) {
                    drop(c);
                    continue;
                }
                c->len += (size_t)n;
                c->last = now;
                if (!serve(c)) drop(c);
            } else if (now - c->last > IDLE_TIMEOUT_US) {
                drop(c);
            }
        }
    }
}

esp_err_t modbus_tcp_start(void)
{
    return xTaskCreatePinnedToCore(modbus_task, "modbus", 4096, NULL, 5, NULL, 0) == pdPASS ? ESP_OK : ESP_ERR_NO_MEM;
}

int modbus_tcp_port(void) { return CONFIG_PLC_MODBUS_PORT; }

#else /* !CONFIG_PLC_MODBUS_ENABLE */

esp_err_t modbus_tcp_start(void)
{
    ESP_LOGI(TAG, "Modbus TCP disabled");
    return ESP_OK;
}
int modbus_tcp_port(void) { return 0; }

#endif
