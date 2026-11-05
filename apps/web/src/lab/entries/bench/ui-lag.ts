import { OrgId } from "@maple/domain"
import { Result, Schema } from "effect"
import { defineLab } from "../../define"
import { init, update } from "../../../page/services/list/update"
import { Model, type ServiceRow } from "../../../page/services/list/model"
import { Message } from "../../../page/services/list/message"
import { view } from "../../../page/services/list/view"

// Deterministic OFFLINE fixture; never presented as live telemetry.
const context = {
	orgId: Schema.decodeSync(OrgId)("org_ui_lag_fixture"),
	pinnedNamespace: null,
	timeZone: "UTC",
}
const nowMs = Date.UTC(2026, 10, 4, 12)
const rows: ServiceRow[] = Array.from({ length: 58 }, (_, i) => ({
	serviceName: `fixture-service-${String(i).padStart(2, "0")}`,
	serviceNamespace: "offline-fixture",
	environment: "fixture",
	commits: [],
	p50LatencyMs: 1,
	p95LatencyMs: 10,
	p99LatencyMs: 20,
	errorRate: i === 0 ? 0.05 : 0,
	throughput: 0.03 + i / 100,
	tracedThroughput: 0.03 + i / 100,
	hasSampling: false,
	samplingWeight: 1,
	spanCount: 100,
}))
const window = { startTime: "2026-11-04 00:00:00", endTime: "2026-11-04 12:00:00" }
const base = update(
	init({ search: {} }, context).model,
	Message.CompletedResolveWindow({ window, nowMs, mode: "Load" }),
	context,
).model
const series = Object.fromEntries(
	rows.map((row) => [
		row.serviceName,
		{
			throughput: Array.from({ length: 144 }, (_, i) => 0.03 + (i % 9) / 100),
			errorRate: Array.from({ length: 144 }, (_, i) => (i % 17 === 0 ? 0.05 : 0)),
		},
	]),
)
const messages: Message[] = [
	Message.CompletedFetchOverview({ key: base.overview.key ?? "", result: Result.succeed(rows) }),
	Message.CompletedFetchSparklines({ key: base.sparklines.key ?? "", result: Result.succeed(series) }),
	Message.CompletedFetchAnomalies({ key: base.anomalies.key ?? "", result: Result.succeed([]) }),
	Message.CompletedFetchFacets({
		key: base.facets.key ?? "",
		result: Result.succeed({ environments: [], namespaces: [], commitShas: [] }),
	}),
	Message.UpdatedIncidents({ orgId: context.orgId, incidents: [] }),
	Message.CompletedLoadChartRuntime(),
	Message.ResolvedThemeColors({
		colors: { "--chart-throughput": "#aa88ee", "--severity-error": "#ee6677" },
	}),
]
const initial = messages.reduce((model, message) => update(model, message, context).model, base)
const metrics = { views: 0, messages: 0, completionMessages: 0 }
Object.assign(globalThis, { __uiLagPage: metrics })
export const lab = defineLab<Model, Message>("OFFLINE Services performance fixture", {
	Model,
	init: () => ({ model: initial }),
	update: (model, message) => {
		metrics.messages++
		if (message._tag === "GotSparklineMessage") metrics.completionMessages++
		// Keep the real update/view but no API commands in this offline workload.
		return { model: update(model, message, context).model }
	},
	view: (model, h) => {
		metrics.views++
		return h.div(
			[h.Class("h-screen bg-background text-foreground"), h.DataAttribute("offline-fixture", "true")],
			[
				h.div([], ["OFFLINE deterministic Services fixture — not live telemetry"]),
				h.submodel({
					slotId: "services",
					model,
					view,
					toParentMessage: (message) => message,
					viewInputs: { context },
				}),
			],
		)
	},
})
