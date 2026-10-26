$ErrorActionPreference = "Stop"

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$base = Join-Path $PSScriptRoot "run-$stamp"
$build = Join-Path $base "build"
$installRoot = Join-Path $env:LOCALAPPDATA "WeMeetH01Test"
$dataDir = Join-Path $base "data"
$poisonHome = Join-Path $base "home"
$poisonCwd = Join-Path $base "cwd"
$tamperDir = Join-Path $base "tamper"
$missingDir = Join-Path $base "missing"
$tamperData = Join-Path $base "tamper-data"
$missingData = Join-Path $base "missing-data"
$checks = [ordered]@{}
$stats = [ordered]@{}
$cert = $null

function Set-Check($name, $ok, $detail) {
    $checks[$name] = [ordered]@{ ok = [bool]$ok; detail = $detail }
}
function Write-Json($path, $value) {
    $value | ConvertTo-Json -Depth 12 | Set-Content -Encoding UTF8 $path
}

try {
    New-Item -ItemType Directory -Force -Path $base, $build, $dataDir, $poisonHome, $poisonCwd | Out-Null

    Write-Output "STEP build"
    Copy-Item (Join-Path $PSScriptRoot "bundle-src\*") $build -Recurse -Force
    Copy-Item (Get-Command node).Source (Join-Path $build "node.exe") -Force
    $nodeModules = if ($env:HARNESS_NODE_MODULES) { $env:HARNESS_NODE_MODULES } else { (Resolve-Path (Join-Path $PSScriptRoot "..\node_modules")).Path }
    $rc = Start-Process robocopy -ArgumentList @($nodeModules, (Join-Path $build "app\node_modules"), "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP") -Wait -PassThru -NoNewWindow
    Set-Check "bundle-node-modules" ($rc.ExitCode -lt 8) @{ robocopyExit = $rc.ExitCode }

    $nodeHash = (Get-FileHash -Algorithm SHA256 (Join-Path $build "node.exe")).Hash.ToLower()
    $sidecarHash = (Get-FileHash -Algorithm SHA256 (Join-Path $build "app\sidecar.mjs")).Hash.ToLower()
    $template = Get-Content -Raw (Join-Path $PSScriptRoot "launcher.template.cs")
    $launcherSource = $template.Replace("__NODE_HASH__", $nodeHash).Replace("__SIDECAR_HASH__", $sidecarHash)
    Set-Content -Encoding UTF8 (Join-Path $build "launcher.cs") $launcherSource
    $csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
    $launcher = Join-Path $build "WeMeetWorkAgent.exe"
    & $csc /nologo /target:exe /out:$launcher (Join-Path $build "launcher.cs") | Out-Null
    Set-Check "compile-launcher" (($LASTEXITCODE -eq 0) -and (Test-Path $launcher)) @{ exit = $LASTEXITCODE }

    Write-Output "STEP sign"
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=WeMeet H01 Test" -CertStoreLocation "Cert:\CurrentUser\My" -NotAfter (Get-Date).AddDays(2) -KeyExportPolicy Exportable
    Set-AuthenticodeSignature -FilePath $launcher -Certificate $cert -HashAlgorithm SHA256 | Out-Null
    $sig = Get-AuthenticodeSignature $launcher
    Set-Check "signature-applied" ($sig.Status -ne "NotSigned" -and $sig.SignerCertificate.Subject -like "*WeMeet H01 Test*") @{
        status = [string]$sig.Status
        subject = $sig.SignerCertificate.Subject
    }
    $signedCopy = Join-Path $base "signed-tampered.exe"
    Copy-Item $launcher $signedCopy -Force
    $signedBytes = [IO.File]::ReadAllBytes($signedCopy)
    $mid = [int]($signedBytes.Length / 2)
    $signedBytes[$mid] = $signedBytes[$mid] -bxor 0xFF
    [IO.File]::WriteAllBytes($signedCopy, $signedBytes)
    $sigTampered = Get-AuthenticodeSignature $signedCopy
    Set-Check "signature-tamper-detected" ($sigTampered.Status -eq "HashMismatch") @{ status = [string]$sigTampered.Status }

    Write-Output "STEP install"
    $installOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot "bundle-src\install.ps1") -Source $build -InstallRoot $installRoot
    $shortcut = Join-Path ([Environment]::GetFolderPath("Programs")) "WeMeet H01 Test.lnk"
    $regKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\WeMeetH01Test"
    Set-Check "install-files" (Test-Path (Join-Path $installRoot "WeMeetWorkAgent.exe")) (Test-Path $installRoot)
    Set-Check "install-shortcut" (Test-Path $shortcut) $shortcut
    Set-Check "install-registry" (Test-Path $regKey) $regKey

    Write-Output "STEP poison"
    New-Item -ItemType Directory -Force -Path (Join-Path $poisonHome ".pi\skills"), (Join-Path $poisonHome ".ssh"), (Join-Path $poisonHome ".aws") | Out-Null
    Set-Content -Encoding UTF8 (Join-Path $poisonHome ".pi\settings.json") '{"token":"POISON_PI_SETTINGS"}'
    Set-Content -Encoding UTF8 (Join-Path $poisonHome ".pi\skills\evil.md") "POISON_PI_SKILL"
    Set-Content -Encoding UTF8 (Join-Path $poisonHome ".npmrc") "//registry.npmjs.org/:_authToken=POISON_NPM_TOKEN"
    Set-Content -Encoding UTF8 (Join-Path $poisonHome ".ssh\id_rsa") "POISON_SSH_KEY"
    Set-Content -Encoding UTF8 (Join-Path $poisonHome ".aws\credentials") "aws_secret_access_key=POISON_AWS_KEY"
    Set-Content -Encoding UTF8 (Join-Path $poisonHome "AGENTS.md") "POISON_AGENTS_MD"
    Set-Content -Encoding UTF8 (Join-Path $poisonHome ".mcp.json") '{"mcpServers":{"evil":{"token":"POISON_MCP"}}}'
    Set-Content -Encoding UTF8 (Join-Path $poisonCwd "AGENTS.md") "POISON_CWD_AGENTS"

    Write-Output "STEP clean-run"
    $envNames = @("PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME", "H01_DATA_DIR", "H01_GUARD_LOG")
    $saved = @{}
    foreach ($name in $envNames) { $saved[$name] = [Environment]::GetEnvironmentVariable($name, "Process") }
    $stdoutFile = Join-Path $base "stdout.txt"
    $stderrFile = Join-Path $base "stderr.txt"
    $guardLog = Join-Path $dataDir "guard.jsonl"
    $whereResults = [ordered]@{}
    $exitCode = $null
    try {
        $env:PATH = "C:\Windows\System32"
        $env:HOME = $poisonHome
        $env:USERPROFILE = $poisonHome
        $env:APPDATA = Join-Path $poisonHome "AppData\Roaming"
        $env:LOCALAPPDATA = Join-Path $poisonHome "AppData\Local"
        $env:TEMP = Join-Path $dataDir "temp"
        $env:TMP = $env:TEMP
        New-Item -ItemType Directory -Force -Path $env:TEMP | Out-Null
        foreach ($name in @("NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME")) {
            Remove-Item ("Env:" + $name) -ErrorAction SilentlyContinue
        }
        $env:H01_DATA_DIR = $dataDir
        $env:H01_GUARD_LOG = $guardLog
        foreach ($tool in @("python", "npm", "git", "wsl")) {
            $out = & cmd.exe /c "where $tool 2>nul"
            $whereResults[$tool] = @{ exit = $LASTEXITCODE; output = ($out -join ";") }
        }
        $proc = Start-Process -FilePath (Join-Path $installRoot "WeMeetWorkAgent.exe") -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
        $exitCode = $proc.ExitCode
    }
    finally {
        foreach ($name in $envNames) {
            [Environment]::SetEnvironmentVariable($name, $saved[$name], "Process")
        }
    }
    $stats["where"] = $whereResults
    Set-Check "clean-run-exit" ($exitCode -eq 0) $exitCode
    Set-Check "no-python-npm-git-on-path" (($whereResults.python.exit -ne 0) -and ($whereResults.npm.exit -ne 0) -and ($whereResults.git.exit -ne 0)) $whereResults

    $resultPath = Join-Path $dataDir "result.json"
    $sidecarResult = if (Test-Path $resultPath) { Get-Content -Raw $resultPath | ConvertFrom-Json } else { $null }
    $sidecarChecksOk = $false
    $spawnAllBlocked = $false
    if ($sidecarResult) {
        $sidecarChecksOk = (($sidecarResult.checks.PSObject.Properties.Value | Where-Object { $_ -eq $false }).Count -eq 0)
        $spawnAllBlocked = (($sidecarResult.spawn.PSObject.Properties.Value | Where-Object { $_.ok }).Count -eq 0)
    }
    Set-Check "sidecar-checks" $sidecarChecksOk $(if ($sidecarResult) { $sidecarResult.checks } else { $null })
    Set-Check "bundled-exec-path" ($sidecarResult -and ($sidecarResult.execPath -like "*WeMeetH01Test*node.exe")) $(if ($sidecarResult) { $sidecarResult.execPath } else { $null })
    Set-Check "spawn-blocked" $spawnAllBlocked $(if ($sidecarResult) { $sidecarResult.spawn } else { $null })

    $guardEntries = if (Test-Path $guardLog) { Get-Content $guardLog | ForEach-Object { $_ | ConvertFrom-Json } } else { @() }
    $netEntries = @($guardEntries | Where-Object { $_.type -eq "net" })
    Set-Check "no-network" ($netEntries.Count -eq 0) $netEntries
    $allowedRoots = @($installRoot, $dataDir)
    $outside = @()
    foreach ($entry in $guardEntries) {
        if ($entry.type -ne "fs") { continue }
        $raw = [string]$entry.detail.path
        if (-not $raw) { continue }
        if ($raw.StartsWith("file://")) {
            try { $raw = ([uri]$raw).LocalPath } catch { $outside += $raw; continue }
        }
        try {
            $full = if ([IO.Path]::IsPathRooted($raw)) { [IO.Path]::GetFullPath($raw) } else { [IO.Path]::GetFullPath((Join-Path (Join-Path $installRoot "app") $raw)) }
        } catch {
            $outside += $raw
            continue
        }
        $ok = $false
        foreach ($root in $allowedRoots) {
            $resolvedRoot = [IO.Path]::GetFullPath($root)
            if ($full.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) { $ok = $true; break }
        }
        if (-not $ok) { $outside += $raw }
    }
    Set-Check "no-read-outside-install" ($outside.Count -eq 0) $outside
    $allText = (Get-Content -Raw $stdoutFile -ErrorAction SilentlyContinue) + (Get-Content -Raw $stderrFile -ErrorAction SilentlyContinue) + (Get-Content -Raw $resultPath -ErrorAction SilentlyContinue) + (Get-Content -Raw $guardLog -ErrorAction SilentlyContinue)
    Set-Check "no-poison-read" (-not ($allText -match "POISON_")) @{ matched = ([regex]::Matches($allText, "POISON_[A-Z_]+") | ForEach-Object { $_.Value } | Select-Object -Unique) }

    Write-Output "STEP no-fallback"
    $rc = Start-Process robocopy -ArgumentList @($installRoot, $tamperDir, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP") -Wait -PassThru -NoNewWindow
    [IO.File]::WriteAllBytes((Join-Path $tamperDir "node.exe"), [IO.File]::ReadAllBytes((Join-Path $tamperDir "node.exe")) + [byte[]](0))
    $savedPath = $env:PATH
    $savedData = $env:H01_DATA_DIR
    $tamperExit = $null
    try {
        $env:PATH = (Split-Path (Get-Command node).Source) + ";C:\Windows\System32"
        $env:H01_DATA_DIR = $tamperData
        New-Item -ItemType Directory -Force -Path $tamperData | Out-Null
        $proc = Start-Process -FilePath (Join-Path $tamperDir "WeMeetWorkAgent.exe") -Wait -PassThru -NoNewWindow
        $tamperExit = $proc.ExitCode
    }
    finally {
        $env:PATH = $savedPath
        $env:H01_DATA_DIR = $savedData
    }
    Set-Check "tamper-refused" ($tamperExit -eq 3) $tamperExit
    Set-Check "tamper-no-sidecar" (-not (Test-Path (Join-Path $tamperData "result.json"))) (Test-Path (Join-Path $tamperData "result.json"))

    Write-Output "STEP missing-binary"
    $rc = Start-Process robocopy -ArgumentList @($installRoot, $missingDir, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP") -Wait -PassThru -NoNewWindow
    Rename-Item (Join-Path $missingDir "node.exe") "node.exe.bak"
    $missingExit = $null
    try {
        $env:H01_DATA_DIR = $missingData
        New-Item -ItemType Directory -Force -Path $missingData | Out-Null
        $proc = Start-Process -FilePath (Join-Path $missingDir "WeMeetWorkAgent.exe") -Wait -PassThru -NoNewWindow
        $missingExit = $proc.ExitCode
    }
    finally {
        $env:H01_DATA_DIR = $savedData
    }
    Set-Check "missing-node-refused" ($missingExit -eq 3) $missingExit

    Write-Output "STEP uninstall"
    $uninstallOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $installRoot "uninstall.ps1") -InstallRoot $installRoot
    Set-Check "uninstall-root" (-not (Test-Path $installRoot)) (Test-Path $installRoot)
    Set-Check "uninstall-shortcut" (-not (Test-Path $shortcut)) (Test-Path $shortcut)
    Set-Check "uninstall-registry" (-not (Test-Path $regKey)) (Test-Path $regKey)

    $allPass = ($checks.Values | Where-Object { -not $_.ok }).Count -eq 0
    $summary = [ordered]@{
        experiment = "H01"
        stamp = $stamp
        base = $base
        installRoot = $installRoot
        dataDir = $dataDir
        checks = $checks
        stats = $stats
        allPass = $allPass
    }
    Write-Json (Join-Path $base "summary.json") $summary
    $summary | ConvertTo-Json -Depth 12
}
finally {
    if ($cert) { Remove-Item ("Cert:\CurrentUser\My\" + $cert.Thumbprint) -Force -ErrorAction SilentlyContinue }
}
