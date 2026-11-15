# Publishes the installer channel (`app-latest`): the setup exe plus a tiny app.json that every
# installed app reads on launch. Content updates can only replace web/api files, so this channel is
# the only way the shell itself (main.cjs, Electron version, menu) can be updated - and it happens
# unattended: the app downloads the exe, runs it with /S and comes back by itself.
#
#   cd desktop
#   ./scripts/publish-app.ps1
#
# ~82 MB leaves the machine, so only use it when the shell changed. For UI/api changes publish
# content instead (publish-content.ps1, ~1-3 MB).

$ErrorActionPreference = 'Continue'  # native stderr must not abort the script
$repo = 'rezaa2544/benzin2'
$channel = 'app-latest'

Set-Location (Join-Path $PSScriptRoot '..')

$version = (Get-Content package.json -Raw | ConvertFrom-Json).version
$installer = Join-Path 'dist' "Benzin2-Setup-$version.exe"
if (-not (Test-Path $installer)) {
  throw "installer not found: $installer - run 'npm run dist' first"
}

Write-Host "1/4 hashing $installer..."
$hash = (Get-FileHash $installer -Algorithm SHA256).Hash.ToLower()
$size = (Get-Item $installer).Length

Write-Host '2/4 writing app.json...'
$manifest = [ordered]@{
  version = $version
  file    = "Benzin2-Setup-$version.exe"
  size    = $size
  sha256  = $hash
  builtAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
}
$manifest | ConvertTo-Json | Set-Content -Path 'dist\app.json' -Encoding utf8
Get-Content 'dist\app.json'

Write-Host '3/4 ensuring the app-latest release exists...'
gh release view $channel --repo $repo 2>&1 | Out-Null
if ($LASTEXITCODE -ne 0) {
  gh release create $channel --repo $repo --title 'App channel (installer)' --notes 'Newest setup exe; installed apps read app.json and update themselves silently.' 2>&1 | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'could not create the app-latest release' }
}

Write-Host '4/4 uploading installer + manifest...'
gh release upload $channel $installer 'dist\app.json' --repo $repo --clobber
if ($LASTEXITCODE -ne 0) { throw 'upload failed' }

Write-Host "done - shell $version is live; running apps install it within one check interval."
