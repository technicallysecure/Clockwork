# Run from Windows PowerShell or PowerShell 7. Existing credentials are preserved.
param([string[]]$AdditionalSlots = @())
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$secretDir = Join-Path $projectDir '.secrets'
[IO.Directory]::CreateDirectory($secretDir) | Out-Null

function New-RandomSecret {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return [Convert]::ToBase64String($bytes)
}

function Write-NewSecret([string]$Name, [string]$Value) {
    $path = Join-Path $secretDir $Name
    if (Test-Path -LiteralPath $path -PathType Leaf) { return }
    try {
        $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    } catch [IO.IOException] {
        if (Test-Path -LiteralPath $path -PathType Leaf) { return }
        throw
    }
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
        $stream.Write($bytes, 0, $bytes.Length)
    } finally {
        $stream.Dispose()
    }
}

$slots = @('personal', 'agent-2', 'agent-3') + $AdditionalSlots
foreach ($id in $slots) {
    if ($id -cnotmatch '^[a-z][a-z0-9-]{0,31}$') {
        throw 'Use lowercase agent IDs starting with a letter, up to 32 letters, digits and hyphens.'
    }
}
Write-NewSecret 'owner_password' (New-RandomSecret)
Write-NewSecret 'lm_token' ''
Write-NewSecret 'openai_key' ''
foreach ($id in $slots) { Write-NewSecret "worker_$id" (New-RandomSecret) }

$envFile = Join-Path $projectDir '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
    Copy-Item -LiteralPath (Join-Path $projectDir '.env.example') -Destination $envFile
}
Write-Host 'Clockwork configuration is ready. Your sign-in password is in .secrets/owner_password.'
