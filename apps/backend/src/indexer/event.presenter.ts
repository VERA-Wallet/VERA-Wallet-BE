import type { TransactionRecord } from "../shared/repository.types";

export function publicEvent(transaction: TransactionRecord) {
  const { _version: _version, _overrideHistory: _history, _anchorPayloadHash: _anchor, ...event } = transaction.payload;
  return event;
}

export function eventMutation(transaction: TransactionRecord) {
  return { event: publicEvent(transaction), version: Number(transaction.payload._version ?? 1) };
}

export function eventDetail(transaction: TransactionRecord) {
  return { ...eventMutation(transaction), override_history: transaction.payload._overrideHistory ?? [] };
}
