import org.omnione.did.sdk.communication.urlconnection.HttpUrlConnectionTask;

public final class EndpointTest {
    static void check(String original, String expected) throws Exception {
        if (!expected.equals(HttpUrlConnectionTask.resolveEndpoint(original))) throw new AssertionError(original);
    }
    public static void main(String[] args) throws Exception {
        String base = "https://verawallet.pelicanlab.dev/opendid";
        check("http://100.109.255.108:8090/tas/api/v1/vc-schema?name=certificate", base + "/tas/api/v1/vc-schema?name=certificate");
        check("http://100.109.255.108:8090/list/api/v1/allowed-ca/list?wallet=did:omn:wallet", base + "/list/api/v1/allowed-ca/list?wallet=did:omn:wallet");
        check("http://100.109.255.108:8092/verifier/api/v1/request-verify", base + "/verifier/api/v1/request-verify");
        for (String original : new String[] {
            "http://100.109.255.108.evil.test:8090/tas/api/v1/vc-schema",
            "http://100.109.255.108:8091/tas/api/v1/vc-schema",
            "http://user@100.109.255.108:8090/tas/api/v1/vc-schema",
            "http://100.109.255.108:9999/tas/api/v1/vc-schema",
            base + "/tas/api/v1/vc-schema"
        }) check(original, original);
        System.out.println("Endpoint mapping: 8 checks passed");
    }
}
