import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaClient } from "@prisma/client";
import { usePrismaPersistence } from "./persistence-mode";

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(private readonly config: ConfigService) { super(); }
  async onModuleInit() {
    if (usePrismaPersistence(this.config)) await this.$connect();
  }
  async onModuleDestroy() {
    if (usePrismaPersistence(this.config)) await this.$disconnect();
  }
}
