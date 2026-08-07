import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { ChainIndexer, IndexedTransaction } from "@vera/interfaces";

const chains = [1, 8453, 42161, 10, 137] as const;
const classifications = ["RECEIVE", "SEND", "EXCHANGE", "INTERNAL_TRANSFER", "UNKNOWN"] as const;

@Injectable()
export class MockAlchemyAdapter implements ChainIndexer {
  async fetchTransactions(address: string): Promise<IndexedTransaction[]> {
    return Array.from({ length: 25 }, (_, index) => {
      const n = index + 1;
      const classification = classifications[index % classifications.length];
      const unknownPrice = [3, 9, 17].includes(index);
      const assetType = (["NATIVE", "ERC20", "ERC721", "ERC1155"] as const)[index % 4];
      const direction = index % 2 === 0 ? "IN" : "OUT";
      const occurredAt = new Date(Date.UTC(2025, 0, 1 + index, 12));
      return {
        source: "mock" as const,
        txHash: `0x${n.toString(16).padStart(64, "0")}`,
        chain: String(chains[index % chains.length]),
        eventType: classification === "EXCHANGE" ? "swap" as const : direction === "IN" ? "transfer_in" as const : "transfer_out" as const,
        occurredAt,
        payload: {
          id: `event-${String(n).padStart(2, "0")}`, tx_hash: `0x${n.toString(16).padStart(64, "0")}`, chain_id: chains[index % chains.length], log_index: index,
          block_timestamp: occurredAt.toISOString(), wallet_address: address, direction, asset_type: assetType,
          asset_contract: assetType === "NATIVE" ? null : `0x${(1000 + index).toString(16).padStart(40, "0")}`,
          token_id: assetType === "ERC721" || assetType === "ERC1155" ? String(index + 100) : null,
          decimals: assetType === "ERC721" || assetType === "ERC1155" ? 0 : 18,
          raw_amount: assetType === "ERC721" || assetType === "ERC1155" ? String((index % 3) + 1) : `${n}${"0".repeat(16)}`,
          counterparty: `0x${(2000 + index).toString(16).padStart(40, "0")}`, gas_fee_native: "0.001", classification,
          confidence: [3, 9, 20].includes(index) ? 0.3 : 0.9, user_override: null,
          price_status: unknownPrice ? "UNKNOWN" : index % 3 === 0 ? "ESTIMATED" : "RESOLVED",
          fiat_value: unknownPrice ? null : `${n * 1000}.00`, fiat_currency: "KRW", symbol: assetType === "NATIVE" ? "ETH" : "TOKEN",
          _version: 1, _overrideHistory: [],
        },
      };
    });
  }
}

@Injectable()
export class AlchemyAdapter implements ChainIndexer {
  constructor(private readonly config: ConfigService) {}
  async fetchTransactions(_address: string): Promise<IndexedTransaction[]> {
    void this.config.get("ALCHEMY_API_KEY");
    // TODO: call Alchemy Transfers APIs and normalize provider-specific payloads.
    throw new ServiceUnavailableException("Alchemy real adapter is not configured yet.");
  }
}
