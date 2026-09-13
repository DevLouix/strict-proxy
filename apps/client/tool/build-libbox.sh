#!/usr/bin/env bash
set -euo pipefail

# Build the exact gomobile artifacts consumed by the local Flutter plugin.
# No binary is downloaded or committed: the caller supplies a reviewed
# sing-box-libbox ref and the local Go/Android/Xcode toolchains do the build.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${ROOT_DIR}/.cache/sing-box-libbox"
REF="${SING_BOX_LIBBOX_REF:?Set SING_BOX_LIBBOX_REF to a reviewed sing-box-libbox tag or commit}"
ANDROID_OUT="${ROOT_DIR}/packages/libbox_bridge/android/libs"
IOS_OUT="${ROOT_DIR}/packages/libbox_bridge/ios/Frameworks"

command -v go >/dev/null || { echo 'Go is required' >&2; exit 1; }
command -v gomobile >/dev/null || { echo 'gomobile is required: go install golang.org/x/mobile/cmd/gomobile@latest' >&2; exit 1; }

mkdir -p "$(dirname "$WORK_DIR")"
if [[ ! -d "$WORK_DIR/.git" ]]; then
  git clone https://github.com/getlantern/sing-box-libbox.git "$WORK_DIR"
fi

git -C "$WORK_DIR" fetch --tags --force origin
# Refuse a moving branch unless the caller explicitly supplied its immutable
# commit hash; reproducible production builds should use a full SHA.
if [[ ! "$REF" =~ ^[0-9a-fA-F]{40}$ ]]; then
  echo "SING_BOX_LIBBOX_REF must be a full 40-character commit SHA; got: $REF" >&2
  exit 1
fi
git -C "$WORK_DIR" checkout --detach "$REF"

git -C "$WORK_DIR" submodule update --init --recursive
pushd "$WORK_DIR" >/dev/null

go run ./cmd/internal/build_libbox -target android -platform android/arm64,android/arm,android/386,android/amd64
mkdir -p "$ANDROID_OUT"
cp -f libbox.aar "$ANDROID_OUT/libbox.aar"

go run ./cmd/internal/build_libbox -target apple -platform ios
mkdir -p "$IOS_OUT"
rm -rf "$IOS_OUT/Libbox.xcframework"
mv Libbox.xcframework "$IOS_OUT/Libbox.xcframework"
popd >/dev/null

echo "Built libbox artifacts for commit $REF"
echo "Android: $ANDROID_OUT/libbox.aar"
echo "Apple:   $IOS_OUT/Libbox.xcframework"
