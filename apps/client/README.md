# StrictProxy client

Flutter client for the StrictProxy platform. Talks only to the Central
Controller; nodes are never contacted directly.

## Building

Flutter is not vendored. Generate the host projects first — they are
gitignored — then build:

```sh
flutter create --platforms=linux,android,ios .
./tool/configure-android-host.sh   # replaces com.example.<name> with the real id
flutter pub get
```

The native VPN engine is built separately with `./tool/build-libbox.sh`, which
reads the reviewed commit pinned in `libbox.ref`. Skip it only when you do not
need to connect.

The Flutter tool picks up the workspace `analysis_options.yaml`.

### Build-time defines

Client binaries are inspectable, so **never** put a credential in a define.
These are all public values:

| Define | Default | Purpose |
|---|---|---|
| `STRICT_ENV` | `development` | `production` makes bundle verification mandatory |
| `STRICT_CONTROLLER_URL` | `http://10.0.2.2:8080` | Controller base URL |
| `STRICT_SIGNING_PUBLIC_KEY` | *(empty)* | Base64 of the controller's Ed25519 **public** key |
| `STRICT_SIGNING_KEY_ID` | *(empty)* | Expected key id, for surfacing rotations |
| `STRICT_TUN_IPV4_ADDRESS` | `172.19.0.1/30` | TUN interface address |
| `STRICT_TUN_IPV6_ADDRESS` | `fdfe:dcba:9876::1/126` | TUN interface address |
| `STRICT_REQUEST_TIMEOUT_SECONDS` | `15` | API timeout |

### Bundle verification

Config bundles are Ed25519-signed by the controller and the client verifies
them **before** any credential reaches the tunnel
(`lib/features/engine/bundle_verifier.dart`).

```sh
# Extract the public key from the controller's signing key, base64:
openssl pkey -in signing-key.pem -pubout -outform DER | tail -c 32 | base64
```

In a production build (`STRICT_ENV=production`) a missing or unusable
`STRICT_SIGNING_PUBLIC_KEY` is a **hard failure**, not a downgrade: the client
refuses to connect rather than run unverified. In development it falls back to
transport TLS only.

The Dart canonical-JSON implementation must match the controller's byte for
byte. It is pinned against fixtures produced by the controller's own signer:

```sh
# from the repository root, after editing test/tools/emit-canonical-fixtures.ts
npx tsx test/tools/emit-canonical-fixtures.ts > apps/client/test/canonical_fixtures.json
```

## Release builds

A build you hand to users must include the native engine and be signed with the
release keystore:

```sh
./tool/build-release-android.sh
```

It requires `STRICT_CONTROLLER_URL`, `STRICT_SIGNING_PUBLIC_KEY`,
`SING_BOX_LIBBOX_REF`, and the `ANDROID_KEYSTORE_*` variables, and it refuses to
produce an APK if the controller URL is not HTTPS, the signing key is missing, or
`libbox.aar` was not built. The CI equivalent is the manual `client-release`
workflow. Full instructions, including keystore setup and how updates work, are
in [`docs/RELEASE-CLIENT.md`](../../docs/RELEASE-CLIENT.md).

## CI artifacts

A push that touches `apps/client/**` or the client workflow runs `client.yml`
and publishes, for that commit:

| Artifact | What it is |
|---|---|
| `strict-proxy-client-android-<sha>.apk` | signed release APK, verified by `apksigner` in the job |
| `strict-proxy-client-linux-<sha>.tar.gz` | Linux release bundle |
| `libbox-aar-<sha>` | native engine the APK was built against |

A push to `main` also publishes those artifacts on the **Releases** page under
the tag `client-<run_number>` (Android APK plus Linux bundle), so users can
install from a stable link instead of digging through a workflow run:

```sh
gh release list                       # newest client build on top
gh release download client-<run_number> -p '*.apk'
gh release view client-<run_number> --json assets --jq '.assets[].name'
```

Run artifacts disappear when their retention window expires; releases do not.
Versioned releases built by `client-release` are separate and unchanged.

To rebuild without a commit — for example right after changing
`CLIENT_CONTROLLER_URL` or the keystore secrets — use **Actions → client → Run
workflow**, or `gh workflow run client`. Pull requests only run the tests and
analysis jobs; they never publish a signed artifact.

## Testing

```sh
flutter analyze
flutter test
```

The full local loop — prerequisites, the native engine, an emulator APK, the
Kotlin bridge tests and the logcat checks for a real tunnel — is in
[`docs/BUILD-AND-TEST.md`](../../docs/BUILD-AND-TEST.md).

Tests load `test/canonical_fixtures.json` at runtime (JSON cannot be imported
as a Dart library) and run from the package root, so paths are relative.
