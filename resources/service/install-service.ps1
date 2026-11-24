# Installs Hearth Media Server as a Windows service using WinSW.
# This script is invoked by the desktop control panel and requires administrator approval.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$DataDir,
  [Parameter(Mandatory = $true)][string]$ResourcesDir,
  [string]$Port = '7341'
)
$ErrorActionPreference = 'Stop'

$serviceId = 'HearthMediaServer'
$serviceName = 'Hearth Media Server'
$serviceDescription = 'Hearth personal media server background service.'
$serviceExe = Join-Path $ResourcesDir 'service\HearthService.exe'
$appRoot = Split-Path -Parent $ResourcesDir
$appExe = Join-Path $appRoot 'Hearth.exe'
$serverScript = Join-Path $ResourcesDir 'server\index.js'
$logDirectory = Join-Path $DataDir 'logs'

if (-not (Test-Path $serviceExe)) { throw "Service wrapper is missing: $serviceExe" }
if (-not (Test-Path $appExe)) { throw "Hearth executable is missing: $appExe" }
if (-not (Test-Path $serverScript)) { throw "Server entry point is missing: $serverScript" }
New-Item -ItemType Directory -Force -Path $DataDir, $logDirectory | Out-Null

$existing = Get-Service -Name $serviceId -ErrorAction SilentlyContinue
if ($existing) { & $serviceExe stop | Out-Null; & $serviceExe uninstall | Out-Null; Start-Sleep -Seconds 2 }

$xmlPath = Join-Path $ResourcesDir 'service\HearthService.xml'
$escapedData = $DataDir.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
$escapedApp = $appExe.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
$escapedServer = $serverScript.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')
$escapedLog = $logDirectory.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;')

# ELECTRON_RUN_AS_NODE makes Hearth.exe act as a Node.js runtime, so no separate Node install is required.
$xml = @"
<service>
  <id>$serviceId</id>
  <name>$serviceName</name>
  <description>$serviceDescription</description>
  <executable>$escapedApp</executable>
  <arguments>"$escapedServer" --data "$escapedData" --port $Port --ffmpeg-dir "$ResourcesDir\ffmpeg"</arguments>
  <env name="ELECTRON_RUN_AS_NODE" value="1"/>
  <env name="ELECTRON_NO_ATTACH_CONSOLE" value="1"/>
  <workingdirectory>$escapedData</workingdirectory>
  <logpath>$escapedLog</logpath>
  <log mode="roll-by-size">
    <sizeThreshold>10240</sizeThreshold>
    <keepFiles>8</keepFiles>
  </log>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="20 sec"/>
  <onfailure action="none"/>
  <resetfailure>1 hour</resetfailure>
  <stoptimeout>15 sec</stoptimeout>
  <stopparentprocessfirst>true</stopparentprocessfirst>
  <startmode>Automatic</startmode>
  <delayedAutoStart>true</delayedAutoStart>
</service>
"@
Set-Content -Path $xmlPath -Value $xml -Encoding UTF8
& $serviceExe install | Out-Null
Start-Service -Name $serviceId
Write-Output "Hearth service installed and started."
