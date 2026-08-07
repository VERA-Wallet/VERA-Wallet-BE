import { createHash } from "node:crypto";
import { Injectable, ServiceUnavailableException } from "@nestjs/common";
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

@Injectable()
export class OmniOneCxAdapter implements IdentityProvider {
  constructor(private readonly config: ConfigService) {}
  async requestVerification(_sessionId: string): Promise<VerificationRequest> {
    void this.config.get("OMNIONE_CX_BASE_URL");
    // TODO: integrate the final OmniOne CX request schema once issued by the provider.
    throw new ServiceUnavailableException("OmniOne CX real adapter is not configured yet.");
  }
  async handleCallback(_token: string): Promise<VerifiedIdentity> {
    // TODO: validate the callback token with OmniOne CX. Never persist raw identity claims.
    throw new ServiceUnavailableException("OmniOne CX real adapter is not configured yet.");
  }
}
