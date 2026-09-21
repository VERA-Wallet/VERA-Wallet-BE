/**
 * 동기화 작업의 진척.
 *
 * 작업 상태가 queued/running/done/failed뿐이면 큰 지갑은 몇 분 동안 "running" 한 단어만 보인다. 화면은
 * 타이머로 단계를 연출하다 마지막 단계에서 멈추고, 사용자는 멈춘 건지 도는 건지 모른다. 그래서 인덱서가
 * (지갑, 체인)마다 지금 무엇을 하는지와 얼마나 했는지를 여기 적고, 작업 레코드가 그 스냅샷을 들고 있는다.
 *
 * 단계는 사용자가 보는 순서 그대로다: 받는 중(fetching) → 내부 이동 추적(tracing) → 가격(pricing) → 저장(saving) → 끝.
 * 체인은 병렬로 돌므로 한 시점에 여러 체인이 서로 다른 단계에 있을 수 있다.
 */
export type SyncChainPhase = "pending" | "fetching" | "tracing" | "pricing" | "saving" | "done" | "failed";

export type SyncChainProgress = {
  chainId: number;
  phase: SyncChainPhase;
  /** 받은 이전(transfer) 수. 정규화가 끝나면 그 체인의 행 수가 된다. */
  fetched: number;
  /** 내부 이동 추적 진척. 추적하는 체인에서만 있다. */
  traced?: { done: number; total: number };
  /** 저장을 마친 행 수. */
  saved: number;
  /** 실패했을 때 그 이유. 어댑터·저장이 로그에만 남기던 문장을 화면까지 보낸다. */
  message?: string;
};

export type SyncBindingProgress = { bindingId: string; walletAddress: string; chains: SyncChainProgress[] };

export type SyncProgress = { bindings: SyncBindingProgress[]; updatedAt: string };

/** 카운터만 바뀐 갱신은 이보다 촘촘히 내보내지 않는다. 단계가 바뀌면 즉시 내보낸다. */
export const PROGRESS_MIN_INTERVAL_MS = 250;

/** 문장은 잘라 둔다 — 스택이나 원문 응답이 작업 레코드에 통째로 들어가지 않게. */
const trimMessage = (message: string): string => message.slice(0, 200);

type ScanUpdate = { phase: "fetching" | "tracing"; fetched: number; traced?: { done: number; total: number } };

/** 체인 하나의 진척을 바꾸는 손잡이. 서비스와 어댑터 훅이 이것만 만진다. */
export type ChainProgressHandle = {
  scanning(update: ScanUpdate): void;
  pricing(fetched: number): void;
  saving(saved: number): void;
  done(rows: number): void;
  fail(message: string): void;
};

export class SyncProgressTracker {
  private readonly bindings: SyncBindingProgress[];
  private readonly index = new Map<string, SyncChainProgress>();
  private lastEmittedAt = Number.NEGATIVE_INFINITY;

  constructor(
    bindings: readonly { id: string; walletAddress: string }[],
    chainIds: readonly number[],
    private readonly emit?: (progress: SyncProgress) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly minIntervalMs = PROGRESS_MIN_INTERVAL_MS,
  ) {
    // 시작할 때 (지갑, 체인)을 전부 '대기'로 등록한다. 그래야 화면이 "몇 곳 중 몇 곳"을 셀 수 있고,
    // 아직 차례가 오지 않은 지갑도 목록에서 사라지지 않는다.
    this.bindings = bindings.map((binding) => ({
      bindingId: binding.id,
      walletAddress: binding.walletAddress,
      chains: chainIds.map((chainId) => ({ chainId, phase: "pending" as const, fetched: 0, saved: 0 })),
    }));
    for (const binding of this.bindings) for (const chain of binding.chains) this.index.set(`${binding.bindingId}:${chain.chainId}`, chain);
    this.publish(true);
  }

  /** 지금 상태의 복사본. 내보낸 스냅샷은 이후 갱신에 흔들리지 않는다. */
  snapshot(): SyncProgress {
    return {
      bindings: this.bindings.map((binding) => ({
        ...binding,
        chains: binding.chains.map((chain) => ({ ...chain, ...(chain.traced ? { traced: { ...chain.traced } } : {}) })),
      })),
      updatedAt: new Date(this.now()).toISOString(),
    };
  }

  chain(bindingId: string, chainId: number): ChainProgressHandle {
    const entry = this.entry(bindingId, chainId);
    const set = (patch: Partial<SyncChainProgress>, phaseChanged: boolean) => {
      Object.assign(entry, patch);
      this.publish(phaseChanged);
    };
    const terminal = () => entry.phase === "done" || entry.phase === "failed";
    return {
      // 실패·완료 뒤에 도착하는 늦은 콜백(동시에 돌던 추적 요청이 마저 끝나며 부르는 것)은 상태를 되돌리지 않는다.
      scanning: (update) => {
        if (terminal()) return;
        const phaseChanged = entry.phase !== update.phase;
        set({ phase: update.phase, fetched: update.fetched, ...(update.traced ? { traced: update.traced } : {}) }, phaseChanged);
      },
      pricing: (fetched) => {
        if (terminal()) return;
        set({ phase: "pricing", fetched }, true);
      },
      saving: (saved) => {
        if (terminal()) return;
        set({ phase: "saving", saved }, entry.phase !== "saving");
      },
      done: (rows) => set({ phase: "done", fetched: rows, saved: rows }, true),
      // 이미 실패한 체인의 첫 사유를 지키고, 끝난 체인은 실패로 되돌리지 않는다.
      fail: (message) => {
        if (terminal()) return;
        set({ phase: "failed", message: trimMessage(message) }, true);
      },
    };
  }

  private entry(bindingId: string, chainId: number): SyncChainProgress {
    const key = `${bindingId}:${chainId}`;
    const existing = this.index.get(key);
    if (existing) return existing;
    // 등록되지 않은 조합(예: 어댑터가 새 체인을 말함)은 조용히 버리지 않고 목록에 붙인다.
    const created: SyncChainProgress = { chainId, phase: "pending", fetched: 0, saved: 0 };
    const binding = this.bindings.find((item) => item.bindingId === bindingId);
    if (binding) binding.chains.push(created);
    this.index.set(key, created);
    return created;
  }

  private publish(force: boolean): void {
    if (!this.emit) return;
    const at = this.now();
    if (!force && at - this.lastEmittedAt < this.minIntervalMs) return;
    this.lastEmittedAt = at;
    this.emit(this.snapshot());
  }
}
