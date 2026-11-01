/**
 * The ClickHouse schema-apply Workflow body (`runClickHouseSchemaApply`, unmodified), run
 * in-process. `Cloudflare.WorkflowStep` is provided by a step runner that executes each
 * `durableStep` inline with its configured retries; there is no replay journal, which is fine:
 * every migration statement is `IF NOT EXISTS` and progress is tracked in
 * `_maple_schema_migrations`, so a crashed run is simply re-applied.
 */
import { DatabasePgLive } from "@maple/backend/platform/DatabasePgLive"
import { withPgConnectionScope } from "@maple/backend/platform/pg-connection-scope"
import { layerMapleDbConnection } from "@maple/backend/platform/pg-connection-source"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Duration, Effect, Layer, Schedule } from "effect"
import { FetchHttpClient } from "effect/http"
import { runClickHouseSchemaApply } from "../../api/src/workflows/ClickHouseSchemaApplyWorkflow.run"

const toDuration = (delay: string | number | undefined): Duration.Duration =>
	typeof delay === "number" ? Duration.millis(delay) : delay ? Duration.fromInputUnsafe(delay as Duration.Input) : Duration.seconds(1)

const InlineWorkflowStep = Layer.succeed(Cloudflare.WorkflowStep, {
	do: (options) => {
		const retries = options.retries?.limit ?? 0
		const base = toDuration(options.retries?.delay)
		const schedule =
			options.retries?.backoff === "exponential"
				? Schedule.exponential(base)
				: options.retries?.backoff === "linear"
					? Schedule.linear(base)
					: Schedule.spaced(base)
		return Effect.scoped(options.effect as Effect.Effect<any, any, any>).pipe(
			Effect.retry(Schedule.both(schedule, Schedule.recurs(retries))),
			Effect.withSpan(`schema-apply.step ${options.name}`),
		) as any
	},
	sleep: (_name, duration) => Effect.sleep(toDuration(duration)),
	sleepUntil: (_name, ts) => Effect.sleep(Duration.millis(Math.max(0, new Date(ts).getTime() - Date.now()))),
	waitForEvent: () => Effect.die(new Error("selfhost: waitForEvent unsupported")),
} as any)

export const runSchemaApplyInline = (orgId: string, env: Record<string, unknown>) =>
	Effect.runPromise(
		withPgConnectionScope(runClickHouseSchemaApply({ orgId } as any)).pipe(
			Effect.provide(
				Layer.mergeAll(DatabasePgLive, workerEnvLayer(env), FetchHttpClient.layer, InlineWorkflowStep).pipe(
					Layer.provideMerge(layerMapleDbConnection(env)),
				),
			),
			Effect.tap((r) => Effect.logInfo("selfhost: schema apply finished", r)),
		) as Effect.Effect<unknown, unknown, never>,
	).then(() => undefined)
