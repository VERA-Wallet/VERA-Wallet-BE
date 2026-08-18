import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AnchorReceipt, AnchorType, EvidenceAnchor } from "@vera/interfaces";
import { createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, toBytes, type Chain } from "viem";
import { defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";

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

const ANCHOR_CONTRACT_ABI = [{ type: "function", name: "anchor", stateMutability: "nonpayable", inputs: [{ name: "payloadHash", type: "bytes32" }, { name: "anchorType", type: "string" }], outputs: [] }] as const;

@Injectable()
export class OmniOneChainAdapter implements EvidenceAnchor {
  constructor(private readonly config: ConfigService) {}
  private chain(): Chain {
    return defineChain({ id: Number(this.config.get("OMNIONE_CHAIN_ID", "201210")), name: "OmniOne Chain", nativeCurrency: { name: "Gasless", symbol: "GAS", decimals: 18 }, rpcUrls: { default: { http: [this.config.get("OMNIONE_RPC_URL", "https://stage-chainapi.omnione.net")] } } });
  }
  private transport(chain: Chain) {
    return http(chain.rpcUrls.default.http[0], { fetchOptions: { headers: this.config.get("OMNIONE_API_KEY") ? { "x-api-key": this.config.get<string>("OMNIONE_API_KEY")! } : {} } });
  }
  async anchor(payloadHash: string, type: AnchorType): Promise<AnchorReceipt> {
    const rawKey = this.config.get<string>("ANCHOR_PRIVATE_KEY");
    if (!rawKey) throw new ServiceUnavailableException("OmniOne Chain write adapter is not configured yet.");
    const account = privateKeyToAccount((rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`);
    const chain = this.chain();
    const transport = this.transport(chain);
    const wallet = createWalletClient({ account, chain, transport });
    const client = createPublicClient({ chain, transport });
    const hash = /^0x[0-9a-fA-F]{64}$/.test(payloadHash) ? (payloadHash as `0x${string}`) : keccak256(toBytes(payloadHash));
    const contract = this.config.get<string>("ANCHOR_CONTRACT_ADDRESS");
    const txHash = contract
      ? await wallet.writeContract({ address: contract as `0x${string}`, abi: ANCHOR_CONTRACT_ABI, functionName: "anchor", args: [hash, type] })
      : await wallet.sendTransaction({ to: account.address, value: 0n, data: encodeAbiParameters([{ type: "bytes32" }, { type: "string" }], [hash, type]) });
    const receipt = await client.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") throw new ServiceUnavailableException(`OmniOne Chain anchor transaction reverted: ${txHash}`);
    return { txHash: receipt.transactionHash, blockNumber: receipt.blockNumber, anchoredAt: new Date() };
  }
  async verify(txHash: string): Promise<boolean> {
    const chain = this.chain();
    const client = createPublicClient({ chain, transport: this.transport(chain) });
    try { return (await client.getTransactionReceipt({ hash: txHash as `0x${string}` })).status === "success"; } catch { return false; }
  }
}
