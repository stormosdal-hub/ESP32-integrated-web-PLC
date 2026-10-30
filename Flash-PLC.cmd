@echo off
rem Double-click to build / flash the PLC firmware: a small menu asks for the
rem chip, the COM port and what to do (it remembers your last answers).
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\flash_menu.ps1"
