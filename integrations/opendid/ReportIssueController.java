package org.omnione.did.issuer.v1.agent.controller;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.omnione.did.issuer.v1.agent.service.*;
import org.omnione.did.issuer.v1.agent.service.query.*;
import org.omnione.did.issuer.v1.admin.service.query.IssueProfileQueryService;
import org.omnione.did.issuer.v1.agent.dto.vc.OfferIssueVcReqDto;
import org.omnione.did.base.db.domain.User;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.*;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.transaction.annotation.Transactional;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.*;

@RestController
@RequestMapping("/issuer/api/v1/verawallet/report")
public class ReportIssueController {
    private final ReportIssueGuard guard;
    private final IssueService issue;
    private final UserQueryService users;
    private final IssueProfileQueryService profiles;
    private final VcQueryService vcs;
    private final String key;
    @org.springframework.beans.factory.annotation.Autowired
    private org.omnione.did.base.db.repository.VcRepository vcRepository;
    private final ObjectMapper json = new ObjectMapper();
    public ReportIssueController(ReportIssueGuard guard, @org.springframework.beans.factory.annotation.Qualifier("issueServiceHelper") IssueService issue, UserQueryService users,
        IssueProfileQueryService profiles, VcQueryService vcs, @Value("${verawallet.report-service-key:}") String key) {
        this.guard=guard; this.issue=issue; this.users=users; this.profiles=profiles; this.vcs=vcs; this.key=key;
    }
    @ExceptionHandler(ResponseStatusException.class)
    public org.springframework.http.ResponseEntity<Map<String,String>> failure(ResponseStatusException error) {
        return org.springframework.http.ResponseEntity.status(error.getStatusCode()).body(Map.of("code", "report_request_rejected"));
    }
    private void authorize(String supplied) {
        if (key.length()<32 || supplied==null || !MessageDigest.isEqual(key.getBytes(StandardCharsets.UTF_8), supplied.getBytes(StandardCharsets.UTF_8))) throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        guard.plan();
    }
    @PostMapping("/capabilities") public Map<String,Object> capabilities(@RequestHeader(value="x-verawallet-service-key",required=false) String supplied) {
        authorize(supplied);
        return Map.of("contract","verawallet-report-vc-v1","holderBound",true,"immutableClaims",true,"issuanceReceipt",true);
    }
    @PostMapping("/offers") @Transactional
    public synchronized Map<String,Object> offer(@RequestHeader(value="x-verawallet-service-key",required=false) String supplied, @RequestBody Map<String,Object> body) throws Exception {
        authorize(supplied);
        String requestId = Objects.toString(body.get("requestId"), ""); UUID.fromString(requestId);
        String holder = Objects.toString(body.get("holderDid"), "");
        if (!holder.matches("^did:[a-z0-9]+:.+$") || !(body.get("snapshot") instanceof Map<?,?> snapshot)) throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        var existing=guard.find(requestId);
        if (existing!=null) {
            if (!holder.equals(existing.get("holder")) || !json.readTree((String)existing.get("snapshot")).equals(json.valueToTree(snapshot))) throw new ResponseStatusException(HttpStatus.CONFLICT);
            return json.readValue((String)existing.get("payload"), Map.class);
        }
        String root=Objects.toString(snapshot.get("evidenceRoot"), "");
        if (!root.matches("^0x[a-fA-F0-9]{64}$") || !holder.equals(snapshot.get("holderDid"))) throw new ResponseStatusException(HttpStatus.BAD_REQUEST);
        Map<String,String> claims=new LinkedHashMap<>();
        claims.put("org.verawallet.report.reportId", requestId);
        claims.put("org.verawallet.report.evidenceRoot", root);
        claims.put("org.verawallet.report.countryCode", Objects.toString(snapshot.get("countryCode")));
        claims.put("org.verawallet.report.taxYear", Objects.toString(snapshot.get("taxYear")));
        claims.put("org.verawallet.report.disclaimer", "estimated_tax_report");
        // Amounts are deliberately absent from v1: only basic disclosure is advertised.
        String claimJson=json.writeValueAsString(claims);
        Long schema=profiles.findByVcPlanId(guard.plan()).getVcSchemaId();
        if (users.findByDidAndVcSchemaId(holder,schema).isEmpty()) users.save(User.builder().did(holder).vcSchemaId(schema).data("{}").pii(requestId).build());
        OfferIssueVcReqDto request=new OfferIssueVcReqDto(); request.setVcPlanId(guard.plan());
        Map payload;
        guard.internal(true);
        try { payload=json.convertValue(issue.requestOffer(request).getIssueOfferPayload(), Map.class); }
        finally { guard.internal(false); }
        String expiry=Objects.toString(payload.get("validUntil"));
        var answer=Map.<String,Object>of("offerId",payload.get("offerId"),"payload",payload,"expiresAt",expiry);
        guard.save(requestId,Objects.toString(payload.get("offerId")),holder,claimJson,json.writeValueAsString(snapshot),json.writeValueAsString(answer),expiry);
        return answer;
    }
    @PostMapping("/result") public Map<String,Object> result(@RequestHeader(value="x-verawallet-service-key",required=false) String supplied,@RequestBody Map<String,Object> body) {
        authorize(supplied);
        String requestId=Objects.toString(body.get("requestId"), "");
        var row=guard.find(requestId);
        if (row==null || !Objects.equals(row.get("offer_id"), body.get("offerId"))) throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        if (Boolean.TRUE.equals(row.get("cancelled"))) throw new ResponseStatusException(HttpStatus.CONFLICT);
        if (row.get("tx_id")==null) return Map.of("status","pending");
        var completed=issue.issueVcResult((String)row.get("offer_id"));
        if (!Boolean.TRUE.equals(completed.getResult())) return Map.of("status","pending");
        var vc=vcs.findByTxId((String)row.get("tx_id"));
        if (!vc.getDid().equals(row.get("holder"))) throw new ResponseStatusException(HttpStatus.CONFLICT);
        try {
            var snapshot=json.readTree((String)row.get("snapshot"));
            return Map.of("status","issued","requestId",requestId,"credentialId",vc.getVcId(),"holderDid",vc.getDid(),"evidenceRoot",snapshot.get("evidenceRoot").asText(),"issuedAt",vc.getIssuedAt().toString());
        } catch (Exception e) { throw new ResponseStatusException(HttpStatus.CONFLICT); }
    }
    @PostMapping("/credential-status") public Map<String,Object> credentialStatus(@RequestHeader(value="x-verawallet-service-key",required=false) String supplied,@RequestBody Map<String,Object> body) {
        authorize(supplied);
        var vc=vcRepository.findByVcId(Objects.toString(body.get("credentialId"), "")).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND));
        if (!guard.plan().equals(vc.getVcPlanId())) throw new ResponseStatusException(HttpStatus.NOT_FOUND);
        return Map.of("status",vc.getStatus(),"holderDid",vc.getDid(),"credentialId",vc.getVcId());
    }
    @PostMapping("/cancel") public Map<String,Object> cancel(@RequestHeader(value="x-verawallet-service-key",required=false) String supplied,@RequestBody Map<String,Object> body) {
        authorize(supplied); return Map.of("cancelled",guard.cancel(Objects.toString(body.get("requestId"), "")));
    }
}
