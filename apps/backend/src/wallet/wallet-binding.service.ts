import { Inject, Injectable } from "@nestjs/common";
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
    const binding = await this.wallets.upsert({ userId: user.sub, walletAddress: checksumAddress, bindingHash });
    const anchor = await this.anchors.submit(bindingHash, "binding");
    return { bindingId: binding.id, walletAddress: binding.walletAddress, bindingHash, anchorStatus: anchor?.status ?? "pending" };
  }
}
