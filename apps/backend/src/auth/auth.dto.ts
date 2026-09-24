import { IsIn, IsOptional, IsString, MinLength, MaxLength } from "class-validator";

export class StartVerificationDto {
  @IsOptional() @IsString() sessionId?: string;
}
export class VerificationCallbackDto {
  @IsString() @MinLength(1) token!: string;
  @IsOptional() @IsIn(["KR", "DE", "US", "UK"]) country?: string;
}
export class PresentDidDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(256) offerId?: string;
  @IsIn(["KR", "DE", "US", "UK"]) country!: "KR" | "DE" | "US" | "UK";
  /**
   * OmniOne CX 표준인증창 성공 콜백의 일회용 토큰(FE `lib/omnione/oacx.ts`).
   *
   * whitelist ValidationPipe는 DTO에 없는 속성을 조용히 버린다. 이 필드가 없으면 FE가 토큰을 실어 보내도
   * 컨트롤러까지 도달하지 못하고, Real 모드 전환 시 검증할 토큰 자체가 사라진다.
   * 인증창을 쓰지 않는 mock 흐름(e2e·계약 테스트)은 이 필드를 생략한다.
   */
  @IsOptional() @IsString() @MinLength(1) cxToken?: string;
}

export class DidOfferDto {
  @IsIn(["KR", "DE", "US", "UK"]) country!: "KR" | "DE" | "US" | "UK";
}
