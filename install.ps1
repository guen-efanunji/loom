# Loom installer.
#   irm https://loomworkspace.bond/install.ps1 | iex
# Downloads the published Windows x64 release, verifies SHA-256 and size, installs
# it into your user folder and updates your user PATH. No clone, no build, no
# administrator access. Each phase is printed as a log line.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$totalPhases = 8
$phase = 0
$started = Get-Date
$useColor = $true
try { $useColor = -not [Console]::IsOutputRedirected } catch { $useColor = $false }
if ($env:NO_COLOR -ne $null) { $useColor = $false }
$ProgressPreference = if ($useColor) { 'Continue' } else { 'SilentlyContinue' }

function Write-Log {
  param([string]$Message, [string]$Kind = 'info')
  $tag = switch ($Kind) {
    'ok' { ' ok' }
    'warn' { 'warn' }
    'fail' { 'fail' }
    default { 'info' }
  }
  $color = switch ($Kind) {
    'ok' { 'Green' }
    'warn' { 'Yellow' }
    'fail' { 'Red' }
    default { 'Cyan' }
  }
  if ($useColor) {
    Write-Host ("{0,-4} {1}" -f $tag, $Message) -ForegroundColor $color
  } else {
    Write-Host ("{0,-4} {1}" -f $tag, $Message)
  }
}
function Write-Detail { param([string]$Message) Write-Host ("      {0}" -f $Message) }
function Write-Phase {
  param([string]$Message)
  $script:phase = $script:phase + 1
  Write-Host ''
  Write-Host ('[{0}/{1}] {2}' -f $script:phase, $totalPhases, $Message) -ForegroundColor $(if ($useColor) { 'Magenta' } else { 'Gray' })
}
function Write-Done { param([string]$Message) Write-Log $Message 'ok' }
function Write-Caution { param([string]$Message) Write-Log $Message 'warn' }
function Stop-Install {
  param([string]$Message, [string[]]$Hints = @())
  Write-Log $Message 'fail'
  foreach ($hint in $Hints) { Write-Detail $hint }
  throw $Message
}
function Get-ToolVersion {
  param([string]$Name, [string[]]$Arguments = @('--version'))
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) { return $null }
  try { (& $Name @Arguments 2>$null | Select-Object -First 1) } catch { $null }
}
function Format-Size {
  param([long]$Bytes)
  if ($Bytes -ge 1GB) { return ('{0:N1} GB' -f ($Bytes / 1GB)) }
  if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
  if ($Bytes -ge 1KB) { return ('{0:N1} KB' -f ($Bytes / 1KB)) }
  return "$Bytes B"
}

Write-Host 'Loom installer  -  a clear desk for parallel coding agents' -ForegroundColor $(if ($useColor) { 'Magenta' } else { 'Gray' })

# ---------- 1. platform ----------
Write-Phase 'Checking your system'
if (-not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64') {
  Stop-Install 'This release supports Windows x64 only.' 'See https://loomworkspace.bond/docs/installation/ for the published platform matrix.'
}
$platform = 'windows-x64'
Write-Done ("Windows x64 ({0})" -f [Environment]::OSVersion.VersionString)
$channel = if ($env:LOOM_CHANNEL) { $env:LOOM_CHANNEL } else { 'stable' }
if ($channel -notin @('stable', 'beta')) { Stop-Install 'LOOM_CHANNEL must be stable or beta.' "Received: $channel" }
$loomHome = if ($env:LOOM_HOME) { $env:LOOM_HOME } else { Join-Path $HOME '.loom' }
if (-not [IO.Path]::IsPathRooted($loomHome)) { Stop-Install 'LOOM_HOME must be an absolute path.' "Received: $loomHome" }
$base = if ($env:LOOM_RELEASE_BASE) { $env:LOOM_RELEASE_BASE } else { 'https://github.com/guen-efanunji/loom/releases/download' }
$site = if ($env:LOOM_SITE_BASE) { $env:LOOM_SITE_BASE } else { 'https://loomworkspace.bond' }
$bin = Join-Path $loomHome 'bin'
$target = Join-Path $bin 'loom.exe'
Write-Detail "install target  $target"
Write-Detail "data directory  $loomHome"
Write-Detail "release channel $channel"

# ---------- 2. installer tools ----------
Write-Phase 'Checking the tools this installer needs'
Write-Done 'PowerShell console host available'
Write-Done 'TLS 1.2 enforced for every download'
if ($PSVersionTable.PSVersion.Major -lt 5) { Stop-Install 'PowerShell 5.1 or newer is required.' 'Install the latest .NET Framework or use pwsh 7+.' }
Write-Done ("PowerShell {0}" -f $PSVersionTable.PSVersion)

# ---------- 3. runtime requirements ----------
Write-Phase 'Checking what Loom needs after the binary is installed'
$gitVersion = Get-ToolVersion 'git'
if ($gitVersion) { Write-Done "$gitVersion - worktrees and task branches are ready" }
else {
  Write-Caution 'git not found - Loom needs it to create worktrees and review diffs'
  Write-Detail 'Install it now or later: https://git-scm.com/downloads'
}
$agyVersion = Get-ToolVersion 'opencode'
if ($agyVersion) { Write-Done 'opencode found - primary chat and task runtime available' }
else {
  Write-Caution 'opencode not found - Loom runs chat and Kanban tasks through OpenCode'
  Write-Detail 'Install it later with the official script: https://opencode.ai/docs/'
}
Write-Log 'Bun, Node.js and npm are not needed: the release bundles the Bun runtime with the UI.'

# ---------- 4. resolve release ----------
Write-Phase "Resolving the latest release on the $channel channel"
Write-Log "GET $base/channel-$channel/manifest.json"
try {
  $manifest = Invoke-RestMethod -Uri "$base/channel-$channel/manifest.json" -TimeoutSec 20
} catch {
  Stop-Install 'No published release is available for this channel.' 'Check https://github.com/guen-efanunji/loom/releases - the first release may not be published yet.'
}
if ($manifest.version -notmatch '^\d+\.\d+\.\d+(-beta\.\d+)?$') { Stop-Install 'Invalid release version.' "Read: $($manifest.version)" }
if ($channel -eq 'stable' -and $manifest.version.Contains('-')) { Stop-Install 'Stable channel contains a prerelease.' "Read: $($manifest.version)" }
$artifact = $manifest.artifacts.$platform
if (-not $artifact) {
  Stop-Install 'This release does not publish a windows-x64 binary yet.' 'Windows support is being prepared; the current release covers macOS and Linux.' "Track it at $site/docs/installation/ and https://github.com/guen-efanunji/loom/releases"
}
$expectedUrl = "$base/v$($manifest.version)/loom-windows-x64.exe"
if ($artifact.url -cne $expectedUrl -or $artifact.sha256 -cnotmatch '^[a-f0-9]{64}$') { Stop-Install 'Invalid artifact metadata.' "Read: $($artifact.url)" }
$declaredSize = [long]$artifact.size
Write-Done ("Loom {0} for {1} ({2})" -f $manifest.version, $platform, (Format-Size $declaredSize))

# ---------- 5. download binary ----------
Write-Phase 'Downloading the Loom binary'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('loom-' + [guid]::NewGuid().ToString() + '.exe')
try {
  Write-Log "GET $($artifact.url)"
  Invoke-WebRequest -UseBasicParsing -Uri $artifact.url -OutFile $temp -TimeoutSec 1800
  $downloaded = (Get-Item -LiteralPath $temp).Length
  $elapsed = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  Write-Done ("Downloaded {0} in {1}s" -f (Format-Size $downloaded), $elapsed)

  # ---------- 6. verify ----------
  Write-Phase 'Verifying the download'
  Write-Detail "expected sha256 $($artifact.sha256)"
  $actual = (Get-FileHash -LiteralPath $temp -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Detail "actual   sha256 $actual"
  if ($actual -cne $artifact.sha256 -or $downloaded -ne $declaredSize) {
    Stop-Install 'Checksum or size mismatch. Nothing was installed.' 'The download did not match the published release.'
  }
  Write-Done ("SHA-256 and size verified for {0}" -f (Format-Size $downloaded))

  # ---------- 7. install ----------
  Write-Phase 'Installing Loom'
  # The same one-liner is the recovery path when loom update cannot finish, so an
  # existing installation is upgraded in place instead of refusing to run.
  $installed = ''
  if (Test-Path -LiteralPath $target) {
    $reportedInstalled = ((& $target --version 2>$null) | Out-String)
    if ($reportedInstalled -match '(\d+\.\d+\.\d+(-beta\.\d+)?)') { $installed = $Matches[1] }
    if ($installed -eq $manifest.version) {
      Stop-Install 'Loom is installed. Run loom update to update safely.' "Existing binary: $target ($installed)"
    }
    Write-Log "Found Loom $(if ($installed) { $installed } else { 'another build' }) in place; updating it to $($manifest.version)"
  }
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  Write-Log 'Running a startup check on the downloaded executable'
  $reported = & $temp --version
  if ($LASTEXITCODE -ne 0) { Stop-Install 'The release binary cannot run on this system.' }
  Write-Done "Executable answers: $reported"
  if ($installed) {
    $previous = Join-Path $bin 'loom.exe.previous'
    Copy-Item -LiteralPath $target -Destination $previous -Force
    Write-Done "Kept the previous build at $previous for rollback"
    Move-Item -LiteralPath $temp -Destination $target
    Write-Done "Updated $target from $installed to $($manifest.version) (no administrator access used)"
  } else {
    Move-Item -LiteralPath $temp -Destination $target
    Write-Done "Installed to $target (no administrator access used)"
  }

  # ---------- 8. PATH ----------
  Write-Phase 'Adding Loom to your user PATH'
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if ($bin -notin ($userPath -split ';')) {
    [Environment]::SetEnvironmentVariable('Path', "$bin;$userPath", 'User')
    Write-Done "Added $bin to your user PATH"
  } else {
    Write-Done "$bin is already on your user PATH"
  }
  $env:Path = "$bin;$env:Path"

  $totalSeconds = [math]::Round(((Get-Date) - $started).TotalSeconds, 1)
  if ($installed) {
    $headline = ("Loom updated from $installed to {0} in {1}s." -f $manifest.version, $totalSeconds)
  } else {
    $headline = ("Loom {0} installed successfully in {1}s." -f $manifest.version, $totalSeconds)
  }
  Write-Host ''
  Write-Host $headline -ForegroundColor $(if ($useColor) { 'Green' } else { 'Gray' })
  Write-Detail 'next  open a new terminal, then run: loom'
  Write-Detail '      the workspace opens at http://127.0.0.1:4317 on this device'
  Write-Detail 'check loom doctor  -  logs loom logs'
  if (-not $gitVersion) { Write-Caution 'Before your first task: install Git.' }
  if (-not $agyVersion) { Write-Caution 'Before your first task: install OpenCode and connect a model provider.' }
  Write-Detail "Docs: $site/docs/installation/"
} finally {
  if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
}
