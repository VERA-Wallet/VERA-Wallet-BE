import { IsIn, IsOptional, IsString, MinLength } from "class-validator";

export class StartVerificationDto {
  @IsOptional() @IsString() sessionId?: string;
}
export class VerificationCallbackDto {
  @IsString() @MinLength(1) token!: string;
  @IsOptional() @IsIn(["KR", "DE", "US", "UK"]) country?: string;
}
export class PresentDidDto {
  @IsIn(["KR", "DE", "US", "UK"]) country!: "KR" | "DE" | "US" | "UK";
}
