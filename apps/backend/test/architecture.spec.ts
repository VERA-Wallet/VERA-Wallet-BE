import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "src");
function filesBelow(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("architecture boundaries", () => {
  it("keeps Prisma outside domain services and controllers", () => {
    const offenders = filesBelow(sourceRoot)
      .filter((path) => /\.(service|controller|strategy)\.ts$/.test(path))
      .filter((path) => !path.endsWith("shared/prisma.service.ts"))
      .filter((path) => /@prisma\/client|PrismaService/.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("keeps repository ports independent from NestJS and Prisma", () => {
    const offenders = filesBelow(sourceRoot)
      .filter((path) => path.endsWith(".repository.ts"))
      .filter((path) => /@nestjs|@prisma|PrismaService/.test(readFileSync(path, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("preserves the anchor privacy boundary", () => {
    const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
    const anchorModel = schema.match(/model AnchorRecord \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(anchorModel).not.toMatch(/^\s*(userId|user)\s/m);
  });
});
