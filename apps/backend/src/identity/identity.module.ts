import { OpenDidVerifierAdapter } from "./opendid-verifier.adapter";
import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { SharedModule } from "../shared/shared.module";
import { identityProviderName } from "../shared/identity-mode";
import { usePrismaPersistence } from "../shared/persistence-mode";
import { MockIdentityAdapter, OmniOneCxAdapter } from "./identity.adapters";
import { MockIdentityRepository, PrismaIdentityRepository } from "./identity.repository.adapters";
import { IDENTITY_PROVIDER, IDENTITY_REPOSITORY, USER_REPOSITORY } from "./identity.tokens";

@Module({
  imports: [SharedModule],
  providers: [
    OpenDidVerifierAdapter,
    MockIdentityAdapter,
    OmniOneCxAdapter,
    MockIdentityRepository,
    PrismaIdentityRepository,
    {
      provide: IDENTITY_PROVIDER,
      useFactory: (config: ConfigService, mock: MockIdentityAdapter, real: OmniOneCxAdapter, open: OpenDidVerifierAdapter) => ({ mock, omnione_cx: real, opendid: open })[identityProviderName(key => config.get<string>(key))],
      inject: [ConfigService, MockIdentityAdapter, OmniOneCxAdapter, OpenDidVerifierAdapter],
    },
    {
      provide: IDENTITY_REPOSITORY,
      useFactory: (config: ConfigService, mock: MockIdentityRepository, prisma: PrismaIdentityRepository) => usePrismaPersistence(config) ? prisma : mock,
      inject: [ConfigService, MockIdentityRepository, PrismaIdentityRepository],
    },
    { provide: USER_REPOSITORY, useExisting: IDENTITY_REPOSITORY },
  ],
  exports: [OpenDidVerifierAdapter, IDENTITY_PROVIDER, IDENTITY_REPOSITORY, USER_REPOSITORY],
})
export class IdentityModule {}
