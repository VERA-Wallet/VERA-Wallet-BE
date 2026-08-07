import { IsEthereumAddress, IsInt, IsOptional, IsString, Min } from "class-validator";

export class BindChallengeDto {
  @IsOptional() @IsEthereumAddress() address?: string;
}
export class BindWalletDto {
  @IsEthereumAddress() address!: string;
  @IsString() message!: string;
  @IsString() signature!: string;
  @IsString() nonce!: string;
}
export class SiweNonceDto {
  @IsInt() @Min(1) chainId!: number;
}
export class SiweVerifyDto {
  @IsString() message!: string;
  @IsString() signature!: string;
}
