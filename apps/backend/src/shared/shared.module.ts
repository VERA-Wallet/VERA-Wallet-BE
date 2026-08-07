import { Global, Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { MockIdentityRepository, PrismaIdentityRepository } from "../identity/identity.repository.adapters";
import { MockWalletRepository, PrismaWalletRepository } from "../wallet/wallet.repository.adapters";
import { MockAnchorRepository, PrismaAnchorRepository } from "../anchor/anchor.repository.adapters";
import { MockTransactionRepository, PrismaTransactionRepository } from "../indexer/transaction.repository.adapters";
import { MockTaxRepository, PrismaTaxRepository } from "../tax/tax.repository.adapters";
import { ANCHOR_REPOSITORY, IDENTITY_REPOSITORY, REPORT_REPOSITORY, TAX_REPOSITORY, TRANSACTION_REPOSITORY, TRANSACTION_SYNC_REPOSITORY, USER_REPOSITORY, WALLET_BINDING_REPOSITORY, WALLET_REPOSITORY } from "./tokens";
import { PrismaService } from "./prisma.service";

@Global()
@Module({
  providers: [
    PrismaService,
    MockIdentityRepository, PrismaIdentityRepository,
    MockWalletRepository, PrismaWalletRepository,
    MockAnchorRepository, PrismaAnchorRepository,
    MockTransactionRepository, PrismaTransactionRepository,
    MockTaxRepository, PrismaTaxRepository,
    { provide: IDENTITY_REPOSITORY, useFactory: (config: ConfigService, mock: MockIdentityRepository, prisma: PrismaIdentityRepository) => config.get("MOCK_MODE", "true") === "true" ? mock : prisma, inject: [ConfigService, MockIdentityRepository, PrismaIdentityRepository] },
    { provide: USER_REPOSITORY, useExisting: IDENTITY_REPOSITORY },
    { provide: WALLET_REPOSITORY, useFactory: (config: ConfigService, mock: MockWalletRepository, prisma: PrismaWalletRepository) => config.get("MOCK_MODE", "true") === "true" ? mock : prisma, inject: [ConfigService, MockWalletRepository, PrismaWalletRepository] },
    { provide: WALLET_BINDING_REPOSITORY, useExisting: WALLET_REPOSITORY },
    { provide: ANCHOR_REPOSITORY, useFactory: (config: ConfigService, mock: MockAnchorRepository, prisma: PrismaAnchorRepository) => config.get("MOCK_MODE", "true") === "true" ? mock : prisma, inject: [ConfigService, MockAnchorRepository, PrismaAnchorRepository] },
    { provide: TRANSACTION_REPOSITORY, useFactory: (config: ConfigService, mock: MockTransactionRepository, prisma: PrismaTransactionRepository) => config.get("MOCK_MODE", "true") === "true" ? mock : prisma, inject: [ConfigService, MockTransactionRepository, PrismaTransactionRepository] },
    { provide: TRANSACTION_SYNC_REPOSITORY, useExisting: TRANSACTION_REPOSITORY },
    { provide: TAX_REPOSITORY, useFactory: (config: ConfigService, mock: MockTaxRepository, prisma: PrismaTaxRepository) => config.get("MOCK_MODE", "true") === "true" ? mock : prisma, inject: [ConfigService, MockTaxRepository, PrismaTaxRepository] },
    { provide: REPORT_REPOSITORY, useExisting: TAX_REPOSITORY },
  ],
  exports: [PrismaService, IDENTITY_REPOSITORY, USER_REPOSITORY, WALLET_REPOSITORY, WALLET_BINDING_REPOSITORY, ANCHOR_REPOSITORY, TRANSACTION_REPOSITORY, TRANSACTION_SYNC_REPOSITORY, TAX_REPOSITORY, REPORT_REPOSITORY],
})
export class SharedModule {}
