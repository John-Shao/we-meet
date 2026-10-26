param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$InstallRoot
)
$ErrorActionPreference = "Stop"

if (Test-Path $InstallRoot) { Remove-Item -Recurse -Force $InstallRoot }
New-Item -ItemType Directory -Force -Path $InstallRoot | Out-Null
Copy-Item (Join-Path $Source "*") $InstallRoot -Recurse -Force
Copy-Item (Join-Path $PSScriptRoot "uninstall.ps1") $InstallRoot -Force

$startMenu = [Environment]::GetFolderPath("Programs")
$shortcutPath = Join-Path $startMenu "WeMeet H01 Test.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $InstallRoot "WeMeetWorkAgent.exe"
$shortcut.WorkingDirectory = $InstallRoot
$shortcut.Description = "WeMeet Work Agent (H01 test)"
$shortcut.Save()

$key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\WeMeetH01Test"
New-Item -Path $key -Force | Out-Null
Set-ItemProperty -Path $key -Name DisplayName -Value "WeMeet Work Agent (H01 Test)"
Set-ItemProperty -Path $key -Name DisplayVersion -Value "0.1.0-h01"
Set-ItemProperty -Path $key -Name Publisher -Value "WeMeet Test"
Set-ItemProperty -Path $key -Name InstallLocation -Value $InstallRoot
Set-ItemProperty -Path $key -Name UninstallString -Value ("powershell -NoProfile -ExecutionPolicy Bypass -File `"" + (Join-Path $InstallRoot "uninstall.ps1") + "`" -InstallRoot `"" + $InstallRoot + "`"")

$files = Get-ChildItem $InstallRoot -Recurse -File
$summary = [ordered]@{
    installRoot = $InstallRoot
    shortcut = $shortcutPath
    registryKey = $key
    fileCount = $files.Count
    bytes = ($files | Measure-Object -Property Length -Sum).Sum
}
$summary | ConvertTo-Json -Depth 6 | Set-Content -Encoding UTF8 (Join-Path $InstallRoot "install-manifest.json")
$summary | ConvertTo-Json -Depth 4
