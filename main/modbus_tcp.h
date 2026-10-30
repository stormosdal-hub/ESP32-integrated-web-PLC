/* ============================================================================
 * modbus_tcp — Modbus TCP server over the PLC's I/Q/M process images
 * (port of modbus_server.py; FC 01-06, 0F, 10). Any SCADA/HMI can connect.
 *
 *   Coils             (FC01, FC05/0F)  0..9999 -> M bit   10000..19999 -> Q bit
 *   Discrete inputs   (FC02)           I bit
 *   Holding registers (FC03, FC06/10)  0..9999 -> M word  10000..19999 -> Q word
 *   Input registers   (FC04)           I word
 *
 * Bit N = byte N/8, bit N%8. Register N = bytes 2N..2N+1 (big-endian), so a
 * Modbus write and a %MW reference in the program hit the same bytes.
 * ==========================================================================*/
#pragma once

#include "esp_err.h"

#define MODBUS_BANK 10000

esp_err_t modbus_tcp_start(void);
int modbus_tcp_port(void); /* 0 when disabled */
