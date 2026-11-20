#!/usr/bin/env bash
# rclone для Android (arm64) из исходников через NDK. Официальных сборок под Android нет,
# а обычная linux-arm64 на Android не находит DNS — поэтому GOOS=android и cgo с clang из NDK.
# Результат кладётся как librclone.so: запускать исполняемые файлы Android разрешает только из nativeLibraryDir.
# Нужны: Go, NDK_HOME. Использование: scripts/build-rclone-android.sh <куда положить .so>
set -euo pipefail
VERSION=$(node -e 'import("./scripts/fetch-rclone.mjs").then(m => console.log(m.RCLONE_VERSION))')
OUT=${1:-src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a/librclone.so}
API=24
CC="$NDK_HOME/toolchains/llvm/prebuilt/linux-x86_64/bin/aarch64-linux-android${API}-clang"
[ -x "$CC" ] || { echo "нет $CC — проверьте NDK_HOME"; exit 1; }
W=$(mktemp -d)
git clone --quiet --depth 1 --branch "$VERSION" https://github.com/rclone/rclone.git "$W/rclone"
cd "$W/rclone"
CGO_ENABLED=1 GOOS=android GOARCH=arm64 CC="$CC" \
  go build -trimpath -tags noselfupdate -ldflags "-s -w -X github.com/rclone/rclone/fs.Version=$VERSION" -o "$W/librclone.so" .
cd - >/dev/null
mkdir -p "$(dirname "$OUT")"
cp "$W/librclone.so" "$OUT"
echo "rclone $VERSION для Android arm64 → $OUT ($(du -h "$OUT" | cut -f1))"
