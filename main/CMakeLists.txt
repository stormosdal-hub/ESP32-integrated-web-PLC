# The web IDE (../web) is gzip-compressed into a generated C file at build time
# (tools/embed_web.py), so the firmware image always carries the matching UI.
set(WEB_DIR ${CMAKE_CURRENT_LIST_DIR}/../web)
set(WEB_ASSETS_C ${CMAKE_CURRENT_BINARY_DIR}/web_assets.c)

idf_component_register(
    SRCS "main.c" "wifi_mgr.c" "web_server.c" "plc_runtime.c" "plc_io_esp.c"
         "plc_store.c" "modbus_tcp.c" "status_led.c" "shiftreg.c" "i2c_dev.c" "${WEB_ASSETS_C}"
    INCLUDE_DIRS "."
    PRIV_REQUIRES plc_core esp_http_server esp_wifi esp_netif esp_event nvs_flash
                  esp_partition esp_timer esp_driver_gpio esp_driver_ledc esp_adc
                  esp_driver_rmt esp_driver_i2c efuse esp_psram esp_rom esp_app_format spi_flash lwip)

file(GLOB_RECURSE WEB_FILES CONFIGURE_DEPENDS "${WEB_DIR}/*")
idf_build_get_property(python PYTHON)
add_custom_command(OUTPUT ${WEB_ASSETS_C}
    COMMAND ${python} ${CMAKE_CURRENT_LIST_DIR}/../tools/embed_web.py ${WEB_DIR} ${WEB_ASSETS_C}
    DEPENDS ${WEB_FILES} ${CMAKE_CURRENT_LIST_DIR}/../tools/embed_web.py
    COMMENT "Embedding the web IDE (gzip)"
    VERBATIM)
add_custom_target(web_assets DEPENDS ${WEB_ASSETS_C})
add_dependencies(${COMPONENT_LIB} web_assets)
set_property(DIRECTORY "${COMPONENT_DIR}" APPEND PROPERTY ADDITIONAL_CLEAN_FILES ${WEB_ASSETS_C})
