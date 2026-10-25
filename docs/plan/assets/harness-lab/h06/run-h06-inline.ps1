$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "appcontainer-lib.ps1")

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$base = Join-Path $PSScriptRoot "run-inline-$stamp"
$profileName = "wemeet-h06-inline-$stamp"
$containerRoot = $null
$sid = $null
$server = $null
$result = [ordered]@{ profile = $profileName; base = $base }
try {
    $hr = [AC3]::CreateProfile($profileName, [ref]$sid, [ref]$containerRoot)
    if ($hr -ne 0) { throw "CreateProfile failed hr=$hr" }
    $result["sid"] = $sid
    $result["containerRoot"] = $containerRoot

    New-Item -ItemType Directory -Force -Path $base | Out-Null
    $sandbox = Join-Path $containerRoot "h06-sandbox"
    $allowed = Join-Path $containerRoot "h06-allowed"
    $secret = Join-Path $base "secret"
    New-Item -ItemType Directory -Force -Path $sandbox, $allowed, $secret | Out-Null

    $systemNode = (Get-Command node).Source
    Copy-Item $systemNode (Join-Path $sandbox "node.exe") -Force
    Start-Sleep -Milliseconds 500

    Set-Content -Encoding UTF8 (Join-Path $allowed "allowed.txt") "ALLOWED_CONTENT"
    Set-Content -Encoding UTF8 (Join-Path $secret "secret.txt") "SECRET_CONTENT_MUST_NOT_LEAK"
    $userSecret = Join-Path $env:TEMP "wemeet-h06-user-secret-$stamp.txt"
    Set-Content -Encoding UTF8 $userSecret "USER_SECRET_MUST_NOT_LEAK"

    $junction = Join-Path $allowed "junction-to-secret"
    cmd.exe /c "mklink /J `"$junction`" `"$secret`"" | Out-Null

    $localPort = Get-Random -Minimum 20000 -Maximum 40000
    $server = Start-Process -FilePath $systemNode -ArgumentList @("-e", "require('net').createServer(s=>s.end()).listen($localPort,'127.0.0.1')") -PassThru -WindowStyle Hidden
    Start-Sleep -Milliseconds 800

    $code = Get-Content -Raw (Join-Path $PSScriptRoot "h06-inline.cjs")
    $env:H06_CODE_B64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($code))
    $eval = "eval(Buffer.from(process.env.H06_CODE_B64,'base64').toString())"
    $errorOut = Join-Path $base "container-error.txt"
    $env:H06_ERROR_OUT = $errorOut

    $outBaseline = Join-Path $allowed "result-baseline.json"
    $outPermission = Join-Path $allowed "result-permission.json"
    $outContainer = Join-Path $allowed "result-appcontainer.json"

    $baselineConfig = @{
        mode = "baseline"; allowed = $allowed; secret = $secret; junction = $junction;
        out = $outBaseline; userSecret = $userSecret; localPort = $localPort
    } | ConvertTo-Json -Compress
    $env:H06_CONFIG = $baselineConfig
    Write-Output "STEP baseline"
    $baselineProc = Start-Process -FilePath $systemNode -ArgumentList @("-e", $eval) -Wait -PassThru -NoNewWindow
    $result["baselineExit"] = $baselineProc.ExitCode

    $permissionConfig = @{
        mode = "permission"; allowed = $allowed; secret = $secret; junction = $junction;
        out = $outPermission; userSecret = $userSecret; localPort = $localPort
    } | ConvertTo-Json -Compress
    $env:H06_CONFIG = $permissionConfig
    Write-Output "STEP permission"
    $permRead1 = "--allow-fs-read=$sandbox"
    $permRead2 = "--allow-fs-read=$allowed"
    $permWrite = "--allow-fs-write=$allowed"
    $permissionProc = Start-Process -FilePath $systemNode -ArgumentList @("--permission", $permRead1, $permRead2, $permWrite, "-e", $eval) -Wait -PassThru -NoNewWindow
    $result["permissionExit"] = $permissionProc.ExitCode

    $containerConfig = @{
        mode = "appcontainer"; allowed = $allowed; secret = $secret; junction = $junction;
        out = $outContainer; userSecret = $userSecret; localPort = $localPort
    } | ConvertTo-Json -Compress
    $env:H06_CONFIG = $containerConfig
    Write-Output "STEP appcontainer"
    $permRead1 = "--allow-fs-read=$sandbox"
    $permRead2 = "--allow-fs-read=$allowed"
    $permWrite = "--allow-fs-write=$allowed"
    $cmdline = '"' + (Join-Path $sandbox "node.exe") + '" --permission ' + $permRead1 + ' ' + $permRead2 + ' ' + $permWrite + ' -e "' + $eval + '"'
    $exitCode = 0
    $errorText = $null
    $ran = [AC3]::Run($sid, $cmdline, $sandbox, [ref]$exitCode, [ref]$errorText)
    $result["containerRun"] = @{ ran = $ran; exitCode = $exitCode; error = $errorText }

    $result["baseline"] = if (Test-Path $outBaseline) { Get-Content -Raw $outBaseline | ConvertFrom-Json } else { $null }
    $result["permission"] = if (Test-Path $outPermission) { Get-Content -Raw $outPermission | ConvertFrom-Json } else { $null }
    $result["appcontainer"] = if (Test-Path $outContainer) { Get-Content -Raw $outContainer | ConvertFrom-Json } else { $null }
    if (Test-Path $errorOut) { $result["containerError"] = Get-Content -Raw $errorOut }

    if (Test-Path $outBaseline) { Copy-Item $outBaseline (Join-Path $base "result-baseline.json") -Force }
    if (Test-Path $outPermission) { Copy-Item $outPermission (Join-Path $base "result-permission.json") -Force }
    if (Test-Path $outContainer) { Copy-Item $outContainer (Join-Path $base "result-appcontainer.json") -Force }
    $result | ConvertTo-Json -Depth 10 | Set-Content -Encoding UTF8 (Join-Path $base "summary.json")
    $result | ConvertTo-Json -Depth 10
}
finally {
    if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
    if ($containerRoot) {
        $progress = Join-Path $containerRoot "h06-allowed\progress.log"
        if (Test-Path $progress) { Copy-Item $progress (Join-Path $base "progress.log") -Force }
        $junction = Join-Path $containerRoot "h06-allowed\junction-to-secret"
        if (Test-Path $junction) { cmd.exe /c "rmdir `"$junction`"" | Out-Null }
    }
    Remove-Item Env:H06_CODE_B64 -ErrorAction SilentlyContinue
    Remove-Item Env:H06_CONFIG -ErrorAction SilentlyContinue
    Remove-Item Env:H06_ERROR_OUT -ErrorAction SilentlyContinue
    [void][AC3]::DeleteAppContainerProfile($profileName)
}
