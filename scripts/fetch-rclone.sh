#!/usr/bin/env bash
# 按当前平台/架构下载 rclone 二进制到 src-tauri/binaries/，命名为 Tauri sidecar 约定
# 的 target-triple 后缀形式（tauri.conf.json externalBin = "binaries/rclone" →
# 实际文件名须为 rclone-<target-triple>[.exe]）。
#
# 文档决策③：二进制不进 git，CI 打包前跑本脚本。对齐现有 scripts/ 的 fetch-* 约定。
set -euo pipefail

RCLONE_VERSION="${RCLONE_VERSION:-current}"
BIN_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../apps/desktop/src-tauri/binaries" && pwd)"

uname_s="$(uname -s)"
uname_m="$(uname -m)"

case "$uname_s" in
  Darwin) os="osx" ;;
  Linux)  os="linux" ;;
  MINGW*|MSYS*|CYGWIN*) os="windows" ;;
  *) echo "unsupported OS: $uname_s" >&2; exit 1 ;;
esac

case "$uname_m" in
  x86_64|amd64) arch="amd64"; triple_arch="x86_64" ;;
  arm64|aarch64) arch="arm64"; triple_arch="aarch64" ;;
  *) echo "unsupported arch: $uname_m" >&2; exit 1 ;;
esac

case "$os" in
  osx)     triple="${triple_arch}-apple-darwin"; ext="" ;;
  linux)   triple="${triple_arch}-unknown-linux-gnu"; ext="" ;;
  windows) triple="${triple_arch}-pc-windows-msvc"; ext=".exe" ;;
esac

zip_name="rclone-${RCLONE_VERSION}-${os}-${arch}.zip"
url="https://downloads.rclone.org/${RCLONE_VERSION}/${zip_name}"
[ "$RCLONE_VERSION" = "current" ] && url="https://downloads.rclone.org/rclone-current-${os}-${arch}.zip"

mkdir -p "$BIN_DIR"
tmp="$(mktemp -d)"
echo "downloading $url"
curl -fsSL "$url" -o "$tmp/rclone.zip"
unzip -q -o "$tmp/rclone.zip" -d "$tmp"
found="$(find "$tmp" -name "rclone${ext}" -type f | head -1)"
dest="$BIN_DIR/rclone-${triple}${ext}"
cp "$found" "$dest"
chmod +x "$dest"
rm -rf "$tmp"
echo "installed sidecar: $dest"
