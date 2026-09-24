# Public DID CA test distribution

Public origin: https://verawallet.pelicanlab.dev. Install instructions: `/did-wallet/install`.
The FE owns an exact method/path allowlist at `/opendid/*` and forwards only JSON to the private native services on host.docker.internal:8090–8095. Set `OPENDID_PUBLIC_UPSTREAM_HOST=host.docker.internal` in the FE container. No browser cookies, issuer service key, or bearer tokens are forwarded. Admin, test, report issuance control, offer creation and verifier confirmation remain private. The native loopback services and BE internal URLs need not change. Tailscale is not used by the new Android client.

## APK

This is an Android 8+ **test** APK, signed by the existing development signing key for update compatibility, not a Play Store production release. Keep that key private and persistent. Existing users must update in place, not uninstall their wallet. No iOS binary or same-device QR deep link is supplied.

Start with the existing VeraWallet DID CA 2.0 checkout (including registration fixes). Restore the original SDK JAR if previously filtered, then run `python3 prepare-android.py /path/to/source/did-ca-aos` and `./gradlew assembleDebug` with the existing JDK 21 / Android SDK 34 configuration. `prepare-android.py` validates the original JAR SHA-256 and retains it as `.jar.original` (not packaged by the Gradle `*.jar` glob). It replaces only the SDK HTTP transport class with the provided source; no VC, signature, DID key, or cryptographic validation code changes.

Transport source derives from OmniOneID/did-client-sdk-aos tag V2.0.0, commit c4fa6c1ac1755d23d75ba3f5106d877369d8cb15, Apache-2.0. It maps only the exact legacy host 100.109.255.108 and service port/path pairs to `/opendid`. Existing signed schema and certificate references remain byte-for-byte intact. New fixed app URLs use HTTPS directly. Plain HTTP is disabled; redirects are not followed; raw request/response logging is removed from this transport. Other app debug logging is unchanged: do not collect/share unredacted logcat.

Copy the built APK to a private host directory dedicated to public artifacts, named `verawallet-did-ca.apk`, and mount that directory read-only at `/app/public/downloads` before starting the FE. Never mount the whole `.opendid` state directory. Publish the APK SHA-256 and signing certificate digest in `release.json` alongside it; no private key belongs there.

## First registration and remaining real-device check

The sample CA still uses the development-account registration flow. New testers need an operator-provisioned development account and initial identity VC accepted by the wallet-link policy. This is not automatic government-ID enrollment; VeraWallet CX identity verification remains a separate step. The install page states this requirement rather than promising self-service enrollment.

After deploy, check public GET schema/certificate/DID endpoints and deny admin/report-control paths. On a phone with Tailscale and VPN disabled: update APK without uninstalling, test first registration using a newly provisioned account, identity VC issuance, web wallet linking, report VC issuance and VP submission. Host-only checks cannot certify the Android camera, installation or full phone flow.
