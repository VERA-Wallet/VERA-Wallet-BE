import { Module } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { IDENTITY_PROVIDER } from "../shared/tokens";
import { MockIdentityAdapter, OmniOneCxAdapter } from "./identity.adapters";

@Module({
  providers: [
    MockIdentityAdapter,
    OmniOneCxAdapter,
    {
      provide: IDENTITY_PROVIDER,
      useFactory: (config: ConfigService, mock: MockIdentityAdapter, real: OmniOneCxAdapter) => config.get("MOCK_MODE", "true") === "true" ? mock : real,
      inject: [ConfigService, MockIdentityAdapter, OmniOneCxAdapter],
    },
  ],
  exports: [IDENTITY_PROVIDER],
})
export class IdentityModule {}
