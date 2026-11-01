# apps/selfhost — NevrLabs fork runtime

Runs Maple's **unmodified** api route graph and alerting ticks as plain Bun processes,
replacing the Cloudflare Workers runtime. No upstream file is edited.

| Cloudflare piece | Self-hosted replacement (`src/ports.ts`) |
|---|---|
| Hyperdrive `MAPLE_DB` | `MAPLE_PG_URL` → `MapleDbConnection` + synthesised `MAPLE_DB` env |
| Queues (vcs-sync, planetscale-webhooks, audit-events) | accepted + dropped (integrations not used self-hosted) |
| Rate-limit bindings | in-memory fixed window (single replica) |
| R2 replay blobs | none (replays stay inline) |
| KV+R2 status pages | `StatusPageStore.inMemory` |
| Email | none — use webhook / Telegram / Discord destinations |
| Durable Objects (AI chat) | `fakeChatSessionsLayer` (AI chat off) |
| ClickHouse schema-apply Workflow | `src/schema-apply.ts`: same `runClickHouseSchemaApply`, steps run inline with retries |
| Cron triggers | `src/alerting.ts`: 1-minute scheduler, same `ALERTING_SCHEDULE`, per-lane deadline, no overlap |

Entrypoints: `bun run src/api.ts` (:3472), `bun run src/alerting.ts` (:3480, `/health`, `POST /fire?cron=`).
Postgres schema: `bun run migrate` (= packages/db `db:migrate`, `DATABASE_URL`).
ClickHouse schema: `bun run packages/clickhouse-cli/src/cli.ts apply` (MAPLE_CH_URL/USER/PASSWORD/DATABASE).

Required env: MAPLE_PG_URL, MAPLE_ROOT_PASSWORD, MAPLE_INGEST_KEY_ENCRYPTION_KEY, MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY,
CLICKHOUSE_URL, CLICKHOUSE_PROVIDER=clickhouse, CLICKHOUSE_USER/PASSWORD/DATABASE, TINYBIRD_HOST+TINYBIRD_TOKEN (dummy;
Env schema requires them), MAPLE_ALERTING_ALLOW_NONPROD=1 (or MAPLE_ENVIRONMENT=production) for alerting.

## Known limits
- BYO ClickHouse via the UI (Settings → Bring your own ClickHouse) rejects private hosts (`@maple/safe-fetch`
  `validateExternalUrl`). Use the env-level warehouse (`CLICKHOUSE_URL`, single-org self_hosted) and apply schema
  with the CLI instead.
- Single api replica (in-memory limiters + edge-cache fallback are per process).
- AI chat / investigations / MCP-over-ai disabled (no maple-ai Worker).
