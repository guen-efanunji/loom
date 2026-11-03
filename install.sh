#!/bin/sh
# Loom installer.
#   curl -fsSL https://loomworkspace.bond/install.sh | sh
# Downloads the published release binary for your OS and CPU, verifies it, and
# installs it into your user folder. No clone, no build, no administrator access.
# Every phase is printed as a log line so you can see what is happening and what
# Loom still needs after the binary is in place (Git and OpenCode).
set -eu

total_steps=8
step=0
started=$(date +%s 2>/dev/null || echo 0)
use_color=0
show_progress=0
if [ -t 1 ]; then
  show_progress=1
  if [ -z "${NO_COLOR:-}" ] && [ -z "${CI:-}" ] && [ "${TERM:-dumb}" != "dumb" ]; then use_color=1; fi
fi

paint() {
  if [ "$use_color" = 1 ]; then printf "\033[%sm%s\033[0m" "$1" "$2"; else printf '%s' "$2"; fi
}
log() { printf '%s  %s\n' "$(paint '36' 'info')" "$*"; }
pass() { printf '%s  %s\n' "$(paint '32' ' ok')" "$*"; }
note() { printf '%s  %s\n' "$(paint '33' 'warn')" "$*"; }
detail() { printf '      %s\n' "$*"; }
die() {
  printf '%s  %s\n' "$(paint '31' 'fail')" "$1" >&2
  shift
  for hint in "$@"; do printf '      %s\n' "$hint" >&2; done
  exit 1
}
phase() {
  step=$((step + 1))
  printf '\n%s %s\n' "$(paint '1;35' "[$step/$total_steps]")" "$(paint '1' "$*")"
}
human() {
  awk -v b="${1:-0}" 'BEGIN {
    split("B KB MB GB TB", unit, " "); i = 1
    while (b >= 1024 && i < 5) { b = b / 1024; i++ }
    printf (i == 1 ? "%d %s" : "%.1f %s"), b, unit[i]
  }'
}
has() { command -v "$1" >/dev/null 2>&1; }

printf '%s\n' "$(paint '1;35' '  Loom installer  ·  a clear desk for parallel coding agents')"

# ---------- 1. platform ----------
phase 'Checking your system'
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die 'This is not macOS or Linux.' 'Run the PowerShell installer instead: irm https://loomworkspace.bond/install.ps1 | iex' ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) die 'Unsupported CPU architecture.' 'Published targets: x64 and arm64 (macOS, Linux glibc, Windows x64).' ;;
esac
platform="$os-$arch"
pass "Platform $platform ($(uname -m), kernel $(uname -r))"
if [ "$os" = linux ] && has ldd && ldd --version 2>&1 | grep -qi musl; then
  die 'Alpine/musl libc is not published.' 'Use a glibc Linux target, or install Bun and run scripts/build-release.ts from a checkout.'
fi
loom_home=${LOOM_HOME:-"$HOME/.loom"}
case "$loom_home" in
  /*) ;;
  *) die 'LOOM_HOME must be an absolute path.' "Received: $loom_home" ;;
esac
bin=$loom_home/bin
channel=${LOOM_CHANNEL:-stable}
case "$channel" in stable|beta) ;; *) die 'LOOM_CHANNEL must be stable or beta.' "Received: $channel" ;; esac
base=${LOOM_RELEASE_BASE:-https://github.com/guen-efanunji/loom/releases/download}
site=${LOOM_SITE_BASE:-https://loomworkspace.bond}
detail "install target  $bin/loom"
detail "data directory  $loom_home"
detail "release channel $channel"

# ---------- 2. installer tools ----------
phase 'Checking the tools this installer needs'
if has curl; then downloader=curl; pass "curl $(curl --version 2>/dev/null | awk 'NR == 1 { print $2 }')"
elif has wget; then downloader=wget; pass "wget $(wget --version 2>/dev/null | awk 'NR == 1 { print $3 }')"
else die 'curl is required.' 'Install curl, or download a binary from GitHub Releases directly.'; fi
for tool in awk grep sed mktemp; do
  has "$tool" || die "$tool is required." 'This installer needs coreutils/busybox to run.'
  pass "$tool found"
done
if has sha256sum; then pass 'sha256sum found'
elif has shasum; then pass 'shasum found'
else die 'sha256sum or shasum is required for verification.' 'Install coreutils so the download can be verified.'; fi
if [ "$show_progress" = 0 ]; then note 'Output is not a terminal: the download progress bar is disabled.'; fi

# ---------- 3. runtime requirements ----------
phase 'Checking what Loom needs after the binary is installed'
if has git; then
  pass "git $(git --version 2>/dev/null | awk 'NR == 1 { print $3 }') — worktrees and task branches are ready"
else
  note 'git not found — Loom needs it to create worktrees and review diffs'
  detail "Install it now or later: https://git-scm.com/downloads"
fi
if has opencode; then
  pass 'opencode found — primary chat and task runtime available'
else
  note 'opencode not found — Loom runs chat and Kanban tasks through OpenCode'
  detail 'Install and connect a model provider later: curl -fsSL https://opencode.ai/install | bash'
fi
log 'Bun, Node.js and npm are not needed: the release bundles the Bun runtime with the UI.'

# ---------- download helper ----------
temp=$(mktemp -d)
candidate=''
cleanup() {
  cleanup_status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$candidate" ]; then rm -f "$candidate"; fi
  rm -rf "$temp"
  exit "$cleanup_status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
fetch() {
  label=$1
  url=$2
  output=$3
  expected_size=${4:-}
  log "$label"
  detail "GET $url"
  if [ "$downloader" = curl ]; then
    # Give a slow connection time to finish a 100 MB binary, but stop when the
    # transfer really stalls instead of when the total run takes long.
    set -- --proto '=https' --tlsv1.2 -fL --connect-timeout 10 --max-time 1800 --speed-limit 8192 --speed-time 60 --retry 2 --retry-delay 3
    if [ "$show_progress" = 1 ] && [ "${expected_size:-0}" -gt 0 ]; then
      curl "$@" --silent --show-error "$url" -o "$output" &
      job=$!
      width=26
      while kill -0 "$job" 2>/dev/null; do
        got=0
        if [ -f "$output" ]; then got=$(wc -c < "$output" | tr -d ' '); fi
        [ -n "$got" ] || got=0
        pct=$((got * 100 / expected_size))
        if [ "$pct" -gt 100 ]; then pct=100; fi
        filled=$((pct * width / 100))
        bar=''
        i=0
        while [ "$i" -lt "$width" ]; do
          if [ "$i" -lt "$filled" ]; then bar="$bar#"; else bar="$bar."; fi
          i=$((i + 1))
        done
        printf '\r  [%s] %3d%%  %s / %s   ' "$bar" "$pct" "$(human "$got")" "$(human "$expected_size")"
        sleep 0.3
      done
      printf '\n'
      if ! wait "$job"; then return 1; fi
    elif [ "$show_progress" = 1 ]; then
      curl "$@" --progress-bar "$url" -o "$output" || return 1
    else
      curl "$@" --silent --show-error "$url" -o "$output" || return 1
    fi
  else
    wget -q --timeout=60 --tries=3 "$url" -O "$output" || return 1
  fi
  if [ ! -s "$output" ]; then
    detail "the server returned no bytes for $(basename "$url")"
    return 1
  fi
  size=$(wc -c < "$output" | tr -d ' ')
  detail "saved $(human "$size") to $output"
}

# ---------- 4. resolve release ----------
phase 'Resolving the latest release on the '"$channel"' channel'
name=loom-$platform
if ! fetch 'Reading the release manifest' "$base/channel-$channel/manifest.json" "$temp/manifest.json"; then
  rm -f "$temp/manifest.json"
  fetch 'Reading the published release version' "$base/channel-$channel/version.txt" "$temp/version" \
    || die 'No published release is available for this channel.' 'Check https://github.com/guen-efanunji/loom/releases — the first release may not be published yet.'
  version=$(tr -d '\r\n' < "$temp/version")
  artifact_url=$base/v$version/$name
  fetch 'Downloading release checksums' "$base/v$version/SHA256SUMS" "$temp/SHA256SUMS" \
    || die 'Cannot download checksums.'
  expected=$(awk -v name="$name" '$2 == name { print $1 }' "$temp/SHA256SUMS")
  total_size=''
else
  meta=$(awk -v key="$platform" 'BEGIN { FS = "\"" }
    $2 == key && index($0, "{") { block = 1; next }
    block && $2 == "url" { url = $4 }
    block && $2 == "sha256" { sha = $4 }
    block && $2 == "size" { digits = $0; gsub(/[^0-9]/, "", digits); size = digits }
    block && index($0, "}") { printf "%s\t%s\t%s", url, sha, size; exit }' "$temp/manifest.json")
  [ -n "$meta" ] || die 'The release manifest has no '"$platform"' artifact.' 'Check https://github.com/guen-efanunji/loom/releases.'
  version=$(awk 'BEGIN { FS = "\"" } $2 == "version" { print $4; exit }' "$temp/manifest.json")
  artifact_url=$(printf '%s' "$meta" | awk -F '\t' '{ print $1 }')
  expected=$(printf '%s' "$meta" | awk -F '\t' '{ print $2 }')
  total_size=$(printf '%s' "$meta" | awk -F '\t' '{ print $3 }')
fi
printf '%s\n' "$version" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$' || die 'Invalid release version.' "Read: $version"
case "$channel:$version" in stable:*-*) die 'Stable channel returned a prerelease.' "Read: $version" ;; esac
printf '%s\n' "$expected" | LC_ALL=C grep -Eq '^[a-f0-9]{64}$' || die 'Missing or invalid checksum.' 'The release manifest does not describe a '"$platform"' artifact.'
case "$artifact_url" in
  "$base"/v"$version"/"$name") ;;
  *) die 'Unexpected artifact URL in the release manifest.' "Read: $artifact_url" ;;
esac
pass "Loom $version for $platform ($(human "${total_size:-0}"))"

# ---------- 5. download binary ----------
phase 'Downloading the Loom binary'
elapsed_start=$(date +%s 2>/dev/null || echo 0)
fetch "Fetching loom $version ($platform) over HTTPS" "$artifact_url" "$temp/loom" "${total_size:-}" \
  || die 'Cannot download this platform artifact.' 'Check your connection, then retry. Nothing was installed.'
elapsed=$(( $(date +%s 2>/dev/null || echo 0) - elapsed_start ))
if [ "$elapsed" -le 0 ]; then elapsed=1; fi
bytes=$(wc -c < "$temp/loom" | tr -d ' ')
speed=$(awk -v b="$bytes" -v t="$elapsed" 'BEGIN { print int(b / t) }')
pass "Downloaded $(human "$bytes") in ${elapsed}s ($(human "$speed")/s)"

# ---------- 6. verify ----------
phase 'Verifying the download'
if has sha256sum; then actual=$(sha256sum "$temp/loom" | awk '{print $1}')
else actual=$(shasum -a 256 "$temp/loom" | awk '{print $1}'); fi
detail "expected sha256 ${expected}"
detail "actual   sha256 ${actual}"
[ "$actual" = "$expected" ] || die 'Checksum mismatch. Nothing was installed.' 'The download did not match the published release.'
size=$(wc -c < "$temp/loom" | tr -d ' ')
pass "SHA-256 verified for $(human "$size")"

# ---------- 7. install ----------
phase 'Installing Loom'
# The same one-liner is the recovery path when `loom update` cannot finish, so an
# existing installation is upgraded in place instead of refusing to run.
had_existing=0
installed=''
if [ -e "$bin/loom" ] || [ -L "$bin/loom" ]; then
  [ -f "$bin/loom" ] && [ ! -L "$bin/loom" ] || die 'The existing Loom target is not a regular file.' "Refusing to replace: $bin/loom"
  had_existing=1
  old_version_log="$temp/old-version.log"
  if [ -x "$bin/loom" ] && "$bin/loom" --version >"$old_version_log" 2>&1; then
    installed=$(LC_ALL=C awk 'match($0, /loom [0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?/) { print substr($0, RSTART + 5, RLENGTH - 5); exit }' "$old_version_log")
    if [ -n "$installed" ]; then
      if [ "$installed" = "$version" ] && [ "${LOOM_REINSTALL:-0}" != 1 ]; then
        die "Loom $version is already installed. Set LOOM_REINSTALL=1 when running the installer to reinstall it." "Existing binary: $bin/loom"
      fi
    else
      note 'Existing executable returned output that did not contain a Loom version.'
    fi
  else
    old_status=$?
    note "Existing executable could not report its version (status $old_status); preparing a verified replacement."
  fi
  if [ -f "$loom_home/daemon.json" ] && [ -n "$installed" ]; then
    daemon_pid=$(awk -F '[^0-9]+' '/"pid"[[:space:]]*:/ { for (i = 1; i <= NF; i++) if ($i ~ /^[0-9]+$/) { print $i; exit } }' "$loom_home/daemon.json")
    case "$daemon_pid" in ''|*[!0-9]*) daemon_pid='' ;; esac
    if [ -n "$daemon_pid" ] && kill -0 "$daemon_pid" 2>/dev/null; then
      daemon_version=$(awk -F '"' '/"version"[[:space:]]*:/ { print $4; exit }' "$loom_home/daemon.json")
      if [ "$daemon_version" = "$installed" ]; then
        daemon_command=$(ps -p "$daemon_pid" -o command= 2>/dev/null || true)
        case "$daemon_command" in
          *"$bin/loom"*)
            die 'A Loom daemon appears to be running; refusing to replace its executable.' 'Stop Loom with `loom stop`, then rerun the installer.'
            ;;
          *)
            die 'A recorded Loom daemon may be running; refusing to replace the executable without confirming process identity.' 'Run `loom stop` if Loom is open, then retry the installer.'
            ;;
        esac
      fi
    fi
  fi
  if [ -n "$installed" ]; then
    log "Found Loom $installed in place; updating it to $version"
  elif [ -f "$bin/loom" ]; then
    log "Found an existing Loom executable; preparing verified version $version"
  else
    log "No existing Loom executable; preparing version $version"
  fi
fi
umask 077
mkdir -p "$bin"
candidate="$bin/loom.candidate.$$"
[ ! -e "$candidate" ] && [ ! -L "$candidate" ] || die 'The candidate path already exists; refusing to overwrite it.'
if ! cp "$temp/loom" "$candidate"; then rm -f "$candidate"; die 'Could not stage the verified Loom executable.' 'The existing installation was not replaced.'; fi
if ! chmod 700 "$candidate"; then rm -f "$candidate"; die 'Could not set executable permissions on the staged Loom binary.' 'The existing installation was not replaced.'; fi
log 'Running a startup check on the downloaded executable'
startup_log="$temp/startup.log"
if "$candidate" --version >"$startup_log" 2>&1; then
  startup_status=0
else
  startup_status=$?
fi
startup_output_bytes=$(wc -c < "$startup_log" 2>/dev/null | tr -d ' ' || true)
case "$startup_output_bytes" in ''|*[!0-9]*) startup_output_bytes=0 ;; esac
if [ "$startup_output_bytes" -gt 4096 ]; then
  if has dd; then captured="$(dd if="$startup_log" bs=1 count=4096 2>/dev/null) [output truncated after 4096 bytes]"
  else captured='[output exceeded 4096 bytes and was truncated]'; fi
else captured=$(cat "$startup_log" 2>/dev/null || true); fi
reported_version=$(printf '%s\n' "$captured" | LC_ALL=C awk 'match($0, /loom [0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?/) { print substr($0, RSTART + 5, RLENGTH - 5); exit }')
if [ "$startup_status" -ne 0 ] || [ -z "$reported_version" ] || [ "$reported_version" != "$version" ]; then
  detail "artifact $platform, version $version"
  detail "startup exit code: $startup_status"
  detail "startup output: ${captured:-empty}"
  detail "expected sha256 $expected"
  detail "actual sha256 $actual"
  detail "downloaded bytes $size"
  if [ "$os" = darwin ]; then
    detail "uname: $(uname -s 2>/dev/null || printf unavailable) $(uname -m 2>/dev/null || printf unavailable) $(uname -r 2>/dev/null || printf unavailable)"
    if has sw_vers; then
      macos_version=$(sw_vers -productVersion 2>/dev/null || true)
      detail "macOS product version: ${macos_version:-unavailable}"
    else detail 'macOS product version: sw_vers unavailable'; fi
    detail "candidate: $candidate"
    detail "candidate sha256 $actual; expected sha256 $expected; downloaded bytes $size"
    if has file; then
      file_output=$(file "$candidate" 2>&1 | head -c 1000 || true)
      detail "file: ${file_output:-unavailable}"
    else detail 'file: unavailable'; fi
    if has codesign; then
      if signature_output=$(codesign --verify --strict --verbose=4 "$candidate" 2>&1); then
        detail "codesign verification: ${signature_output:-passed with no diagnostic output}"
      else
        signature_status=$?
        detail "codesign verification: failed (status $signature_status): ${signature_output:-no diagnostic output}"
      fi
    else detail 'codesign verification: unavailable'; fi
    if has xattr; then
      xattr_names=$(xattr "$candidate" 2>/dev/null | head -c 1000 || true)
      detail "extended attribute names: ${xattr_names:-none or unavailable}"
    else detail 'extended attribute names: xattr unavailable'; fi
  fi
  rm -f "$candidate"
  candidate=''
  if [ "$startup_status" -ne 0 ]; then
    die 'Download integrity was verified, but Loom failed its startup check; the candidate was not activated.' 'The existing installation was not replaced.'
  fi
  if [ -z "$reported_version" ]; then
    die 'The candidate exited successfully but did not report a recognizable Loom version; it was not activated.' 'The existing installation was not replaced.'
  fi
  die "The candidate reported Loom $reported_version instead of expected $version; it was not activated." 'The existing installation was not replaced.'
fi
pass "Executable answers: $captured"
if [ "$had_existing" -eq 1 ]; then
  if [ -e "$bin/loom.previous" ] || [ -L "$bin/loom.previous" ]; then
    backup="$bin/loom.previous.$(date +%s).$$"
  else backup="$bin/loom.previous"; fi
  [ ! -e "$backup" ] && [ ! -L "$backup" ] || { rm -f "$candidate"; die 'The rollback path already exists; refusing to overwrite it.'; }
  if ! cp "$bin/loom" "$backup"; then rm -f "$candidate"; candidate=''; die 'Could not preserve the previous executable; refusing to replace it.'; fi
  if ! chmod 700 "$backup"; then rm -f "$backup" "$candidate"; candidate=''; die 'Could not secure the previous executable backup; refusing to replace it.'; fi
  pass "Kept the previous build at $backup for rollback"
  if ! mv "$candidate" "$bin/loom"; then rm -f "$candidate"; candidate=''; die 'Could not activate the candidate; the previous executable remains in place.'; fi
  candidate=''
  if [ -n "$installed" ]; then
    pass "Updated $bin/loom from $installed to $version (mode 700, no administrator access used)"
  else
    pass "Repaired $bin/loom with verified version $version (mode 700, no administrator access used)"
  fi
else
  if ! mv "$candidate" "$bin/loom"; then rm -f "$candidate"; candidate=''; die 'Could not activate the candidate.'; fi
  candidate=''
  pass "Installed to $bin/loom (mode 700, no administrator access used)"
fi

# ---------- 8. PATH ----------
phase 'Adding Loom to your user PATH'
escaped=$(printf '%s' "$bin" | sed "s/'/'\\\\''/g")
line="export PATH='$escaped':\$PATH"
case "${SHELL:-}" in
  */zsh) profile="$HOME/.zshrc"; ;;
  */fish) profile="$HOME/.config/fish/conf.d/loom.fish"; mkdir -p "$(dirname "$profile")"; line="fish_add_path '$escaped'" ;;
  *) profile="$HOME/.profile"
     if [ -f "$HOME/.bashrc" ]; then profile="$HOME/.bashrc"; fi ;;
esac
if grep -Fqx "$line" "$profile" 2>/dev/null; then
  pass "$profile already puts Loom on your PATH"
else
  printf '\n# Loom\n%s\n' "$line" >> "$profile"
  pass "Wrote PATH entry to $profile"
  detail "$line"
fi

finished=$(date +%s 2>/dev/null || echo 0)
elapsed_total=$((finished - started))
if [ -n "$installed" ]; then
  headline="Loom updated from $installed to $version in ${elapsed_total}s."
elif [ "$had_existing" -eq 1 ]; then
  headline="Loom repaired to $version in ${elapsed_total}s."
else
  headline="Loom $version installed successfully in ${elapsed_total}s."
fi
printf '\n%s\n' "$(paint '1;32' "$headline")"
detail 'next  restart your terminal, then run: loom'
detail '      the workspace opens at http://127.0.0.1:4317 on this device'
detail 'check loom doctor  ·  logs loom logs'
if ! has git; then note 'Before your first task: install Git.'; fi
if ! has opencode; then note 'Before your first task: install OpenCode and connect a model provider.'; fi
printf '\n  Docs: %s/docs/installation/\n' "$site"
