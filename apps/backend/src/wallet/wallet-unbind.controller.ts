import { Controller, Delete, Param, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { success } from "../shared/api";
import { WalletUnbindService } from "./wallet-unbind.service";

/** FE 호환 표면. `GET /api/auth/wallets`가 목록을 주듯 `DELETE /api/auth/wallets/:address`가 하나를 뺀다. */
@UseGuards(JwtAuthGuard)
@Controller("api/auth")
export class FrontendWalletUnbindController {
  constructor(private readonly unbinding: WalletUnbindService) {}

  @Delete("wallets/:address") async remove(@CurrentUser() user: AuthenticatedUser, @Param("address") address: string) {
    return success(await this.unbinding.unbind(user, address));
  }
}
