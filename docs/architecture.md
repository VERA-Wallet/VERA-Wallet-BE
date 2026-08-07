# Architecture and SOLID boundaries

## Dependency direction

Controllers call application services. Application services depend on narrow repository interfaces or external ports. The composition root binds those ports to Mock or Prisma implementations according to `MOCK_MODE`.

```text
HTTP controller
    ↓
application use case
    ↓
domain port (interface/token)
    ↓
Mock adapter | Prisma adapter | external adapter
```

Domain services and controllers must not import `PrismaService` or `@prisma/client`. Repository port files must not import NestJS or Prisma. `test/architecture.spec.ts` enforces both rules.

## Responsibility boundaries

- Identity: verification orchestration and identity persistence
- Wallet: challenge lifecycle, signature verification, binding persistence
- Indexer: external synchronization, transaction queries, event presentation and reclassification
- Anchor: evidence adapter, status lifecycle, queue dispatch and submission use case
- Tax: pure engine, calculation orchestration and report persistence
- Report: report lookup and audit-finalization workflow

The pure `packages/tax-engine` package is divided into core types/rules/calculation and frontend compatibility metadata/estimation. It has no NestJS dependency.

## Privacy invariant

`AnchorRecord` contains no user relation or `userId`. Anchor adapters receive only a payload hash and anchor type. Raw identity claims, wallet addresses and transaction payloads never cross the anchor port.
