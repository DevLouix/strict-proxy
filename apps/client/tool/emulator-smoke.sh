#!/usr/bin/env bash
# End-to-end smoke for the x86_64 emulator APK.
#
# Installs the APK on a running emulator, launches the app and — when
# CLIENT_E2E_EMAIL / CLIENT_E2E_PASSWORD are set — drives the real sign-in and
# Connect flow, then captures logcat. The point is not to decide whether the
# tunnel works (an emulator is a poor judge of that: sing-box needs a network
# stack the emulator only approximates). It is to catch the failures that are
# real everywhere and used to be invisible until a user installed the app:
# an APK whose native engine is the wrong ABI, a native crash on start, and an
# engine failure that reached the UI with no reason attached.
#
# Exit status is reserved for those hard failures. A tunnel that does not come
# up is reported with its reason and does not fail the job, because an emulator
# refusing to run the datapath is not a regression in the shipped app.
set -euo pipefail

APK="${1:?usage: emulator-smoke.sh <path-to-apk>}"
OUT="${OUT_DIR:-build/emulator-smoke}"
PKG="com.strictproxy.client"

mkdir -p "$OUT"
adb wait-for-device
# Animations change nothing about the flow and only slow the taps down.
for scale in window_animation_scale transition_animation_scale animator_duration_scale; do
  adb shell settings put global "$scale" 0 >/dev/null 2>&1 || true
done

echo "== installing $APK"
adb install -r "$APK" | tee "$OUT/install.txt"

echo "== clearing the log and launching"
adb logcat -c || true
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1

ui_xml() {
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || return 1
  adb exec-out cat /sdcard/ui.xml > "$OUT/ui.xml" 2>/dev/null || return 1
  cat "$OUT/ui.xml"
}

# tap_text prints the screen and taps the centre of the first node whose text,
# content-desc or label contains the argument. Exits 1 when it is not there.
tap_text() {
  local needle="$1"
  local xml
  xml="$(ui_xml)" || return 1
  local coords
  coords="$(XML="$xml" NEEDLE="$needle" python3 - <<'PY'
import os, re, xml.etree.ElementTree as ET
needle = os.environ["NEEDLE"]
try:
    root = ET.fromstring(os.environ["XML"])
except ET.ParseError:
    raise SystemExit(1)
for node in root.iter("node"):
    labels = (node.get("text") or "", node.get("content-desc") or "")
    if not any(needle in label for label in labels):
        continue
    m = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds") or "")
    if not m:
        continue
    x1, y1, x2, y2 = map(int, m.groups())
    print((x1 + x2) // 2, (y1 + y2) // 2)
    raise SystemExit(0)
raise SystemExit(1)
PY
)" || return 1
  # shellcheck disable=SC2086
  adb shell input tap $coords
}

wait_for() {
  local needle="$1" seconds="$2" i xml
  for ((i = 0; i < seconds; i++)); do
    # Captured first: `ui_xml | grep -q` ends the pipeline on the first match,
    # which kills the reader and makes pipefail report a failure that is not one.
    xml="$(ui_xml)" || { sleep 1; continue; }
    if grep -q "$needle" <<<"$xml"; then return 0; fi
    sleep 1
  done
  return 1
}

if wait_for "Sign in" 60 || wait_for "Connect" 10; then
  echo "== app is up"
else
  echo "error: the app never reached a usable screen" >&2
  ui_xml >/dev/null 2>&1 || true
  exit 1
fi

if [[ -n "${CLIENT_E2E_EMAIL:-}" && -n "${CLIENT_E2E_PASSWORD:-}" ]]; then
  echo "== signing in as $CLIENT_E2E_EMAIL"
  # The first EditText is the email field, the next one the password; the form
  # is the only screen with two of them before sign-in.
  XML="$(ui_xml)" python3 - <<'PY' > "$OUT/fields.txt"
import os, re, xml.etree.ElementTree as ET
root = ET.fromstring(os.environ["XML"])
for node in root.iter("node"):
    if node.get("class") == "android.widget.EditText":
        m = re.fullmatch(r"\[(\d+),(\d+)\]\[(\d+),(\d+)\]", node.get("bounds") or "")
        if m:
            x1, y1, x2, y2 = map(int, m.groups())
            print((x1 + x2) // 2, (y1 + y2) // 2)
PY
  email_xy="$(sed -n 1p "$OUT/fields.txt")"
  password_xy="$(sed -n 2p "$OUT/fields.txt")"
  if [[ -z "$email_xy" || -z "$password_xy" ]]; then
    echo "error: the sign-in form did not expose two text fields" >&2
    exit 1
  fi
  # shellcheck disable=SC2086
  adb shell input tap $email_xy
  adb shell input text "$CLIENT_E2E_EMAIL"
  # shellcheck disable=SC2086
  adb shell input tap $password_xy
  adb shell input text "$CLIENT_E2E_PASSWORD"
  adb shell input keyevent 4 # hide the keyboard
  tap_text "Sign in" || { echo "error: the sign-in button is missing" >&2; exit 1; }
  if wait_for "Connect" 90; then
    echo "== signed in"
  else
    echo "error: sign-in did not reach the home screen" >&2
    exit 1
  fi
else
  echo "== CLIENT_E2E_EMAIL/CLIENT_E2E_PASSWORD are not set; capturing launch only"
fi

if tap_text "Connect"; then
  # The VPN consent dialog belongs to the system, not the app.
  for _ in 1 2 3 4 5 6; do
    sleep 3
    tap_text "OK" >/dev/null 2>&1 || tap_text "Allow" >/dev/null 2>&1 || true
  done
  sleep 20
  wait_for "Connected" 20 || wait_for "The VPN engine" 20 || true
fi

adb logcat -d -v time > "$OUT/logcat.txt" || true
ui_xml >/dev/null 2>&1 || true

echo "== engine log lines"
grep -E "StrictProxyLibbox|libbox\.so|libbox failed|Fatal signal|SIGILL" "$OUT/logcat.txt" || echo "(none)"

status=0
if ! grep -q "libbox\.so" "$OUT/logcat.txt"; then
  # A build without the engine also reports "not available" in the app; either
  # way the artifact is unusable on this device.
  echo "error: the APK never loaded libbox.so" >&2
  status=1
fi
if grep -qE "Fatal signal|SIGILL|FATAL EXCEPTION" "$OUT/logcat.txt"; then
  echo "error: the app crashed on the emulator" >&2
  status=1
fi
if grep -q "libbox native artifact is unavailable" "$OUT/logcat.txt"; then
  echo "error: the APK was built without a usable native engine" >&2
  status=1
fi

echo "== device log captured in $OUT/logcat.txt"
exit "$status"
