# Native libbox and Linux integration

The Flutter client has platform-specific VPN engines:

- **Linux desktop:** `LinuxSingBoxEngine` runs the installed `sing-box` CLI with a
  private temporary configuration file.
- **Android:** the native plugin runs generated sing-box libbox inside a foreground
  `VpnService`.
- **iOS:** the native plugin uses a signed Network Extension packet-tunnel target.

Client runtime and build values are supplied as Flutter defines. Production builds
must use an HTTPS controller URL; credentials must never be embedded in the app:

```bash
flutter build apk --release \
  --dart-define=STRICT_ENV=production \
  --dart-define=STRICT_CONTROLLER_URL=https://api.example.com \
  --dart-define=STRICT_REQUEST_TIMEOUT_SECONDS=15
```

## Linux development setup

Install Debian/Ubuntu dependencies, install or bootstrap Flutter, generate the
Linux/Android host projects, and run tests/analyzer:

```bash
./apps/client/tool/setup-linux.sh
```

The Linux runtime binary is not downloaded automatically. Install `sing-box` and
optionally set:

```bash
export STRICT_SING_BOX_BIN=/absolute/path/to/sing-box
```

Linux unit tests use a fake process, so they do not require a live TUN, root, or a
sing-box binary. The live desktop client does require the privileges needed by the
configured TUN inbound.

## Linux and Android verification

```bash
./apps/client/tool/verify-linux-android.sh
```

This runs:

```text
flutter test
flutter analyze
flutter build linux --release
flutter build apk --debug
```

CI runs the same workflow in `.github/workflows/client.yml`.

## Android

The plugin requests `VpnService.prepare()`, starts a foreground service, invokes
the generated `Libbox.newService(config, platform)` API, and establishes the TUN
file descriptor through the platform callback.

The generated `libbox.aar` is optional for APK compilation because the bridge
loads it at runtime. It is required for an actual Android VPN session. If it is
absent, the app reports an explicit native artifact error and never claims a
connection.

## Build Android libbox artifacts

Generated binaries are intentionally not committed. The reviewed upstream commit
is pinned in `apps/client/libbox.ref`, so the build needs no arguments:

```bash
./apps/client/tool/build-libbox.sh                  # Android + iOS (needs Xcode)
./apps/client/tool/build-libbox.sh --android-only   # what CI and release APKs use
```

To upgrade the engine, review the upstream diff, replace the SHA in that file, and
rebuild; `SING_BOX_LIBBOX_REF=<40-character-sha>` overrides the pin for a one-off
build. The script resolves `ANDROID_NDK_HOME` from the Android SDK when it is
unset, installs the exact `github.com/sagernet/gomobile` version the pinned
commit requires, and installs the matching `gobind` next to it (never
`gobind@latest`). That fork needs Go 1.22 or 1.23; newer Go fails while
compiling its `golang.org/x/tools` dependency, and CI pins Go 1.22 for this
reason.

CI builds this AAR on every push (`.github/workflows/client.yml`, job `libbox`),
caches it by pinned commit, and uploads it as `libbox-aar-<sha>`. The Android
artifact job consumes that artifact, so push builds are never missing the native
engine.

The script writes:

- `apps/client/packages/libbox_bridge/android/libs/libbox.aar`
- `apps/client/packages/libbox_bridge/ios/Frameworks/Libbox.xcframework`

The current repository does not commit Flutter's generated `android/` or `ios/`
host folders. Generate the Linux/Android host projects with:

```bash
cd apps/client
flutter create --platforms=linux,android .
./tool/configure-android-host.sh
```

`configure-android-host.sh` replaces Flutter's `com.example.<name>` placeholder
with the real application id (`com.strictproxy.client` by default) and the
`StrictProxy` launcher label. Skipping it produces an APK that cannot be
published or updated.

## iOS

The iOS plugin creates a `NETunnelProviderManager` and starts a separate Packet
Tunnel Network Extension. Add `packages/libbox_bridge/ios/Extension` as a Packet
Tunnel target in Xcode, set its bundle identifier to the host profile's provider
bundle identifier, enable the Network Extension entitlement, and link
`Libbox.xcframework` to both the app/plugin and extension target.

iOS cannot establish a system TUN from the Flutter app process itself; the Packet
Tunnel extension is mandatory.
