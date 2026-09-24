import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { NestExpressApplication } from "@nestjs/platform-express";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import { HttpExceptionEnvelopeFilter } from "./shared/http-exception.filter";

import { installFetchTiming, requestTiming } from "./shared/request-timing";

async function bootstrap() {
  installFetchTiming();
  if (process.env.MOCK_MODE === "false" && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
    throw new Error("JWT_SECRET must contain at least 32 characters outside MOCK_MODE.");
  }
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // 계산 근거 정본은 판정 하나가 잎 하나라, 거래가 많은 지갑이면 본문이 수 MB가 된다.
  // Express 기본 100KB로는 1,000건짜리 지갑이 자기 근거를 체인에 올리지 못한다(실지갑 249건에서 413 관측).
  // 무한정 열어 두지 않는다 — 잎 수 상한(EVIDENCE_MAX_LEAVES)이 같은 경계를 도메인 쪽에서 한 번 더 막는다.
  app.use(requestTiming);
  app.useBodyParser("json", { limit: process.env.JSON_BODY_LIMIT ?? "12mb" });
  app.use(cookieParser());
  app.enableCors({ origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:3100", credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionEnvelopeFilter());
  await app.listen(Number(process.env.PORT ?? 3200));
}

void bootstrap();


