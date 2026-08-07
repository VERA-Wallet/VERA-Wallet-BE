import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AnchorReceipt, AnchorType, EvidenceAnchor } from "@vera/interfaces";
import { createPublicClient, http, keccak256, toBytes } from "viem";
import { defineChain } from "viem";

@Injectable()
export class MockAnchorAdapter implements EvidenceAnchor {
  private readonly records = new Set<string>();
  private block = 1n;
  async anchor(payloadHash: string, type: AnchorType): Promise<AnchorReceipt> {
    const txHash = keccak256(toBytes(`${payloadHash}:${type}:${this.block}`));
    this.records.add(txHash);
    return { txHash, blockNumber: this.block++, anchoredAt: new Date() };
  }
  async verify(txHash: string) { return this.records.has(txHash); }
}

@Injectable()
export class OmniOneChainAdapter implements EvidenceAnchor {
  constructor(private readonly config: ConfigService) {}
  async anchor(_payloadHash: string, _type: AnchorType): Promise<AnchorReceipt> {
    void this.config.get("ANCHOR_PRIVATE_KEY");
    // TODO: submit only payloadHash and AnchorType after the production contract ABI is finalized.
    throw new ServiceUnavailableException("OmniOne Chain write adapter is not configured yet.");
  }
  async verify(txHash: string): Promise<boolean> {
    const chain = defineChain({ id: 201210, name: "OmniOne Chain", nativeCurrency: { name: "Gasless", symbol: "GAS", decimals: 18 }, rpcUrls: { default: { http: [this.config.get("OMNIONE_RPC_URL", "https://stage-chainapi.omnione.net")] } } });
    const client = createPublicClient({ chain, transport: http(chain.rpcUrls.default.http[0], { fetchOptions: { headers: this.config.get("OMNIONE_API_KEY") ? { "x-api-key": this.config.get<string>("OMNIONE_API_KEY")! } : {} } }) });
    try { await client.getTransactionReceipt({ hash: txHash as `0x${string}` }); return true; } catch { return false; }
  }
}
