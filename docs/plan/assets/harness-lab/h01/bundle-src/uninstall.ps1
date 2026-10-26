param(
    [Parameter(Mandatory = $true)][string]$InstallRoot
)
$ErrorActionPreference = "Stop"

$startMenu = [Environment]::GetFolderPath("Programs")
$shortcutPath = Join-Path $startMenu "WeMeet H01 Test.lnk"
$key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\WeMeetH01Test"

if (Test-Path $shortcutPath) { Remove-Item $shortcutPath -Force }
if (Test-Path $key) { Remove-Item $key -Recurse -Force }
if (Test-Path $InstallRoot) { Remove-Item -Recurse -Force $InstallRoot }

$summary = [ordered]@{
    installRoot = $InstallRoot
    installRootExists = Test-Path $InstallRoot
    shortcutExists = Test-Path $shortcutPath
    registryExists = Test-Path $key
}
$summary | ConvertTo-Json -Depth 4
