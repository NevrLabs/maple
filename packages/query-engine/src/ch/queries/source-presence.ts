// Last sample of one metric series over a window (NevrLabs selfhost). SourcesService dates an
// infrastructure push platform's last arrival with it: `mongodb_atlas`, `proxmox` and `postgresql`
// are sent by a collector the org already runs, often under another of its keys, so
// `sources.last_used_at` alone cannot say they receive data.
import type { DateTime } from "effect"
import * as CH from "@maple-dev/effect-orm/expr"
import { from, param } from "@maple-dev/effect-orm/clickhouse"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { orgIdParam } from "../tables"

export interface MetricLastSeenOutput {
	/** Over an empty window ClickHouse answers the epoch start; callers read that as never. */
	readonly lastSeen: DateTime.Utc
}

/** A `metrics_gauge` series' newest sample in the window. */
export function gaugeMetricLastSeenQuery(metricName: string) {
	return from(Datasources.metricsGauge)
		.select(($) => ({ lastSeen: CH.max_($.TimeUnix) }))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			$.MetricName.eq(metricName),
		])
		.format("JSON")
}

/** A `metrics_sum` series' newest sample in the window. */
export function sumMetricLastSeenQuery(metricName: string) {
	return from(Datasources.metricsSum)
		.select(($) => ({ lastSeen: CH.max_($.TimeUnix) }))
		.where(($) => [
			$.OrgId.eq(orgIdParam),
			$.TimeUnix.gte(param.dateTime("startTime")),
			$.TimeUnix.lte(param.dateTime("endTime")),
			$.MetricName.eq(metricName),
		])
		.format("JSON")
}
