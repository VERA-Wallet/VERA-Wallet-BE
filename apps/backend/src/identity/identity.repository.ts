import type { UserRecord } from "../shared/repository.types";

export interface VerifiedIdentityRepository {
  upsertVerifiedUser(didHash: string, method: string, verifiedAt: Date): Promise<UserRecord>;
}
export interface UserRepository {
  getUser(id: string): Promise<UserRecord | null>;
}
