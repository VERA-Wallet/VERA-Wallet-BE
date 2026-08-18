import { Inject, Injectable, NotFoundException } from "@nestjs/common";
import type { ChainIndexer } from "@vera/interfaces";
import { keccak256, toBytes } from "viem";
import type { AnchorSubmissionPort } from "../anchor/anchor.port";
import { ANCHOR_SUBMISSION } from "../anchor/anchor.tokens";
import type { WalletRepository } from "../wallet/wallet.repository";
import { WALLET_REPOSITORY } from "../wallet/wallet.tokens";
import type { TransactionSyncRepository } from "./transaction.repository";
import { CHAIN_INDEXER, TRANSACTION_SYNC_REPOSITORY } from "./indexer.tokens";

@Injectable()
export class IndexerService {
  constructor(
    @Inject(CHAIN_INDEXER) private readonly indexer: ChainIndexer,
    @Inject(WALLET_REPOSITORY) private readonly wallets: WalletRepository,
    @Inject(TRANSACTION_SYNC_REPOSITORY) private readonly transactions: TransactionSyncRepository,
    @Inject(ANCHOR_SUBMISSION) private readonly anchors: AnchorSubmissionPort,
  ) {}

  async sync(userId: string) {
    const binding = await this.wallets.findLatestByUser(userId);
    if (!binding) throw new NotFoundException("A bound wallet is required before sync.");
    const fetched = await this.indexer.fetchTransactions(binding.walletAddress);
    const withHashes = fetched.map((item) => ({
      ...item,
      payload: { ...item.payload, _anchorPayloadHash: keccak256(toBytes(JSON.stringify({ txHash: item.txHash, eventType: item.eventType, payload: item.payload }))) },
    }));
    const stored = await this.transactions.save(binding.id, userId, withHashes);
    for (const transaction of stored) {
      const payloadHash = String(transaction.payload._anchorPayloadHash);
      await this.anchors.submit(payloadHash, "audit");
    }
    return { bindingId: binding.id, walletAddress: binding.walletAddress, fetched: fetched.length, normalized: stored.length };
  }
}
