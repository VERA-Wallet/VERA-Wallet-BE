import { Injectable, ServiceUnavailableException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AnchorReceipt, AnchorType, EvidenceAnchor } from "@vera/interfaces";
import { createPublicClient, createWalletClient, encodeAbiParameters, http, keccak256, toBytes, type Chain } from "viem";
import { defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { redactError } from "../shared/redact";

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

/**
 * OmniOne RPC 인증 헤더.
 *
 * 이 노드가 받는 방식은 **URL 쿼리의 `?token=`** 과 **`Authorization: Bearer`** 둘이다.
 * 예전에 보내던 `x-api-key`는 받지 않는다(실측 401) — 그래서 `OMNIONE_API_KEY`를 채워도 아무 일도
 * 일어나지 않았다.
 *
 * 헤더 쪽을 기본으로 둔다: 토큰이 URL에 있으면 viem이 실패 메시지에 URL을 통째로 넣어(`URL: ${...}`)
 * 로그와 에러에 자격증명이 평문으로 남는다. 헤더로 보내면 그 경로 자체가 사라진다
 * (`shared/redact.ts`는 URL에 토큰을 둔 기존 설정을 위한 이중 안전장치로 남는다).
 */
export function rpcAuthHeaders(apiKey?: string): Record<string, string> {
  const token = apiKey?.trim();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

const ANCHOR_CONTRACT_ABI = [{ type: "function", name: "anchor", stateMutability: "nonpayable", inputs: [{ name: "payloadHash", type: "bytes32" }, { name: "anchorType", type: "string" }], outputs: [] }] as const;

@Injectable()
export class OmniOneChainAdapter implements EvidenceAnchor {
  constructor(private readonly config: ConfigService) {}
  private chain(): Chain {
    return defineChain({ id: Number(this.config.get("OMNIONE_CHAIN_ID", "201210")), name: "OmniOne Chain", nativeCurrency: { name: "Gasless", symbol: "GAS", decimals: 18 }, rpcUrls: { default: { http: [this.config.get("OMNIONE_RPC_URL", "https://stage-chainapi.omnione.net")] } } });
  }
  private transport(chain: Chain) {
    return http(chain.rpcUrls.default.http[0], { fetchOptions: { headers: rpcAuthHeaders(this.config.get<string>("OMNIONE_API_KEY")) } });
  }

  /**
   * 체인 호출은 전부 이 래퍼를 지난다. RPC 인증 토큰이 **URL 쿼리**에 실려 있어(`?token=<JWT>`)
   * viem의 실패 메시지에 그대로 딸려 나오기 때문이다 — 로그에도 응답에도 평문으로 남으면 안 된다.
   */
  private async guarded<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      throw redactError(error);
    }
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
    const txHash = await this.guarded(() => contract
      ? wallet.writeContract({ address: contract as `0x${string}`, abi: ANCHOR_CONTRACT_ABI, functionName: "anchor", args: [hash, type] })
      : wallet.sendTransaction({ to: account.address, value: 0n, data: encodeAbiParameters([{ type: "bytes32" }, { type: "string" }], [hash, type]) }));
    const receipt = await this.guarded(() => client.waitForTransactionReceipt({ hash: txHash }));
    if (receipt.status !== "success") throw new ServiceUnavailableException(`OmniOne Chain anchor transaction reverted: ${txHash}`);
    return { txHash: receipt.transactionHash, blockNumber: receipt.blockNumber, anchoredAt: new Date() };
  }
  async verify(txHash: string): Promise<boolean> {
    const chain = this.chain();
    const client = createPublicClient({ chain, transport: this.transport(chain) });
    // 여기는 원래 예외를 삼키지만, 삼키기 전에도 메시지가 로거로 새지 않도록 같은 래퍼를 쓴다.
    try { return (await this.guarded(() => client.getTransactionReceipt({ hash: txHash as `0x${string}` }))).status === "success"; } catch { return false; }
  }
}
