/**
 * VeraAnchor 조회 — 탐색기 없는 환경에서 "무엇이 봉인돼 있나"를 RPC로 읽는다.
 *
 *   cd apps/backend && npx tsx contracts/inspect.mts                 # 전체 이벤트 목록 + 총 건수
 *   cd apps/backend && npx tsx contracts/inspect.mts 0x<payloadHash> # 해시 하나의 기록
 *
 * 읽기만 한다. 주소는 .env의 ANCHOR_CONTRACT_ADDRESS, 인증은 OMNIONE_API_KEY(Bearer).
 *
 * 노드가 eth_getLogs의 블록 범위를 제한한다(Besu 기본 5,000; "Request exceeds defined limit").
 * 그래서 (1) 컨트랙트가 생긴 블록을 이진 탐색으로 찾고 (2) 거기서부터 LOG_WINDOW 블록씩 끊어 읽는다.
 * ANCHOR_CONTRACT_DEPLOY_BLOCK을 주면 탐색을 건너뛴다.
 */
import "dotenv/config";
import { readFileSync } from "node:fs";
import { createPublicClient, defineChain, http, parseAbiItem } from "viem";

const artifact = JSON.parse(readFileSync(new URL("./VeraAnchor.json", import.meta.url), "utf8")) as { abi: readonly unknown[] };
const address = process.env.ANCHOR_CONTRACT_ADDRESS as `0x${string}` | undefined;
if (!address) throw new Error("ANCHOR_CONTRACT_ADDRESS가 없습니다.");

const rpcUrl = process.env.OMNIONE_RPC_URL ?? "https://stage-chainapi.omnione.net";
const apiKey = process.env.OMNIONE_API_KEY?.trim();
const chain = defineChain({ id: Number(process.env.OMNIONE_CHAIN_ID ?? "201210"), name: "OmniOne Chain", nativeCurrency: { name: "Gasless", symbol: "GAS", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const client = createPublicClient({ chain, transport: http(rpcUrl, { fetchOptions: { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {} } }) });
const abi = artifact.abi as never;
const ANCHORED = parseAbiItem("event Anchored(bytes32 indexed payloadHash, address indexed submitter, bytes32 indexed anchorTypeId, string anchorType, uint256 anchoredAt, uint256 blockNumber)");
const LOG_WINDOW = BigInt(process.env.ANCHOR_LOG_WINDOW ?? "1000");

const code = await client.getCode({ address });
const total = await client.readContract({ address, abi, functionName: "totalAnchors" }) as bigint;
console.log(`컨트랙트 ${address} · 코드 ${((code?.length ?? 2) - 2) / 2}바이트 · totalAnchors ${total}`);

/** 코드가 처음 나타난 블록. 그 전 블록에는 로그가 있을 수 없으니 거기서부터만 훑는다. */
async function deployBlock(latest: bigint): Promise<bigint> {
  if (process.env.ANCHOR_CONTRACT_DEPLOY_BLOCK) return BigInt(process.env.ANCHOR_CONTRACT_DEPLOY_BLOCK);
  let lo = 25_741_359n, hi = latest; // lo = 이 프로젝트의 첫 배포 블록(그 전엔 어떤 VeraAnchor도 없다)
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    const c = await client.getCode({ address, blockNumber: mid });
    if (c && c !== "0x") hi = mid; else lo = mid + 1n;
  }
  return lo;
}

const target = process.argv[2] as `0x${string}` | undefined;
if (target) {
  const [submitter, anchoredAt, blockNumber, anchorType] = await client.readContract({ address, abi, functionName: "anchors", args: [target] }) as [string, bigint, bigint, string];
  const anchored = await client.readContract({ address, abi, functionName: "isAnchored", args: [target] }) as boolean;
  console.log(`\n${target}\n  isAnchored ${anchored}`);
  if (anchored) console.log(`  submitter ${submitter} · type ${anchorType} · block ${blockNumber} · at ${new Date(Number(anchoredAt) * 1000).toISOString()}`);
} else {
  const latest = await client.getBlockNumber();
  const from = await deployBlock(latest);
  const logs = [];
  for (let start = from; start <= latest; start += LOG_WINDOW) {
    const end = start + LOG_WINDOW - 1n < latest ? start + LOG_WINDOW - 1n : latest;
    logs.push(...(await client.getLogs({ address, event: ANCHORED, fromBlock: start, toBlock: end })));
  }
  console.log(`배포 블록 ${from} ~ 최신 ${latest} (${latest - from + 1n}블록, ${LOG_WINDOW}블록씩) · Anchored 이벤트 ${logs.length}건`);
  for (const log of logs) {
    console.log(`  block ${log.blockNumber} · ${log.args.anchorType} · ${log.args.payloadHash} · by ${log.args.submitter} · tx ${log.transactionHash}`);
  }
}
