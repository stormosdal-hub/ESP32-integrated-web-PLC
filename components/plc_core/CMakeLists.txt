# Portable PLC engine (no ESP-IDF dependencies; also built on the PC by the
# parity tests in test/ and the emulator in tools/).
idf_component_register(
    SRCS "jdom.c" "jw.c" "plc_engine.c" "plc_scl.c" "plc_types.c" "plc_sysfb.c"
    INCLUDE_DIRS "include"
    PRIV_INCLUDE_DIRS ".")
target_compile_options(${COMPONENT_LIB} PRIVATE -Wno-unused-parameter)
