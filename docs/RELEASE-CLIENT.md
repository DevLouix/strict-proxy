# Releasing the Android client

This is how an installable, connectable APK is produced. The existing `client`
workflow only proves the code compiles and uploads a **debug** APK with no
signing key — it cannot talk to a production controller, and a debug key cannot
be used for updates. The `client-release` workflow is the one that produces
something you can hand to users.

## What the release build guarantees

`apps/client/tool/build-release-android.sh` refuses to produce an artifact
unless all of the following hold:

| Requirement | Why |
|---|---|
| `STRICT_ENV=production` | unsigned config bundles are rejected instead of silently trusted |
| `STRICT_CONTROLLER_URL` starts with `https://` | credentials never travel over cleartext |
| `STRICT_SIGNING_PUBLIC_KEY` is set | the client verifies the controller's Ed25519 signature; a missing key is a hard failure |
| `libbox.aar` exists | without the native engine the app installs but cannot open a VPN session |
| A real keystore is supplied | the APK is re-signed, so future builds can update it in place |

## One-time setup

### 1. Create the release keystore

Do this once, on a machine you control:

```bash
keytool -genkeypair -v \
  -keystore upload.jks \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -alias upload
```

Back up `upload.jks` **and** its passwords. If you lose them, every installed
app can only be updated by uninstalling it first — Android will refuse an APK
signed by a different key.

### 2. Add the GitHub secrets

Repository **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64 -w0 upload.jks` |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | `upload` |
| `ANDROID_KEY_PASSWORD` | key password (often the same) |

These are used only by `client-release`; the regular `client` workflow never
sees them.

### 3. Collect the two public build inputs

```bash
# From the controller's signing key (NOT a secret — it only verifies):
openssl pkey -in signing-key.pem -pubout -outform DER | tail -c 32 | base64
```

And pick the `sing-box-libbox` commit to build the VPN engine from. It must be a
full 40-character commit SHA that someone reviewed. Never use a moving branch.

## Run a release

The workflow builds `libbox.aar` for all four Android ABIs, compiles the APK,
re-signs it with your keystore, verifies the signature, and uploads the artifact.
Expect roughly 15–25 minutes on a cold cache because of the native build.

```bash
gh workflow run client-release \
  -f controller_url=https://api.example.com \
  -f signing_public_key='<base64 key from step 3>' \
  -f signing_key_id=primary \
  -f libbox_ref=<40-character SHA> \
  -f app_version=0.1.0 \
  -f app_build_number=1 \
  -f release_tag=v0.1.0        # optional: attaches the APK to a GitHub release
```

Leaving `release_tag` empty still uploads the APK as a workflow artifact; you can
download it from the run page.

## Local build (same result)

With Flutter, Go, `gomobile`, the Android SDK/NDK, and `zip` installed:

```bash
export STRICT_CONTROLLER_URL=https://api.example.com
export STRICT_SIGNING_PUBLIC_KEY='<base64 public key>'
export SING_BOX_LIBBOX_REF=<40-character SHA>
export APP_VERSION=0.1.0 APP_BUILD_NUMBER=1

export ANDROID_KEYSTORE_PATH="$PWD/upload.jks"
export ANDROID_KEYSTORE_PASSWORD='...'
export ANDROID_KEY_ALIAS=upload
export ANDROID_KEY_PASSWORD='...'   # omit if same as keystore password

./apps/client/tool/build-release-android.sh
```

The artifact lands in `apps/client/build/dist/`.

## Distributing to users

- **Direct install:** host the APK over HTTPS and give users the link. They must
  allow installs from the browser/file manager once. `adb install -r <apk>` works
  for testing.
- **GitHub Releases:** the workflow's `release_tag` input publishes the APK on a
  release page, which is the simplest shareable location.
- **Play Store:** requires a Play Console account and an `.aab`. The Play upload
  key is managed by Google Play App Signing; direct-APK updates and Play updates
  are separate tracks, so pick one and stay on it.

### Updates

Bump `app_build_number` for every release — Android compares the version code.
Build with the same keystore, or the install will be rejected as a signature
mismatch. Because the signing key is compiled into the app, changing
`STRICT_SIGNING_PUBLIC_KEY` also requires a new build for every user.

## iOS

The workflow does not produce iOS builds. iOS needs an Apple Developer account,
a distribution certificate and provisioning profiles, plus the Packet Tunnel
extension target described in [apps/client/LIBBOX.md](../apps/client/LIBBOX.md).
CI compiles iOS with `--no-codesign` to catch breakage, but a shippable build is
a manual Xcode step.

## Pre-release check

Before sharing a build:

1. Install it on a real device, not just an emulator.
2. Log in, open the server list, and connect — this exercises the signed bundle,
   the libbox engine, and VPN permission end to end.
3. Confirm the About/Connection screen shows the expected controller URL (never
   `10.0.2.2`).
4. Make a test purchase if billing is enabled; the tier must change after the
   webhook, not after the redirect.
