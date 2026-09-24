package org.omnione.did.issuer.v1.agent.service;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ResponseStatusException;
import org.springframework.http.HttpStatus;
import java.util.Map;

/** Durable, immutable report issuance authorization. No report offer can use mutable User.data. */
@Component
public class ReportIssueGuard {
    private final JdbcTemplate db;
    private final String plan;
    private final ThreadLocal<Boolean> internal = ThreadLocal.withInitial(() -> false);
    public ReportIssueGuard(JdbcTemplate db, @Value("${verawallet.report-plan-id:}") String plan) {
        this.db = db; this.plan = plan;
        if (!plan.isBlank()) db.execute("CREATE TABLE IF NOT EXISTS verawallet_report_offer (request_id varchar(64) PRIMARY KEY, offer_id varchar(64) UNIQUE NOT NULL, holder text NOT NULL, claims text NOT NULL, snapshot text NOT NULL, payload text NOT NULL, expires_at timestamptz NOT NULL, tx_id text UNIQUE, cancelled boolean NOT NULL DEFAULT false)");
    }
    public String plan() { if (plan.isBlank()) throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE); return plan; }
    public boolean applies(String candidate) { return !plan.isBlank() && plan.equals(candidate); }
    public void internal(boolean enabled) { if (enabled) internal.set(true); else internal.remove(); }
    public void authorizeCreation(String candidate) {
        if (applies(candidate) && !internal.get()) throw new ResponseStatusException(HttpStatus.FORBIDDEN);
    }
    public void bind(String candidate, String offerId, String txId) {
        if (!applies(candidate)) return;
        int changed = db.update("UPDATE verawallet_report_offer SET tx_id=? WHERE offer_id=? AND tx_id IS NULL AND NOT cancelled AND expires_at>now()", txId, offerId);
        if (changed != 1) throw new ResponseStatusException(HttpStatus.CONFLICT);
    }
    public String claims(String candidate, String txId, String holder, String fallback) {
        if (!applies(candidate)) return fallback;
        var rows = db.queryForList("SELECT claims FROM verawallet_report_offer WHERE tx_id=? AND holder=? AND NOT cancelled AND expires_at>now() FOR UPDATE", txId, holder);
        if (rows.size() != 1) throw new ResponseStatusException(HttpStatus.FORBIDDEN);
        return (String) rows.getFirst().get("claims");
    }
    public org.omnione.did.base.db.domain.User reportUser(String txId, String holder, Long schemaId,
            org.omnione.did.issuer.v1.agent.service.query.UserQueryService users) {
        // The protected offer authorizes this holder, not the generic issuer-init PII lookup.
        // Recheck expiry/cancellation and take the same row lock before profile creation.
        claims(plan(), txId, holder, null);
        return users.findByDidAndVcSchemaId(holder, schemaId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.FORBIDDEN));
    }
    public Map<String, Object> find(String requestId) {
        var rows = db.queryForList("SELECT * FROM verawallet_report_offer WHERE request_id=?", requestId);
        return rows.isEmpty() ? null : rows.getFirst();
    }
    public void save(String requestId, String offerId, String holder, String claims, String snapshot, String payload, String expiry) {
        db.update("INSERT INTO verawallet_report_offer(request_id,offer_id,holder,claims,snapshot,payload,expires_at) VALUES(?,?,?,?,?,?,?::timestamptz)", requestId, offerId, holder, claims, snapshot, payload, expiry);
    }
    public boolean cancel(String requestId) {
        return db.update("UPDATE verawallet_report_offer SET cancelled=true WHERE request_id=?", requestId) == 1;
    }
}
