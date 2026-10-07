param(
    [string]$TargetDirectory = (Join-Path $env:LOCALAPPDATA 'WeMeet\LocalAgent\0.3.1'),
    [string]$WheelPath = ''
)

$ErrorActionPreference = 'Stop'
$agentSource = $PSScriptRoot
$agentTarget = [System.IO.Path]::GetFullPath($TargetDirectory)
if ($agentTarget -eq [System.IO.Path]::GetPathRoot($agentTarget)) {
    throw 'Choose an application directory, not a drive root.'
}
if (-not (Test-Path -LiteralPath (Join-Path $agentTarget 'Scripts\python.exe'))) {
    & py -3.13 -m venv $agentTarget
    if ($LASTEXITCODE -ne 0) { throw 'Python 3.13 is required.' }
}
$agentPython = Join-Path $agentTarget 'Scripts\python.exe'
& $agentPython -m pip install --require-hashes -r (Join-Path $agentSource 'requirements-dsh.lock')
if ($LASTEXITCODE -ne 0) { throw 'Locked dsh dependency installation failed.' }
$agentPackage = if ($WheelPath) { (Resolve-Path -LiteralPath $WheelPath).Path } else { $agentSource }
& $agentPython -m pip install --no-deps --force-reinstall $agentPackage
if ($LASTEXITCODE -ne 0) { throw 'Local adapter installation failed.' }
Write-Output (Join-Path $agentTarget 'Scripts\work-agent-local.exe')
