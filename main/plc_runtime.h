/* ============================================================================
 * plc_runtime — the CPU: owns the compiled program, the RUN/STOP state and
 * the cyclic scan task (read inputs -> execute OBs -> write outputs, paced to
 * the program's scan time). One mutex serialises everything that touches the
 * program or its memory (scan task, web API, Modbus) — the same model as
 * plc_server.py's Runtime.lock.
 * ==========================================================================*/
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "esp_err.h"
#include "jw.h"
#include "plc_engine.h"

typedef struct {
    uint32_t last_us, min_us, max_us, avg_us; /* measured scan cycle (I/O + logic) */
    uint32_t overruns;                       /* cycles longer than the scan time  */
    uint32_t cycles;
} plc_rt_stats_t;

typedef struct {
    bool running, has_program;
    uint32_t rev;
    char name[64];
    plc_rt_stats_t stats;
} plc_rt_status_t;

/* source of a download body: fill buf, report bytes in *got */
typedef esp_err_t (*plc_rt_reader_t)(void *ctx, char *buf, size_t cap, size_t *got);

esp_err_t plc_rt_init(void); /* load the stored program, start the scan task */

void plc_rt_lock(void);
void plc_rt_unlock(void);
plc_t *plc_rt_engine(void);  /* lock held; never NULL */

/* the following take the lock themselves */
bool plc_rt_running(void);
bool plc_rt_has_program(void);
uint32_t plc_rt_program_rev(void);
size_t plc_rt_forced_count(void);
void plc_rt_project_name(char *out, size_t cap);
bool plc_rt_set_running(bool run);  /* returns the new state */
void plc_rt_stats(plc_rt_stats_t *out);
/* lock held: the same facts without re-taking the (non-recursive) lock */
void plc_rt_status_locked(plc_rt_status_t *out);

/* Download a project (len bytes from rd). Stops the CPU, stores the program in
 * flash, compiles and installs it, then RUNs. On failure the previous program
 * is restored. Writes the JSON reply into w; returns the HTTP status. */
int plc_rt_download(size_t len, plc_rt_reader_t rd, void *ctx, jw_t *w);
esp_err_t plc_rt_erase_program(void);
