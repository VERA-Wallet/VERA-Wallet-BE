import { BadRequestException, Body, Controller, Get, NotFoundException, Param, Post, Query, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { JwtAuthGuard } from "../auth/jwt-auth.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { success } from "../shared/api";
import { RecordEvidenceDto } from "./evidence.dto";
import { TaxEvidenceService } from "./evidence.service";

/**
 * 계산 근거 기록. FE가 사용자의 "기록하기"에서 정본 문서를 올리면 서버가 루트를 다시 계산해
 * OmniOne 체인에 올린다. 경로가 `api/`로 시작하는 이유는 FE 프록시 allowlist와 같은 이름을 쓰기 위해서다
 * (`/api/anchor-proof`와 같은 규약).
 */
@UseGuards(JwtAuthGuard)
@Controller("api/tax-evidence")
export class TaxEvidenceController {
  constructor(private readonly evidence: TaxEvidenceService) {}

  @Post()
  async record(@CurrentUser() user: AuthenticatedUser, @Body() body: RecordEvidenceDto) {
    return success(await this.evidence.record(user.sub, body));
  }

  @Get()
  async latest(@CurrentUser() user: AuthenticatedUser, @Query("country") country?: string, @Query("taxYear") taxYear?: string) {
    const year = Number(taxYear);
    if (!country || !Number.isInteger(year)) throw new BadRequestException("country and taxYear are required.");
    const record = await this.evidence.latest(user.sub, country, year);
    if (!record) throw new NotFoundException("No recorded evidence for that tax year.");
    return success(record);
  }

  /**
   * 체인을 지금 읽어 대조한다. OmniOne에는 블록 탐색기가 없어 사용자가 직접 트랜잭션을 볼 수 없으므로,
   * 서버가 대신 읽어 "체인의 해시 == 내 근거의 루트"를 확인해 준다.
   * 경로 세그먼트가 둘이라 아래 정본 문서 라우트(`:merkleRoot`)와 겹치지 않는다.
   */
  @Get(":merkleRoot/chain")
  async chain(@CurrentUser() user: AuthenticatedUser, @Param("merkleRoot") merkleRoot: string) {
    const check = await this.evidence.checkChain(user.sub, merkleRoot);
    if (!check) throw new NotFoundException("Evidence document not found.");
    return success(check);
  }

  /**
   * 루트가 덮고 있는 정본 문서. 체인에는 해시만 있으므로, 나중에 건별 판정을 증명하려면
   * 이 원본에서 잎과 경로를 다시 만들어야 한다 — 그래서 올린 사람만 열 수 있게 둔다.
   */
  @Get(":merkleRoot")
  async document(@CurrentUser() user: AuthenticatedUser, @Param("merkleRoot") merkleRoot: string) {
    const document = await this.evidence.document(user.sub, merkleRoot);
    if (!document) throw new NotFoundException("Evidence document not found.");
    return success(document);
  }
}
