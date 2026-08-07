import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, Max, Min } from "class-validator";

export class CalculateTaxDto {
  @IsIn(["KR", "DE", "US"]) countryCode!: "KR" | "DE" | "US";
  @IsString() period!: string;
  @IsOptional() @IsString() ruleVersion?: string;
}

export class FrontendEstimateDto {
  @IsString() country!: string;
  @IsInt() @Min(2009) @Max(2100) taxYear!: number;
  @IsIn(["scenario", "wallet"]) source!: "scenario" | "wallet";
  @IsOptional() @IsObject() profile?: Record<string, unknown>;
  @IsOptional() @IsBoolean() includeMarginal?: boolean;
}
