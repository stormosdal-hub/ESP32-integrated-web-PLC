/* plc_store.c — see plc_store.h */
#include "plc_store.h"

#include <stddef.h>
#include <string.h>

#include "esp_log.h"
#include "esp_rom_crc.h"

static const char *TAG = "plc_store";

#define STORE_MAGIC 0x31434C50u /* "PLC1" */
#define HDR_SECTOR 4096u        /* header owns the slot's first sector; data follows */

typedef struct {
    uint32_t magic, seq, len, crc;
    uint32_t hcrc; /* CRC of the fields above */
} hdr_t;

static const esp_partition_t *s_part;
static size_t s_slot;     /* slot size in bytes */
static int s_active = -1; /* -1 = no program */
static uint32_t s_seq;
static size_t s_len;

static uint32_t hdr_crc(const hdr_t *h) { return esp_rom_crc32_le(0, (const uint8_t *)h, offsetof(hdr_t, hcrc)); }

static size_t slot_base(int slot) { return (size_t)slot * s_slot; }

static bool read_hdr(int slot, hdr_t *h)
{
    if (esp_partition_read(s_part, slot_base(slot), h, sizeof *h) != ESP_OK) return false;
    return h->magic == STORE_MAGIC && h->hcrc == hdr_crc(h) && h->len > 0 && h->len <= s_slot - HDR_SECTOR;
}

static bool data_ok(int slot, const hdr_t *h)
{
    const void *ptr;
    esp_partition_mmap_handle_t mh;
    if (esp_partition_mmap(s_part, slot_base(slot) + HDR_SECTOR, h->len, ESP_PARTITION_MMAP_DATA, &ptr, &mh) != ESP_OK)
        return false;
    uint32_t c = esp_rom_crc32_le(0, (const uint8_t *)ptr, h->len);
    esp_partition_munmap(mh);
    return c == h->crc;
}

esp_err_t plc_store_init(void)
{
    s_part = esp_partition_find_first(ESP_PARTITION_TYPE_DATA, (esp_partition_subtype_t)0x40, "plcprog");
    if (!s_part) {
        ESP_LOGE(TAG, "partition 'plcprog' not found - check partitions.csv");
        return ESP_ERR_NOT_FOUND;
    }
    s_slot = (s_part->size / 2) & ~(size_t)(HDR_SECTOR - 1);
    hdr_t h[2];
    bool ok[2];
    for (int i = 0; i < 2; i++) ok[i] = read_hdr(i, &h[i]) && data_ok(i, &h[i]);
    int pick = -1;
    if (ok[0] && ok[1]) pick = ((int32_t)(h[1].seq - h[0].seq) > 0) ? 1 : 0;
    else if (ok[0]) pick = 0;
    else if (ok[1]) pick = 1;
    if (pick >= 0) {
        s_active = pick;
        s_seq = h[pick].seq;
        s_len = h[pick].len;
        ESP_LOGI(TAG, "stored program: slot %d, %u bytes, download #%u", pick, (unsigned)s_len, (unsigned)s_seq);
    } else {
        ESP_LOGI(TAG, "no stored program");
    }
    return ESP_OK;
}

size_t plc_store_max_len(void) { return s_part ? s_slot - HDR_SECTOR : 0; }

bool plc_store_has_program(size_t *len, uint32_t *seq)
{
    if (len) *len = s_active >= 0 ? s_len : 0;
    if (seq) *seq = s_seq;
    return s_active >= 0;
}

esp_err_t plc_store_map(const char **text, size_t *len, esp_partition_mmap_handle_t *h)
{
    if (!s_part || s_active < 0) return ESP_ERR_NOT_FOUND;
    const void *ptr;
    esp_err_t err = esp_partition_mmap(s_part, slot_base(s_active) + HDR_SECTOR, s_len, ESP_PARTITION_MMAP_DATA, &ptr, h);
    if (err != ESP_OK) return err;
    *text = (const char *)ptr;
    *len = s_len;
    return ESP_OK;
}

void plc_store_unmap(esp_partition_mmap_handle_t h) { esp_partition_munmap(h); }

esp_err_t plc_store_begin(plc_store_tx_t *tx, size_t len)
{
    if (!s_part) return ESP_ERR_NOT_FOUND;
    if (len == 0 || len > plc_store_max_len()) return ESP_ERR_INVALID_SIZE;
    memset(tx, 0, sizeof *tx);
    tx->slot = (s_active == 0) ? 1 : 0;
    tx->len = len;
    tx->seq = s_seq + 1;
    size_t span = (HDR_SECTOR + len + HDR_SECTOR - 1) & ~(size_t)(HDR_SECTOR - 1);
    return esp_partition_erase_range(s_part, slot_base(tx->slot), span);
}

esp_err_t plc_store_write(plc_store_tx_t *tx, const void *data, size_t n)
{
    if (tx->written + n > tx->len) return ESP_ERR_INVALID_SIZE;
    esp_err_t err = esp_partition_write(s_part, slot_base(tx->slot) + HDR_SECTOR + tx->written, data, n);
    if (err != ESP_OK) return err;
    tx->crc = esp_rom_crc32_le(tx->crc, (const uint8_t *)data, n);
    tx->written += n;
    return ESP_OK;
}

esp_err_t plc_store_map_tx(plc_store_tx_t *tx, const char **text, esp_partition_mmap_handle_t *h)
{
    if (tx->written != tx->len) return ESP_ERR_INVALID_STATE;
    const void *ptr;
    esp_err_t err = esp_partition_mmap(s_part, slot_base(tx->slot) + HDR_SECTOR, tx->len, ESP_PARTITION_MMAP_DATA, &ptr, h);
    if (err == ESP_OK) *text = (const char *)ptr;
    return err;
}

esp_err_t plc_store_commit(plc_store_tx_t *tx)
{
    if (tx->written != tx->len) return ESP_ERR_INVALID_STATE;
    hdr_t h = {.magic = STORE_MAGIC, .seq = tx->seq, .len = (uint32_t)tx->len, .crc = tx->crc};
    h.hcrc = hdr_crc(&h);
    esp_err_t err = esp_partition_write(s_part, slot_base(tx->slot), &h, sizeof h);
    if (err != ESP_OK) return err;
    s_active = tx->slot;
    s_seq = tx->seq;
    s_len = tx->len;
    ESP_LOGI(TAG, "program committed: slot %d, %u bytes, download #%u", s_active, (unsigned)s_len, (unsigned)s_seq);
    return ESP_OK;
}

esp_err_t plc_store_erase(void)
{
    if (!s_part) return ESP_ERR_NOT_FOUND;
    /* the older (inactive) slot first: a power cut between the two erases must
     * leave the newest program, never resurrect an older one */
    int first = (s_active == 0) ? 1 : 0;
    esp_err_t err = esp_partition_erase_range(s_part, slot_base(first), HDR_SECTOR);
    if (err == ESP_OK) err = esp_partition_erase_range(s_part, slot_base(1 - first), HDR_SECTOR);
    s_active = -1;
    s_len = 0;
    return err;
}
