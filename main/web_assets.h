/* The web IDE, gzip-compressed into the firmware by tools/embed_web.py */
#pragma once

#include <stddef.h>
#include <stdint.h>

typedef struct {
    const char *path;     /* URL path, e.g. "/js/core.js" */
    const char *mime;
    const uint8_t *data;  /* gzip bytes */
    uint32_t len;
} web_asset_t;

extern const web_asset_t web_assets[];
extern const size_t web_assets_count;
extern const char web_assets_etag[];
