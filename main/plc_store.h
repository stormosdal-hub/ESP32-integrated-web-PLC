/* ============================================================================
 * plc_store — the downloaded program (project JSON) in flash.
 *
 * The "plcprog" partition holds two slots. A download is written to the slot
 * that is NOT active and only becomes active when its header — written last,
 * CRC-protected — lands. A power cut mid-download therefore leaves the old
 * program intact. Reading maps the text straight out of flash, so a stored
 * program never needs a RAM copy.
 * ==========================================================================*/
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "esp_partition.h"

typedef struct {
    int slot;
    size_t len, written;
    uint32_t crc, seq;
} plc_store_tx_t;

esp_err_t plc_store_init(void);
size_t plc_store_max_len(void);
bool plc_store_has_program(size_t *len, uint32_t *seq);

/* map the active program read-only; release with plc_store_unmap() */
esp_err_t plc_store_map(const char **text, size_t *len, esp_partition_mmap_handle_t *h);
void plc_store_unmap(esp_partition_mmap_handle_t h);

/* write a new program: begin -> write... -> (map_tx to compile it) -> commit */
esp_err_t plc_store_begin(plc_store_tx_t *tx, size_t len);
esp_err_t plc_store_write(plc_store_tx_t *tx, const void *data, size_t n);
esp_err_t plc_store_map_tx(plc_store_tx_t *tx, const char **text, esp_partition_mmap_handle_t *h);
esp_err_t plc_store_commit(plc_store_tx_t *tx);

/* forget the stored program */
esp_err_t plc_store_erase(void);
