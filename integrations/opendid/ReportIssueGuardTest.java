package org.omnione.did.issuer.v1.agent.service;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import java.util.List;
import java.util.Map;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
class ReportIssueGuardTest {
  @Test void publicReportOffersAreForbiddenButLegacyPlansRemainAvailable() {
    var guard=new ReportIssueGuard(mock(JdbcTemplate.class),"report-plan");
    assertThrows(RuntimeException.class,()->guard.authorizeCreation("report-plan"));
    assertDoesNotThrow(()->guard.authorizeCreation("legacy"));
    guard.internal(true); assertDoesNotThrow(()->guard.authorizeCreation("report-plan"));
    guard.internal(false); assertThrows(RuntimeException.class,()->guard.authorizeCreation("report-plan"));
  }
  @Test void reportClaimsNeverFallBackToMutableUserData() {
    var db=mock(JdbcTemplate.class); var guard=new ReportIssueGuard(db,"report-plan");
    when(db.queryForList(anyString(),anyString(),anyString())).thenReturn(List.of());
    assertThrows(RuntimeException.class,()->guard.claims("report-plan","tx","wrong-holder","mutable-data"));
    assertEquals("legacy-data",guard.claims("legacy","tx","holder","legacy-data"));
  }
  @Test void validHolderReceivesOnlyImmutableSnapshot() {
    var db=mock(JdbcTemplate.class); var guard=new ReportIssueGuard(db,"report-plan");
    when(db.queryForList(anyString(),anyString(),anyString())).thenReturn(List.of(Map.of("claims","immutable-data")));
    assertEquals("immutable-data",guard.claims("report-plan","tx","holder","mutable-data"));
  }
  @Test void consumedExpiredOrUnregisteredOfferCannotBind() {
    var db=mock(JdbcTemplate.class); var guard=new ReportIssueGuard(db,"report-plan");
    when(db.update(anyString(),anyString(),anyString())).thenReturn(0);
    assertThrows(RuntimeException.class,()->guard.bind("report-plan","offer","tx"));
  }
  @Test void reportProfileResolvesOnlyTheAuthorizedDidAndSchema() {
    var db=mock(JdbcTemplate.class); var guard=new ReportIssueGuard(db,"report-plan");
    var users=mock(org.omnione.did.issuer.v1.agent.service.query.UserQueryService.class);
    var user=org.omnione.did.base.db.domain.User.builder().did("did:omn:holder").vcSchemaId(3L).build();
    when(db.queryForList(anyString(),eq("tx"),eq("did:omn:holder"))).thenReturn(List.of(Map.of("claims","{}")));
    when(users.findByDidAndVcSchemaId("did:omn:holder",3L)).thenReturn(java.util.Optional.of(user));
    assertSame(user,guard.reportUser("tx","did:omn:holder",3L,users));
    verify(users,never()).findByPiiAndVcSchemaId(any(),any());
  }
  @Test void profileLookupCannotBypassOfferHolderBinding() {
    var db=mock(JdbcTemplate.class); var guard=new ReportIssueGuard(db,"report-plan");
    var users=mock(org.omnione.did.issuer.v1.agent.service.query.UserQueryService.class);
    when(db.queryForList(anyString(),anyString(),anyString())).thenReturn(List.of());
    assertThrows(RuntimeException.class,()->guard.reportUser("tx","wrong-holder",3L,users));
    verifyNoInteractions(users);
  }
}
