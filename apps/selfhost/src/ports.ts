/**
 * Self-hosted runtime ports: the seams `apiPorts()` (apps/api/src/worker/bindings.ts)
 * fills from Cloudflare bindings, filled here from plain process resources so the unmodified
 * api route graph and alerting ticks run under Bun on Kubernetes.
 *
 * Fork-only file (NevrLabs/maple `selfhost`). Upstream files are not edited.
 */
import { StatusPageStore } from "@maple/backend/services/status-pages/StatusPageStore"
import { fakeChatSessionsLayer } from "@maple/backend/platform/chat-sessions-fake"
import { envPorts } from "@maple/backend/platform/env-ports"
import {
	ApiV2RateLimit,
	AuditEventsQueueProducer,
	CancellationReviewQueueProducer,
	CliAuthRateLimit,
	EmailSender,
	MapleDbConnection,
	McpOAuthRateLimit,
	PlanetScaleWebhookQueueProducer,
	type QueueProducer,
	type RateLimiter,
	ReplayBlobBucket,
	SchemaApplyWorkflow,
	ShareLinkRateLimit,
	VcsBackfillQueueProducer,
	VcsSyncQueueProducer,
	type WorkflowStarter,
	WorkflowStartError,
} from "@maple/backend/platform/bindings"
import { Effect, Layer, Option } from "effect"
import { pgStatusBindings, statusDb } from "./status-store"

/** Process env as the Worker env record; `MAPLE_DB` is synthesised from `MAPLE_PG_URL`. */
export const selfhostEnv = (): Record<string, unknown> => {
	const env: Record<string, unknown> = { ...process.env }
	const pg = process.env.MAPLE_PG_URL
	if (pg) {
		const u = new URL(pg)
		// The shape `readMapleDbBinding` checks (packages/infra/src/cloudflare/maple-db.ts).
		env.MAPLE_DB = {
			connectionString: pg,
			host: u.hostname,
			port: Number(u.port || "5432"),
			database: u.pathname.replace(/^\//, "") || "postgres",
		}
	}
	return env
}

/** A queue whose consumer is not deployed here: accepted and dropped, logged once per batch. */
const droppingQueue = (name: string): QueueProducer => ({
	sendBatch: (messages) =>
		Effect.logDebug(`selfhost: ${name} queue disabled, dropped ${messages.length} message(s)`),
})

/** Fixed-window in-memory limiter (single replica). */
const memoryLimiter = (limit: number, periodSeconds: number): RateLimiter => {
	const windows = new Map<string, { start: number; count: number }>()
	return {
		limit: (key) =>
			Effect.sync(() => {
				const now = Date.now()
				const w = windows.get(key)
				if (!w || now - w.start >= periodSeconds * 1000) {
					windows.set(key, { start: now, count: 1 })
					return { success: true }
				}
				w.count += 1
				return { success: w.count <= limit }
			}),
	}
}

/**
 * Schema apply. The Cloudflare Workflow is replaced by an in-process runner injected by the
 * entrypoint (it needs the full route graph's services); until injected, starts fail typed.
 */
export type SchemaApplyRunner = (orgId: string) => Promise<void>
let schemaApplyRunner: SchemaApplyRunner | undefined
export const setSchemaApplyRunner = (runner: SchemaApplyRunner) => {
	schemaApplyRunner = runner
}
const schemaApplyStarter: WorkflowStarter<{ readonly orgId: string }> = {
	create: (params) =>
		schemaApplyRunner === undefined
			? Effect.fail(new WorkflowStartError({ message: "selfhost: schema apply runner not ready", cause: undefined }))
			: Effect.sync(() => {
					// Fire and forget, as a Workflow start is: the UI polls the run row.
					void schemaApplyRunner!(params.orgId).catch((error) =>
						console.error("selfhost: schema apply run failed", error),
					)
				}),
}

/** Status-page storage shared by api, alerting and the status server (PATCHES #9). */
export const selfhostStatusBindings = (() => {
	let bindings: ReturnType<typeof pgStatusBindings> | null | undefined
	return () => {
		if (bindings === undefined)
			bindings = process.env.MAPLE_PG_URL ? pgStatusBindings(statusDb(process.env.MAPLE_PG_URL)) : null
		return bindings
	}
})()

const statusPageStoreLayer = () => {
	const bindings = selfhostStatusBindings()
	return bindings === null ? StatusPageStore.inMemory : StatusPageStore.fromBindings(bindings.kv, bindings.bucket)
}

/** : the Postgres-backed queue (vcs-queue.ts, PATCHES #6); without it VCS jobs are dropped as before. */
export const selfhostPorts = (env: Record<string, unknown>, vcsSync?: QueueProducer) =>
	Layer.mergeAll(
		Layer.succeed(VcsSyncQueueProducer, vcsSync ?? droppingQueue("vcs-sync")),
		// Both upstream VCS lanes use the durable selfhost consumer.
		Layer.succeed(VcsBackfillQueueProducer, vcsSync ?? droppingQueue("vcs-backfill")),
		Layer.succeed(PlanetScaleWebhookQueueProducer, droppingQueue("planetscale-webhooks")),
		Layer.succeed(AuditEventsQueueProducer, droppingQueue("audit-events")),
		Layer.succeed(CancellationReviewQueueProducer, droppingQueue("cancellation-reviews")),
		Layer.succeed(ShareLinkRateLimit, memoryLimiter(6000, 60)),
		Layer.succeed(ApiV2RateLimit, memoryLimiter(600, 60)),
		Layer.succeed(CliAuthRateLimit, memoryLimiter(30, 60)),
		Layer.succeed(McpOAuthRateLimit, memoryLimiter(60, 60)),
		Layer.succeed(ReplayBlobBucket, { getBytes: () => Effect.succeed(Option.none()) }),
		// PATCHES #9: status-page KV/R2 in Postgres (status-store.ts), served by status.ts; in-memory without a DB.
		statusPageStoreLayer(),
		Layer.succeed(EmailSender, Option.none()),
		Layer.succeed(SchemaApplyWorkflow, schemaApplyStarter),
		Layer.succeed(
			MapleDbConnection,
			Option.map(Option.fromNullishOr(process.env.MAPLE_PG_URL), (connectionString) => {
				const u = new URL(connectionString)
				return {
					connectionString,
					attributes: {
						"db.namespace": u.pathname.replace(/^\//, ""),
						"server.address": u.hostname,
						"server.port": Number(u.port || "5432"),
					},
				}
			}),
		),
		// AI chat lives in maple-ai's Durable Object; not deployed self-hosted.
		fakeChatSessionsLayer(() => ({})),
		envPorts(env),
	)
