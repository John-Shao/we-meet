[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('Preflight', 'Start', 'Stop')]
  [string]$Mode,

  [string]$EvidenceDir = 'C:\work-k2\ev123',
  [string]$MarkerPath,
  [string]$ReceiptPath,
  [string]$PipeLogPath,
  [switch]$Positive
)

$ErrorActionPreference = 'Stop'

function Write-Json([string]$Path, $Value) {
  $json = ConvertTo-Json -InputObject $Value -Depth 12
  [IO.File]::WriteAllText($Path, $json, (New-Object Text.UTF8Encoding($false)))
}

function Read-Json([string]$Path) {
  return ConvertFrom-Json -InputObject ([IO.File]::ReadAllText($Path))
}

function Invoke-Native([string]$File, [string[]]$Arguments) {
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $output = & $File @Arguments 2>&1 | Out-String
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previous
  }
  return @{ exitCode = $code; output = $output }
}

function Invoke-Tool([string]$File, [string[]]$Arguments) {
  $result = Invoke-Native $File $Arguments
  if ($result.exitCode -ne 0) {
    throw "$File failed with exit code $($result.exitCode): $($result.output)"
  }
  return $result.output
}

function Test-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-ToolStatus {
  $tools = @{}
  foreach ($name in @('pktmon', 'logman', 'tracerpt')) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    $tools[$name] = if ($command) { $command.Source } else { $null }
  }
  return $tools
}

function Get-PktmonStatus {
  $result = Invoke-Native 'pktmon' @('status')
  if ($result.exitCode -ne 0) { return @{ available = $false; output = $result.output.Trim() } }
  return @{ available = $true; output = $result.output.Trim() }
}

function Invoke-Preflight {
  New-Item -ItemType Directory -Path $EvidenceDir -Force | Out-Null
  $tools = Get-ToolStatus
  $admin = Test-Administrator
  $packet = Get-PktmonStatus
  $ready = $admin -and @($tools.Values | Where-Object { -not $_ }).Count -eq 0 -and $packet.available
  $result = [ordered]@{
    schemaVersion = 1
    mode = 'Preflight'
    administrator = $admin
    tools = $tools
    pktmon = $packet
    readyForCapture = $ready
    checkedAt = [DateTime]::UtcNow.ToString('o')
  }
  Write-Json (Join-Path $EvidenceDir 'preflight.json') $result
  Write-Output (ConvertTo-Json -InputObject $result -Depth 8)
  if (-not $ready) { exit 2 }
}

function Invoke-Start {
  if (-not (Test-Administrator)) { throw 'Start requires an elevated PowerShell window; this script never self-elevates.' }
  $resolved = [IO.Path]::GetFullPath($EvidenceDir)
  if (-not $resolved.StartsWith('C:\work-k2\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Raw OS evidence must stay under C:\work-k2\.'
  }
  if (Test-Path (Join-Path $resolved 'session.json')) { throw 'session.json already exists; choose a fresh evidence directory.' }
  New-Item -ItemType Directory -Path $resolved -Force | Out-Null
  $tools = Get-ToolStatus
  if (@($tools.Values | Where-Object { -not $_ }).Count -ne 0) { throw 'pktmon, logman and tracerpt are required.' }
  $packet = Get-PktmonStatus
  if (-not $packet.available) { throw 'pktmon status failed.' }
  if ($packet.output -match '(?i)(?:currently running|status:\s*running|capture:\s*running)') {
    throw 'pktmon is already running; stop the existing capture before starting this evidence window.'
  }

  $runId = 'work-ev-' + [Guid]::NewGuid().ToString('N').Substring(0, 12)
  $marker = if ($MarkerPath) { [IO.Path]::GetFullPath($MarkerPath) } else { Join-Path $resolved 'idle-marker.json' }
  $providers = [ordered]@{
    net = 'Microsoft-Windows-Kernel-Network'
    dns = 'Microsoft-Windows-DNS-Client'
    file = 'Microsoft-Windows-Kernel-File'
    pipe = 'Microsoft-Windows-Kernel-Pipe'
  }
  $session = [ordered]@{
    schemaVersion = 1
    runId = $runId
    status = 'starting'
    positive = [bool]$Positive
    evidenceDir = $resolved
    markerPath = $marker
    startedAt = [DateTime]::UtcNow.ToString('o')
    traces = @()
    pktmonStarted = $false
  }
  $sessionPath = Join-Path $resolved 'session.json'
  Write-Json $sessionPath $session

  $created = @()
  $packetStarted = $false
  try {
    foreach ($name in @('net', 'dns', 'file', 'pipe')) {
      $traceName = "$runId-$name"
      $etl = Join-Path $resolved "$name.etl"
      Invoke-Tool 'logman' @('create', 'trace', $traceName, '-p', $providers[$name], '0xffffffffffffffff', '5', '-o', $etl, '-ets') | Out-Null
      $created += $traceName
      $session.traces += [ordered]@{ name = $traceName; provider = $providers[$name]; etl = $etl }
    }
    $session.status = 'tracing'
    Write-Json $sessionPath $session
    $pktmonFile = Join-Path $resolved 'pktmon.etl'
    Invoke-Tool 'pktmon' @('start', '--capture', '--pkt-size', '0', '--file-name', $pktmonFile) | Out-Null
    $packetStarted = $true
    $session.pktmonStarted = $true
    $session.pktmonFile = $pktmonFile
    $session.status = 'running'
    Write-Json $sessionPath $session
    Write-Output (ConvertTo-Json -InputObject $session -Depth 8)
  } catch {
    foreach ($name in $created) {
      Invoke-Native 'logman' @('stop', $name, '-ets') | Out-Null
      Invoke-Native 'logman' @('delete', $name, '-ets') | Out-Null
    }
    if ($packetStarted) { Invoke-Native 'pktmon' @('stop') | Out-Null }
    $session.status = 'failed'
    $session.error = $_.Exception.Message
    Write-Json $sessionPath $session
    throw
  }
}

function Invoke-Stop {
  if (-not (Test-Administrator)) { throw 'Stop requires an elevated PowerShell window; this script never self-elevates.' }
  $resolved = [IO.Path]::GetFullPath($EvidenceDir)
  $sessionPath = Join-Path $resolved 'session.json'
  if (-not (Test-Path $sessionPath)) { throw 'session.json not found.' }
  $session = Read-Json $sessionPath
  if ($session.status -eq 'stopped') {
    Write-Output (ConvertTo-Json -InputObject $session -Depth 8)
    return
  }
  if ($session.status -ne 'running' -and $session.status -ne 'tracing') { throw "Cannot stop session in state $($session.status)." }
  $errors = @()
  foreach ($trace in $session.traces) {
    try { Invoke-Tool 'logman' @('stop', $trace.name, '-ets') | Out-Null } catch { $errors += $_.Exception.Message }
    try { Invoke-Tool 'logman' @('delete', $trace.name, '-ets') | Out-Null } catch { $errors += $_.Exception.Message }
  }
  if ($session.pktmonStarted) {
    try { Invoke-Tool 'pktmon' @('stop') | Out-Null } catch { $errors += $_.Exception.Message }
  }

  $outputs = @()
  foreach ($name in @('net', 'dns', 'file', 'pipe')) {
    $etl = Join-Path $resolved "$name.etl"
    $xml = Join-Path $resolved "$name.xml"
    try {
      Invoke-Tool 'tracerpt' @($etl, '-o', $xml, '-of', 'XML') | Out-Null
      $outputs += $xml
    } catch { $errors += $_.Exception.Message }
  }
  if ($session.pktmonStarted) {
    $text = Join-Path $resolved 'pktmon.txt'
    try {
      Invoke-Tool 'pktmon' @('etl2txt', $session.pktmonFile, '--out', $text, '--timestamp') | Out-Null
      $outputs += $text
    } catch { $errors += $_.Exception.Message }
    $outputs += $session.pktmonFile
  }

  if ($ReceiptPath) {
    $target = if ($Positive) { 'receipt.json' } else { 'idle-receipt.json' }
    Copy-Item -LiteralPath $ReceiptPath -Destination (Join-Path $resolved $target) -Force
    $outputs += Join-Path $resolved $target
  } else { $errors += 'ReceiptPath is required for a complete evidence bundle.' }
  if ($PipeLogPath) {
    Copy-Item -LiteralPath $PipeLogPath -Destination (Join-Path $resolved 'acceptance-pipe.log') -Force
    $outputs += Join-Path $resolved 'acceptance-pipe.log'
  } else { $errors += 'PipeLogPath is required for a complete evidence bundle.' }
  if (-not $Positive -and (Test-Path $session.markerPath)) {
    Copy-Item -LiteralPath $session.markerPath -Destination (Join-Path $resolved 'idle-marker.json') -Force
    $outputs += Join-Path $resolved 'idle-marker.json'
  } elseif (-not $Positive) { $errors += 'Idle marker was not produced.' }

  $files = @()
  foreach ($file in ($outputs | Sort-Object -Unique)) {
    if (Test-Path $file) {
      $files += [ordered]@{
        name = [IO.Path]::GetFileName($file)
        bytes = (Get-Item $file).Length
        sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $file).Hash.ToLowerInvariant()
      }
    }
  }
  $collection = [ordered]@{
    schemaVersion = 1
    runId = $session.runId
    status = if ($errors.Count -eq 0) { 'stopped' } else { 'incomplete' }
    startedAt = $session.startedAt
    stoppedAt = [DateTime]::UtcNow.ToString('o')
    errors = $errors
    files = $files
  }
  Write-Json (Join-Path $resolved 'collection.json') $collection
  $session.status = $collection.status
  $session.stoppedAt = $collection.stoppedAt
  Write-Json $sessionPath $session
  Write-Output (ConvertTo-Json -InputObject $collection -Depth 8)
  if ($errors.Count -ne 0) { exit 2 }
}

switch ($Mode) {
  'Preflight' { Invoke-Preflight }
  'Start' { Invoke-Start }
  'Stop' { Invoke-Stop }
}
