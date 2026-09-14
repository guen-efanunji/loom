#!/bin/sh
set -eu

fail() { printf 'Loom: %s\n' "$*" >&2; exit 1; }
command -v curl >/dev/null 2>&1 || fail 'curl is required.'
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) fail 'Use install.ps1 in Windows PowerShell.' ;; esac
case "$(uname -m)" in x86_64|amd64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) fail 'Supported architectures: x64 and arm64.' ;; esac
channel=${LOOM_CHANNEL:-stable}
case "$channel" in stable|beta) ;; *) fail 'LOOM_CHANNEL must be stable or beta.' ;; esac
base=https://github.com/MrPinguiiin/loom/releases/download
download() { curl --proto '=https' --tlsv1.2 -fsSL --connect-timeout 10 --max-time 180 --retry 2 "$1" -o "$2"; }
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT HUP INT TERM
download "$base/channel-$channel/version.txt" "$temp/version" || fail 'No published release is available for this channel. Check GitHub Releases.'
version=$(tr -d '\r\n' < "$temp/version")
printf '%s\n' "$version" | LC_ALL=C grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$' || fail 'Invalid release version.'
case "$channel:$version" in stable:*-*) fail 'Stable channel returned a prerelease.' ;; esac
name=loom-$os-$arch
download "$base/v$version/SHA256SUMS" "$temp/SHA256SUMS" || fail 'Cannot download checksums.'
download "$base/v$version/$name" "$temp/loom" || fail 'Cannot download this platform artifact.'
expected=$(awk -v name="$name" '$2 == name { print $1 }' "$temp/SHA256SUMS")
printf '%s\n' "$expected" | LC_ALL=C grep -Eq '^[a-f0-9]{64}$' || fail 'Missing or invalid checksum.'
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$temp/loom" | awk '{print $1}')
elif command -v shasum >/dev/null 2>&1; then actual=$(shasum -a 256 "$temp/loom" | awk '{print $1}')
else fail 'sha256sum or shasum is required for verification.'; fi
[ "$actual" = "$expected" ] || fail 'Checksum mismatch. Nothing was installed.'
loom_home=${LOOM_HOME:-"$HOME/.loom"}
case "$loom_home" in /*) ;; *) fail 'LOOM_HOME must be an absolute path.' ;; esac
bin=$loom_home/bin
[ ! -e "$bin/loom" ] || fail 'Loom is already installed. Run loom update to update safely.'
umask 077
mkdir -p "$bin"
cp "$temp/loom" "$bin/loom.next"
chmod 700 "$bin/loom.next"
"$bin/loom.next" --version || fail 'This binary cannot run on your OS. Linux requires glibc; see installation docs.'
mv "$bin/loom.next" "$bin/loom"
escaped=$(printf '%s' "$bin" | sed "s/'/'\\\\''/g")
line="export PATH='$escaped':\$PATH"
case "${SHELL:-}" in
  */zsh) profile="$HOME/.zshrc" ;;
  */fish) profile="$HOME/.config/fish/conf.d/loom.fish"; mkdir -p "$(dirname "$profile")"; line="fish_add_path '$escaped'" ;;
  *) profile="$HOME/.profile"; if [ -f "$HOME/.bashrc" ]; then profile="$HOME/.bashrc"; fi ;;
esac
if ! grep -Fqx "$line" "$profile" 2>/dev/null; then printf '\n# Loom\n%s\n' "$line" >> "$profile"; fi
printf '\nLoom %s installed.\nRestart your terminal, then run: loom\nOr run now: "%s/loom"\nGit and OpenCode must be installed and a model provider configured.\n' "$version" "$bin"
