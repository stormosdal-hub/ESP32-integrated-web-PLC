# ESP32 web PLC — a TIA-Portal-style IDE served by the ESP32 itself (S3, classic
# ESP32 or P4 + C6), running LAD / FBD / SCL programs on the chip's GPIO.
cmake_minimum_required(VERSION 3.16)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
# Trim the build to main + what it depends on.
idf_build_set_property(MINIMAL_BUILD ON)
# One lock file per chip: the P4 pulls in extra components (esp_hosted for the
# C6), so a shared lock would flip back and forth between chips.
idf_build_set_property(DEPENDENCIES_LOCK dependencies.lock.${IDF_TARGET})
project(esp32_web_plc)

# Some toolchain ranlib executables are blocked by this machine's Device Guard
# policy. 'ar qcs' writes the symbol index itself, so ranlib is redundant, and
# 'cmake -E true' is a built-in no-op that Device Guard cannot block. Harmless
# on machines without the restriction.
set(CMAKE_C_ARCHIVE_CREATE   "<CMAKE_AR> qcs <TARGET> <LINK_FLAGS> <OBJECTS>")
set(CMAKE_CXX_ARCHIVE_CREATE "<CMAKE_AR> qcs <TARGET> <LINK_FLAGS> <OBJECTS>")
set(CMAKE_ASM_ARCHIVE_CREATE "<CMAKE_AR> qcs <TARGET> <LINK_FLAGS> <OBJECTS>")
set(CMAKE_C_ARCHIVE_APPEND   "<CMAKE_AR> qs <TARGET> <LINK_FLAGS> <OBJECTS>")
set(CMAKE_CXX_ARCHIVE_APPEND "<CMAKE_AR> qs <TARGET> <LINK_FLAGS> <OBJECTS>")
set(CMAKE_ASM_ARCHIVE_APPEND "<CMAKE_AR> qs <TARGET> <LINK_FLAGS> <OBJECTS>")
set(CMAKE_C_ARCHIVE_FINISH   "${CMAKE_COMMAND} -E true <TARGET>")
set(CMAKE_CXX_ARCHIVE_FINISH "${CMAKE_COMMAND} -E true <TARGET>")
set(CMAKE_ASM_ARCHIVE_FINISH "${CMAKE_COMMAND} -E true <TARGET>")
