# Run from Windows PowerShell or PowerShell 7. Existing credentials are preserved.
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$secretDir = Join-Path $projectDir '.secrets'
[IO.Directory]::CreateDirectory($secretDir) | Out-Null
$passwordFile = Join-Path $secretDir 'owner_password'
if (-not (Test-Path -LiteralPath $passwordFile)) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    [IO.File]::WriteAllText($passwordFile, [Convert]::ToBase64String($bytes))
}
foreach ($name in @('lm_token', 'openai_key')) {
    $file = Join-Path $secretDir $name
    if (-not (Test-Path -LiteralPath $file)) {
        [IO.File]::WriteAllText($file, '')
    }
}
$envFile = Join-Path $projectDir '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
    Copy-Item -LiteralPath (Join-Path $projectDir '.env.example') -Destination $envFile
}
Write-Host 'Clockwork configuration is ready. Your sign-in password is in .secrets/owner_password.'
