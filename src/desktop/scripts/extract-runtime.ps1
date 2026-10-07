param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $Destination) { throw 'runtime_stage_exists' }
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
    $total = 0L
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    if ($zip.Entries.Count -gt 20000) { throw 'runtime_invalid_package' }
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName
        # Packages contain files only. Refuse links, ADS, reserved names and traversal before extraction.
        if ($name.Length -gt 240 -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'runtime_invalid_package' }
        foreach ($part in $name.Split('/')) {
            if ($part -notmatch '^[a-zA-Z0-9_.@+ -]+$' -or $part -in '.', '..' -or $part -match '[. ]$' -or $part -match '^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)') { throw 'runtime_invalid_package' }
        }
        if (-not $names.Add($name)) { throw 'runtime_invalid_package' }
        $total += $entry.Length
        if ($total -gt 1000000000) { throw 'runtime_invalid_package' }
    }
    [IO.Directory]::CreateDirectory($Destination) | Out-Null
    foreach ($entry in $zip.Entries) {
        $target = [IO.Path]::GetFullPath([IO.Path]::Combine($Destination, $entry.FullName.Replace('/', '\')))
        if (-not $target.StartsWith([IO.Path]::GetFullPath($Destination) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'runtime_invalid_package' }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($target)) | Out-Null
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $target, $false)
    }
} finally { $zip.Dispose() }
