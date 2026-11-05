// SAFETY-FILE: JSON here is emitted by the query under test before assertions.
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { compileUnsafe } from "@maple-dev/effect-orm/clickhouse"
import { Effect } from "effect"
import { OrgId } from "@maple/domain/primitives"
import { auditNativeSpanProfileByServiceQuery, auditOrphanSpansSQL } from "@maple/query-engine-integrations"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_audit_e2e")
const orgId = OrgId.make("org_audit")
const start = Math.floor((Date.now() - 3 * 3_600_000) / 1000) * 1000
const dt = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19)
const window = {
	orgId,
	childStart: dt(start),
	childEnd: dt(start + 3_600_000),
	parentStart: dt(start - 3_600_000),
}
const quote = (s: string) => `'${s.replace(/'/g, "\\'")}'`
const span = (
	service: string,
	trace: string,
	id: string,
	parent: string,
	kind: string,
	ms = start,
	org = orgId,
	state = "",
) => [org, dt(ms), trace, id, parent, kind, service, state].map(quote).join(", ")
const read = async (traceSampleModulus = 1) => {
	const { sql } = Effect.runSync(auditOrphanSpansSQL({ ...window, traceSampleModulus }))
	const body = await clickhouseExec(sql, database, { output_format_json_quote_64bit_integers: "0" })
	return (
		JSON.parse(body) as {
			data: Array<{
				serviceName: string
				childCount: number
				orphanCount: number
				sampledOrphanCount: number
			}>
		}
	).data
}

describe.skipIf(!clickhouseE2eEnabled)("setup audit parent existence", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		const rows = [
			// Existing Internal parent, cross-service and earlier than the child window.
			span("caller", "internal", "p", "", "Internal", start - 1000),
			span("internal", "internal", "c", "p", "Server"),
			// Duplicate exports must not multiply the denominator in the parent join.
			span("caller", "internal", "p", "", "Internal", start - 1000),
			span("missing", "missing", "c", "p", "Consumer"),
			span("sampled", "sampled", "c", "p", "Server", start, orgId, "th:8"),
			// A matching span id in another trace or org cannot repair a missing parent.
			span("caller", "wrong-trace", "p", "", "Internal"),
			span("trace-isolated", "isolated", "c", "p", "Server"),
			span("caller", "tenant", "p", "", "Internal", start, OrgId.make("org_other")),
			span("tenant-isolated", "tenant", "c", "p", "Server"),
			// Parent-start is inclusive, child-end exclusive, parent before lookback absent.
			span("caller", "boundary", "p", "", "Internal", start - 3_600_000),
			span("boundary", "boundary", "c", "p", "Server"),
			span("caller", "old", "p", "", "Internal", start - 3_600_001),
			span("old-parent", "old", "c", "p", "Server"),
			span("outside-child", "outside", "c", "p", "Server", start + 3_600_000),
			span("outside-child", "before", "c", "p", "Server", start - 1000),
		]
		// Enough traces that modulus=4 actually exercises both kept and dropped traces.
		for (let i = 0; i < 64; i++) {
			rows.push(span("caller", `mod-${i}`, "p", "", "Internal"))
			rows.push(span("modulus", `mod-${i}`, "c", "p", "Server"))
		}
		await clickhouseExec(
			`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanKind, ServiceName, TraceState) VALUES ${rows.map((r) => `(${r})`).join(",")}`,
			database,
		)
	}, 180_000)
	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("separates synthetic scopes from native spans including mixed-service errors and entrypoints", async () => {
		await clickhouseExec(
			`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ServiceName, ScopeName, SpanKind, StatusCode) VALUES
		('${orgId}', '${dt(start)}', 'synthetic', '1', 'synthetic-only', 'maple-uptime', 'Server', 'Error'),
		('${orgId}', '${dt(start)}', 'synthetic', '2', 'mixed', 'maple-uptime', 'Server', 'Error'),
		('${orgId}', '${dt(start)}', 'native', '3', 'mixed', 'sdk', 'Internal', 'Unset'),
		('${orgId}', '${dt(start)}', 'native', '4', 'native-error', '', 'Consumer', 'Error'),
		('org_other', '${dt(start)}', 'native', '5', 'foreign', 'sdk', 'Server', 'Error')`,
			database,
		)
		const { sql } = compileUnsafe(auditNativeSpanProfileByServiceQuery(), {
			orgId,
			startTime: window.childStart,
			endTime: window.childEnd,
		})
		const result = JSON.parse(
			await clickhouseExec(sql, database, { output_format_json_quote_64bit_integers: "0" }),
		) as { data: Array<Record<string, unknown>> }
		assert.deepInclude(
			result.data.find((r) => r.serviceName === "synthetic-only"),
			{ spanCount: 0, errorCount: 0, serverCount: 0, consumerCount: 0 },
		)
		assert.deepInclude(
			result.data.find((r) => r.serviceName === "mixed"),
			{ spanCount: 1, errorCount: 0, serverCount: 0, consumerCount: 0 },
		)
		assert.deepInclude(
			result.data.find((r) => r.serviceName === "native-error"),
			{ spanCount: 1, errorCount: 1, serverCount: 0, consumerCount: 1 },
		)
		assert.isFalse(result.data.some((r) => r.serviceName === "foreign"))
	})

	it("finds Internal parents without multiplying duplicate exports", async () => {
		const row = (await read()).find((r) => r.serviceName === "internal")
		assert.deepInclude(row, { childCount: 1, orphanCount: 0, sampledOrphanCount: 0 })
	})
	it("retains true orphans, sampling evidence and trace/tenant isolation", async () => {
		const rows = await read()
		for (const name of ["missing", "trace-isolated", "tenant-isolated", "old-parent"]) {
			assert.deepInclude(
				rows.find((r) => r.serviceName === name),
				{ childCount: 1, orphanCount: 1, sampledOrphanCount: 0 },
			)
		}
		assert.deepInclude(
			rows.find((r) => r.serviceName === "sampled"),
			{ orphanCount: 1, sampledOrphanCount: 1 },
		)
	})
	it("keeps the existing half-open window and extra parent lookback", async () => {
		const rows = await read()
		assert.deepInclude(
			rows.find((r) => r.serviceName === "boundary"),
			{ childCount: 1, orphanCount: 0 },
		)
		assert.isFalse(rows.some((r) => r.serviceName === "outside-child"))
	})
	it("samples whole traces on both sides of the join", async () => {
		const row = (await read(4)).find((r) => r.serviceName === "modulus")
		assert.isAbove(row!.childCount, 0)
		assert.isBelow(row!.childCount, 64)
		assert.strictEqual(row!.orphanCount, 0)
	})
})
