import { Module } from "@nestjs/common";
import { AuthModule } from "../auth/auth.module";
import { IndexerModule } from "../indexer/indexer.module";
import { WalletModule } from "./wallet.module";
import { FrontendWalletUnbindController } from "./wallet-unbind.controller";
import { WalletUnbindService } from "./wallet-unbind.service";

/**
 * 지갑 등록 해제는 지갑 모듈과 인덱서 모듈 양쪽의 저장소를 쓴다. 인덱서가 이미 지갑 모듈을 import하므로
 * 지갑 모듈에 두면 순환이 된다 — 둘 다 import하는 얇은 모듈로 뺀다.
 */
@Module({
  imports: [AuthModule, WalletModule, IndexerModule],
  controllers: [FrontendWalletUnbindController],
  providers: [WalletUnbindService],
})
export class WalletUnbindModule {}
