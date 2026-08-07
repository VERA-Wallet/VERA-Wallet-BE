import { BadRequestException, Injectable, UnauthorizedException } from "@nestjs/common";
import { SiweMessage } from "siwe";
import { getAddress, verifyMessage } from "viem";
import type { AuthenticatedUser } from "../auth/auth.types";
import { WalletBindingService } from "./wallet-binding.service";
import { WalletChallengeService } from "./wallet-challenge.service";

@Injectable()
export class WalletService {
  constructor(private readonly challenges: WalletChallengeService, private readonly bindings: WalletBindingService) {}
  issueBindingChallenge(user: AuthenticatedUser) { return this.challenges.issueBinding(user); }
  issueSiweChallenge(user: AuthenticatedUser, chainId: number) { return this.challenges.issueSiwe(user, chainId); }

  async bind(user: AuthenticatedUser, input: { address: string; message: string; signature: string; nonce: string }) {
    const challenge = this.challenges.consume(input.nonce, user.sub);
    if (input.message !== challenge.message) throw new BadRequestException({ code: "challenge_mismatch", message: "Signed message does not match challenge." });
    await this.assertSignature(input.address, input.message, input.signature);
    return this.bindings.bind(user, input.address, input.nonce, input.signature);
  }

  async bindSiwe(user: AuthenticatedUser, input: { message: string; signature: string }) {
    const parsed = this.parseSiwe(input.message);
    const challenge = this.challenges.consume(parsed.nonce, user.sub);
    if (parsed.domain !== challenge.domain || parsed.uri !== challenge.uri || parsed.chainId !== challenge.chainId || parsed.issuedAt !== challenge.issuedAt) {
      throw new BadRequestException({ code: "challenge_mismatch", message: "Challenge does not match signed message." });
    }
    await this.assertSignature(parsed.address, input.message, input.signature);
    return this.bindings.bind(user, parsed.address, parsed.nonce, input.signature);
  }

  private parseSiwe(message: string) {
    try { return new SiweMessage(message); } catch { throw new BadRequestException("Invalid SIWE message."); }
  }
  private async assertSignature(address: string, message: string, signature: string) {
    const valid = await verifyMessage({ address: getAddress(address), message, signature: signature as `0x${string}` }).catch(() => false);
    if (!valid) throw new UnauthorizedException({ code: "invalid_signature", message: "Signature verification failed." });
  }
}
