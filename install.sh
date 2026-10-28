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
trap 'rm -rf "$temp"' EXIT HUP INT TERM
fetch() {
  label=$1
  url=$2
  output=$3
  expected_size=${4:-}
  log "$label"
  detail "GET $url"
  if [ "$downloader" = curl ]; then
    set -- --proto '=https' --tlsv1.2 -fL --connect-timeout 10 --max-time 180 --retry 2
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
    wget -q --timeout=180 --tries=2 "$url" -O "$output" || return 1
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
[ ! -e "$bin/loom" ] || die 'Loom is already installed. Run loom update to update safely.' "Existing binary: $bin/loom"
umask 077
mkdir -p "$bin"
cp "$temp/loom" "$bin/loom.next"
chmod 700 "$bin/loom.next"
log 'Running a startup check on the downloaded executable'
captured=$("$bin/loom.next" --version 2>/dev/null) || die 'This binary cannot run on your system.' 'Linux releases require glibc; Alpine/musl is not published.'
pass "Executable answers: $captured"
mv "$bin/loom.next" "$bin/loom"
pass "Installed to $bin/loom (mode 700, no administrator access used)"

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
printf '\n%s\n' "$(paint '1;32' 'Loom '"$version"' installed successfully in '"$((finished - started))"'s.')"
detail 'next  restart your terminal, then run: loom'
detail '      the workspace opens at http://127.0.0.1:4317 on this device'
detail 'check loom doctor  ·  logs loom logs'
if ! has git; then note 'Before your first task: install Git.'; fi
if ! has opencode; then note 'Before your first task: install OpenCode and connect a model provider.'; fi
printf '\n  Docs: %s/docs/installation/\n' "$site"
