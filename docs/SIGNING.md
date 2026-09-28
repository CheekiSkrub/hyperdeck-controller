# Code signing

`npm run package` builds an unsigned Node single executable (ad-hoc signed on macOS so it runs locally). The release workflow signs on each platform when the matching secrets are set, and skips signing when they're not.

## Windows: Authenticode

Option A, **Azure Trusted Signing** (recommended; no hardware token needed):

| Secret | |
|---|---|
| `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | App registration with the *Trusted Signing Certificate Profile Signer* role |
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | e.g. `https://weu.codesigning.azure.net/` |
| `AZURE_TRUSTED_SIGNING_ACCOUNT`, `AZURE_CERT_PROFILE` | Account and certificate profile names |

Option B, **PFX certificate** (OV certificates exportable as PFX): `WINDOWS_CERT_PFX_BASE64` and `WINDOWS_CERT_PASSWORD`.

The workflow signs `hyperdeck-controller.exe`, `ffmpeg.exe` and `ffprobe.exe` with SHA-256 and an RFC 3161 timestamp.

## macOS: Developer ID + notarization

| Secret | |
|---|---|
| `APPLE_CERT_P12_BASE64`, `APPLE_CERT_PASSWORD` | *Developer ID Application* certificate exported as .p12 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Rebus Industries (TEAMID)` |
| `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect API key for `notarytool` |

The binaries are signed with the hardened runtime and `scripts/entitlements.mac.plist`. Node's V8 needs `allow-jit` and `allow-unsigned-executable-memory`. The folder is then zipped and notarized. Bare executables can't be stapled, so Gatekeeper checks notarization online on first run. If offline installs matter, wrap the build in a signed `.pkg` or `.dmg` and staple that.

## Linux: GPG

`GPG_PRIVATE_KEY` (ASCII-armoured) and `GPG_PASSPHRASE` produce a detached `.asc` signature for each `.tar.gz`. The release job also publishes `SHA256SUMS.txt`.
