# StrictProxy client

Flutter client for the StrictProxy platform. Talks only to the Central
Controller; nodes are never contacted directly.

## Building

Flutter is not vendored. Generate the host projects first — they are
gitignored — then build:

```sh
flutter create --platforms=linux,android,ios .
flutter pub get
```

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

## Testing

```sh
flutter analyze
flutter test
```

Tests load `test/canonical_fixtures.json` at runtime (JSON cannot be imported
as a Dart library) and run from the package root, so paths are relative.
