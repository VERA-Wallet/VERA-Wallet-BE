import "reflect-metadata";
import { ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import cookieParser from "cookie-parser";
import { AppModule } from "./app.module";
import { HttpExceptionEnvelopeFilter } from "./shared/http-exception.filter";

async function bootstrap() {
  if (process.env.MOCK_MODE === "false" && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
    throw new Error("JWT_SECRET must contain at least 32 characters outside MOCK_MODE.");
  }
  const app = await NestFactory.create(AppModule);
  app.use(cookieParser());
  app.enableCors({ origin: process.env.FRONTEND_ORIGIN ?? "http://localhost:3100", credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  app.useGlobalFilters(new HttpExceptionEnvelopeFilter());
  await app.listen(Number(process.env.PORT ?? 3200));
}

void bootstrap();
