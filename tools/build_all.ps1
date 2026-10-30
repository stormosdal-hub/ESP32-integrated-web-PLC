# Build every firmware configuration the project supports and report warnings
# per configuration. Run it after changing Kconfig options, chip-specific code
# (#if CONFIG_IDF_TARGET_* / CONFIG_PLC_*) or sdkconfig.defaults*:
#
#   .\tools\build_all.ps1
#
# A disabled Kconfig bool is absent from sdkconfig.h, so code behind an option
# only gets compiled in a configuration that turns it on - hence the variants
# in test/config. They are compile checks, not meant for flashing.
# Every configuration builds in its own side folder (build_<chip>, build_variant_*),
# never in the main build\ that VS Code / your flashing uses.
$configs = @()
foreach ($c in @(@('ESP32-S3', 'esp32s3'), @('ESP32', 'esp32'), @('ESP32-P4 NANO', 'esp32p4'),
                 @('ESP32-C3', 'esp32c3'), @('ESP32-C6', 'esp32c6'))) {
    $configs += @{ name = "$($c[0]) (default)"; args = @('-Chip', $c[1], '-B', "build_$($c[1])", '-D', "SDKCONFIG=sdkconfig.$($c[1])") }
}
foreach ($v in 'a', 'b', 'c') {
    $configs += @{ name = "ESP32-S3 variant $v"; args = @('-Chip', 'esp32s3', '-B', "build_variant_$v", '-D', "SDKCONFIG=build_variant_$v/sdkconfig",
        '-D', "SDKCONFIG_DEFAULTS=sdkconfig.defaults;test/config/sdkconfig.variant_$v") }
}
$configs += @{ name = 'ESP32 variant d'; args = @('-Chip', 'esp32', '-B', 'build_variant_d', '-D', 'SDKCONFIG=build_variant_d/sdkconfig',
    '-D', 'SDKCONFIG_DEFAULTS=sdkconfig.defaults;test/config/sdkconfig.variant_d') }
foreach ($v in 'e', 'f') {
    $configs += @{ name = "ESP32-P4 variant $v"; args = @('-Chip', 'esp32p4', '-B', "build_variant_$v", '-D', "SDKCONFIG=build_variant_$v/sdkconfig",
        '-D', "SDKCONFIG_DEFAULTS=sdkconfig.defaults;test/config/sdkconfig.variant_$v") }
}

$failed = 0
foreach ($c in $configs) {
    $a = $c.args + @('reconfigure', 'build')   # Kconfig.projbuild edits don't trigger a reconfigure on their own
    $out = & "$PSScriptRoot\idf.ps1" @a 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
    $warn = @($out | Select-String -Pattern 'warning:|error:' | Select-Object -Unique)
    $size = ($out | Select-String -Pattern 'esp32_web_plc\.bin binary size' | Select-Object -First 1)
    if ($code -ne 0 -or $warn.Count) { $failed++ }
    $state = if ($code -ne 0) { 'FAILED' } elseif ($warn.Count) { "$($warn.Count) warning(s)" } else { 'ok' }
    Write-Output ('{0,-22} {1}  {2}' -f $c.name, $state, $(if ($size) { ($size.Line -replace '.*binary size (0x[0-9a-f]+) bytes.*\((\d+%)\) free.*', '$1 bytes, $2 of the app partition free') }))
    $warn | Select-Object -First 15 | ForEach-Object { Write-Output "    $($_.Line)" }
    if ($code -ne 0 -and -not $warn.Count) { $out | Select-Object -Last 15 | ForEach-Object { Write-Output "    $_" } }
}
exit $failed
