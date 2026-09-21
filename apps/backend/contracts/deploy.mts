/**
 * VeraAnchor를 OmniOne Chain에 배포한다.
 *
 *   cd apps/backend && npx tsx contracts/deploy.mts
 *
 * 앵커 어댑터와 같은 자격증명(.env의 ANCHOR_PRIVATE_KEY, OMNIONE_RPC_URL, OMNIONE_API_KEY)을 쓴다 —
 * 배포 계정과 앵커 계정이 같아야 콘솔·탐색기에서 "이 계정의 활동"이 한 줄로 이어진다.
 * 성공하면 주소를 찍는다. .env에 ANCHOR_CONTRACT_ADDRESS로 넣으면 어댑터가 컨트랙트 경로로 전환된다.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const artifact = JSON.parse(readFileSync(new URL("./VeraAnchor.json", import.meta.url), "utf8")) as {
  abi: readonly unknown[];
  bytecode: `0x${string}`;
  evmVersion: string;
};

const rawKey = process.env.ANCHOR_PRIVATE_KEY;
if (!rawKey) throw new Error("ANCHOR_PRIVATE_KEY가 없습니다.");
const account = privateKeyToAccount((rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`);

const rpcUrl = process.env.OMNIONE_RPC_URL ?? "https://stage-chainapi.omnione.net";
const apiKey = process.env.OMNIONE_API_KEY?.trim();
const chain = defineChain({
  id: Number(process.env.OMNIONE_CHAIN_ID ?? "201210"),
  name: "OmniOne Chain",
  nativeCurrency: { name: "Gasless", symbol: "GAS", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const transport = http(rpcUrl, { fetchOptions: { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} } });
const publicClient = createPublicClient({ chain, transport });
const wallet = createWalletClient({ account, chain, transport });

console.log(`배포 계정 ${account.address} · chainId ${await publicClient.getChainId()} · evm ${artifact.evmVersion}`);
const hash = await wallet.deployContract({ abi: artifact.abi as never, bytecode: artifact.bytecode });
console.log(`배포 tx ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`배포 실패: ${receipt.status}`);
const code = await publicClient.getCode({ address: receipt.contractAddress });
console.log(`블록 ${receipt.blockNumber} · 코드 ${((code?.length ?? 2) - 2) / 2}바이트`);
console.log(`\nANCHOR_CONTRACT_ADDRESS=${receipt.contractAddress}`);
