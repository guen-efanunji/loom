$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { throw 'This release supports Windows x64. See the installation documentation.' }
$channel = if ($env:LOOM_CHANNEL) { $env:LOOM_CHANNEL } else { 'stable' }
if ($channel -notin @('stable', 'beta')) { throw 'LOOM_CHANNEL must be stable or beta.' }
$base = 'https://github.com/MrPinguiiin/loom/releases/download'
$manifest = Invoke-RestMethod -Uri "$base/channel-$channel/manifest.json" -TimeoutSec 15
if ($manifest.version -notmatch '^\d+\.\d+\.\d+(-beta\.\d+)?$') { throw 'Invalid release version.' }
if ($channel -eq 'stable' -and $manifest.version.Contains('-')) { throw 'Stable channel contains a prerelease.' }
$artifact = $manifest.artifacts.'windows-x64'
$expectedUrl = "$base/v$($manifest.version)/loom-windows-x64.exe"
if ($artifact.url -cne $expectedUrl -or $artifact.sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid artifact metadata.' }
$loomHome = if ($env:LOOM_HOME) { $env:LOOM_HOME } else { Join-Path $HOME '.loom' }
if (-not [IO.Path]::IsPathRooted($loomHome)) { throw 'LOOM_HOME must be an absolute path.' }
$bin = Join-Path $loomHome 'bin'
$target = Join-Path $bin 'loom.exe'
if (Test-Path -LiteralPath $target) { throw 'Loom is installed. Run loom update to update safely.' }
$temp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString() + '.exe')
try {
  Invoke-WebRequest -UseBasicParsing -Uri $artifact.url -OutFile $temp -TimeoutSec 180
  if ((Get-FileHash -LiteralPath $temp -Algorithm SHA256).Hash.ToLowerInvariant() -cne $artifact.sha256 -or (Get-Item -LiteralPath $temp).Length -ne $artifact.size) { throw 'Checksum or size mismatch. Nothing was installed.' }
  & $temp --version
  if ($LASTEXITCODE -ne 0) { throw 'The release binary cannot run on this system.' }
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  Move-Item -LiteralPath $temp -Destination $target
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($bin -notin ($userPath -split ';')) { [Environment]::SetEnvironmentVariable('Path', "$bin;$userPath", 'User') }
  $env:Path = "$bin;$env:Path"
  Write-Host "Loom $($manifest.version) installed. Run: loom"
  Write-Host 'Git and OpenCode must be installed and a model provider configured.'
} finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
