#!/usr/bin/env bash
#
# Expand libbox.aar into the form the Gradle plugin can consume.
#
# The plugin is an Android *library* module, and AGP refuses to package a direct
# local .aar dependency inside a library module (`bundleDebugAar` fails with
# "Direct local .aar file dependencies are not supported when building an AAR").
# Unpacking it into a plain classes.jar plus jni/<abi>/libbox.so is packaged
# correctly, so build-libbox.sh, the release build, and CI all run this.
#
# No-op when the AAR is absent, which keeps compile-only builds working.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LIBS="${ROOT_DIR}/packages/libbox_bridge/android/libs"
AAR="${LIBS}/libbox.aar"

[[ -f "$AAR" ]] || exit 0

STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

unzip -q -o "$AAR" classes.jar 'jni/*' -d "$STAGE"

cp -f "${STAGE}/classes.jar" "${LIBS}/libbox-classes.jar"
for abi_dir in "${STAGE}"/jni/*/; do
  [[ -d "$abi_dir" ]] || continue
  abi="$(basename "$abi_dir")"
  mkdir -p "${LIBS}/${abi}"
  cp -f "${abi_dir}"*.so "${LIBS}/${abi}/"
done

echo "Unpacked libbox for the Gradle plugin: libbox-classes.jar + jni/<abi>/libbox.so"
