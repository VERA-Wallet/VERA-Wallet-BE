import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { getAddress } from "viem";
import type { AuthenticatedUser } from "../auth/auth.types";
import { OWN_WALLET_UNLINK, SYNC_CURSOR_REPOSITORY, TRANSACTION_SYNC_REPOSITORY } from "../indexer/indexer.tokens";
import type { OwnWalletUnlinkPort } from "../indexer/own-wallet-unlink.port";
import type { SyncCursorRepository } from "../indexer/sync-cursor.repository";
import type { TransactionSyncRepository } from "../indexer/transaction.repository";
import type { WalletBindingRepository } from "./wallet.repository";
import { WALLET_REPOSITORY } from "./wallet.tokens";

export type UnbindResult = { walletAddress: string; removedTransactions: number; rejudgedTransactions: number };

/**
 * 지갑 등록 해제. 바인딩 하나와 거기서 파생된 것(원장 행·동기화 커서)을 함께 지운다.
 *
 * 지우는 순서는 FK 순서다: 거래 → 커서 → 바인딩. 저장소마다 트랜잭션이 따로라 중간에 실패하면
 * 바인딩만 남을 수 있는데, 그 상태는 위험하지 않다 — 커서가 없으니 다음 동기화가 처음부터 다시 걷는다.
 *
 * 남은 지갑에서 이 지갑으로 보낸·받은 이동은 "내 지갑 간 이동" 판정을 잃는다 — 증명하던 바인딩이 사라졌으므로
 * 일반 전송으로 되돌린다(인덱서의 OwnWalletUnlinkPort).
 *
 * 체인에 올린 `binding` 앵커는 건드리지 않는다. 앵커에는 사용자 FK가 없고(프라이버시 경계), 체인 기록은 지울 수도 없다.
 * 주소는 이 계정의 바인딩에서만 찾는다 — 남의 지갑 주소를 넣어도 "없음"이다.
 */
@Injectable()
export class WalletUnbindService {
  constructor(
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletBindingRepository,
    @Inject(TRANSACTION_SYNC_REPOSITORY) private readonly transactions: TransactionSyncRepository,
    @Inject(SYNC_CURSOR_REPOSITORY) private readonly cursors: SyncCursorRepository,
    @Inject(OWN_WALLET_UNLINK) private readonly ownWalletLinks: OwnWalletUnlinkPort,
  ) {}

  async unbind(user: AuthenticatedUser, address: string): Promise<UnbindResult> {
    let checksumAddress: string;
    try {
      checksumAddress = getAddress(address);
    } catch {
      throw new BadRequestException({ code: "invalid_address", message: "Wallet address is not a valid EVM address." });
    }
    const binding = await this.wallets.findByUserAndAddress(user.sub, checksumAddress);
    if (!binding) throw new NotFoundException({ code: "wallet_not_found", message: "Wallet is not registered to this account." });

    const removedTransactions = await this.transactions.deleteAllForBinding(binding.id, user.sub);
    await this.cursors.deleteForBinding(binding.id);
    await this.wallets.delete(binding.id);
    const rejudgedTransactions = await this.ownWalletLinks.unlinkCounterparty(user.sub, binding.walletAddress);
    return { walletAddress: binding.walletAddress, removedTransactions, rejudgedTransactions };
  }
}
