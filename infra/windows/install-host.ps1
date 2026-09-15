$ErrorActionPreference = 'Stop'

$repoRoot = '\\wsl.localhost\Ubuntu-26.04\home\hieul\slay-the-spire-the-boardgame-the-game'
$installRoot = Join-Path $env:LOCALAPPDATA 'SlayTheSpireServer'
$caddy = Join-Path $installRoot 'caddy.exe'
$caddyFile = Join-Path $installRoot 'Caddyfile'
$caddyCandidate = Join-Path $installRoot 'Caddyfile.next'
$caddyTemplateFile = Join-Path $installRoot 'Caddyfile.template'
$mappingScript = Join-Path $installRoot 'renew-router-pinhole.ps1'
$mappingCandidate = Join-Path $installRoot 'renew-router-pinhole.next.ps1'
$mappingBackup = Join-Path $installRoot 'renew-router-pinhole.rollback.ps1'
$templateCandidate = Join-Path $installRoot 'Caddyfile.template.next'
$templateBackup = Join-Path $installRoot 'Caddyfile.template.rollback'
$routerState = Join-Path $installRoot 'router-state.json'
$publishedOriginPath = Join-Path $installRoot 'published-origin.txt'
$repository = 'hieu-lee/slay-the-spire-the-boardgame-the-game'
New-Item -ItemType Directory -Force -Path $installRoot | Out-Null

if (-not (Test-Path $caddy)) {
  $release = Invoke-RestMethod -Uri 'https://api.github.com/repos/caddyserver/caddy/releases/latest'
  $asset = $release.assets | Where-Object name -Like 'caddy_*_windows_amd64.zip' | Select-Object -First 1
  if (-not $asset) { throw 'Could not find the Windows Caddy release asset.' }
  $archive = Join-Path $env:TEMP $asset.name
  Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $archive
  if ($asset.digest -match '^sha256:(.+)$') {
    $actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
    if ($actual -ne $Matches[1].ToLowerInvariant()) { throw 'Caddy archive checksum mismatch.' }
  }
  Expand-Archive -Path $archive -DestinationPath $installRoot -Force
  Remove-Item -LiteralPath $archive
}

Copy-Item -LiteralPath (Join-Path $repoRoot 'infra\windows\renew-router-pinhole.ps1') `
  -Destination $mappingCandidate -Force
Copy-Item -LiteralPath (Join-Path $repoRoot 'infra\windows\Caddyfile') `
  -Destination $templateCandidate -Force
& $mappingCandidate | Out-Null
$state = Get-Content -LiteralPath $routerState -Raw | ConvertFrom-Json
$hostName = $state.hostName
$origin = $state.origin
if ($hostName -notmatch '^sts-([0-9]{1,3}-){3}[0-9]{1,3}\.([0-9a-f]{1,4}-){7}[0-9a-f]{1,4}\.sslip\.io$' -or
    $origin -ne "https://${hostName}:18443") {
  throw "The router mapping script returned an invalid origin: $origin"
}
$caddyTemplate = Get-Content -LiteralPath $templateCandidate -Raw
$siteAddresses = $hostName
if (Test-Path $publishedOriginPath) {
  $publishedOrigin = (Get-Content -LiteralPath $publishedOriginPath -Raw).Trim()
  if ($publishedOrigin -and $publishedOrigin -ne $origin) {
    try {
      $publishedUri = [Uri]$publishedOrigin
      if ($publishedUri.Scheme -eq 'https' -and $publishedUri.Port -eq 18443 -and
          $publishedUri.DnsSafeHost -match '^sts-([0-9]{1,3}-){3}[0-9]{1,3}\.([0-9a-f]{1,4}-){7}[0-9a-f]{1,4}\.sslip\.io$') {
        $siteAddresses = $publishedUri.DnsSafeHost + ', ' + $hostName
      }
    } catch {}
  }
}
[System.IO.File]::WriteAllText(
  $caddyCandidate,
  $caddyTemplate.Replace('__SERVER_HOSTS__', $siteAddresses),
  (New-Object System.Text.UTF8Encoding $false)
)
& $caddy validate --config $caddyCandidate --adapter caddyfile
if ($LASTEXITCODE -ne 0) { throw 'The generated Caddy configuration is invalid.' }

$caddyBackup = Join-Path $installRoot 'Caddyfile.rollback'
$previousCaddyFile = Test-Path $caddyFile
if ($previousCaddyFile) { Copy-Item -LiteralPath $caddyFile -Destination $caddyBackup -Force }
$previousMapping = Test-Path $mappingScript
$previousTemplate = Test-Path $caddyTemplateFile
if ($previousMapping) { Copy-Item -LiteralPath $mappingScript -Destination $mappingBackup -Force }
if ($previousTemplate) { Copy-Item -LiteralPath $caddyTemplateFile -Destination $templateBackup -Force }
$managedTasks = @('Slay the Spire TLS proxy', 'Slay the Spire router mapping', 'Slay the Spire WSL services')
$taskBackups = @{}
foreach ($taskName in $managedTasks) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    $taskBackups[$taskName] = Export-ScheduledTask -TaskName $taskName
  }
}
$previousServerOrigin = (& wsl.exe -d Ubuntu-26.04 -u hieul -- gh variable get `
  MULTIPLAYER_SERVER_ORIGIN --repo $repository 2>$null | Out-String).Trim()
$previousServerOriginExists = $LASTEXITCODE -eq 0
$firewallRuleExisted = [bool](Get-NetFirewallRule -DisplayName 'Slay the Spire TLS proxy' -ErrorAction SilentlyContinue)
$firewallRuleCreated = $false
$installationSucceeded = $false
try {
  $settings = New-ScheduledTaskSettingsSet -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -WakeToRun
  $taskPrincipal = New-ScheduledTaskPrincipal `
    -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited
  $hostTriggers = @(
    (New-ScheduledTaskTrigger -AtStartup),
    (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME)
  )
  $caddyArguments = 'run --config "' + $caddyFile + '" --adapter caddyfile'
  $caddyAction = New-ScheduledTaskAction -Execute $caddy -Argument $caddyArguments -WorkingDirectory $installRoot
  Register-ScheduledTask -TaskName 'Slay the Spire TLS proxy' -Action $caddyAction -Trigger $hostTriggers `
    -Principal $taskPrincipal -Settings $settings `
    -Description 'Always-on TLS proxy for Slay the Spire multiplayer' -Force | Out-Null
  $windowsPowerShell = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
  $mappingArguments = '-NoProfile -ExecutionPolicy Bypass -File "' + $mappingScript + '" -Watch'
  $mappingAction = New-ScheduledTaskAction -Execute $windowsPowerShell -Argument $mappingArguments `
    -WorkingDirectory $installRoot
  Register-ScheduledTask -TaskName 'Slay the Spire router mapping' -Action $mappingAction -Trigger $hostTriggers `
    -Principal $taskPrincipal -Settings $settings `
    -Description 'Renews IPv4 and IPv6 multiplayer port mappings' -Force | Out-Null
  $wslAction = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wsl.exe" `
    -Argument '-d Ubuntu-26.04 -u hieul -- systemctl --user start sts-actions-runner.service sts-room-server.service'
  Register-ScheduledTask -TaskName 'Slay the Spire WSL services' -Action $wslAction -Trigger $hostTriggers `
    -Principal $taskPrincipal -Settings $settings `
    -Description 'Starts the Slay the Spire room server and deployment runner' -Force | Out-Null
  if (-not $firewallRuleExisted) {
    New-NetFirewallRule -DisplayName 'Slay the Spire TLS proxy' -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort 80,443 -Program $caddy -Profile Any | Out-Null
    $firewallRuleCreated = $true
  }
  if (Get-Process caddy -ErrorAction SilentlyContinue) {
    & $caddy stop
    if ($LASTEXITCODE -ne 0) { throw 'Could not stop the existing Caddy process.' }
  }
  Stop-ScheduledTask -TaskName 'Slay the Spire TLS proxy' -ErrorAction SilentlyContinue
  Stop-ScheduledTask -TaskName 'Slay the Spire router mapping' -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $mappingCandidate -Destination $mappingScript -Force
  Move-Item -LiteralPath $templateCandidate -Destination $caddyTemplateFile -Force
  Move-Item -LiteralPath $caddyCandidate -Destination $caddyFile -Force
  Start-ScheduledTask -TaskName 'Slay the Spire WSL services'
  Start-ScheduledTask -TaskName 'Slay the Spire TLS proxy'
  & $mappingScript -Publish
  if ($LASTEXITCODE -ne 0) { throw 'Could not publish the multiplayer origin.' }
  $installationSucceeded = $true
} finally {
  try {
    if (-not $installationSucceeded) {
      if (Get-Process caddy -ErrorAction SilentlyContinue) { & $caddy stop }
      if ($previousCaddyFile) { Copy-Item -LiteralPath $caddyBackup -Destination $caddyFile -Force }
      elseif (Test-Path $caddyFile) { Remove-Item -LiteralPath $caddyFile -Force }
      if ($previousMapping) { Copy-Item -LiteralPath $mappingBackup -Destination $mappingScript -Force }
      elseif (Test-Path $mappingScript) { Remove-Item -LiteralPath $mappingScript -Force }
      if ($previousTemplate) { Copy-Item -LiteralPath $templateBackup -Destination $caddyTemplateFile -Force }
      elseif (Test-Path $caddyTemplateFile) { Remove-Item -LiteralPath $caddyTemplateFile -Force }
      foreach ($taskName in $managedTasks) {
        if ($taskBackups.ContainsKey($taskName)) {
          Register-ScheduledTask -TaskName $taskName -Xml $taskBackups[$taskName] -Force | Out-Null
        } elseif (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
          Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
        }
      }
      if ($previousServerOriginExists) {
        & wsl.exe -d Ubuntu-26.04 -u hieul -- gh variable set MULTIPLAYER_SERVER_ORIGIN `
          --repo $repository --body $previousServerOrigin
      } else {
        & wsl.exe -d Ubuntu-26.04 -u hieul -- gh variable delete MULTIPLAYER_SERVER_ORIGIN `
          --repo $repository 2>$null
      }
      if ($LASTEXITCODE -ne 0) { throw 'Could not restore MULTIPLAYER_SERVER_ORIGIN.' }
      if ($firewallRuleCreated) {
        Remove-NetFirewallRule -DisplayName 'Slay the Spire TLS proxy'
      }
    }
  } finally {
    foreach ($taskName in @('Slay the Spire WSL services', 'Slay the Spire TLS proxy', 'Slay the Spire router mapping')) {
      if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
        Start-ScheduledTask -TaskName $taskName
      }
    }
  }
}
Remove-Item -LiteralPath $caddyBackup,$mappingBackup,$templateBackup,$mappingCandidate,$templateCandidate `
  -Force -ErrorAction SilentlyContinue

Write-Output "MULTIPLAYER_SERVER_ORIGIN=$origin"
Write-Output 'Bbox IPv4 and IPv6 mappings are active and will renew every hour.'
