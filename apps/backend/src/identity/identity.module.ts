import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SharedModule } from "../shared/shared.module";
import { useMockIdentity } from "../shared/identity-mode";
import { usePrismaPersistence } from "../shared/persistence-mode";
import { MockIdentityAdapter, OmniOneCxAdapter } from "./identity.adapters";
import { MockIdentityRepository, PrismaIdentityRepository } from "./identity.repository.adapters";
import { IDENTITY_PROVIDER, IDENTITY_REPOSITORY, USER_REPOSITORY } from "./identity.tokens";

@Module({
  imports: [SharedModule],
  providers: [
    MockIdentityAdapter,
    OmniOneCxAdapter,
    MockIdentityRepository,
    PrismaIdentityRepository,
    {
      provide: IDENTITY_PROVIDER,
      useFactory: (config: ConfigService, mock: MockIdentityAdapter, real: OmniOneCxAdapter) => useMockIdentity(config) ? mock : real,
      inject: [ConfigService, MockIdentityAdapter, OmniOneCxAdapter],
    },
    {
      provide: IDENTITY_REPOSITORY,
      useFactory: (config: ConfigService, mock: MockIdentityRepository, prisma: PrismaIdentityRepository) => usePrismaPersistence(config) ? prisma : mock,
      inject: [ConfigService, MockIdentityRepository, PrismaIdentityRepository],
    },
    { provide: USER_REPOSITORY, useExisting: IDENTITY_REPOSITORY },
  ],
  exports: [IDENTITY_PROVIDER, IDENTITY_REPOSITORY, USER_REPOSITORY],
})
export class IdentityModule {}
