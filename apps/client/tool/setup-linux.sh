#!/usr/bin/env bash
set -euo pipefail

# Install the Linux packages needed by Flutter tests and Linux/Android builds.
# Run on an Ubuntu/Debian development machine, not in production.
if ! command -v apt-get >/dev/null 2>&1; then
  echo "This setup script currently supports Debian/Ubuntu via apt-get." >&2
  exit 1
fi

SUDO=""
if [[ "${EUID}" -ne 0 ]]; then
  SUDO="sudo"
fi

${SUDO} apt-get update
${SUDO} apt-get install -y \
  clang cmake ninja-build pkg-config libgtk-3-dev liblzma-dev \
  libstdc++-12-dev unzip curl git openjdk-17-jdk

if ! command -v flutter >/dev/null 2>&1; then
  FLUTTER_DIR="${FLUTTER_DIR:-${HOME}/.cache/strict-proxy/flutter}"
  FLUTTER_REF="${FLUTTER_REF:-stable}"
  mkdir -p "$(dirname "$FLUTTER_DIR")"
  if [[ ! -d "$FLUTTER_DIR/.git" ]]; then
    git clone --depth 1 --branch "$FLUTTER_REF" https://github.com/flutter/flutter.git "$FLUTTER_DIR"
  fi
  export PATH="$FLUTTER_DIR/bin:$PATH"
fi

if ! command -v flutter >/dev/null 2>&1; then
  echo "Flutter installation failed or is not on PATH." >&2
  exit 1
fi

# Bootstrap Google's official Android command-line tools when Android Studio or
# sdkmanager is not already installed. Override the version for an audited
# enterprise mirror/release if required.
ANDROID_SDK_DIR="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-${HOME}/.cache/strict-proxy/android-sdk}}"
ANDROID_CMDLINE_TOOLS_VERSION="${ANDROID_CMDLINE_TOOLS_VERSION:-13114758}"
ANDROID_CMDLINE_TOOLS_DIR="${ANDROID_SDK_DIR}/cmdline-tools/latest"

if [[ ! -x "${ANDROID_CMDLINE_TOOLS_DIR}/bin/sdkmanager" ]]; then
  mkdir -p "${ANDROID_SDK_DIR}/cmdline-tools"
  archive="$(mktemp)"
  trap 'rm -f "$archive"' EXIT
  curl --fail --silent --show-error --location \
    "https://dl.google.com/android/repository/commandlinetools-linux-${ANDROID_CMDLINE_TOOLS_VERSION}_latest.zip" \
    --output "$archive"
  rm -rf "${ANDROID_CMDLINE_TOOLS_DIR}" "${ANDROID_SDK_DIR}/cmdline-tools/cmdline-tools"
  unzip -q "$archive" -d "${ANDROID_SDK_DIR}/cmdline-tools"
  mv "${ANDROID_SDK_DIR}/cmdline-tools/cmdline-tools" "$ANDROID_CMDLINE_TOOLS_DIR"
fi

export ANDROID_SDK_ROOT="$ANDROID_SDK_DIR"
export ANDROID_HOME="$ANDROID_SDK_DIR"
export PATH="${ANDROID_CMDLINE_TOOLS_DIR}/bin:${ANDROID_SDK_DIR}/platform-tools:${PATH}"

yes | sdkmanager --licenses >/dev/null || true
sdkmanager \
  "platform-tools" \
  "platforms;android-35" \
  "build-tools;35.0.0" \
  "ndk;28.2.13676358"

flutter config --enable-linux-desktop
flutter config --android-sdk "$ANDROID_SDK_DIR"
flutter precache --linux --android

CLIENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

(
  cd "$CLIENT_DIR"
  flutter create --platforms=linux,android .
  flutter pub get
  flutter test
  flutter analyze
)

echo "Linux/Android Flutter development environment is ready."
echo "Android SDK: $ANDROID_SDK_DIR"
