# Run idf.py for this project from any PowerShell window:
#
#   .\tools\idf.ps1 build
#   .\tools\idf.ps1 -p COM5 flash monitor
#   .\tools\idf.ps1 menuconfig
#
# Without -Chip it builds the main folder (sdkconfig + build\) for the chip
# sdkconfig is set up for (ESP32-S3 by default; the VS Code extension's target
# switch changes it). A different chip builds side by side, with its own
# settings file and build folder:
#
#   .\tools\idf.ps1 -Chip esp32 build                 # sdkconfig.esp32 + build_esp32\
#   .\tools\idf.ps1 -Chip esp32 -p COM7 flash monitor
#   .\tools\idf.ps1 -Chip esp32 menuconfig
#
# Activates ESP-IDF first (once per shell). The IDF Python venv is built for the
# bundled Python 3.11, so that interpreter is put first on PATH while
# activating (a newer system Python otherwise makes export.ps1 fail). Override
# the locations with IDF_PATH / IDF_TOOLS_PATH if yours differ.
#
# (No param() block on purpose: every argument, including -D / -B, must reach
# idf.py untouched instead of being taken as a PowerShell common parameter.)
# ESP-IDF's export.ps1 and idf.py write progress to stderr, which Windows
# PowerShell turns into error records: never let a caller's 'Stop' preference
# (e.g. tools\flash_menu.ps1) abort on those
$ErrorActionPreference = 'Continue'
$chips = @('esp32s3', 'esp32', 'esp32p4', 'esp32c3', 'esp32c6')
$idfArgs = @()
$chip = $null
for ($i = 0; $i -lt $args.Count; $i++) {
    if ("$($args[$i])" -ieq '-Chip') {
        if ($i + 1 -ge $args.Count) { Write-Error "-Chip needs a value: $($chips -join ', ')"; exit 1 }
        $chip = "$($args[$i + 1])".ToLower()
        $i++
    } else {
        $idfArgs += $args[$i]
    }
}
if ($chip -and $chips -notcontains $chip) { Write-Error "unknown chip '$chip' - supported: $($chips -join ', ')"; exit 1 }
# The main build (sdkconfig + build\) is for whatever chip sdkconfig says - the
# ESP32-S3 unless it was switched, e.g. by the VS Code extension's "Set
# Espressif Device Target". Other chips go to their own folder.
$rootChip = 'esp32s3'
$rootCfg = Join-Path (Split-Path $PSScriptRoot -Parent) 'sdkconfig'
if (Test-Path $rootCfg) {
    $m = Select-String -Path $rootCfg -Pattern '^CONFIG_IDF_TARGET="(\w+)"' | Select-Object -First 1
    if ($m) { $rootChip = $m.Matches[0].Groups[1].Value }
}
if (-not $chip) { $chip = $rootChip }
if ($chip -ne $rootChip -and $idfArgs -notcontains '-B') {
    # own build folder + settings file per chip, so switching never wipes the other
    # (an explicit -B, e.g. a test variant, brings its own -D SDKCONFIG=...)
    Write-Host "[$chip] settings: sdkconfig.$chip   build: build_$chip\"
    $idfArgs = @('-B', "build_$chip", '-D', "SDKCONFIG=sdkconfig.$chip") + $idfArgs
}

function Get-VenvPython {
    if ($env:IDF_PYTHON_ENV_PATH) {
        $p = Join-Path $env:IDF_PYTHON_ENV_PATH 'Scripts\python.exe'
        if (Test-Path $p) { return $p }
    }
    return $null
}

$venvPy = Get-VenvPython
if (-not $venvPy -or -not (Get-Command xtensa-esp32s3-elf-gcc -ErrorAction SilentlyContinue)) {
    if (-not $env:IDF_PATH) { $env:IDF_PATH = "$env:USERPROFILE\esp\v5.5.1\esp-idf" }
    if (-not $env:IDF_TOOLS_PATH) { $env:IDF_TOOLS_PATH = "$env:USERPROFILE\.espressif" }
    $py = Get-ChildItem "$env:IDF_TOOLS_PATH\tools\idf-python" -Directory -ErrorAction SilentlyContinue |
          Sort-Object Name -Descending | Select-Object -First 1
    if ($py) { $env:PATH = "$($py.FullName);$env:PATH" }
    . "$env:IDF_PATH\export.ps1" *> $null
    $venvPy = Get-VenvPython
}
if (-not $venvPy) {
    Write-Error "ESP-IDF environment not found (IDF_PATH=$env:IDF_PATH) - run the ESP-IDF installer, or set IDF_PATH / IDF_TOOLS_PATH"
    exit 1
}
Set-Location (Split-Path $PSScriptRoot -Parent)
# IDF_TARGET picks the chip for this run only: a script's $env changes would
# otherwise stay in the calling shell (and so would a stale value set by,
# e.g., the VS Code extension's terminal)
$oldTarget = $env:IDF_TARGET
$env:IDF_TARGET = $chip
try {
    & $venvPy "$env:IDF_PATH\tools\idf.py" @idfArgs
    $code = $LASTEXITCODE
} finally {
    $env:IDF_TARGET = $oldTarget
}
exit $code
