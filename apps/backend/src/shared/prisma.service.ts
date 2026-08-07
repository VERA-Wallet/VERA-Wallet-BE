import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly config: ConfigService) { super(); }
  async onModuleInit() {
    if (this.config.get<string>("MOCK_MODE", "true") !== "true") await this.$connect();
  }
  async onModuleDestroy() {
    if (this.config.get<string>("MOCK_MODE", "true") !== "true") await this.$disconnect();
  }
}
