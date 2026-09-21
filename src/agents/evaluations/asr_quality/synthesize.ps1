param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$corpus = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'script.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$destination = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $destination | Out-Null
$speaker = New-Object -ComObject SAPI.SpVoice
foreach ($scenario in $corpus.scenarios) {
    $index = 0
    foreach ($turn in $scenario.turns) {
        $voices = @($speaker.GetVoices() | Where-Object { $_.GetDescription().StartsWith($turn.voice) })
        if ($voices.Count -ne 1) { throw "Required voice unavailable: $($turn.voice)" }
        $speaker.Voice = $voices[0]
        $speaker.Rate = 0
        $stream = New-Object -ComObject SAPI.SpFileStream
        $stream.Format.Type = 18 # SAFT16kHz16BitMono
        $target = Join-Path $destination ($scenario.id + '-' + $index + '.wav')
        if (Test-Path -LiteralPath $target) { throw "Refusing to overwrite $target" }
        try {
            $stream.Open($target, 3, $false)
            $speaker.AudioOutputStream = $stream
            $speaker.Speak($turn.text, 0) | Out-Null
        } finally { $stream.Close() }
        $index++
    }
}
