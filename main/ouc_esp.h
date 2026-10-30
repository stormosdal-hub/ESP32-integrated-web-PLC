/* ============================================================================
 * ouc_esp — the firmware's network for S7 Open User Communication (TCON /
 * TDISCON / TSEND / TRCV): one ouc_net (main/ouc_net.c) whose sockets a
 * background task serves, so the PLC scan only copies bytes in and out.
 *
 *   scan task (runtime lock held) ──plc_net_t──> slots <── "plc_ouc" task:
 *                                   (own mutex, memory only)   select / accept /
 *                                                              connect / recv / send
 * The poll task never takes the runtime lock; the scan never waits for a
 * socket.
 * ==========================================================================*/
#pragma once

#include "esp_err.h"
#include "jw.h"
#include "plc_engine.h"

/* create the connection slots and start the poll task. Call after
 * esp_netif_init() and before plc_rt_init() (the engine gets the transport
 * when it loads a program); no network has to be up yet. */
esp_err_t ouc_esp_init(void);

/* the transport for plc_env_t.net; NULL when ouc_esp_init failed */
const plc_net_t *ouc_esp_net(void);

/* array of the open sockets with their actual partners (ouc_net_json);
 * takes only the OUC mutex — call it without the runtime lock */
void ouc_esp_json(jw_t *w);
