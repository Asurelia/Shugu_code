[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location -LiteralPath $repoRoot

function Invoke-Git {
  param(
    [Parameter(Mandatory = $true)]
    [string[]]$Arguments,
    [switch]$AllowFailure
  )

  $output = & git @Arguments 2>&1
  $exitCode = $LASTEXITCODE

  if ($exitCode -ne 0 -and -not $AllowFailure) {
    $details = ($output | Out-String).Trim()
    throw "git $($Arguments -join ' ') a échoué (code $exitCode).`n$details"
  }

  return [pscustomobject]@{
    ExitCode = $exitCode
    Output = @($output)
  }
}

$branchResult = Invoke-Git -Arguments @("branch", "--show-current") -AllowFailure
if ($branchResult.ExitCode -ne 0) {
  Write-Warning "[launcher] Impossible de lire la branche Git. Lancement de la copie locale."
  exit 0
}

$branch = ($branchResult.Output | Out-String).Trim()
if ($branch -ne "main") {
  Write-Host "[launcher] Branche '$branch' active : synchronisation automatique réservée à main."
  exit 0
}

$statusResult = Invoke-Git -Arguments @("status", "--porcelain") -AllowFailure
if ($statusResult.ExitCode -ne 0) {
  Write-Warning "[launcher] Impossible de vérifier l'état Git. Lancement de la copie locale."
  exit 0
}

if ($statusResult.Output.Count -gt 0 -and ($statusResult.Output | Out-String).Trim().Length -gt 0) {
  Write-Host "[launcher] Modifications locales détectées : elles sont conservées, mise à jour distante ignorée."
  exit 0
}

Write-Host "[launcher] Recherche de la dernière version de main..."
$fetchResult = Invoke-Git -Arguments @("fetch", "--quiet", "origin", "main") -AllowFailure
if ($fetchResult.ExitCode -ne 0) {
  Write-Warning "[launcher] GitHub est indisponible. Lancement de la dernière version locale validée."
  exit 0
}

$before = ((Invoke-Git -Arguments @("rev-parse", "HEAD")).Output | Out-String).Trim()
$mergeResult = Invoke-Git -Arguments @("merge", "--ff-only", "origin/main") -AllowFailure
if ($mergeResult.ExitCode -ne 0) {
  $details = ($mergeResult.Output | Out-String).Trim()
  Write-Error "[launcher] main a divergé de origin/main. Mise à jour automatique annulée pour protéger le dépôt.`n$details"
  exit 1
}

$after = ((Invoke-Git -Arguments @("rev-parse", "HEAD")).Output | Out-String).Trim()
if ($before -eq $after) {
  Write-Host "[launcher] main est déjà à jour ($($after.Substring(0, 7)))."
  exit 0
}

Write-Host "[launcher] main mis à jour : $($before.Substring(0, 7)) -> $($after.Substring(0, 7))."
Write-Host "[launcher] Synchronisation des dépendances pnpm..."
& pnpm install --frozen-lockfile
if ($LASTEXITCODE -ne 0) {
  Write-Error "[launcher] pnpm install a échoué (code $LASTEXITCODE)."
  exit $LASTEXITCODE
}

Write-Host "[launcher] Dépendances à jour."
