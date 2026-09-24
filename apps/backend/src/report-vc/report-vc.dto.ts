import { IsIn, IsInt, IsString, Matches, Max, Min } from "class-validator";
export class IssueReportVcDto {
  @IsString() @Matches(/^0x[a-fA-F0-9]{64}$/) evidenceId!: string;
}
export class VerifyReportVcDto {
  @IsIn(["basic", "with_amounts"]) disclosure!: "basic" | "with_amounts";
}
export class CheckReportFileDto {
  @IsIn(["csv", "xlsx"]) format!: "csv" | "xlsx";
  @IsIn(["keccak256"]) algorithm!: "keccak256";
  @IsString() @Matches(/^0x[a-fA-F0-9]{64}$/) hash!: string;
  @IsInt() @Min(0) @Max(100_000_000) byteLength!: number;
}
