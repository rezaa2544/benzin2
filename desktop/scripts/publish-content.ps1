# Publishes the light content package (API bundle + customer SPA + admin SPA) to the
# `content-latest` GitHub release. Installed apps pick it up on their next launch.
#
#   cd desktop
#   pnpm --filter @benzin/api build   # optional, prepack re-bundles from src anyway
#   ./scripts/publish-content.ps1
#
# Only ~1-3 MB leaves the machine, versus ~82 MB for a full installer.

$ErrorActionPreference = 'Stop'
$repo = 'rezaa2544/benzin2'
$channel = 'content-latest'

Set-Location (Join-Path $PSScriptRoot '..')

Write-Host '1/3 bundling api and copying SPAs…'
npm run prepack:app
if ($LASTEXITCODE -ne 0) { throw 'prepack:app failed' }

Write-Host '2/3 packing content.tar.gz…'
node scripts/pack-content.cjs
if ($LASTEXITCODE -ne 0) { throw 'pack-content failed' }

Write-Host '3/3 uploading to the content channel…'
gh release upload $channel dist-content/content.tar.gz dist-content/content.json --repo $repo --clobber
if ($LASTEXITCODE -ne 0) { throw 'upload failed' }

Get-Content dist-content/content.json
Write-Host 'done — running apps will offer the update on their next launch.'
