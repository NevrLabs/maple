import { RawSqlExecuteRequest } from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { Effect, Schema } from "effect"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import type { ServiceRow } from "./model"

// NevrLabs selfhost (PATCHES #14): dead vs alive on /services. One raw-SQL read through the query engine's
// `executeRawSql` (the dashboard widgets' path: `$__orgFilter`, validator, limits), so no new backend.
// Last seen per service = the newest trace, log or metric row. Uptime target spans (PATCHES #8, span name
// `uptime …`) only count when the check passed, so a probe against a dead target never keeps it "alive".
// Older than the raw windows, the hourly rollups answer (metric_catalog, service_usage logs) at hour grain.
// k8s workload-state gauges (deployment.desired, …) are emitted for scaled-to-zero apps forever: excluded.

export const LIVENESS_SQL = `SELECT service, toUnixTimestamp(max(seen)) * 1000 AS lastSeenMs FROM (
  SELECT ServiceName AS service, max(Timestamp) AS seen FROM traces t
  WHERE $__orgFilter(t) AND Timestamp >= $__endTime - INTERVAL 1 DAY AND Timestamp <= $__endTime
    AND (NOT startsWith(SpanName, 'uptime ') OR SpanAttributes['maple.uptime.ok'] = 'true')
  GROUP BY service
  UNION ALL
  SELECT ServiceName, max(Timestamp) FROM logs l
  WHERE $__orgFilter(l) AND Timestamp >= $__endTime - INTERVAL 1 DAY AND Timestamp <= $__endTime GROUP BY ServiceName
  UNION ALL
  SELECT ServiceName, max(TimeUnix) FROM metrics_gauge g
  WHERE $__orgFilter(g) AND TimeUnix >= $__endTime - INTERVAL 30 MINUTE AND TimeUnix <= $__endTime
    AND NOT match(MetricName, '^k8s[.](deployment|replicaset|statefulset|daemonset|job|cronjob|hpa)[.]') GROUP BY ServiceName
  UNION ALL
  SELECT ServiceName, max(TimeUnix) FROM metrics_sum s
  WHERE $__orgFilter(s) AND TimeUnix >= $__endTime - INTERVAL 30 MINUTE AND TimeUnix <= $__endTime GROUP BY ServiceName
  UNION ALL
  SELECT ServiceName, least(max(Hour) + INTERVAL 3599 SECOND, $__endTime - INTERVAL 31 MINUTE) FROM metric_catalog c
  WHERE $__orgFilter(c) AND Hour >= $__endTime - INTERVAL 30 DAY
    AND NOT match(MetricName, '^k8s[.](deployment|replicaset|statefulset|daemonset|job|cronjob|hpa)[.]') GROUP BY ServiceName
  UNION ALL
  SELECT ServiceName, least(max(Hour) + INTERVAL 3599 SECOND, $__endTime - INTERVAL 1 DAY) FROM service_usage u
  WHERE $__orgFilter(u) AND Hour >= $__endTime - INTERVAL 30 DAY AND LogCount > 0 GROUP BY ServiceName
) GROUP BY service`

export const Liveness = Schema.Record(Schema.String, Schema.Number)
export type Liveness = typeof Liveness.Type

export type LivenessState = "alive" | "stale" | "dead"

/** Alive: data in the last 15 min. Stale: within 24 h. Dead: older, or nothing in 30 days. */
export const ALIVE_MS = 15 * 60_000
export const STALE_MS = 24 * 60 * 60_000

export const livenessState = (lastSeenMs: number | undefined, nowMs: number): LivenessState =>
	lastSeenMs === undefined || !Number.isFinite(lastSeenMs) || nowMs - lastSeenMs > STALE_MS
		? "dead"
		: nowMs - lastSeenMs > ALIVE_MS
			? "stale"
			: "alive"

/** `undefined` while liveness is unknown (loading or failed): nothing is hidden on a guess. */
export const stateOf = (
	liveness: Liveness | undefined,
	service: Pick<ServiceRow, "serviceName">,
	nowMs: number,
): LivenessState | undefined =>
	liveness === undefined ? undefined : livenessState(liveness[service.serviceName], nowMs)

/** Rows the table shows: dead ones only when `showDead`. */
export const withoutDead = (
	services: ReadonlyArray<ServiceRow>,
	liveness: Liveness | undefined,
	nowMs: number,
	showDead: boolean,
): ReadonlyArray<ServiceRow> =>
	showDead || liveness === undefined
		? services
		: services.filter((service) => stateOf(liveness, service, nowMs) !== "dead")

export const countDead = (services: ReadonlyArray<ServiceRow>, liveness: Liveness | undefined, nowMs: number) =>
	liveness === undefined ? 0 : services.filter((service) => stateOf(liveness, service, nowMs) === "dead").length

export const toLiveness = (rows: ReadonlyArray<Readonly<Record<string, unknown>>>): Liveness =>
	Object.fromEntries(
		rows.flatMap((row) => {
			const name = typeof row.service === "string" ? row.service : ""
			const ms = Number(row.lastSeenMs)
			return name === "" || !Number.isFinite(ms) || ms <= 0 ? [] : [[name, ms] as const]
		}),
	)

/** The read, ending now. A failure leaves liveness unknown (no row is hidden). */
export const loadLiveness = (nowMs: number) =>
	Effect.gen(function* () {
		const client = yield* MapleInternalApiClient
		const response = yield* client.queryEngine.executeRawSql({
			payload: new RawSqlExecuteRequest({
				sql: LIVENESS_SQL,
				displayType: "table",
				startTime: formatWarehouseDateTime(nowMs - STALE_MS),
				endTime: formatWarehouseDateTime(nowMs),
			}),
		})
		return toLiveness(response.data as ReadonlyArray<Readonly<Record<string, unknown>>>)
	}).pipe(Effect.mapError(toLoadFailure))
