#!/usr/bin/env bash
set -euo pipefail

# Build the exact gomobile artifacts consumed by the local Flutter plugin.
# No binary is downloaded or committed: a reviewed sing-box-libbox commit (pinned
# in apps/client/libbox.ref, or supplied through SING_BOX_LIBBOX_REF) plus the
# local Go/Android/Xcode toolchains do the build.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK_DIR="${SING_BOX_LIBBOX_WORK_DIR:-${ROOT_DIR}/.cache/sing-box-libbox}"
PINNED_REF_FILE="${ROOT_DIR}/libbox.ref"
ANDROID_OUT="${ROOT_DIR}/packages/libbox_bridge/android/libs"
IOS_OUT="${ROOT_DIR}/packages/libbox_bridge/ios/Frameworks"

fail() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

# Linux hosts and Android-only release jobs cannot build the Apple framework
# (it needs Xcode). `--android-only` is what CI uses for APK artifacts.
TARGET=all
case "${1:-}" in
  ""|"--all") TARGET=all ;;
  "--android-only") TARGET=android ;;
  *) echo "usage: $0 [--all|--android-only]" >&2; exit 2 ;;
esac

# The repository pins a reviewed commit so a plain build, CI, and a release all
# use the same native engine without anyone passing a SHA by hand.
if [[ -z "${SING_BOX_LIBBOX_REF:-}" && -f "$PINNED_REF_FILE" ]]; then
  SING_BOX_LIBBOX_REF="$(tr -d '[:space:]' < "$PINNED_REF_FILE")"
fi
REF="${SING_BOX_LIBBOX_REF:-}"
[[ -n "$REF" ]] || fail "no sing-box-libbox ref: set SING_BOX_LIBBOX_REF, or pin one in apps/client/libbox.ref"
# Refuse a moving branch: the APK must be reproducible from the recorded commit.
[[ "$REF" =~ ^[0-9a-fA-F]{40}$ ]] || fail "SING_BOX_LIBBOX_REF must be a full 40-character commit SHA; got: $REF"

command -v go >/dev/null || fail 'Go is required (https://go.dev/dl/)'

# sing-box's build tool resolves gobind/gomobile from $GOPATH/bin by absolute
# path, so that is where the matching versions must live.
GOPATH_BIN="$(go env GOPATH)/bin"
export PATH="${GOPATH_BIN}:${PATH}"

# gomobile and the sing-box build tool both need an NDK. CI images export one;
# desktop machines usually only have it installed inside the SDK, so resolve the
# newest installed NDK instead of failing later with a cgo error.
if [[ -z "${ANDROID_NDK_HOME:-}" ]]; then
  SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
  [[ -n "$SDK" ]] || fail 'set ANDROID_NDK_HOME, or ANDROID_SDK_ROOT/ANDROID_HOME so the NDK can be found'
  NDK="$(find "$SDK/ndk" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -1 || true)"
  [[ -n "$NDK" ]] || fail "no Android NDK under $SDK/ndk — install one with: sdkmanager 'ndk;28.2.13676358'"
  export ANDROID_NDK_HOME="$NDK"
fi
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$(dirname "$(dirname "$ANDROID_NDK_HOME")")}}"
export ANDROID_SDK_ROOT="${ANDROID_SDK_ROOT:-$ANDROID_HOME}"
echo "Using NDK: $ANDROID_NDK_HOME"

mkdir -p "$(dirname "$WORK_DIR")"
if [[ ! -d "$WORK_DIR/.git" ]]; then
  git clone https://github.com/getlantern/sing-box-libbox.git "$WORK_DIR"
fi

git -C "$WORK_DIR" fetch --tags --force origin
git -C "$WORK_DIR" checkout --detach "$REF"
# sing-box drives a patched gomobile: upstream golang.org/x/mobile rejects its
# -libname flag, so install the exact fork version its go.mod pins.
MOBILE_VERSION="$(awk '/github.com\/sagernet\/gomobile[[:space:]]/{print $2; exit}' "${WORK_DIR}/go.mod")"
[[ -n "$MOBILE_VERSION" ]] || fail "could not read the sagernet/gomobile version from ${WORK_DIR}/go.mod"
# `gomobile bind` resolves gobind from PATH, and `gomobile init` would install
# gobind@latest (unpinned, and newer releases need a newer Go) — so install the
# version matching the pinned engine directly and do not run init.
echo "Installing github.com/sagernet/gomobile ${MOBILE_VERSION} into ${GOPATH_BIN}"
for tool in gomobile gobind; do
  GOBIN="$GOPATH_BIN" go install "github.com/sagernet/gomobile/cmd/${tool}@${MOBILE_VERSION}" \
    || fail "could not build gomobile ${MOBILE_VERSION}; sing-box-libbox ${REF} pins golang.org/x/tools v0.16.0, which needs Go 1.22 or 1.23 (this is $(go version))"
done

pushd "$WORK_DIR" >/dev/null
go run ./cmd/internal/build_libbox -target android -platform android/arm64,android/arm,android/386,android/amd64
mkdir -p "$ANDROID_OUT"
cp -f libbox.aar "$ANDROID_OUT/libbox.aar"
"${ROOT_DIR}/tool/unpack-libbox-aar.sh"
echo "Android: $ANDROID_OUT/libbox.aar (commit $REF)"

if [[ "$TARGET" == "all" ]]; then
  go run ./cmd/internal/build_libbox -target apple -platform ios
  mkdir -p "$IOS_OUT"
  rm -rf "$IOS_OUT/Libbox.xcframework"
  mv Libbox.xcframework "$IOS_OUT/Libbox.xcframework"
  echo "Apple:   $IOS_OUT/Libbox.xcframework"
fi
popd >/dev/null

echo "Built libbox artifacts for commit $REF"
