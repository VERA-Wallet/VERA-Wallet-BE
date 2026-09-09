# 세금 원가 파이프라인 보완 계획

```
status: pending approval
revision: 4 (합의 도달 — Architect SOUND / Critic APPROVE. 비블로킹 제안 8건 반영)
scope: packages/tax-engine, apps/backend/src/indexer, apps/backend/src/tax
out of scope: FIFO, 1-hour price bucket, 3-tier response cache
배포 순서: PR-3 → PR-1 → PR-2 (§2.0 참조 — 작업 번호와 배포 순서가 다르다)
```

VERA의 원장형 구조(인덱서 → Postgres → 저장 시점 분류·브릿지·시세 → 읽기 시점 이동평균 fold)를 유지한 채 3가지 결함을 고친다. DeSpell의 FIFO 파이프라인 문서에서 가져오는 것은 **규칙**(가스 귀속, ledger.move)이지 **구조**(FIFO lot 추적)가 아니다.

---

## 1. RALPLAN-DR

### Principles

1. **저장은 관측값, 읽기는 판정값.** 체인에서 관측한 사실만 payload에 쓰고, 순서 의존 파생값(원가·실현손익)은 읽기 시점 fold로만 만든다.
2. **모르면 비운다.** **개별 이벤트에는 아는 값을 그대로 내보내고, 합계에는 완전히 아는 항목만 더한다.** 빠진 것은 `limitations`로 드러낸다.
3. **비과세 이동은 손익을 만들지 않는다.** 브릿지·내부 이체는 과세 라인을 만들지 않되, 원가는 소멸하지 않고 목적지로 이동한다.
4. **자동 판정은 실제 처분을 지우지 않는다.** 불확실하면 오늘의 보수적 동작(제외 + 플래그)으로 되돌린다.
5. **엔진은 순수 함수.** `computeCostBasis`는 외부 I/O를 하지 않는다. **그 대가로 캐시 미스 복구 책임은 호출자에게 있다.**

### Decision Drivers (상위 3)

| # | 드라이버 | 설명 |
|---|---|---|
| D1 | 앵커 해시 churn | `_anchorPayloadHash = keccak(JSON({txHash, eventType, payload}))`(`indexer.service.ts:139`). `mergeSavedPayload`는 user_override가 없는 행의 해시를 리싱크 때 덮어쓴다. payload에 필드를 추가하면 전 원장이 재앵커된다. 단, **필드 값 변경만으로도 같은 churn이 일어난다**(enrichment의 `fiat_value`/`price_status`가 이미 그 경로다). |
| D2 | CoinGecko 무료 쿼터 | 분당 ~30콜. 조회 축은 (chain, assetKey, day)이고 `HistoricalPrice`가 영구 캐시라, 새 축이 **캐시에 들어가는지**가 비용을 결정한다. |
| D3 | 기존 사용자 숫자 변화 | `periodPnl`·`taxableGains`가 현금흐름에서 실현손익으로 바뀌면 FE가 보던 수치가 즉시 달라진다. 필드명을 유지하면서 산출 근거를 응답에 명시해야 한다. |

### 결정 0 — 원가 미확인 처분(`disposal_exceeds_holdings`)을 합계에 넣는가

**결정: 합계에서 제외하고 `totals.unresolvedProceeds`로 따로 보고한다.**

원칙 2는 "완전히 아는 항목만 더한다"이다. 시세 미확인(E4)은 proceeds를 몰라 빼면서, 원가 미확인(E5)은 원가를 0으로 간주해 전액 이익으로 더하는 것은 같은 원칙의 반대 적용이다. 보유 초과 처분의 원가는 "0"이 아니라 "모름"이다.

- 개별 이벤트에는 아는 값을 그대로 내보낸다: `proceeds` 실제 값, `costBasis "0"`, `realizedPnl`은 proceeds와 동일, `review: "disposal_exceeds_holdings"`. 오늘 동작 유지이며 FE 상세 화면은 변하지 않는다.
- **합계에서만 제외**하고 빠진 금액을 `totals.unresolvedProceeds`(신규)로 노출한다.
- `limitations[kind="review"]`에 이벤트 id를 싣는다.

부분 초과(`cell.qty > 0`이지만 `qty > cell.qty`)도 동일 처리한다. 인식 원가의 일부만 확실한 혼합 상태를 합계에 넣는 것이 더 나쁜 근사다.

### 결정 1 — 과세연도 귀속 방식

| 옵션 | 내용 | Pros | Cons |
|---|---|---|---|
| **A (채택)** | 전체 이력 fold → 각 처분의 `realizedPnl`을 **처분 시점 연도**에 귀속. 취득은 0 기여 | 이동평균법의 정의와 일치. 전년도 취득 원가가 살아있음. 엔진 변경 0 | 읽기마다 전체 이력 fold(규모는 §리스크 표 참조) |
| B | 연도 필터를 먼저 걸고 부분집합만 fold | 계산량 최소 | **무효.** 전년도 취득이 사라져 모든 처분이 `disposal_exceeds_holdings`가 된다. `estimate.ts:12-18`의 현재 버그 |
| C | 연말 스냅샷을 영속화하고 연도별 fold | 대용량에서 빠름 | 파생값 저장으로 원칙 1 위반. 재분류·리싱크마다 무효화 필요 |

**채택: A.**

### 결정 2 — 가스의 KRW 평가 위치

| 옵션 | 내용 | Pros | Cons |
|---|---|---|---|
| A | enrichment가 payload에 `gas_fee_fiat`를 **영속 기록** | 읽기 경로 단순 | 파생값 영속화로 **원칙 1 위반**. 새 필드 → 전 원장 재앵커(D1) |
| **B (채택)** | (chain, day) **native 종가를 `HistoricalPrice` 캐시에만 워밍**하고 읽기 시점에 맵으로 주입 | 파생값 비저장(원칙 1). payload·스키마 무변경 | 읽기 경로에 조회 1회 + fold 캐시 키 확장. **기존 사용자 백필 필요** |
| C | `gas_fee_fiat`를 쓰되 해시 대상에서 제외 | 신규 필드의 해시 영향 차단 | 해싱 정의를 바꾸는 순간 전 기존 행의 해시가 달라진다. 여전히 파생값 영속화 |
| D | 가스를 F1까지 **아예 반영하지 않는다**(PR-2 전체 연기) | 실데이터 영향 0이므로 코드·리뷰·백필 비용 절약 | 규칙 없는 상태로 F1을 진행하면 F1이 "데이터 수집 + 세무 규칙 + 백필"을 한꺼번에 짊어진다 |

**채택: B.** A·C는 파생값을 저장한다는 같은 이유로 탈락한다(C의 "앵커 의미론 훼손" 논거는 성립하지 않는다 — `bridge-linking.service.ts:213-220`이 이미 classification·bridge_group_id를 쓰면서 기존 해시를 보존하므로 "해시가 payload 전체를 커밋한다"는 전제는 깨져 있다). D도 유효한 후보이며, 승인자가 PR-2를 F1과 합치기로 하면 이 계획의 PR-2를 그대로 F1에 흡수하면 된다.

> **선행 조건.** 실제 Alchemy 어댑터는 `gas_fee_native: "0"`을 하드코딩한다(`indexer.adapters.ts:416`). 즉 **PR-2를 머지해도 실데이터 숫자는 변하지 않는다.** 영수증 조회로 값을 채우는 F1은 **기존 필드의 값을 바꾸므로 필드 추가 없이도 해시 churn이 발생한다. 옵션 B는 D1을 회피하는 것이 아니라 PR-2 시점까지 미룰 뿐이다.**

### 결정 3 — 브릿지 이동과 수수료 델타

| 옵션 | 내용 | Pros | Cons |
|---|---|---|---|
| i | 델타를 proceeds 0의 처분으로 인식 | 손실 즉시 인식 | 비과세 이동에서 과세 손실을 만든다(원칙 3 위반) |
| **ii (채택)** | 이동 **원가 총액을 전부** 목적지 수령 수량에 실어 평균단가를 올린다 | 원가 총량 보존. PR-2의 취득 가스 자본화와 동일한 사고 | 목적지 평균단가가 수수료만큼 상승 |
| iii | 델타분 원가를 버린다 | 구현 최단 | 원가 증발 → 미래 손익 과대계상 |
| iv | **asset key를 체인 비스코프 canonical key로 교체**(`bridge-linking.service.ts:147-162`가 이미 `native:ETH`/`token:USDC` 계산) 후 payload에 실어 그 키로 fold | 이동 로직·에스크로·사전 스캔·정렬 문제가 전부 사라진다. 구조적으로 최선 | payload 필드 추가 → **D1 직격**. canonical 해석 실패 자산은 여전히 체인 스코프라 두 체계 공존. 정규화 실수가 서로 다른 자산의 원가를 섞을 위험 |

**채택: ii.** **iv는 설계로는 가장 우수하지만 D1 때문에 기각한다.** 그 비용을 감수할 시점은 이미 churn이 확정된 F1과 묶을 때이며 F3에 등록한다.

**`bridge_group_id` 없는 수동 INTERNAL_TRANSFER**: 이동하지 않고 제외를 유지하되 `excludeReason`을 `internal_transfer_unlinked`로 분리한다.

### 추가 항목 판정

- **스왑 상대 레그 평가**: Follow-up F2로 연기. 결정 0 이후 `unresolvedProceeds`를 실제로 줄이는 최우선 후속 항목이지만, 이는 평가(valuation) 관심사이고 PR-1~3의 숫자 변화와 섞이면 회귀 원인 분리가 어렵다.
- **proceeds/cost/pnl 독립 판정**: PR-1 범위 안. 결정 0이 구현체다.

---

## 2. PR 계획

### 2.0 배포 순서와 그 이유 (블로킹 B3)

**작업 번호는 PR-1/2/3을 유지하되 배포 순서는 PR-3 → PR-1 → PR-2로 한다.**

PR-1만 먼저 배포되면 브릿지 사용자에게 골짜기가 생긴다. (a) INTERNAL_TRANSFER 레그가 합계에서 빠지고, (b) 목적지 체인 처분이 전부 `disposal_exceeds_holdings`라 결정 0에 의해 합계에서 또 빠진다. 결과적으로 `taxableGains`가 0 근처로 붕괴하고 전액이 `unresolvedProceeds`로 옮겨간다. 그 구간에 신고하면 과소 신고가 된다.

| 선택지 | 판단 |
|---|---|
| (i) PR-1과 PR-3 동시 배포 | 골짜기는 없앤다. 단 하나의 큰 diff가 되어 회귀 원인 분리(bisect)가 어렵다. **PR-3이 일정상 지연될 때의 대체안으로 남긴다** |
| **(ii) PR-3을 먼저 배포 (채택)** | PR-3은 **어떤 집계도 바꾸지 않는다** — 이벤트별 `cost_basis`/`pnl`만 정확해지고 `summary`/`estimate`는 그대로 현금흐름이다. 따라서 PR-3 단독 배포에는 자체 골짜기가 없고, PR-1이 결정 0으로 합계를 게이트하기 전에 목적지 체인의 `disposal_exceeds_holdings` 모수를 미리 제거한다 |
| (iii) 결정 0을 플래그로 게이트 | 두 가지 집계 동작을 동시에 지원해야 하고 설정 축이 하나 늘며, 플래그를 언제 끄는지에 대한 결정이 다시 필요하다. 기각 |

PR-3은 PR-1에 의존하지 않는다(순수 엔진 변경). PR-2만 PR-1이 추출한 `CostBasisSnapshotService`에 의존하므로 마지막이다.

---

### PR-3 — 브릿지 페어에서 원가 이동(ledger.move) · **배포 1순위**

**문제.** `bridge-linking.service.ts`가 두 레그를 INTERNAL_TRANSFER로 만들고 엔진이 둘 다 제외한다. 목적지 asset key(`8453:NATIVE:native:`)는 잔고 0에서 시작해 이후 처분이 전부 `disposal_exceeds_holdings`가 된다.

**변경 파일**

- `packages/tax-engine/src/core/cost-basis.ts` — 사전 스캔 + 이동 + **정렬 후처리 패스**
- `packages/tax-engine/src/core/cost-basis.spec.ts` — 케이스 추가
- `apps/backend/src/indexer/event.presenter.ts` — `bridge_move` 노출
- `apps/backend/src/indexer/event-query.service.spec.ts` — 통합 케이스 1건

**동작 변경**

1. **사전 스캔.** fold 전에 `bridge_group_id`별로 레그를 모아 **OUT 1개 + IN 1개가 모두 입력에 존재하는 완전한 페어만** 이동 대상으로 등록한다. 불완전하면 이동하지 않는다.
2. **순서 보정 — 비교자를 건드리지 않는다 (블로킹 B1).** revision 2의 "비교자에 그룹 내 OUT 우선 항 추가" 안은 **철회한다.** 그 비교자는 전순서를 깨뜨린다: 동일 `occurredAt`에서 A=IN(group g, log 0), B=OUT(group g, log 5), C=무관(log 2)이면 `A<C`, `C<B`, `B<A`의 순환이 생기고 `Array.prototype.sort`는 구현 정의된 임의 순서를 낸다.
   - **채택: 정렬 후 안정적 후처리 패스.** 기존 비교자로 정렬을 끝낸 뒤, 완전 페어 중 **IN이 짝 OUT보다 앞에 있는 경우에만** 그 IN을 배열에서 빼내 OUT 바로 뒤에 다시 넣는다. 다른 모든 이벤트의 상대 순서는 그대로 보존된다(안정 이동). O(n)이고 결정적이다.
   - **패스는 순서 역전을 조건 없이 교정한다.** 브릿지 링킹이 `delta >= 0`을 요구하므로(`bridge-linking.service.ts` `withinWindow`) 지금은 역전이 동일 시각 동률에서만 발생하지만, 이는 **발동 빈도의 근거일 뿐 패스의 전제 조건이 아니다.** 링킹이 나중에 시계 오차를 허용하도록 완화되어 IN 시각이 OUT보다 이른 페어가 생겨도 엔진은 그대로 버틴다.
   - **부수 효과 (B10).** 짝 IN을 OUT 뒤로 옮기면 그 사이에 있던 동일 시각 이벤트는 IN보다 앞서게 된다. 목적지 체인 이벤트가 거기 있으면 아직 크레딧되지 않은 셀을 보고 `disposal_exceeds_holdings`가 붙는다. **이를 의도된 동작으로 확정한다** — 동일 시각에는 진짜 순서에 대한 근거가 없고, 패스는 원장 의미상 반드시 필요한 순서(차변이 대변보다 앞선다) 하나만 교정하며 나머지는 결정적 기본 정렬에 맡긴다. 결과는 보수적 플래그(결정 0에 의해 합계에서 제외)이지 지어낸 원가가 아니므로 원칙 4에 부합한다. 소스 OUT을 앞으로 당기는 반대 방향 보정도 같은 위험을 소스 체인으로 옮길 뿐이라 채택하지 않는다.
   - **기각한 대안 — 지연 크레딧**(IN을 만나면 보류했다가 OUT 처리 시점에 차변·대변을 한 번에 적용): 임의 순서 역전까지 견디지만, 목적지 셀의 크레딧 시점이 그 사이의 다른 목적지 이벤트와 어긋날 수 있어 추론이 어렵다. 실제 역전이 동률뿐이므로 이득이 없다.
   - **2차 방어는 유지.** 에스크로가 빈 상태에서 이동 IN을 만나면 **0원가를 가산하지 않고** 그 IN을 일반 제외로 처리하며 짝 OUT에 `review: "bridge_move_unmatched"`를 남긴다.
3. **OUT 레그.** 소스 asset key에서 `min(qty, cell.qty)`를 차감하고 그 **원가 총액**(`disposable × avgCost`)을 그룹 에스크로에 넣는다. `excluded: true` 유지, `proceeds`/`realizedPnl`은 `null`, `bridgeMove: "out"`.
4. **IN 레그.** 에스크로의 원가 총액을 그대로 목적지 asset key에 수령 수량과 함께 가산한다. `newAvg = (qty×avgCost + movedCost) / (qty + inQty)`. `bridgeMove: "in"`.
5. **에스크로 미소진.** fold 종료 시 남은 에스크로가 있으면 해당 OUT에 `review: "bridge_move_unmatched"`.
6. **자산 키 불일치 허용.** 이동은 그룹 id로 정의되므로 소스 `1:NATIVE:native:` → 목적지 `8453:ERC20:0x4200...:`(canonical WETH)도 동작한다. 엔진에 정규 자산 레지스트리를 복제하지 않는다.
7. **`bridge_group_id` 없는 INTERNAL_TRANSFER.** 이동 없음. `excludeReason: "internal_transfer_unlinked"`.
8. `excluded`의 의미를 주석으로 재정의한다. "과세 라인이 아님"이지 "상태를 바꾸지 않음"이 아니다.

**API / 응답 형태 변화**

| 필드 | 변화 |
|---|---|
| 목적지 처분의 `cost_basis`, `pnl` | 0 / 전액 이익 → 실제 이동 원가 반영 |
| `pnl_review` | 목적지 처분에서 `disposal_exceeds_holdings`가 사라진다 |
| 브릿지 레그의 `cost_basis`, `pnl` | `null` 유지(비과세) |
| `bridge_move` | 신규. `"out"`, `"in"`, 또는 부재 |
| 집계(`periodPnl`, `taxableGains`) | **변화 없음.** PR-3 단독 배포 시점에는 여전히 현금흐름 계산이다 |
| `excludeReason` (S9) | **외부 노출 없음.** `event.presenter.ts`가 내보내지 않으므로 내부 값 변경이다. 별도 노출 작업은 하지 않는다 |

**마이그레이션 / 스키마.** 없음.

**테스트 기준 (구체 수치)** — ETH, 18 decimals.

| 케이스 | 입력 | 기대 |
|---|---|---|
| B1 완전 이동 | ① chain1 IN 1 ETH @3,000,000 ② chain1 OUT 1 ETH INTERNAL_TRANSFER group `bridge:1:0xabc` ③ chain8453 IN 0.99 ETH 같은 group ④ chain8453 OUT 0.99 ETH @3,200,000 SEND | ④ `costBasis "3000000"`, `proceeds "3200000"`, `realizedPnl "200000"`, `review` 없음 |
| B2 수수료 자본화 | B1의 ③ 직후 목적지 셀 | `qty 0.99`, `avgCost` = 3,000,000 ÷ 0.99 (Decimal 고정소수 비교) |
| B3 부분 이동 | chain1에 2 ETH 평균 3,000,000 보유 후 1 ETH 브릿지 | 소스 잔여 `qty 1`, `avgCost "3000000"`; 이동 원가 `3000000` |
| B4 브릿지 레그 비과세 | B1의 ②③ | 둘 다 `excluded true`, `proceeds null`, `realizedPnl null`, `bridgeMove` `"out"`/`"in"` |
| B5 불완전 페어 | ②만 있고 ③ 없음 | 이동 없음, 소스 잔고 불변, `review "bridge_move_unmatched"` |
| B6 수동 내부이체 | group 없는 INTERNAL_TRANSFER OUT | 제외, 잔고 불변, `excludeReason "internal_transfer_unlinked"` |
| B7 회귀 | `cost-basis.spec.ts` 기존 11개 | 전부 통과 |
| B8 통합 | `event-query.service.spec.ts`에 B1 시나리오 | 목적지 처분에 `pnl "200000"`, `pnl_review` 부재 |
| **B9 동시각 4-이벤트 순환 방어 (블로킹 B1)** | ① chain1 IN 1 ETH @3,000,000 (T0). **T1에 동일 시각 3건**: A = chain8453 IN 0.99 ETH group g, `log_index 0` / **C = chain1 OUT 0.5 XYZ 무관 처분 @500,000, `log_index 2`**(사전에 1 XYZ @800,000 취득) / B = chain1 OUT 1 ETH group g, `log_index 5`. 그리고 ④ chain8453 OUT 0.99 ETH @3,200,000 (T2) | ④ `costBasis "3000000"`, `realizedPnl "200000"`. **C의 결과는 브릿지 페어가 없는 대조군 실행과 완전히 동일**(후처리 패스가 무관 이벤트의 순서를 바꾸지 않음). 후처리 패스를 제거하면 이 케이스가 실패해야 한다 |
| **B10 부수 효과 확정** | B9와 같되 T1의 중간 이벤트를 **목적지 체인 처분** D = chain8453 OUT 0.99 ETH @3,100,000 SEND, `log_index 1`로 교체(정렬 후 T1 순서: IN(log 0) → D(log 1) → OUT(log 5)) | 패스가 IN을 OUT 뒤로 옮기므로 D는 크레딧 이전에 평가된다. D는 `costBasis "0"`, `review "disposal_exceeds_holdings"`이며 결정 0에 따라 합계에서 제외된다. **이것이 의도된 동작**임을 주석과 함께 고정한다(동일 시각에는 진짜 순서의 근거가 없고, 지어낸 원가 대신 보수적 플래그를 낸다) |

**검증 명령**

```
pnpm --filter @vera/tax-engine test
pnpm --filter @vera/backend test
pnpm build && pnpm lint
```

**Acceptance criteria**

- [ ] AC3-1 B1이 `realizedPnl "200000"`을 반환하고 `disposal_exceeds_holdings`가 없다.
- [ ] AC3-2 B4에서 브릿지 두 레그 모두 과세 라인을 만들지 않는다.
- [ ] AC3-3 **B5가 통과한다.** 불완전 페어가 잔고를 건드리지 않고 `bridge_move_unmatched`가 붙는다.
- [ ] AC3-4 B6에서 수동 내부이체가 이동을 일으키지 않는다.
- [ ] AC3-5 원가 보존: B3에서 (소스 잔여 원가 + 이동 원가)가 이동 전 총원가와 정확히 같다.
- [ ] AC3-6 엔진이 체인별 canonical 자산 목록을 복제하지 않는다.
- [ ] AC3-7 B7 회귀 전부 통과.
- [ ] **AC3-8 (B1)** **정렬 비교자(`cost-basis.ts:100-105`)가 수정되지 않았고**, 순서 보정이 정렬 이후의 별도 안정 패스로 구현되어 있다. B9와 B10이 모두 통과한다(B9는 무관 이벤트가 대조군과 동일함을, B10은 부수 효과가 보수적 플래그로 귀결됨을 고정한다). 빈 에스크로 2차 방어가 코드에 존재한다.
- [ ] **AC3-9 (S8)** B8이 통과한다. 즉 `event-query.service.ts`의 읽기 경로를 통해 목적지 처분의 `pnl`이 `"200000"`으로, `pnl_review` 없이 FE 응답에 실린다.
- [ ] **AC3-10 (B3)** PR-3 단독 배포에서 `summary().periodPnl`과 `estimate`의 `taxableGains`가 변하지 않음을 spec이 확인한다.
- [ ] **AC3-11 배포 노트 (사용자용 문구)** "이번 배포로 **개별 거래의 취득원가·손익(`pnl`)이 정확해지고, 브릿지 목적지 체인 거래에 붙어 있던 검토 표시(`pnl_review`)가 사라집니다. 기간 손익·과세 대상 합계는 이번에 바뀌지 않습니다**(합계 개선은 다음 배포)."가 배포 노트에 있다.

---

### PR-1 — `estimate` / `summary()`를 실현손익으로 전환 · **배포 2순위**

**문제.** `estimate.ts:12-18`은 연도 필터를 먼저 걸고 `Σ(OUT fiat) − Σ(IN fiat)`를 계산한다. `summary()`도 같은 현금흐름 합이다.

**변경 파일**

- `packages/tax-engine/src/frontend/estimate.ts` — 재작성
- `packages/tax-engine/src/frontend/estimate.spec.ts` — 신규
- `apps/backend/src/indexer/cost-basis-snapshot.service.ts` — **신규 공용 provider.** `EventQueryService`와 `FrontendTaxService`가 서로 다른 인스턴스라 WeakMap이 공유되지 않아 요청당 fold가 2회 도는 문제를 해결한다
- `apps/backend/src/indexer/event-query.service.ts` — `summary()` 교체, `basisFor` 제거 후 provider 주입
- `apps/backend/src/indexer/indexer.module.ts` / `apps/backend/src/tax/tax.module.ts` — provider 등록·export·주입
- `apps/backend/src/tax/frontend-tax.service.ts` — fold 결과를 `calculateFrontendEstimate`에 전달
- spec: `event-query.service.spec.ts`, `cost-basis-snapshot.service.spec.ts`(신규)

**`CostBasisSnapshotService` 캐시 계약 (블로킹 B2)**

- **메모에는 결과가 아니라 Promise를 저장한다.** `CachedTransactionRepository`의 `inflight` 맵(`transaction.repository.adapters.ts:105-116`)과 같은 방식이다. async 전환 후 list와 summary가 동시에 들어오면 둘 다 캐시 미스로 fold를 2회 돌 수 있는데, Promise를 먼저 넣어 두면 두 번째 호출이 진행 중인 fold를 나눠 쓴다. 정착 후에도 같은 엔트리가 결과로 남는다.
- **키는 `(rows 배열 인스턴스, nativePrices Map 인스턴스)` 2단이며 둘 다 동일성(WeakMap)으로 판정한다.** 가스 맵 자체를 `(userId, rows 인스턴스)`로 메모하므로 같은 스냅샷 안에서는 항상 **같은 Map 인스턴스**가 돌아온다. 따라서 내용 해시가 필요 없다 — FNV-1a 같은 32비트 지문은 충돌 시 내용이 다른 두 맵을 같은 것으로 취급할 위험만 더한다(revision 3의 지문 방식은 이 이유로 철회한다).
- 가스가 비활성인 호출은 2단 키로 **모듈 스코프의 고정 sentinel 객체**를 쓴다. PR-1 시점에는 모든 호출이 이 sentinel을 쓰며, 2단 구조와 Promise 메모만 먼저 도입해 PR-2가 실제 맵을 넣게 한다.

**동작 변경**

1. `calculateFrontendEstimate`는 **필터 전에** 전체 이력 fold 결과를 주입받는다.
2. 연도 귀속: 해당 연도 이벤트 중 `direction === "OUT"` + `excluded === false` + **`review !== "disposal_exceeds_holdings"`**인 처분의 `realizedPnl`만 합산한다. 취득은 0 기여.
3. `total = Σ realizedPnl` → `taxableGains = max(total, 0)`, `lossCarryforward = |min(total, 0)|`.
4. `judgments`: 기존 필드 유지 + `costBasis`, `realizedPnl`, `pnlReview`. **`amount`의 의미는 바꾸지 않는다.** OUT의 `breakdown.cost`가 `"0"` 고정에서 실제 원가로 바뀐다.
5. `limitations` 세 종류: `excluded`(시세 미확인), `review`(원가 미확인 — 결정 0), **`non_taxable`(`NON_TAXABLE_CLASSES` — A1)**.
6. `summary()`: `periodPnl`을 기간 내 처분의 `realizedPnl` 합으로 교체(같은 게이트). `pendingReviewCount`에 `pnl_review` 보유 이벤트 포함.

**API / 응답 형태 변화 (FE 관점)**

| 필드 | 이전 | 이후 |
|---|---|---|
| `totals.taxableGains` | Σ OUT fiat − Σ IN fiat (양수 클램프) | Σ 처분 realizedPnl (원가 미확인 제외, 양수 클램프) |
| `totals.unresolvedProceeds` | 없음 | **신규.** 원가 미확인으로 뺀 처분의 proceeds 합 |
| `lossCarryforward` | 현금흐름 음수분 | 실현손실 |
| **INTERNAL_TRANSFER 레그의 합계 기여 (A1)** | **포함됨**(`estimate.ts`에 classification 필터가 없고 enrichment는 SPAM만 건너뛰므로 브릿지 레그에 `fiat_value`가 있다) | **제외.** 연도 귀속과 **독립적인 두 번째 수치 변화**이며 브릿지 사용자에게는 이쪽 영향이 더 클 수 있다 |
| `judgments[].breakdown.cost` | 항상 `"0"` | 실제 인식 원가 |
| `judgments[].costBasis` / `.realizedPnl` / `.pnlReview` | 없음 | 신규 |
| `limitations[]` | `excluded`만 | `excluded` + `review` + `non_taxable` |
| `summary.periodPnl` | 현금흐름 | 실현손익 |
| `summary.periodPnlBasis` | 없음 | 신규 상수 `"realized_moving_average"` |

`status: "UNDETERMINED"`(KR), `openQuestions`, `provenance: "mock"`은 변경 없음.

**마이그레이션 / 스키마.** 없음.

**테스트 기준 (구체 수치)** — `packages/tax-engine/src/frontend/estimate.spec.ts`는 신규 파일이다(현재 estimate 전용 spec 없음).

| 케이스 | 입력 | 기대 |
|---|---|---|
| E1 전년도 취득 | 2024-06-01 IN 1개 @1,000,000 / 2025-03-01 OUT 1개 @1,500,000, taxYear=2025 | `taxableGains "500000"` (기존 `1500000`) |
| E2 취득만 있는 해 | 위 데이터, taxYear=2024 | `taxableGains "0"`, `lossCarryforward "0"` (기존 `1000000`) |
| E3 당해 손실 | 2025-01 IN 1 @1,000,000 / 2025-02 OUT 1 @800,000 | `taxableGains "0"`, `lossCarryforward "200000"` |
| E4 시세 미확인 처분 | 2025-02 OUT 1, `price_status "UNKNOWN"` | 합계 미포함, `limitations[kind="excluded"]` |
| E5 원가 미확인 처분 (결정 0) | 취득 없이 2025-02 OUT 1 @900,000 | `taxableGains "0"`, `totals.unresolvedProceeds "900000"`, `limitations[kind="review"]`. 개별 judgment는 `realizedPnl "900000"` + `pnlReview "disposal_exceeds_holdings"`를 **그대로 노출** |
| E6 breakdown | E1의 OUT judgment | `breakdown.cost "1000000"`, `breakdown.proceeds "1500000"` |
| E7 브릿지 레그 제외 (A1) | 2025-04 OUT 1 ETH INTERNAL_TRANSFER `fiat_value "3000000"` 단독 | 이전 `taxableGains "3000000"` → 신규 `"0"` + `limitations[kind="non_taxable"]` |

`apps/backend/src/indexer/event-query.service.spec.ts` / `cost-basis-snapshot.service.spec.ts`:

| 케이스 | 입력 | 기대 |
|---|---|---|
| S1 (신규) 현금흐름과 구분되는 값 | 2024-12-01 IN 2개 @2,000,000(총액) / 2025-01-05 OUT 1개 @1,500,000, `summary(from="2025-01-01")` | `periodPnl "500000"` (기존 `1500000`) |
| S2 (신규 — S6) periodPnl 고정 | 기존 buy/sell 1:1 rows | `periodPnl "500000"`. 현재 spec(`event-query.service.spec.ts:48`)에 `periodPnl` 단언이 없으므로 회귀 방어가 아닌 **신규 커버리지** |
| **S3 (B2b 강화)** 동시 호출 | `await Promise.all([service.list(u), service.summary(u)])` | fold 스파이 호출 수 **1**. 두 호출이 같은 Promise를 공유했음을 증명 |

**검증 명령**

```
pnpm --filter @vera/tax-engine test
pnpm --filter @vera/backend test
pnpm build && pnpm lint
```

**수동 검증 (S10)**

1. 실지갑 계정으로 배포 전/후 `GET /events/summary`와 `POST /api/tax/estimate` 응답을 저장하고, `periodPnl`·`taxableGains`·`unresolvedProceeds`의 before/after를 PR 본문에 첨부한다. 변화를 (a) 연도 귀속 (b) INTERNAL_TRANSFER 제외 (c) 원가 미확인 제외 세 원인으로 각각 몇 원인지 분해해 적는다.
2. fold 1회 소요 시간을 측정한다. **환경을 고정해 기록한다**: 스테이징 백엔드(로컬 개발 머신 아님), Postgres 연결 상태, **스팸 포함 5,000행 이상**의 실계정 원장, 콜드 1회(스냅샷 캐시 비운 직후)와 웜 10회를 나눠 측정, 웜 10회의 p95를 AC 판정에 쓰고 콜드 값은 참고로 병기. 행 수를 반드시 함께 적는다.

**Acceptance criteria**

- [ ] AC1-1 E1이 `"500000"`을 반환한다.
- [ ] AC1-2 E2가 `lossCarryforward "0"`을 반환한다.
- [ ] AC1-3 `estimate.ts`가 fold 결과를 주입받고, 연도 필터가 fold **이후**에 적용된다.
- [ ] AC1-4 S1이 `"500000"`을 반환하고 `summary()`의 현금흐름 `reduce`가 제거되었다.
- [ ] AC1-5 (결정 0) E4·E5·E7이 모두 합계에서 빠지고 `limitations`에 `excluded`/`review`/`non_taxable`로 분리된다. E5의 proceeds가 `unresolvedProceeds`에 정확히 900,000으로 남고 개별 `realizedPnl`은 `"900000"` 그대로다.
- [ ] AC1-6 (A1) `judgments[].amount`·`status`·`provenance`·`period`의 의미가 동일하고, INTERNAL_TRANSFER 제외가 API 변화 표와 PR 본문에 **별도 항목**으로 기재되어 있다.
- [ ] AC1-7 (S7) `cost-basis.spec.ts`의 기존 11개 케이스가 전부 통과한다(estimate 전용 spec은 신설이므로 "기존 통과" 대상이 아니다).
- [ ] **AC1-8 (A2/S9/S10)** S3가 통과해 요청당 fold가 1회다. **스테이징에서 5,000행 이상 실계정 원장의 웜 fold p95 < 200ms**이며, 측정 환경(스테이징/행 수/콜드·웜 구분)과 함께 PR 본문에 적는다. 계획서의 "1만 4천 행"은 `transaction.repository.adapters.ts:85` **코드 주석 인용이지 이번 측정치가 아니며**, 이 AC의 실측으로 갱신한다.
- [ ] **AC1-9 (S11/B3)** 배포 노트에 두 가지가 있다. (a) `POST /tax/calculate`는 여전히 현금흐름 기반이라 `/api/tax/estimate`와 숫자가 다르다(F4). (b) **`unresolvedProceeds` 급증 경고** — 이 값이 크면 합계가 과소하므로 신고 전 확인이 필요하다.
- [ ] **AC1-10 (B2a)** `CostBasisSnapshotService`의 2단 키가 **둘 다 인스턴스 동일성**이고 메모에 Promise를 저장한다. PR-1 시점의 2단 키는 고정 sentinel 객체다.

---

### PR-2 — 가스비를 원가/처분가에 반영 · **배포 3순위**

**변경 파일**

- `packages/tax-engine/src/core/cost-basis.ts` — 가스 귀속 규칙, `CostBasisResult`에 `gasFiat`, 선택적 `options`
- `packages/tax-engine/src/core/cost-basis.spec.ts` — 케이스 추가
- `apps/backend/src/indexer/historical-price-enrichment.service.ts` — native 종가 워밍
- `apps/backend/src/indexer/historical-price.repository.ts` + `.adapters.ts` — `getMany(keys)` 추가
- `apps/backend/src/indexer/cost-basis-snapshot.service.ts` — native 종가 맵 구축·메모 + 2단 키 채우기
- `apps/backend/src/indexer/native-price-backfill.ts` (+ `package.json` 스크립트) — 기존 사용자 백필
- `apps/backend/src/indexer/event.presenter.ts` — `gas_fee_fiat` 노출

**동작 변경**

1. **엔진 옵션은 함수가 아니라 Map이다 (블로킹 B2a).** `computeCostBasis(events, options?: { nativePrices?: ReadonlyMap<string, string> })`이며 키는 `` `${chainId}:${YYYY-MM-DD}` ``, 값은 KRW 종가다. 클로저를 받으면 매 호출 새 함수가 되어 캐시 키가 성립하지 않으므로 **함수 대신 메모 가능한 자료구조를 받는다.** 옵션 미전달 시 오늘과 동일하게 가스를 무시한다(하위 호환).
2. **캐시 키 규칙 (블로킹 B2a).** 맵을 `(userId, rows 인스턴스)`로 메모하고, fold 메모의 2단 키를 **그 메모된 Map 인스턴스의 동일성**으로 둔다. 같은 스냅샷에 대한 반복 호출은 같은 인스턴스를 받으므로 영구 미스가 발생하지 않으며(AC1-8과 충돌하지 않는다), 내용 해시가 없으니 해시 충돌로 서로 다른 맵이 섞일 여지도 없다. 스냅샷이 무효화되면 새 맵·새 fold가 된다. **백필이 60초 TTL 중간에 끝나면 최대 TTL 1주기(60초) 동안 낡은 맵이 재사용되어 `gas_unpriced`가 남을 수 있다.** 허용 오차로 두고 배포 런북에 적는다(백필은 배포 시 1회성이다).
3. **귀속 규칙 (전 분기 정의)**

   | 상황 | 규칙 |
   |---|---|
   | 취득(IN), `group_id` 없음 | 가스를 원가에 자본화. `costBasis = fiat + gasFiat` |
   | 순수 처분(OUT), `group_id` 없음 | 가스를 처분가에서 차감. `proceeds = fiat − gasFiat` |
   | 스왑 그룹에 **제외되지 않은 IN이 정확히 1개** | 그 IN에 1회만 자본화. 같은 그룹 OUT의 가스는 무시 |
   | 스왑 그룹의 IN이 **전부 제외** 또는 **IN 없음** | **폴백: 그룹에서 제외되지 않은 가장 이른 OUT의 proceeds에서 차감.** 가스가 조용히 사라지지 않게 한다 |
   | 자격 있는 레그가 **여러 개** | 정렬 순서(occurredAt → log_index → id) **첫 레그에만** 귀속. 그룹당 1회를 넘지 않는다 |
   | **그룹 내 레그별 `gas_fee_native`가 서로 다를 때 (S7)** | **귀속 대상으로 선택된 그 레그 자신의 값**을 쓴다(최댓값·합계가 아니다). 어댑터는 tx 단위 가스를 모든 레그에 같은 값으로 싣도록 되어 있으므로 불일치는 데이터 이상이며, 규칙을 국소적·결정적으로 유지하는 편이 낫다 |
   | 자격 있는 레그가 하나도 없음 | 가스 미반영. 제외 이벤트에는 `review`를 달지 않으므로 조용한 누락이며, 시세 미확인 자체가 더 큰 누락이므로 감수한다 |
   | 브릿지 레그 | 반영하지 않는다(비과세 이동, F5) |

4. `review` 우선순위: `disposal_exceeds_holdings` > `bridge_move_unmatched` > `gas_unpriced`.
5. **캐시 워밍 위치 (S4 정정).** "조기 continue 이전"은 문자 그대로 불가능하다. `chainId`/`date` 도출이 가드 뒤(`:74-75`)에 있고 `dateOf` null이 다섯 번째 종료 지점(`:76`)이기 때문이다. 실제 구현은 **`chainId`/`date` 도출을 루프 최상단으로 올린 뒤 워밍하고, 그다음에 기존 가드를 둔다.** 이렇게 하면 조기 종료 5곳(`:53` 기존 fiat_value, `:58` SPAM, `:68` endpoint null, `:72` 수량 0, `:76` date 무효) 중 앞의 4곳은 워밍 이후가 된다. **`date`가 무효인 행은 워밍 자체가 불가능하며(어느 날의 종가인지 모른다) 이는 원리적 예외다.** payload에는 아무것도 쓰지 않고 캐시만 채운다.
6. **기존 사용자 백필.** `enrich()`는 sync 시에만 돌고 `listOrSync`는 바인딩당 최초 1회만 동기화한다(`transaction-availability.service.ts:14-18`). PR-2 이전에 첫 동기화를 끝낸 사용자는 캐시가 영원히 비어 `gas_unpriced`가 고착된다. 배포 시 **1회성 백필 커맨드**(`pnpm --filter @vera/backend backfill:native-prices`)를 실행한다. 저장된 원장에서 distinct (chain, day)를 뽑아 캐시에 없는 것만 조회하며, 분당 25콜 스로틀 + 멱등 재실행을 만족한다. 읽기 경로 지연 워밍은 요청 지연·쿼터 폭주 위험으로 기각한다.
7. **체인 간 중복 조회 (A5).** 워밍 단계에서 native 심볼이 같은 체인끼리 오라클 결과를 **공유**한다(한 번 조회해 각 체인 키에 동일 값을 `put`). 심볼이 다른 체인(POL 등)은 별도 조회한다.

**API / 응답 형태 변화**

| 필드 | 변화 |
|---|---|
| `cost_basis` | 취득 시 가스 포함액으로 증가 |
| `pnl`, `pnl_ratio` | 가스만큼 감소 |
| `gas_fee_fiat` | 신규(읽기 시점 파생, 미확인 시 `null`) |
| `pnl_review` | `"gas_unpriced"` 추가 가능 |
| `judgments[].breakdown.fee` | 기존 native 수량 유지 + `feeFiat` 병기 |

**마이그레이션 / 스키마.** 없음. `HistoricalPrice`에 `assetKey: "native"` 행이 늘어날 뿐이다. **payload 필드 추가 없음 → 앵커 해시 무변경.**

**테스트 기준 (구체 수치)** — `nativePrices` 맵은 모든 키에 `"4000000"`(1 ETH = 4,000,000 KRW).

| 케이스 | 입력 | 기대 |
|---|---|---|
| G1 취득 가스 자본화 | IN 1토큰 @1,000,000, gas `"0.0025"` (= 10,000) | `costBasis "1010000"` |
| G2 처분 가스 차감 | G1 이후 OUT 1토큰 @1,500,000, gas `"0.00125"` (= 5,000) | `proceeds "1495000"`, `costBasis "1010000"`, `realizedPnl "485000"` |
| G3 스왑 이중계상 방지 | group `1:0xabc`, OUT EXCHANGE @1,000,000 gas 0.00125, IN RECEIVE @1,000,000 gas 0.00125 | OUT `proceeds "1000000"`, IN `costBasis "1005000"` |
| G4 시세 미확인 가스 | 해당 (chain,date) 키가 맵에 없음, gas `"0.001"` | `gasFiat null`, `costBasis`는 가스 없는 값과 동일, `review "gas_unpriced"` |
| G5 review 우선순위 | 보유 초과 처분 + 가스 미확인 | `review === "disposal_exceeds_holdings"` |
| G6 하위 호환 | `options` 미전달 | 기존 11개 spec 기댓값 전부 통과 |
| G7 gas 0 | `gas_fee_native "0"`(실어댑터 기본값) | `gasFiat "0"`, 숫자 변화 없음, `review` 없음 |
| G8 스왑 폴백 | group 공유, OUT EXCHANGE @1,000,000 gas 0.00125, IN RECEIVE `price_status "UNKNOWN"` | OUT `proceeds "995000"` |
| G9 그룹당 1회 상한 | 같은 group에 자격 있는 IN 2개 | 정렬 첫 IN에만 5,000 가산 |
| **G10 레그별 가스 불일치 (S7)** | group 공유, IN gas `"0.00125"`(5,000), OUT gas `"0.0025"`(10,000) | IN에 귀속되므로 `costBasis`에 **5,000**만 가산(10,000이 아님) |

`historical-price-enrichment.service.spec.ts`:

| 케이스 | 기대 |
|---|---|
| W1 정상 행 | (chain, day) 종가가 `put` 1회, 같은 키의 두 번째 이벤트에서 추가 오라클 호출 없음 |
| W2 SPAM 행 | SPAM 이벤트만 있어도 워밍된다(`:58` 종료 이전 실행 증명) |
| W3 NFT 행 | `endpointKind` null인 ERC721 행만 있어도 워밍된다(`:68` 이전) |
| **W4 date 무효 행 (S4)** | `block_timestamp`가 파싱 불가인 행은 **워밍되지 않고** 오라클 호출도 없다(원리적 예외의 명시적 고정) |
| W5 체인 간 공유 (A5) | chain 1과 8453의 같은 날 ETH 이벤트 → 오라클 호출 1회, `put` 2회 |

**검증 명령**

```
pnpm --filter @vera/tax-engine test
pnpm --filter @vera/backend test
pnpm build && pnpm lint
# 배포 시 1회
pnpm --filter @vera/backend backfill:native-prices --dry-run
pnpm --filter @vera/backend backfill:native-prices
```

**백필 런북 — `--dry-run` 합격 기준.** dry-run은 조회 없이 **캐시에 없는 (native 심볼, day) 조합 수 N과 예상 소요 시간(N ÷ 25콜/분)**을 출력한다. 진행 판단은 다음과 같다.

| N | 판단 |
|---|---|
| N ≤ 750 (예상 30분 이내) | 그대로 실행 |
| 750 < N ≤ 2,000 (예상 80분 이내) | 저트래픽 시간대에 실행하고 완료까지 모니터링 |
| N > 2,000 | **실행 보류.** 조합 수가 예상을 크게 넘었다는 뜻이므로 원인(체인 수·기간 범위·심볼 공유 미적용)을 먼저 확인한다 |

중단해도 안전하며(멱등) 재실행 시 남은 조합만 조회한다. 완료 후 최대 TTL 1주기(60초) 동안 낡은 맵이 남을 수 있음을 공지한다.

**Acceptance criteria**

- [ ] AC2-1 G1~G10 전부 통과.
- [ ] AC2-2 `computeCostBasis`가 여전히 순수 함수다(`await`·fetch·저장소 참조 없음).
- [ ] AC2-3 payload에 새 영속 필드가 없다. `indexer.service.ts:139`의 해시 입력이 이전과 동일하다.
- [ ] AC2-4 G7이 통과하므로 실데이터 숫자는 변하지 않는다. PR 본문에 그 사실이 명시되어 있다.
- [ ] AC2-5 (A5/S4) W1~W5 전부 통과. 오라클 호출이 **(native 심볼, day)당 최대 1회**이고, SPAM·NFT·수량 0·기존 시세 보유 행에서도 워밍되며, date 무효 행만 예외다.
- [ ] **AC2-6 (B2a)** 엔진 옵션이 `ReadonlyMap`이고, **같은 스냅샷에 대한 반복 호출이 메모된 동일 Map 인스턴스를 받아 fold를 1회만 수행**함을 spec이 증명한다(fold 스파이 호출 수 1). 스냅샷이 무효화되어 새 맵이 만들어지면 미스가 나 다시 fold한다. 내용 해시 코드는 존재하지 않는다.
- [ ] AC2-7 백필 커맨드가 멱등하고(2회 실행 시 두 번째는 오라클 호출 0) 분당 25콜 스로틀이 spec으로 검증된다. `--dry-run`이 **미해소 조합 수 N과 예상 소요 시간**을 출력하고, 런북에 N 구간별 진행/보류 기준과 **TTL 1주기 지연** 안내가 있다.

---

## 3. 리스크와 완화

| 리스크 | 영향 | 완화 |
|---|---|---|
| **배포 순서 골짜기 (B3)** — PR-1 단독 구간에서 브릿지 사용자의 `taxableGains`가 0 근처로 붕괴하고 전액이 `unresolvedProceeds`로 이동 | 그 구간에 신고하면 **과소 신고** | 배포 순서를 **PR-3 → PR-1 → PR-2**로 확정(§2.0). PR-3이 지연되면 PR-1과 묶어 동시 배포(대체안 i). 배포 노트에 `unresolvedProceeds` 급증 경고(AC1-9) |
| **정렬 비교자 순환 (B1)** | 비결정적 결과, 원가 증발 | 비교자를 수정하지 않고 정렬 후 안정 후처리 패스로만 그룹 순서를 교정. B9(동일 시각 4-이벤트)와 AC3-8로 고정 |
| **fold 캐시 계약 (B2)** | 가스 미반영 결과 유출 또는 영구 캐시 미스 | Map 기반 옵션 + 메모된 인스턴스 동일성 2단 키(AC2-6), Promise 메모로 동시 호출 합류(S3/AC1-8) |
| **앵커 해시 churn** | 앵커 큐 폭주, 온체인 비용 | 세 PR 모두 payload 무변경(AC2-3). **F1은 필드 값 변경으로 churn이 확정되므로 착수 전 재앵커 비용 산정과 배치 전략을 별도로 정한다** |
| **기존 사용자 native 종가 캐시 공백** | PR-2 이전 사용자에게 `gas_unpriced` 고착 | 배포 시 1회성 백필(AC2-7). 백필 직후 최대 TTL 1주기(60초) 지연은 허용 오차로 명시 |
| **CoinGecko 쿼터** | 다른 자산 가격 해소 지연 | (native 심볼, day)당 1회로 축소, 영구 캐시, 백필은 분당 25콜 스로틀 |
| **기존 사용자 숫자 변화 (D3)** | FE·사용자 혼란 | 필드명 유지 + `periodPnlBasis`, 원인 3분해 스냅샷(S10), `unresolvedProceeds`로 은폐 방지, 순차 배포 |
| **결정 0으로 인한 과소 신고 인상** | 사용자가 실제보다 적게 신고 | `unresolvedProceeds` + `limitations[kind="review"]` 노출. PR-3과 F2가 이 모수를 실제로 줄인다 |
| **KR `UNDETERMINED` 의미 훼손** | 세무 리스크 | `status`·`openQuestions`·`ESTIMATE_DISCLAIMER`·`isEstimate`·`provenance` 모두 무변경 |
| **fold 규모 (A2/S9)** — 서로 다른 인스턴스라 요청당 2회 실행 | 응답 지연 | 공용 provider로 요청당 1회 보장. p95 < 200ms를 실제 행 수와 함께 실측(AC1-8). "1만 4천 행"은 코드 주석 인용치이며 이 실측으로 갱신 |
| **브릿지 오탐이 원가를 잘못 옮김** | 원가 왜곡 | 판정을 새로 만들지 않고 `bridge-linking.service.ts`의 보수적 판정을 신뢰. 엔진은 완전 페어만 실행 |
| **PR-2가 실데이터에 무영향** | 리뷰어의 잘못된 반려 | AC2-4로 명시. 결정 2 옵션 D가 있으므로 승인자가 F1과 병합하는 선택도 가능 |

---

## 4. ADR

### ADR-000 부분 정보 처분은 개별에는 노출하고 합계에서는 제외한다

- **Decision.** `disposal_exceeds_holdings` 처분은 개별 이벤트에 `proceeds`·`realizedPnl`을 그대로 내보내되 합계에서는 제외하고, 빠진 금액을 `totals.unresolvedProceeds`로 보고한다.
- **Drivers.** 원칙 2, 시세 미확인(E4) 처리와의 대칭성.
- **Alternatives.**
  - *원가 0으로 전액 합산*: 미상을 0으로 치환해 존재하지 않는 이익을 만든다.
  - *이벤트에서도 숨김*: 아는 값(proceeds)까지 버린다.
  - *(S6) proceeds는 남기고 `realizedPnl`만 null로 두기*: 아는 값을 버리지 않으면서 "손익 미상"을 정직하게 표시하는 안이다. 합계 제외라는 결과는 채택안과 같다. **기각 이유는 정직성이 아니라 호환성이다** — `pnl`이 null이 되면 FE의 손익 표시가 기존 이벤트에서 사라지고, `realizedPnl`을 `unresolvedProceeds`로 집계할 근거도 이벤트에서 없어진다. 채택안은 이벤트 표현을 오늘 그대로 두고 합계 게이트만 추가한다.
- **Why chosen.** 보유 초과 처분의 원가는 0이 아니라 미상이다. 미상을 0으로 치환하는 것은 추정치를 지어내는 것과 같다.
- **Consequences.** 과세 대상 금액이 이전보다 작아 보일 수 있다. `unresolvedProceeds`와 `limitations`가 이를 드러내야 하며, PR-3과 F2가 이 모수를 줄이는 작업이다. **PR-1이 PR-3보다 먼저 배포되면 브릿지 사용자에게 골짜기를 만든다(§2.0).**
- **Follow-ups.** F2.

### ADR-001 실현손익 산출은 전체 이력 fold 후 처분 연도 귀속으로 한다

- **Decision.** 전체 이력을 fold하고 각 처분의 `realizedPnl`을 처분 시점 연도에 귀속한다. 취득은 기여하지 않는다.
- **Drivers.** 이동평균법의 정의, 기존 fold 재사용, 파생값 비영속 원칙.
- **Alternatives.** 연도 부분집합 fold(전년도 원가 소실로 무효), 연말 스냅샷 영속화(파생값 저장 부채).
- **Why chosen.** 유일하게 정의에 맞고 엔진과 스키마를 건드리지 않는다.
- **Consequences.** 수치가 즉시 달라진다. **연도 귀속과 무관하게 INTERNAL_TRANSFER 레그가 합계에서 빠지는 두 번째 변화가 동시에 발생한다.** 읽기 경로가 전체 이력에 비례하므로 fold를 요청당 1회로 묶는 공용 provider와 Promise 메모가 필요하다.
- **Follow-ups.** 이력이 수만 건대로 커지면 연도 경계 스냅샷 캐시를 재검토한다.

### ADR-002 가스는 native 종가 캐시를 읽기 시점에 주입해 평가한다

- **Decision.** `gas_fee_fiat`를 payload에 쓰지 않는다. enrichment가 (chain, day) native 종가를 캐시에 워밍하고, 읽기 시점에 **메모 가능한 `ReadonlyMap`으로** 주입한다(인스턴스 동일성이 곧 캐시 키다). 취득 가스는 자본화, 순수 처분 가스는 차감, 스왑은 IN에 1회 귀속하되 IN이 제외되면 OUT proceeds에서 차감한다.
- **Drivers.** 원칙 1(파생값 비영속), 쿼터(D2), 엔진 순수성.
- **Alternatives.** payload 영속(A), 해시 대상 제외 영속(C), 가스 전체를 F1까지 연기(D).
- **Why chosen.** A·C는 파생값을 저장한다는 같은 이유로 탈락한다. D는 유효한 대안이며 승인자가 선택하면 PR-2를 F1에 흡수하면 된다. B는 세무 규칙을 데이터 수집과 분리해 먼저 고정한다.
- **Consequences.** 읽기 경로에 캐시 조회가 추가되고 fold 스냅샷 API가 async로 바뀐다. **엔진 순수성 유지의 대가로 캐시 미스 복구 책임은 호출자에게 있으며**, 백필 커맨드가 그 책임의 구현이다. 백필 직후 최대 TTL 1주기 동안 낡은 맵이 재사용될 수 있다. 실어댑터가 `gas_fee_native: "0"`이라 실데이터 영향은 F1 전까지 없다. **F1은 기존 필드 값을 바꾸므로 옵션 B로도 D1을 회피하지 못하고 미룰 뿐이다.**
- **Follow-ups.** F1, F5.

### ADR-003 브릿지 페어는 원가를 이동시키고 수수료 델타는 자본화한다

- **Decision.** 완전 페어에 한해 (수량, 원가 총액)을 소스에서 목적지 asset key로 이동한다. 수령 수량이 적어도 원가 총액은 전액 이월된다. **순서 문제는 정렬 비교자가 아니라 정렬 후 안정 후처리 패스로 해결한다.**
- **Drivers.** 체인 스코프 asset key로 인한 목적지 잔고 0 문제, 원칙 3, 원칙 4.
- **Alternatives.** proceeds 0 처분 인식, 델타 원가 폐기, 양 레그 제외 유지, **체인 비스코프 canonical asset key(iv)**, 그리고 순서 문제에 대한 *비교자 수정*(전순서 위반으로 철회)과 *지연 크레딧*(실제 역전이 동률뿐이라 이득 없음).
- **Why chosen.** ii가 원가 총량 보존과 비과세 성격을 동시에 만족한다. iv는 구조적으로 더 우수하지만 payload 필드 추가가 D1을 유발해 기각했다.
- **Consequences.** 목적지 처분의 `disposal_exceeds_holdings`가 사라지고, 결정 0 이후에는 그 처분이 합계에 다시 들어온다. 목적지 평균단가가 수수료만큼 상승한다. 엔진이 "제외 이벤트가 상태를 바꾸는" 첫 사례를 갖게 되므로 `excluded`의 의미를 문서화해야 한다. 이동 레그의 가스는 반영하지 않는다.
- **Follow-ups.** F2, F3, F5.

### Follow-ups

- **F1 — `gas_fee_native` 실데이터 채우기.** `getAssetTransfers`는 가스를 주지 않으므로 `eth_getTransactionReceipt`를 tx 단위로 조회해야 한다. RPC 콜 수·레이트리밋에 더해 **기존 필드 값 변경으로 인한 전 원장 재앵커 비용 산정**이 선행 조건이다.
- **F2 — 스왑 상대 레그 평가.** 같은 `group_id`의 한 레그가 UNKNOWN일 때 상대 레그 `fiat_value`로 평가. 결정 0 이후 `unresolvedProceeds`를 실제로 줄이는 최우선 항목.
  - **Consequences (S5).** PR-2의 스왑 가스 폴백은 "IN이 제외되면 OUT proceeds에서 차감"이다. F2로 그 IN이 가격을 얻으면 **정상 경로(IN 원가 자본화 → 미래 처분으로 이연)로 전환**되고, 그 결과 **이미 보고된 연도의 `realizedPnl`이 달라진다.** F2 배포 시 이 재계산을 D3와 같은 수준으로 공지해야 한다.
- **F3 — 체인 비스코프 canonical asset key + 토큰 레지스트리 확장 + `bridge_group_id` 입도.** 결정 3 옵션 iv 재검토와 롱테일 자산 커버리지 확대. F1과 묶어 앵커 churn을 1회로 합치는 것을 검토한다.
  - **입도 한계(기존 링킹의 제약).** `bridge_group_id`는 `` `bridge:${chain_id}:${tx_hash}` ``이고 `log_index`를 포함하지 않는다(`bridge-linking.service.ts:107`). 한 트랜잭션에서 서로 다른 두 자산을 동시에 브릿지하면 **두 OUT이 같은 groupId를 갖게 되어** PR-3의 사전 스캔 조건("OUT 1개 + IN 1개")이 성립하지 않고 이동이 보수적으로 무산된다(`bridge_move_unmatched`). PR-3이 만든 문제가 아니라 링킹의 기존 한계가 드러나는 지점이며, 해소하려면 groupId에 자산 축을 추가해야 한다. 그 변경은 payload 값 변경이라 D1에 걸리므로 F1·F3과 함께 다룬다.
- **F4 — `tax.service.ts` `calculate()` 정합.** `calculateTaxEvents`/`summarize`는 여전히 현금흐름 기반이며 `TaxReport`로 영속된다. `POST /tax/calculate`와 `POST /api/tax/estimate`의 숫자 불일치가 PR-1 이후에도 남는다(배포 노트에 명시 — AC1-9).
- **F5 — 브릿지 이동 레그의 가스 처리.** 현재는 무시한다. 실데이터가 F1 이후에야 존재하므로 지금 결정하지 않는다.
