[CmdletBinding()]
param(
  [switch]$Watch,
  [switch]$Publish
)

$ErrorActionPreference = 'Stop'
$leaseSeconds = 86400
$statePath = Join-Path $PSScriptRoot 'router-state.json'
$logPath = Join-Path $PSScriptRoot 'router-pinhole.log'
$noncePath = Join-Path $PSScriptRoot 'pcp-nonces.json'
$nonceCandidate = Join-Path $PSScriptRoot 'pcp-nonces.next.json'
$caddy = Join-Path $PSScriptRoot 'caddy.exe'
$caddyFile = Join-Path $PSScriptRoot 'Caddyfile'
$caddyCandidate = Join-Path $PSScriptRoot 'Caddyfile.next'
$caddyTemplate = Join-Path $PSScriptRoot 'Caddyfile.template'
$publishedOriginPath = Join-Path $PSScriptRoot 'published-origin.txt'
$pcpNonces = @{}
if (Test-Path $noncePath) {
  try {
    $storedNonces = Get-Content -LiteralPath $noncePath -Raw | ConvertFrom-Json
    foreach ($property in $storedNonces.PSObject.Properties) {
      $pcpNonces[$property.Name] = $property.Value
    }
  } catch {
    $pcpNonces = @{}
  }
}

function Set-BigEndianUInt16([byte[]]$Buffer, [int]$Offset, [int]$Value) {
  $Buffer[$Offset] = [byte]($Value -shr 8)
  $Buffer[$Offset + 1] = [byte]($Value -band 255)
}

function Set-BigEndianUInt32([byte[]]$Buffer, [int]$Offset, [uint32]$Value) {
  $Buffer[$Offset] = [byte]($Value -shr 24)
  $Buffer[$Offset + 1] = [byte](($Value -shr 16) -band 255)
  $Buffer[$Offset + 2] = [byte](($Value -shr 8) -band 255)
  $Buffer[$Offset + 3] = [byte]($Value -band 255)
}

function Get-BigEndianUInt16([byte[]]$Buffer, [int]$Offset) {
  return ([int]$Buffer[$Offset] * 256) + [int]$Buffer[$Offset + 1]
}

function Get-BigEndianUInt32([byte[]]$Buffer, [int]$Offset) {
  return [uint32](
    ([uint64]$Buffer[$Offset] -shl 24) -bor
    ([uint64]$Buffer[$Offset + 1] -shl 16) -bor
    ([uint64]$Buffer[$Offset + 2] -shl 8) -bor
    [uint64]$Buffer[$Offset + 3]
  )
}

function ConvertTo-DnsIpv6Label([System.Net.IPAddress]$Address) {
  $bytes = $Address.GetAddressBytes()
  $groups = for ($offset = 0; $offset -lt $bytes.Length; $offset += 2) {
    '{0:x}' -f (([int]$bytes[$offset] * 256) + [int]$bytes[$offset + 1])
  }
  return $groups -join '-'
}

function Get-PcpNonce([int]$ExternalPort) {
  $key = [string]$ExternalPort
  if ($pcpNonces.ContainsKey($key)) {
    try {
      $stored = [Convert]::FromBase64String($pcpNonces[$key])
      if ($stored.Length -eq 12) { return $stored }
    } catch {}
  }
  $nonce = New-Object byte[] 12
  $random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($nonce) } finally { $random.Dispose() }
  $pcpNonces[$key] = [Convert]::ToBase64String($nonce)
  [System.IO.File]::WriteAllText(
    $nonceCandidate,
    ($pcpNonces | ConvertTo-Json),
    (New-Object System.Text.UTF8Encoding $false)
  )
  Move-Item -LiteralPath $nonceCandidate -Destination $noncePath -Force
  return $nonce
}

function Invoke-NatPmpMapping([string]$Gateway, [int]$InternalPort, [int]$ExternalPort) {
  $client = New-Object System.Net.Sockets.UdpClient
  try {
    $client.Client.ReceiveTimeout = 5000
    $client.Connect($Gateway, 5351)
    $request = New-Object byte[] 12
    $request[1] = 2
    Set-BigEndianUInt16 $request 4 $InternalPort
    Set-BigEndianUInt16 $request 6 $ExternalPort
    Set-BigEndianUInt32 $request 8 $leaseSeconds
    [void]$client.Send($request, $request.Length)
    $remote = New-Object System.Net.IPEndPoint ([System.Net.IPAddress]::Any, 0)
    $response = $client.Receive([ref]$remote)
    if ($response.Length -ne 16 -or $response[0] -ne 0 -or $response[1] -ne 130) {
      throw "Invalid NAT-PMP response for TCP $ExternalPort."
    }
    $result = Get-BigEndianUInt16 $response 2
    $mappedPort = Get-BigEndianUInt16 $response 10
    if ($result -ne 0 -or $mappedPort -ne $ExternalPort) {
      throw "NAT-PMP rejected TCP $ExternalPort (result $result, mapped port $mappedPort)."
    }
    return Get-BigEndianUInt32 $response 12
  } finally {
    $client.Dispose()
  }
}

function Invoke-PcpMapping(
  [System.Net.IPAddress]$SourceAddress,
  [System.Net.IPAddress]$Gateway,
  [int]$InternalPort,
  [int]$ExternalPort,
  [byte[]]$Nonce
) {
  $client = New-Object System.Net.Sockets.UdpClient ([System.Net.Sockets.AddressFamily]::InterNetworkV6)
  try {
    $client.Client.Bind((New-Object System.Net.IPEndPoint ($SourceAddress, 0)))
    $client.Client.ReceiveTimeout = 5000
    $client.Connect($Gateway, 5351)
    $request = New-Object byte[] 60
    $request[0] = 2
    $request[1] = 1
    Set-BigEndianUInt32 $request 4 $leaseSeconds
    [Array]::Copy($SourceAddress.GetAddressBytes(), 0, $request, 8, 16)
    [Array]::Copy($Nonce, 0, $request, 24, 12)
    $request[36] = 6
    Set-BigEndianUInt16 $request 40 $InternalPort
    Set-BigEndianUInt16 $request 42 $ExternalPort
    [void]$client.Send($request, $request.Length)
    $remote = New-Object System.Net.IPEndPoint ([System.Net.IPAddress]::IPv6Any, 0)
    $response = $client.Receive([ref]$remote)
    if ($response.Length -ne 60 -or $response[0] -ne 2 -or $response[1] -ne 129 -or $response[3] -ne 0) {
      $result = if ($response.Length -gt 3) { $response[3] } else { -1 }
      throw "PCP rejected TCP $ExternalPort (result $result)."
    }
    for ($index = 0; $index -lt $Nonce.Length; $index += 1) {
      if ($response[24 + $index] -ne $Nonce[$index]) {
        throw "PCP returned the wrong nonce for TCP $ExternalPort."
      }
    }
    if ((Get-BigEndianUInt16 $response 40) -ne $InternalPort -or
        (Get-BigEndianUInt16 $response 42) -ne $ExternalPort) {
      throw "PCP returned an unexpected port mapping for TCP $ExternalPort."
    }
    return Get-BigEndianUInt32 $response 4
  } finally {
    $client.Dispose()
  }
}

function Update-RouterMappings {
  $ipv4Route = Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' |
    Sort-Object RouteMetric | Select-Object -First 1
  $ipv6Route = Get-NetRoute -AddressFamily IPv6 -DestinationPrefix '::/0' |
    Sort-Object RouteMetric | Select-Object -First 1
  if (-not $ipv4Route -or -not $ipv6Route) {
    throw 'Both IPv4 and IPv6 default routes are required.'
  }

  $wan = Invoke-RestMethod -Uri ("http://{0}/api/v1/wan/ip" -f $ipv4Route.NextHop) -TimeoutSec 10
  $publicIpv4 = $wan[0].wan.ip.address
  if ($wan[0].wan.ip.cgnatenable -ne 0 -or $publicIpv4 -notmatch '^([0-9]{1,3}\.){3}[0-9]{1,3}$') {
    throw 'The Bbox did not report a directly reachable public IPv4 address.'
  }

  $publicIpv6 = Get-NetIPAddress -InterfaceIndex $ipv6Route.InterfaceIndex -AddressFamily IPv6 |
    Where-Object {
      $_.AddressState -eq 'Preferred' -and
      $_.PrefixOrigin -eq 'RouterAdvertisement' -and
      $_.SuffixOrigin -eq 'Link' -and
      $_.IPAddress -notlike 'fe80:*'
    } | Select-Object -First 1 -ExpandProperty IPAddress
  if (-not $publicIpv6) {
    throw 'No stable public IPv6 address was found on the default interface.'
  }

  $grantedLeases = @(
    (Invoke-NatPmpMapping $ipv4Route.NextHop 80 80),
    (Invoke-NatPmpMapping $ipv4Route.NextHop 443 18443)
  )

  $scopedIpv6Gateway = [System.Net.IPAddress]::Parse(
    ("{0}%{1}" -f $ipv6Route.NextHop, $ipv6Route.InterfaceIndex)
  )
  $sourceIpv6 = [System.Net.IPAddress]::Parse($publicIpv6)
  $grantedLeases += @(
    (Invoke-PcpMapping $sourceIpv6 $scopedIpv6Gateway 80 80 (Get-PcpNonce 80)),
    (Invoke-PcpMapping $sourceIpv6 $scopedIpv6Gateway 443 18443 (Get-PcpNonce 18443))
  )
  $minimumLease = ($grantedLeases | Measure-Object -Minimum).Minimum
  if ($minimumLease -lt 300) {
    throw "The router granted an unsafe mapping lifetime of $minimumLease seconds."
  }
  $renewAfterSeconds = [Math]::Min(3600, [Math]::Max(60, [Math]::Floor($minimumLease / 2)))

  $ipv6Label = ConvertTo-DnsIpv6Label $sourceIpv6
  $hostName = 'sts-' + $publicIpv4.Replace('.', '-') + '.' + $ipv6Label + '.sslip.io'
  $state = [ordered]@{
    hostName = $hostName
    origin = "https://${hostName}:18443"
    publicIpv4 = $publicIpv4
    publicIpv6 = $publicIpv6
    renewAfterSeconds = $renewAfterSeconds
    renewedAt = [DateTimeOffset]::Now.ToString('o')
  }
  $json = $state | ConvertTo-Json
  [System.IO.File]::WriteAllText($statePath, $json, (New-Object System.Text.UTF8Encoding $false))
  return $state
}

function Publish-OriginChange($State) {
  if (-not (Test-Path $caddy) -or -not (Test-Path $caddyTemplate)) {
    throw 'Caddy and its template must be installed before publishing an origin change.'
  }
  $published = if (Test-Path $publishedOriginPath) {
    (Get-Content -LiteralPath $publishedOriginPath -Raw).Trim()
  } else { '' }
  $siteAddresses = $State.hostName
  if ($published -and $published -ne $State.origin) {
    try {
      $publishedUri = [Uri]$published
      if ($publishedUri.Scheme -eq 'https' -and $publishedUri.Port -eq 18443 -and
          $publishedUri.DnsSafeHost -match '^sts-([0-9]{1,3}-){3}[0-9]{1,3}\.([0-9a-f]{1,4}-){7}[0-9a-f]{1,4}\.sslip\.io$') {
        $siteAddresses = $publishedUri.DnsSafeHost + ', ' + $State.hostName
      }
    } catch {}
  }

  $template = Get-Content -LiteralPath $caddyTemplate -Raw
  [System.IO.File]::WriteAllText(
    $caddyCandidate,
    $template.Replace('__SERVER_HOSTS__', $siteAddresses),
    (New-Object System.Text.UTF8Encoding $false)
  )
  & $caddy validate --config $caddyCandidate --adapter caddyfile
  if ($LASTEXITCODE -ne 0) { throw 'The replacement Caddy configuration is invalid.' }
  $caddyLoaded = $false
  for ($attempt = 0; $attempt -lt 12; $attempt += 1) {
    & $caddy reload --config $caddyCandidate --adapter caddyfile
    if ($LASTEXITCODE -eq 0) {
      $caddyLoaded = $true
      break
    }
    Start-Sleep -Seconds 5
  }
  if (-not $caddyLoaded) { throw 'Caddy rejected the replacement origin.' }
  Move-Item -LiteralPath $caddyCandidate -Destination $caddyFile -Force

  $healthy = $false
  for ($attempt = 0; $attempt -lt 12; $attempt += 1) {
    try {
      $health = Invoke-RestMethod -Uri ($State.origin + '/api/health') -TimeoutSec 20
      $compatible = $health.protocolVersion -eq 1 -and $health.profiles -eq $true
      $releaseReady = [string]$health.releaseSha -match '^[0-9a-f]{40}$'
      # Reinstalling boot tasks must work while an existing stable origin is
      # serving a bootstrap build. A changed origin still needs an immutable
      # deployed release before it can be published to Pages.
      if ($compatible -and ($published -eq $State.origin -or $releaseReady)) {
        $healthy = $true
        break
      }
    } catch {}
    Start-Sleep -Seconds 5
  }
  if (-not $healthy) { throw 'The replacement public origin did not become healthy.' }
  if ($published -eq $State.origin) { return }

  $repository = 'hieu-lee/slay-the-spire-the-boardgame-the-game'
  & wsl.exe -d Ubuntu-26.04 -u hieul -- gh variable set MULTIPLAYER_SERVER_ORIGIN `
    --repo $repository --body $State.origin
  if ($LASTEXITCODE -ne 0) { throw 'Could not update MULTIPLAYER_SERVER_ORIGIN.' }
  & wsl.exe -d Ubuntu-26.04 -u hieul -- gh workflow run pages-deploy.yml `
    --repo $repository --ref master -f ("deploy_sha={0}" -f [string]$health.releaseSha)
  if ($LASTEXITCODE -ne 0) { throw 'Could not queue the refreshed Pages client.' }
  $pagesPublished = $false
  for ($attempt = 0; $attempt -lt 90; $attempt += 1) {
    try {
      $session = Invoke-RestMethod -Uri (
        'https://hieu-lee.github.io/slay-the-spire-the-boardgame-the-game/session.json?origin=' +
        [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
      ) -TimeoutSec 30
      if ($session.origin -eq $State.origin -and $session.alwaysOn -eq $true -and
          $session.sha -eq [string]$health.releaseSha) {
        $pagesPublished = $true
        break
      }
    } catch {}
    Start-Sleep -Seconds 10
  }
  if (-not $pagesPublished) { throw 'Pages did not publish the replacement origin.' }
  [System.IO.File]::WriteAllText(
    $publishedOriginPath,
    $State.origin,
    (New-Object System.Text.UTF8Encoding $false)
  )
}

function Start-WslServices {
  $watchdogState = (& wsl.exe -d Ubuntu-26.04 -u hieul -- bash `
    /home/hieul/slay-the-spire-the-boardgame-the-game/infra/watchdog-wsl-host.sh | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) { throw 'Could not start the persistent WSL services.' }
  if ($watchdogState -ne 'ready') { throw 'The WSL watchdog returned an invalid state.' }
  $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8787/api/health' -TimeoutSec 20
  if ($health.protocolVersion -ne 1 -or $health.profiles -ne $true) {
    throw 'The local WSL room service returned an incompatible health response.'
  }
}

if (-not $Watch) {
  $state = Update-RouterMappings
  if ($Publish) { Publish-OriginChange $state }
  exit 0
}

$retrySeconds = 60
while ($true) {
  $succeeded = $false
  try {
    Start-WslServices
    $state = Update-RouterMappings
    Publish-OriginChange $state
    $line = '{0} renewed {1}' -f [DateTimeOffset]::Now.ToString('o'), $state.origin
    $succeeded = $true
  } catch {
    $line = '{0} ERROR {1}' -f [DateTimeOffset]::Now.ToString('o'), $_.Exception.Message
  }
  [System.IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine)
  if ($succeeded) {
    $retrySeconds = 60
    $watchdogIterations = [Math]::Max(1, [Math]::Floor($state.renewAfterSeconds / 60))
    for ($watchdogMinute = 0; $watchdogMinute -lt $watchdogIterations; $watchdogMinute += 1) {
      Start-Sleep -Seconds 60
      try {
        [void](Start-WslServices)
      } catch {
        $watchdogLine = '{0} ERROR {1}' -f [DateTimeOffset]::Now.ToString('o'), $_.Exception.Message
        [System.IO.File]::AppendAllText($logPath, $watchdogLine + [Environment]::NewLine)
        break
      }
    }
  } else {
    Start-Sleep -Seconds $retrySeconds
    $retrySeconds = [Math]::Min($retrySeconds * 2, 300)
  }
}
