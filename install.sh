#!/usr/bin/env bash
set -euo pipefail
install_dir="${IMAGEGEN_INSTALL_DIR:-$HOME/.local/bin}"
if [[ "${1:-}" == --local ]]; then
  [[ -f "${2:-}" ]] || { echo 'Usage: install.sh --local dist/imagegen' >&2; exit 2; }
  install -Dm755 "$2" "$install_dir/imagegen"
  echo "Installed $install_dir/imagegen"
  exit
fi
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'Prebuilt releases support Linux x86-64.' >&2; exit 1; }
task_tmp="$(mktemp -d)"
trap 'rm -rf "$task_tmp"' EXIT
base="https://github.com/DovieW/imagegen-cli/releases"
if [[ -n "${IMAGEGEN_VERSION:-}" ]]; then base="$base/download/$IMAGEGEN_VERSION"; else base="$base/latest/download"; fi
curl --fail --location --silent --show-error "$base/imagegen-linux-x64" -o "$task_tmp/imagegen-linux-x64"
curl --fail --location --silent --show-error "$base/SHA256SUMS" -o "$task_tmp/SHA256SUMS"
(cd "$task_tmp" && sha256sum --check --ignore-missing SHA256SUMS)
install -Dm755 "$task_tmp/imagegen-linux-x64" "$install_dir/imagegen"
echo "Installed $install_dir/imagegen"
