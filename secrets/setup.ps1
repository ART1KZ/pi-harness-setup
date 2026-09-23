<#
  secret-guard vault setup.

  One file per secret: ~/.pi/agent/secrets/entries/<NAME>.dpapi
  Content is a base64 DPAPI (CurrentUser) blob — ASCII, BOM-free, no structure to
  parse. Plaintext never touches disk; the pi extension decrypts into its own
  process memory only.

  Usage:
    powershell -NoProfile -File setup.ps1 -List
    powershell -NoProfile -File setup.ps1 -Add MY_API_KEY
    powershell -NoProfile -File setup.ps1 -Remove MY_API_KEY
    powershell -NoProfile -File setup.ps1 -AddFromStdin MY_API_KEY   # automation

  Interactive -Add prompts with masked input (Read-Host -AsSecureString).
#>
param(
  [switch]$List,
  [string]$Add,
  [string]$AddFromStdin,
  [string]$Remove
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security | Out-Null

$SecretsDir = Join-Path $env:USERPROFILE '.pi\agent\secrets'
$EntriesDir = Join-Path $SecretsDir 'entries'
if (-not (Test-Path $EntriesDir)) { New-Item -ItemType Directory -Path $EntriesDir -Force | Out-Null }

function Assert-Name([string]$name) {
  if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]{1,63}$') { throw "Invalid secret name: '$name' (use ENV_VAR style)" }
}

function Entry-Path([string]$name) { return (Join-Path $EntriesDir ($name + '.dpapi')) }

function Protect-Value([string]$value) {
  $bytes = [Text.Encoding]::UTF8.GetBytes($value)
  $blob  = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser')
  return [Convert]::ToBase64String($blob)
}

function Unprotect-Value([string]$base64) {
  $bytes = [Convert]::FromBase64String($base64.Trim())
  $plain = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser')
  return [Text.Encoding]::UTF8.GetString($plain)
}

function Set-Secret([string]$name, [string]$value) {
  Assert-Name $name
  if ([string]::IsNullOrEmpty($value)) { throw 'Empty value' }
  if ($value.Length -lt 8) { throw "Value too short ($($value.Length) chars); values under 8 risk redaction over-matching" }
  # ASCII encoding keeps the file BOM-free, so plain JSON/text readers behave.
  Set-Content -LiteralPath (Entry-Path $name) -Value (Protect-Value $value) -Encoding ASCII -NoNewline
  Write-Output "stored $name (len=$($value.Length)) -> $(Entry-Path $name)"
}

if ($Add) {
  $sec  = Read-Host -AsSecureString -Prompt "Value for $Add"
  $sec2 = Read-Host -AsSecureString -Prompt "Repeat value"
  $v1 = [System.Net.NetworkCredential]::new('', $sec).Password
  $v2 = [System.Net.NetworkCredential]::new('', $sec2).Password
  if ($v1 -ne $v2) { throw 'Values do not match' }
  Set-Secret $Add $v1
}

if ($AddFromStdin) {
  $value = [Console]::In.ReadToEnd().TrimEnd("`r", "`n")
  Set-Secret $AddFromStdin $value
}

if ($Remove) {
  Assert-Name $Remove
  $p = Entry-Path $Remove
  if (-not (Test-Path -LiteralPath $p)) { throw "No such secret: $Remove" }
  Remove-Item -LiteralPath $p -Force
  Write-Output "removed $Remove"
}

if ($List) {
  $files = @(Get-ChildItem -LiteralPath $EntriesDir -Filter '*.dpapi' -File -ErrorAction SilentlyContinue)
  if ($files.Count -eq 0) { Write-Output '(vault is empty)' }
  foreach ($f in $files) {
    $name = [IO.Path]::GetFileNameWithoutExtension($f.Name)
    $len = (Unprotect-Value (Get-Content -Raw -LiteralPath $f.FullName)).Length
    Write-Output ("{0}  len={1}  modified={2:u}" -f $name, $len, $f.LastWriteTime)
  }
}
