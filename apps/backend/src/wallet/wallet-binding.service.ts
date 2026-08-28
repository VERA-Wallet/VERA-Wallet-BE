import { BadRequestException, Inject, Injectable } from "@nestjs/common";
import { encodePacked, getAddress, keccak256 } from "viem";
import type { AnchorSubmissionPort } from "../anchor/anchor.port";
import { ANCHOR_SUBMISSION } from "../anchor/anchor.tokens";
import type { AuthenticatedUser } from "../auth/auth.types";
import type { WalletBindingRepository } from "./wallet.repository";
import { WALLET_BINDING_REPOSITORY } from "./wallet.tokens";


@Injectable()
export class WalletBindingService {
  constructor(@Inject(WALLET_BINDING_REPOSITORY) private readonly wallets: WalletBindingRepository, @Inject(ANCHOR_SUBMISSION) private readonly anchors: AnchorSubmissionPort) {}
  async bind(user: AuthenticatedUser, address: string, nonce: string, signature: string) {
    const checksumAddress = getAddress(address);
    const bindingHash = keccak256(encodePacked(["address", "bytes32", "string", "bytes"], [checksumAddress, user.didHash as `0x${string}`, nonce, signature as `0x${string}`]));
    // Signature verified upstream -> a verified siwe binding (or promotion from watch_only).
    const binding = await this.wallets.upsert({ userId: user.sub, walletAddress: checksumAddress, bindingHash, verificationMethod: "siwe", verifiedAt: new Date() });
    // Anchor submission is reserved for verified bindings.
    const anchor = await this.anchors.submit(bindingHash, "binding");
    return { bindingId: binding.id, walletAddress: binding.walletAddress, bindingHash, anchorStatus: anchor?.status ?? "pending" };
  }

  // Watch-only: track an address with no signature. Never anchors, never downgrades an
  // already-verified binding, and is idempotent for an existing binding of the same address.
  async watch(user: AuthenticatedUser, address: string) {
    let checksumAddress: string;
    try {
      checksumAddress = getAddress(address);
    } catch {
      throw new BadRequestException({ code: "invalid_address", message: "Wallet address is not a valid EVM address." });
    }
    const existing = await this.wallets.findByUserAndAddress(user.sub, checksumAddress);
    // No chainId: a watch-only registration has no signed chain, and fabricating one
    // (the old hardcoded 1) misrepresents a chain-agnostic EVM address.
    if (existing) return { walletAddress: existing.walletAddress };
    const binding = await this.wallets.upsert({ userId: user.sub, walletAddress: checksumAddress, bindingHash: null, verificationMethod: "watch_only", verifiedAt: null });
    return { walletAddress: binding.walletAddress };
  }
}
