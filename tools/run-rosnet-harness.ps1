<#
  Runs tools/rosnet-sandbox-harness.js. With -Write it asks for the Rosnet SANDBOX client secret with a masked prompt
  (asterisks), hands it to the harness for this one run only, and clears it afterwards. Nothing is written to disk.

    powershell -ExecutionPolicy Bypass -File .\tools\run-rosnet-harness.ps1           dry run, no secret needed
    powershell -ExecutionPolicy Bypass -File .\tools\run-rosnet-harness.ps1 -Write    executes against the sandbox
  Anything after that is passed to the harness as is (for example --loc3 0).
#>
param([switch]$Write, [Parameter(ValueFromRemainingArguments = $true)] $Rest)
$ErrorActionPreference = "Stop"
$harness = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) "rosnet-sandbox-harness.js"
$nodeArgs = @($harness)
$setHere = $false
if ($Write) {
  $nodeArgs += "--write"
  if (-not $env:ROSNET_CLIENT_SECRET) {
    $sec = Read-Host "Paste the Rosnet SANDBOX client secret (shows as asterisks), then press Enter" -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
    try { $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
    $plain = "$plain".Trim()
    if (-not $plain) { Write-Host "No secret given. Nothing was sent." -ForegroundColor Yellow; exit 1 }
    if ($plain -match "\s" -or $plain -match "^\$" -or $plain.Length -gt 100) {
      Write-Host ("That does not look like the secret ({0} characters, or it contains spaces): the clipboard probably held something else." -f $plain.Length) -ForegroundColor Yellow
      Write-Host "Copy the client secret from the credentials document and run this again. Nothing was sent." -ForegroundColor Yellow
      exit 1
    }
    Write-Host ("Secret received ({0} characters)." -f $plain.Length)
    $env:ROSNET_CLIENT_SECRET = $plain
    $setHere = $true
  }
}
if ($Rest) { $nodeArgs += $Rest }
$code = 1
try { & node @nodeArgs; $code = $LASTEXITCODE }
finally { if ($setHere) { Remove-Item Env:ROSNET_CLIENT_SECRET -ErrorAction SilentlyContinue } }
exit $code
