# Open DID report extension (development)

Upstream source is Apache-2.0 OmniOne Open DID. These patches target:

- Issuer commit `8f7bfa0b1a22fcb5549523a9c03e97f97d85fee6`
- Verifier commit `69b586a4f216748b4bfa639f38501a2c5ca285de`

Apply `issuer.patch` / `verifier.patch` with `git apply --check` then `git apply` in clean matching upstream repositories. Verifier patch includes the existing holder/issuer confirmation hardening as well as report credential ID confirmation; do not apply it a second time to an already patched runtime. The standalone ReportIssue Java files are convenience copies of the additions in the patch, not an additional patch step.

Build with JDK 21 and Gradle 8.8 from each `source/did-*-server` directory. Pass `-DskipFrontendBuild=true`. The upstream Issuer excludes its tests by default: use `-I /absolute/path/report-vc-tests.gradle test --tests '*ReportIssueGuardTest' bootJar --no-daemon` to actually run the guard tests. Verifier uses `test --tests '*ConfirmationIssuerTest*' bootJar --no-daemon`. Check actual test XML, not merely BUILD SUCCESSFUL.

Issuer configuration (private runtime file):

```yaml
verawallet:
  report-plan-id: verawallet-report-v1
  report-service-key: <random secret, at least 32 characters>
```

`ReportIssueGuard` creates its isolated `verawallet_report_offer` table on startup when the report plan is enabled. Its DB user needs CREATE TABLE permission. Protect/back up this table along with the native Issuer DB: it contains frozen per-offer authorization. Keep native admin APIs private. The service-key protected extension is under `/issuer/api/v1/verawallet/report`; normal mobile SDK paths are unchanged.

The development Issuer calls TA internally during schema registration. Its `tas.url` must reach private TA admin endpoints (on this host, `http://127.0.0.1:8090`), not the tailnet gateway that intentionally blocks admin routes. Do not expose TA admin publicly to make registration work.

`bootstrap-report-policy.py` is an idempotent **local development registration script**, currently configured for this Mac mini (`100.109.255.108`, native localhost 8091/8092). Review its public URLs before using another environment. It creates a separate namespace/schema/issuer-init profile and report Verifier policy; existing login policies are untouched. It writes non-secret registration IDs to the parent workspace `.opendid/report-vc-policy.json`.

Rebuild/restart native development Issuer and Verifier with backups, verify startup, then run registration. Match the BE service key/URLs/policy IDs. Do not commit runtime YAML, keys, native DB dumps, issued credentials or raw VP logs. Existing sample server logging needs a separate production hardening review before exposing it beyond this isolated development environment.
