import type { IndexedTransaction } from "@vera/interfaces";
import type { TransactionRecord } from "../shared/repository.types";

/**
 * One leg a normalization pass positively re-emitted for a (binding, chain) sync window.
 *
 * `id` is the STORAGE id — the `txHash` column, which equals `payload.id` (`${chainId}:${uniqueId}`,
 * e.g. `1:0xbde5…:log:275`). A leg's identity is that id ALONE, never (id, eventType): re-normalization
 * legitimately moves the same leg to another eventType (UNKNOWN `transfer_out` -> EXCHANGE `swap`), and
 * the storage unique key `(bindingId, txHash, eventType)` then makes the upsert insert a second row.
 * `nettedLegIds` are the legs this row absorbed (`payload.netted_leg_ids`); they no longer own a row.
 */
export type EmittedLeg = { id: string; eventType: string; nettedLegIds: string[] };

/** What one purge pass did. `preserved` names user-edited rows deliberately left in place. */
export type SupersededPurgeResult = { deleted: number; carriedOverrides: number; preserved: string[] };

export interface TransactionRepository {
  listForUser(userId: string): Promise<TransactionRecord[]>;
  findForUser(userId: string, id: string): Promise<TransactionRecord | null>;
  updatePayload(userId: string, id: string, payload: Record<string, unknown>): Promise<TransactionRecord | null>;
}
export interface TransactionSyncRepository {
  /** `onSaved`는 저장한 행 수를 중간중간 알린다 — 만 단위 행을 저장하는 동안 화면이 멈춘 것처럼 보이지 않게. */
  save(bindingId: string, userId: string, sourceItems: IndexedTransaction[], onSaved?: (saved: number) => void): Promise<TransactionRecord[]>;
  /**
   * Converge a re-sync: drop the rows this normalization no longer produces for the legs it DID
   * re-emit. Keyed strictly on `emitted` — never on a block range — so a partial fetch (a chain that
   * raised ChainIncompleteError, a provider hiccup) can never wipe real history.
   */
  deleteSupersededRows(bindingId: string, userId: string, emitted: EmittedLeg[]): Promise<SupersededPurgeResult>;
  /**
   * 지갑을 등록 해제할 때 그 바인딩의 원장 행을 **전부** 지운다. 사용자 수정도 함께 사라진다 — 지갑을 지우는 것은
   * 그 지갑의 이력을 지우겠다는 뜻이고, 다시 등록하면 처음부터 다시 걷는다. 지운 행 수를 돌려준다.
   */
  deleteAllForBinding(bindingId: string, userId: string): Promise<number>;
}

export interface TransactionAvailabilityPort {
  listOrSync(userId: string): Promise<TransactionRecord[]>;
}
