import { randomUUID } from "node:crypto";
import { Injectable } from "@nestjs/common";
import { PrismaService } from "../shared/prisma.service";
import type { TaxEvidenceDocumentView, TaxEvidenceRecordView, TaxEvidenceRepository } from "./evidence.repository";

type StoredEvidence = TaxEvidenceRecordView & { userId: string; document: unknown };

const key = (userId: string, merkleRoot: string) => `${userId}:${merkleRoot.toLowerCase()}`;

@Injectable()
export class MockTaxEvidenceRepository implements TaxEvidenceRepository {
  private readonly records = new Map<string, StoredEvidence>();

  async save(input: { userId: string; countryCode: string; taxYear: number; merkleRoot: string; document: unknown; leafCount: number }) {
    const existing = this.records.get(key(input.userId, input.merkleRoot));
    if (existing) return view(existing);
    const record: StoredEvidence = { id: randomUUID(), createdAt: new Date(), ...input };
    this.records.set(key(input.userId, input.merkleRoot), record);
    return view(record);
  }

  async findLatest(userId: string, countryCode: string, taxYear: number) {
    const matches = [...this.records.values()]
      .filter((record) => record.userId === userId && record.countryCode === countryCode && record.taxYear === taxYear)
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
    return matches[0] ? view(matches[0]) : null;
  }

  async findByRoot(userId: string, merkleRoot: string): Promise<TaxEvidenceDocumentView | null> {
    const record = this.records.get(key(userId, merkleRoot));
    return record ? { ...view(record), document: record.document } : null;
  }
}

function view(record: StoredEvidence): TaxEvidenceRecordView {
  const { userId: _userId, document: _document, ...rest } = record;
  return rest;
}

const SELECT = { id: true, countryCode: true, taxYear: true, merkleRoot: true, leafCount: true, createdAt: true } as const;

@Injectable()
export class PrismaTaxEvidenceRepository implements TaxEvidenceRepository {
  constructor(private readonly prisma: PrismaService) {}

  save(input: { userId: string; countryCode: string; taxYear: number; merkleRoot: string; document: unknown; leafCount: number }) {
    // 같은 사용자가 같은 근거를 다시 올리면 기존 기록을 그대로 돌려준다(앵커는 payloadHash 기준으로 이미 멱등이다).
    return this.prisma.taxEvidence.upsert({
      where: { userId_merkleRoot: { userId: input.userId, merkleRoot: input.merkleRoot } },
      update: {},
      create: { ...input, document: input.document as never },
      select: SELECT,
    });
  }

  findLatest(userId: string, countryCode: string, taxYear: number) {
    return this.prisma.taxEvidence.findFirst({ where: { userId, countryCode, taxYear }, orderBy: { createdAt: "desc" }, select: SELECT });
  }

  findByRoot(userId: string, merkleRoot: string): Promise<TaxEvidenceDocumentView | null> {
    return this.prisma.taxEvidence.findUnique({ where: { userId_merkleRoot: { userId, merkleRoot } }, select: { ...SELECT, document: true } });
  }
}
