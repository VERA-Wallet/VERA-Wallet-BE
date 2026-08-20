import { createHash } from "node:crypto";
import { Injectable, ServiceUnavailableException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { IdentityProvider, VerificationRequest, VerifiedIdentity } from "@vera/interfaces";

const delay = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

@Injectable()
export class MockIdentityAdapter implements IdentityProvider {
  async requestVerification(sessionId: string): Promise<VerificationRequest> {
    return { sessionId, verificationUrl: `mock://omnione/verify?session=${sessionId}`, deepLink: `omnione://verify/${sessionId}`, expiresAt: new Date(Date.now() + 5 * 60_000) };
  }
  async handleCallback(_token: string): Promise<VerifiedIdentity> {
    await delay(300);
    return { didHash: `0x${createHash("sha256").update("vera-wallet-mock-identity").digest("hex")}`, verifiedAt: new Date(), method: "mock" };
  }
}

/** OmniOne CX v1.0 §2.4 Token 파싱 응답. data에는 개인정보 원문이 들어오므로 절대 밖으로 내보내지 않는다. */
interface OacxTokenResponse {
  oacxCode?: string;
  resultCode?: string;
  data?: { ci?: string; userDid?: string };
}

@Injectable()
export class OmniOneCxAdapter implements IdentityProvider {
  constructor(private readonly config: ConfigService) {}

  async requestVerification(_sessionId: string): Promise<VerificationRequest> {
    // QR/딥링크 발급(§2.2~2.3)은 FE의 CX 표준 인증창이 수행한다. 서버 발급 QR 흐름이 필요해지면 그때 붙인다.
    throw new ServiceUnavailableException("OmniOne CX server-side QR issuance is not configured; use the frontend auth window.");
  }

  /**
   * CX 표준 인증창이 FE로 돌려준 result token을 §2.4 Token 파싱 API로 검증한다.
   * 개인정보 원문(name, ihidnum 등)은 사용하지 않고, ci(없으면 userDid)만 해시해 didHash로 쓴다.
   */
  async handleCallback(token: string): Promise<VerifiedIdentity> {
    const baseUrl = this.config.get<string>("OMNIONE_CX_BASE_URL");
    if (!baseUrl) throw new ServiceUnavailableException("OMNIONE_CX_BASE_URL is not configured.");

    let payload: OacxTokenResponse;
    try {
      const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/oacx/api/v1.0/trans/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`OmniOne CX responded with HTTP ${response.status}`);
      payload = (await response.json()) as OacxTokenResponse;
    } catch {
      throw new ServiceUnavailableException("OmniOne CX server is unreachable.");
    }

    if (payload.oacxCode !== "OACX_SUCCESS") throw new UnauthorizedException("OmniOne CX token validation failed.");
    const subject = payload.data?.ci || payload.data?.userDid;
    if (!subject) throw new UnauthorizedException("OmniOne CX token did not carry a verifiable subject.");

    return { didHash: `0x${createHash("sha256").update(`omnione-cx:${subject}`).digest("hex")}`, verifiedAt: new Date(), method: "omnione_cx" };
  }
}
