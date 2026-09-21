import { ArrayMinSize, IsArray, IsIn, IsOptional, IsString, Matches } from "class-validator";

/**
 * FE가 올리는 계산 근거 정본.
 *
 * `merkleRoot`는 **받아서 믿는 값이 아니다** — 서버가 잎에서 다시 계산하고, 값이 함께 왔으면 대조해
 * 어긋나면 거절한다. FE·BE 구현이 갈린 채 체인에 올라가는 것을 막는 유일한 지점이다.
 */
export class RecordEvidenceDto {
  @IsIn([1]) version!: number;
  /** 잎 0번은 헤더(귀속연도·국가·totals)여야 한다. 서비스가 그 계약을 확인한다. */
  @IsArray() @ArrayMinSize(1) leaves!: Record<string, unknown>[];
  @IsOptional() @IsString() @Matches(/^0x[0-9a-fA-F]{64}$/) merkleRoot?: string;
}
