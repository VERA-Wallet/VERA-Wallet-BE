import { IsIn, IsInt, IsOptional, IsString, Min } from "class-validator";

export class ReclassifyDto {
  @IsIn(["RECEIVE", "SEND", "EXCHANGE", "INTERNAL_TRANSFER", "UNKNOWN", "SPAM"]) classification!: string;
  @IsOptional() @IsString() reason?: string;
  @IsInt() @Min(1) expectedVersion!: number;
}
