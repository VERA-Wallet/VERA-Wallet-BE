export type TaxEvidenceRecordView = {
  id: string;
  countryCode: string;
  taxYear: number;
  merkleRoot: string;
  leafCount: number;
  createdAt: Date;
};

export interface TaxEvidenceRepository {
  /** 같은 근거(같은 루트)를 다시 올리면 새 기록을 만들지 않는다 — 앵커도 한 번만 일어난다. */
  save(input: {
    userId: string;
    countryCode: string;
    taxYear: number;
    merkleRoot: string;
    document: unknown;
    leafCount: number;
  }): Promise<TaxEvidenceRecordView>;
  /** 그 해의 가장 최근 기록. 화면이 "이미 기록함"을 말할 근거다. */
  findLatest(userId: string, countryCode: string, taxYear: number): Promise<TaxEvidenceRecordView | null>;
  findDocument(userId: string, merkleRoot: string): Promise<unknown | null>;
}
