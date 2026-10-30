# Menu for building / flashing the PLC firmware - started by double-clicking
# "Flash-PLC.cmd" in the project folder. Asks for the chip, the COM port and
# what to do, remembers the answers (Enter = same as last time) and runs
# tools\idf.ps1 with them.
#
# Without the questions (for scripts / testing):
#   tools\flash_menu.ps1 -Chip esp32p4 -Port COM9 -Action flash [-DryRun]
param(
    [string]$Chip,
    [string]$Port,
    [ValidateSet('', 'flash', 'build', 'monitor', 'menuconfig', 'erase')][string]$Action = '',
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$lastFile = Join-Path $PSScriptRoot 'flash_menu.last'   # gitignored: your last answers

$chips = [ordered]@{ 'esp32s3' = 'ESP32-S3'; 'esp32' = 'ESP32 (classic)'; 'esp32p4' = 'ESP32-P4 (+ C6 Wi-Fi)';
           'esp32c3' = 'ESP32-C3 (SuperMini)'; 'esp32c6' = 'ESP32-C6' }
$actions = [ordered]@{
    'flash'      = 'Build + flash + serial monitor'
    'build'      = 'Build only'
    'monitor'    = 'Serial monitor only'
    'menuconfig' = 'Settings (menuconfig: Wi-Fi, status LED, ESP32-P4 board ...)'
    'erase'      = 'Erase the whole flash (program, Wi-Fi settings) - then choose flash'
}

$last = @{}
if (Test-Path $lastFile) {
    Get-Content $lastFile | ForEach-Object { if ($_ -match '^(\w+)=(.*)$') { $last[$Matches[1]] = $Matches[2] } }
}

function Ask-Choice([string]$title, $options, [string]$default) {
    Write-Host ''
    Write-Host $title -ForegroundColor Cyan
    $keys = @($options.Keys)
    for ($i = 0; $i -lt $keys.Count; $i++) {
        $mark = if ($keys[$i] -eq $default) { '  <- Enter' } else { '' }
        Write-Host ("  {0}) {1}{2}" -f ($i + 1), $options[$keys[$i]], $mark)
    }
    while ($true) {
        $a = Read-Host 'Choice'
        if (-not $a -and $default) { return $default }
        $n = 0
        if ([int]::TryParse($a, [ref]$n) -and $n -ge 1 -and $n -le $keys.Count) { return $keys[$n - 1] }
        Write-Host '  type one of the numbers' -ForegroundColor Yellow
    }
}

function Get-ComPorts {
    $list = [ordered]@{}
    Get-CimInstance -ClassName Win32_PnPEntity -Filter "Name LIKE '%(COM%'" -ErrorAction SilentlyContinue |
        Sort-Object Name | ForEach-Object {
            if ($_.Name -match '\((COM\d+)\)') { $list[$Matches[1]] = $_.Name }
        }
    return $list
}

# ---- chip
if (-not $Chip) { $Chip = Ask-Choice 'Which chip?' $chips ($(if ($last.chip) { $last.chip } else { 'esp32s3' })) }
if (-not $chips.Contains($Chip)) { Write-Host "unknown chip '$Chip'" -ForegroundColor Red; exit 1 }

# the ESP32-P4 firmware is built for one board: show which
if ($Chip -eq 'esp32p4') {
    # same choice as idf.ps1: the main sdkconfig if it is set to the P4, else sdkconfig.esp32p4
    $cfg = @((Join-Path $root 'sdkconfig'), (Join-Path $root 'sdkconfig.esp32p4')) | Where-Object {
        (Test-Path $_) -and (Select-String -Path $_ -Pattern '^CONFIG_IDF_TARGET="esp32p4"' -Quiet) } | Select-Object -First 1
    $board = 'NANO (default - not configured yet)'
    if ($cfg) {
        $m = Select-String -Path $cfg -Pattern '^CONFIG_PLC_P4_BOARD_(\w+)=y' | Select-Object -First 1
        if ($m) { $board = @{ WS_NANO = 'Waveshare ESP32-P4-NANO'; WS_MODULE = 'Waveshare ESP32-P4-Module-DEV-KIT';
                              WS_WIFI6 = 'Waveshare ESP32-P4-WIFI6'; GENERIC = 'other board' }[$m.Matches[0].Groups[1].Value] }
    }
    Write-Host "  ESP32-P4 board in the settings: $board  (change it with 'Settings')" -ForegroundColor DarkGray
}

# ---- action
if (-not $Action) { $Action = Ask-Choice 'What to do?' $actions ($(if ($last.action) { $last.action } else { 'flash' })) }

# ---- port (not needed for build / menuconfig)
if ($Action -in 'flash', 'monitor', 'erase' -and -not $Port) {
    $ports = Get-ComPorts
    if ($ports.Count -eq 0) {
        Write-Host ''
        Write-Host 'No COM port found - is the board plugged in (USB "UART" port) and the USB driver installed?' -ForegroundColor Red
        if (-not $DryRun) { Read-Host 'Press Enter to close' | Out-Null }
        exit 1
    }
    $default = if ($last.port -and $ports.Contains($last.port)) { $last.port } else { @($ports.Keys)[0] }
    $Port = if ($ports.Count -eq 1) { @($ports.Keys)[0] } else { Ask-Choice 'Which port?' $ports $default }
    Write-Host "  port: $($ports[$Port])" -ForegroundColor DarkGray
}

if ($Action -eq 'erase' -and -not $DryRun) {
    Write-Host ''
    Write-Host "This erases EVERYTHING on the board at $Port (PLC program, Wi-Fi settings)." -ForegroundColor Yellow
    if ((Read-Host 'Type YES to continue') -cne 'YES') { Write-Host 'cancelled'; Read-Host 'Press Enter to close' | Out-Null; exit 0 }
}

Set-Content -Path $lastFile -Value @("chip=$Chip", "action=$Action", "port=$(if ($Port) { $Port } else { $last.port })") -Encoding ascii

$idfArgs = @('-Chip', $Chip)
if ($Port) { $idfArgs += @('-p', $Port) }
$idfArgs += @{ flash = @('flash', 'monitor'); build = @('build'); monitor = @('monitor'); menuconfig = @('menuconfig'); erase = @('erase-flash') }[$Action]

Write-Host ''
Write-Host ("> tools\idf.ps1 " + ($idfArgs -join ' ')) -ForegroundColor Green
if ($Action -in 'flash', 'monitor') { Write-Host '  (leave the serial monitor with Ctrl+])' -ForegroundColor DarkGray }
if ($DryRun) { exit 0 }
Write-Host ''
$ErrorActionPreference = 'Continue'   # ESP-IDF's progress output on stderr is not an error
& (Join-Path $PSScriptRoot 'idf.ps1') @idfArgs
$code = $LASTEXITCODE
Write-Host ''
if ($code -eq 0) { Write-Host 'Done.' -ForegroundColor Green } else { Write-Host "Failed (exit code $code) - see the messages above." -ForegroundColor Red }
Read-Host 'Press Enter to close' | Out-Null
exit $code
