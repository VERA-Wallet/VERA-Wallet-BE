# Estimated tax report VC backend

This adds a separate post-login credential workflow. It does not replace CX login, mint a login session from a report VP, or represent a government tax filing/payment certificate. Existing Open DID login routes remain unchanged.

## Required configuration

- `REPORT_VC_ENABLED=true`, `MOCK_MODE=false`, `PERSISTENCE=prisma`, a JWT secret of at least 32 characters.
- `FRONTEND_ORIGIN` must equal the browser origin. Account routes require the normal session cookie and a persisted `omnione_cx` identity verification. Wallet linking requires CX authentication within 15 minutes.
- `REPORT_VC_ISSUER_URL`: trusted official Issuer base URL ending in `/issuer`.
- `REPORT_VC_ISSUER_SERVICE_KEY`: random secret of at least 32 characters; same value as Issuer `verawallet.report-service-key`. Never expose it to FE or put it in Git.
- `REPORT_VC_ISSUER_DID`: trusted issuer DID, currently the isolated developer issuer. This is not a government mobile-ID issuer.
- `OPENDID_VERIFIER_URL`: official Verifier base URL ending in `/verifier`.
- `REPORT_VC_LINK_POLICY_ID`: policy for the existing developer credential used to demonstrate control of a DID.
- `REPORT_VC_VERIFY_POLICY_ID`: separate report credential policy produced by registration.
- Real anchor settings: `ANCHOR_ENABLED=true`, `OMNIONE_API_KEY`, `ANCHOR_PRIVATE_KEY`, `OMNIONE_RPC_URL`, `OMNIONE_CHAIN_ID`, and optionally `ANCHOR_CONTRACT_ADDRESS`. Use a separate development account for development tests. Chain identity uses the same setting as the anchor adapter.

Apply `prisma migrate deploy` before enabling the feature. Migration adds wallet, attempt and issued credential tables; it does not change existing identity/login records. Deploy FE/BE from their respective default branches after review; the frontend and backend remain separate Git repositories.

## Flow and guarantees

1. A recently CX-authenticated account scans a link QR with its DID wallet. Official Verifier validates the VP. The backend binds the returned holder DID to that account, with uniqueness across accounts. This establishes control of both credentials in one session, not an independent government attestation that the developer DID carries the same civil identity.
2. POST issuance accepts only an owned saved evidence identifier and an idempotency key. The backend reads the saved evidence, recomputes its Merkle root, confirms the actual anchor transaction, then freezes the holder, root, report metadata and anchor snapshot.
3. The protected Issuer extension generates an issuer-init native IssueOffer. Report claims come from the immutable request snapshot, never mutable generic User data. Issuance checks the actual holder DID, expiry and cancellation under a database row lock. Public creation of report offers is forbidden.
4. Completion records the actual Issuer credential ID only after native issuance succeeds and the receipt matches request, holder and root.
5. Public verification uses its own browser-bound QR. Verifier signature/holder/issuer result, exact signed root claim, actual credential ID, issuer status and on-chain anchor are checked together. Only active credentials with a matching chain record are marked verified. The raw VP is not stored in the application database or returned to the browser.
6. CSV/XLSX checks return only the selected file leaf and Merkle siblings. FE recomputes inclusion against the previously verified VC root and checks file hash/format/length. PDF byte verification is unsupported.

Evidence inputs are saved calculation records; this feature does **not** independently audit the financial calculation or certify a tax liability. The report VC v1 discloses only report ID, root, country, year and an estimated-report disclaimer. Amount disclosure is intentionally unsupported. A saved report changing after issuance marks the older root superseded, not automatically revoked. `claims.version=1` denotes the evidence format; it is not a sequential reissue counter.

## API contract decisions

The FE contract at `docs/opendid-report-vc-api-contract.md` in the frontend repository describes the routes. Implemented under `/api/report-vc`: capabilities; wallet get/delete; link create/get/cancel; evidence eligibility; issue create/get/cancel; verification create/get/cancel; file checks.

- Same envelope as other BE routes (`data`, live provenance, or `error.code`). No mock issuer fallback.
- HttpOnly, SameSite=Lax browser-binding cookies use the three agreed names and scoped paths. Secure is enabled in production.
- QR attempts have at most 180 seconds. Public completed verification allows file checks for another 10 minutes. Attempts are removed 24 hours after expiry; issued credential/snapshot records remain. Idempotency guarantees are bounded by this retention window.
- Pending GET returns 202. Issuance POST replay may return a terminal issuance instead of another QR; FE was updated to accept both. Expired attempts return 410. Repeated cancellation before expiry returns 204.
- PostgreSQL locks serialize account changes; polling leases and final compare-and-set prevent a cancelled/expired result from linking a wallet or recording a credential. Upstream failures never become successful issuance.
- Public creation is capped at 60 per minute per process. Multi-instance deployments need a shared edge/distributed limiter. Issuer offer creation is serialized in the current single Issuer instance.
- Cancelling a link/verification invalidates its application attempt; the native Verifier has no offer-cancel API. Cancelling issuance invalidates the protected Issuer offer. Cancellation does not revoke a VC that already finished issuing.
- Public verification currently accepts only report VCs recorded by this application, not arbitrary third-party issuers. Revoked native VP submission may be rejected by Verifier before a detailed result is available.

## Native server setup

See `integrations/opendid/README.md`. The source patches are required; configuring the unmodified upstream Issuer is insufficient. In particular, the extension prevents replacing a report's frozen claims through generic user data updates and preserves historical report VCs.

## Verification and remaining manual work

Automated tests cover snapshot/Merkle validation, browser/account binding, wrong issuance receipts, native protocol handling, repeated cancellation, real PostgreSQL concurrency and cancellation fencing. Native smoke tests create an explicitly synthetic unissued offer, repeat it, poll pending, cancel it, and confirm 403 without service key / 409 after cancellation.

Development acceptance has now confirmed CX account → DID wallet link → actual phone VC receipt → phone VP submission, with the verification screen showing issuer/presentation, active status, latest version, chain root and account binding checks passing. The downloaded CSV was independently hashed and matched to the saved Merkle evidence and actual chain transaction; a one-byte modification failed inclusion. Expiry/cancellation have automated coverage; supersession and revocation still need dedicated real-phone acceptance cases. Repeat the issuance workflow after a production rollout: development application records are not automatically copied into the production database.

### Development chain connectivity check (2026-09-24)

Authenticated reads succeeded against `https://stage-chainapi.omnione.net/` (chain ID 201210), both with the documented query token and with Bearer authorization. The `test.stage-chainapi.omnione.net` hostname returned 404.

A zero-value self-transfer carrying an explicitly non-financial connectivity-test hash succeeded at block 26170151, transaction `0x90d457c03197451361c1035c9a08b0d7a50b915054154be04160462d498117e2`. The mined transaction input matched the submitted encoding. This verifies development signing and chain writes, not actual report VC issuance. No anchor contract address was configured for this test; the existing self-transfer anchor mode was used.
