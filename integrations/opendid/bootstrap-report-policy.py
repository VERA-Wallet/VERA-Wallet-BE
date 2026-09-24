"""Register isolated report schema/plan/policy through localhost admin APIs; never edit login schema."""
import json
from pathlib import Path
import urllib.request

ISSUER = 'http://127.0.0.1:8091/issuer/admin/v1'
VERIFIER = 'http://127.0.0.1:8092/verifier/admin/v1'
PUBLIC_ISSUER = 'http://100.109.255.108:8091/issuer'
PUBLIC_VERIFIER = 'http://100.109.255.108:8092/verifier'
PLAN = 'verawallet-report-v1'
TITLE = 'VeraWallet estimated report'
SCHEMA_URL = PUBLIC_ISSUER + '/api/v1/vc/vcschema?name=' + PLAN
CLAIMS = ['reportId', 'evidenceRoot', 'countryCode', 'taxYear', 'disclaimer']

def call(base, path, data=None):
    request = urllib.request.Request(base + path, data=None if data is None else json.dumps(data).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=15) as response:
        body = response.read()
        return json.loads(body) if body else {}

def rows(base, path):
    result = call(base, path)
    return result['content'] if isinstance(result, dict) else result

def ensure(base, path, key, expected, payload):
    found = next((row for row in rows(base, path) if row.get(key) == expected), None)
    if found is None:
        call(base, path, payload)
        found = next(row for row in rows(base, path) if row.get(key) == expected)
    return found

ns = ensure(ISSUER, '/namespaces', 'namespaceId', 'org.verawallet.report', {
    'namespace': {'id': 'org.verawallet.report', 'name': TITLE, 'ref': SCHEMA_URL},
    'items': [{'id': c, 'caption': c, 'type': 'text', 'format': 'plain', 'hideValue': False, 'required': True, 'description': 'Estimated report integrity metadata'} for c in CLAIMS]})
schema = ensure(ISSUER, '/vc-schemas', 'vcSchemaId', PLAN, {'namespaces': [ns['id']], 'vcSchemaId': PLAN,
    'title': TITLE, 'description': 'Estimated report integrity, not official tax filing or payment proof', 'language': 'ko', 'version': '1.0'})
plan = ensure(ISSUER, '/issue-profiles', 'vcPlanId', PLAN, {'vcPlanId': PLAN, 'title': TITLE, 'description': 'Holder-bound immutable report issuance',
    'vcSchemaId': schema['id'], 'language': 'ko', 'endpoints': [PUBLIC_ISSUER], 'cipher': 'AES-256-CBC', 'curve': 'Secp256r1', 'padding': 'PKCS5', 'initiateType': 'issuer_init', 'tags': ['report'], 'zkpEnabled': False})
filter_row = ensure(VERIFIER, '/filters', 'title', TITLE, {'title': TITLE, 'id': SCHEMA_URL, 'type': 'OsdSchemaCredential',
    'requiredClaims': ['org.verawallet.report.' + c for c in CLAIMS], 'displayClaims': ['org.verawallet.report.' + c for c in CLAIMS], 'allowedIssuers': ['did:omn:issuer'], 'presentAll': False})
process = ensure(VERIFIER, '/processes', 'title', TITLE, {'title': TITLE, 'reqE2e': {'curve': 'Secp256r1', 'cipher': 'AES-256-CBC', 'padding': 'PKCS5'}, 'authType': 6, 'endpoints': [PUBLIC_VERIFIER]})
profile = ensure(VERIFIER, '/profiles', 'title', TITLE, {'title': TITLE, 'type': 'VerifyProfile', 'description': 'Report holder and integrity verification', 'encoding': 'UTF-8', 'language': 'ko', 'processId': process['id'], 'filterId': filter_row['filterId']})
payload = ensure(VERIFIER, '/payloads', 'service', TITLE, {'service': TITLE, 'device': 'PC', 'locked': False, 'mode': 'Indirect', 'endpoints': json.dumps([PUBLIC_VERIFIER]), 'validSecond': 180, 'offerType': 'VerifyOffer'})
policy = ensure(VERIFIER, '/policies', 'policyTitle', TITLE, {'policyTitle': TITLE, 'payloadId': payload['payloadId'], 'policyProfileId': profile['policyProfileId']})
output = {'planId': PLAN, 'schemaId': schema['id'], 'namespaceId': ns['id'], 'policyId': policy['policyId']}
state = Path(__file__).resolve().parents[3] / '.opendid/report-vc-policy.json'
state.write_text(json.dumps(output, indent=2)); state.chmod(0o600)
print(json.dumps(output))
