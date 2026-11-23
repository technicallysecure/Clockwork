# Inspect a running Compose deployment. No credentials or workspace contents are read.
param([string]$ProjectName)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$arguments = @('--project-directory', $projectDir)
if ($ProjectName) { $arguments += @('-p', $ProjectName) }
$containerIds = @(docker compose @arguments ps -q)
if ($LASTEXITCODE -ne 0 -or -not $containerIds.Count) { throw 'Start the Compose project before checking isolation.' }
$raw = docker inspect @containerIds
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect the running containers.' }
$containers = ($raw -join "`n") | ConvertFrom-Json

function Get-ContainerSetting($Container, [string]$Name) {
    $entry = @($Container.Config.Env | Where-Object { $_.StartsWith("$Name=") })
    if ($entry.Count -eq 1) { return $entry[0].Substring($Name.Length + 1) }
}
function Test-SecretMounts($Container, $Expected) {
    $prefix = '/run/secrets/'
    $secretMounts = @($Container.Mounts | Where-Object { $_.Destination.StartsWith($prefix) })
    if (@($secretMounts | Where-Object RW).Count) { throw "Writable secret in $($Container.Name)." }
    $names = @($secretMounts | ForEach-Object { $_.Destination.Substring($prefix.Length) })
    if (Compare-Object @($Expected | Sort-Object) @($names | Sort-Object)) {
        throw "Unexpected secret grants in $($Container.Name)."
    }
}
$gateways = @($containers | Where-Object { (Get-ContainerSetting $_ 'CLOCKWORK_ROLE') -eq 'gateway' })
$workers = @($containers | Where-Object { (Get-ContainerSetting $_ 'CLOCKWORK_ROLE') -eq 'worker' })
if ($gateways.Count -ne 1) { throw 'Expected one running gateway.' }
$gateway = $gateways[0]
$slots = (Get-ContainerSetting $gateway 'CLOCKWORK_AGENT_SLOTS').Split(',')
if ($workers.Count -ne $slots.Count) { throw 'Some registered workers are missing or the project has extra workers.' }
$gatewayBindings = @($gateway.HostConfig.PortBindings.'8787/tcp')
if ($gatewayBindings.Count -ne 1 -or $gatewayBindings[0].HostIp -ne '127.0.0.1') { throw 'Gateway must publish to loopback.' }
$callbackPort = Get-ContainerSetting $gateway 'CLOCKWORK_PLAN_CALLBACK_PORT'
$allowedPorts = @('8787/tcp')
if ($callbackPort) { $allowedPorts += "$callbackPort/tcp" }
foreach ($port in $gateway.HostConfig.PortBindings.PSObject.Properties) {
    if ($port.Name -notin $allowedPorts -or $port.Value.Count -ne 1 -or $port.Value[0].HostIp -ne '127.0.0.1') {
        throw 'Unexpected published gateway port.'
    }
}
Test-SecretMounts $gateway (@('owner_password') + @($slots | ForEach-Object { "worker_$_" }))
if (@($gateway.Mounts | Where-Object { $_.Destination -ne '/tmp' -and -not $_.Destination.StartsWith('/run/secrets/') }).Count) {
    throw 'Gateway has an unexpected mount.'
}
$seenIds = @{}
$volumeNames = @{}
$workerNetworks = @{}
$searchCount = 0
$gatewayNetworks = @($gateway.NetworkSettings.Networks.PSObject.Properties.Name)
if ($gatewayNetworks.Count -ne $slots.Count) { throw 'Gateway must join exactly one network per slot.' }
foreach ($container in @($gateway) + $workers) {
    if ($container.HostConfig.Privileged -or -not $container.HostConfig.ReadonlyRootfs -or
        $container.Config.User -ne 'node' -or 'ALL' -notin $container.HostConfig.CapDrop) {
        throw "Unexpected container privileges in $($container.Name)."
    }
}
foreach ($worker in $workers) {
    $id = Get-ContainerSetting $worker 'CLOCKWORK_AGENT_ID'
    if (-not $id -or $seenIds.ContainsKey($id) -or $id -notin $slots) { throw 'Unexpected or duplicate worker ID.' }
    $seenIds[$id] = $true
    if (@($worker.HostConfig.PortBindings.PSObject.Properties | Where-Object { $_.Value }).Count) {
        throw "Worker $id publishes a port."
    }
    $networks = @($worker.NetworkSettings.Networks.PSObject.Properties.Name)
    $routing = @($networks | Where-Object { $_ -in $gatewayNetworks })
    if ($routing.Count -ne 1 -or $workerNetworks.ContainsKey($routing[0])) {
        throw "Worker $id needs a dedicated gateway network."
    }
    $workerNetworks[$routing[0]] = $true
    $extra = @($networks | Where-Object { $_ -notin $gatewayNetworks })
    if ((Get-ContainerSetting $worker 'CLOCKWORK_WEB_SEARCH') -eq 'true') {
        $search = @($containers | Where-Object { $_.Config.Labels.'com.docker.compose.service' -eq "search-$id" })
        if ($extra.Count -ne 1 -or $search.Count -ne 1 -or $workerNetworks.ContainsKey($extra[0])) { throw "Missing isolated search service for $id." }
        $service = $search[0]
        $links = @($service.NetworkSettings.Networks.PSObject.Properties)
        if ($links.Count -ne 1 -or $links[0].Name -ne $extra[0] -or 'web-search' -notin $links[0].Value.Aliases) { throw "Incorrect search network for $id." }
        if ($service.HostConfig.Privileged -or -not $service.HostConfig.ReadonlyRootfs -or
            $service.Config.User -ne '977:977' -or 'ALL' -notin $service.HostConfig.CapDrop -or
            $service.HostConfig.LogConfig.Type -ne 'none' -or @($service.HostConfig.PortBindings.PSObject.Properties | Where-Object Value).Count) {
            throw "Unexpected search privileges, logging or port on $id."
        }
        foreach ($mount in $service.Mounts) {
            if ($mount.Destination -in @('/tmp','/var/cache/searxng') -and $mount.Type -eq 'tmpfs') { continue }
            if ($mount.Destination -ne '/etc/searxng' -or $mount.Type -ne 'bind' -or $mount.RW) { throw "Unexpected search mount on $id." }
        }
        $workerNetworks[$extra[0]] = $true
        $searchCount++
    } elseif ($extra.Count) { throw "Unexpected network on $id." }
    $secrets = @("worker_$id")
    if ($id -eq 'personal') { $secrets += @('lm_token', 'openai_key') }
    Test-SecretMounts $worker $secrets
    $destinations = @('/data', '/workspace')
    if ($callbackPort) { $destinations += '/plan-secrets' }
    foreach ($destination in $destinations) {
        $mounts = @($worker.Mounts | Where-Object { $_.Destination -eq $destination })
        if ($mounts.Count -ne 1 -or $mounts[0].Type -ne 'volume' -or -not $mounts[0].RW -or
            $volumeNames.ContainsKey($mounts[0].Name)) { throw "Worker $id needs a dedicated volume for $destination." }
        $volumeNames[$mounts[0].Name] = $true
    }
    foreach ($mount in $worker.Mounts) {
        if ($mount.Destination -in $destinations -or $mount.Destination -eq '/tmp' -or $mount.Destination.StartsWith('/run/secrets/')) { continue }
        if ($mount.Destination -notin @('/app/config','/app/extensions') -or $mount.RW) {
            throw "Unexpected mount on worker $id."
        }
    }
}
if ($containers.Count -ne 1 + $workers.Count + $searchCount) { throw 'Unexpected services in the deployment.' }
Write-Host "Verified $($workers.Count) isolated workers, $searchCount search services, $($volumeNames.Count) private volumes, and a loopback-only gateway."
