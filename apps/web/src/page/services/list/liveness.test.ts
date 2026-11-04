import { describe, expect, it } from "vitest"
import { countDead, LIVENESS_SQL, livenessState, toLiveness, withoutDead } from "./liveness"
import type { ServiceRow } from "./model"

const NOW = Date.parse("2026-11-04T12:00:00Z")
const MIN = 60_000

const row = (serviceName: string): ServiceRow => ({
	serviceName,
	serviceNamespace: "",
	environment: "homelab",
	commits: [],
	p50LatencyMs: 1,
	p95LatencyMs: 1,
	p99LatencyMs: 1,
	errorRate: 0,
	throughput: 1,
	tracedThroughput: 1,
	hasSampling: false,
	samplingWeight: 1,
	spanCount: 1,
})

describe("service liveness (PATCHES #14)", () => {
	it("alive under 15 min, stale under 24 h, dead after or never seen", () => {
		expect(livenessState(NOW - 14 * MIN, NOW)).toBe("alive")
		expect(livenessState(NOW - 16 * MIN, NOW)).toBe("stale")
		expect(livenessState(NOW - 23 * 60 * MIN, NOW)).toBe("stale")
		expect(livenessState(NOW - 25 * 60 * MIN, NOW)).toBe("dead")
		expect(livenessState(undefined, NOW)).toBe("dead")
	})

	it("hides dead rows unless asked, and hides nothing while liveness is unknown", () => {
		const rows = [row("zitadel"), row("odoo"), row("crucix")]
		const liveness = { zitadel: NOW - MIN, crucix: NOW - 2 * 60 * MIN }
		expect(withoutDead(rows, liveness, NOW, false).map((r) => r.serviceName)).toEqual(["zitadel", "crucix"])
		expect(withoutDead(rows, liveness, NOW, true)).toHaveLength(3)
		expect(withoutDead(rows, undefined, NOW, false)).toHaveLength(3)
		expect(countDead(rows, liveness, NOW)).toBe(1)
		expect(countDead(rows, undefined, NOW)).toBe(0)
	})

	it("decodes the query rows and drops blanks", () => {
		expect(toLiveness([{ service: "a", lastSeenMs: "1793703599000" }, { service: "", lastSeenMs: 5 }, { service: "b", lastSeenMs: 0 }])).toEqual({
			a: 1793703599000,
		})
	})

	it("a failed uptime probe never counts as a sign of life, and workload-state gauges are ignored", () => {
		expect(LIVENESS_SQL).toContain("SpanAttributes['maple.uptime.ok'] = 'true'")
		expect(LIVENESS_SQL).toContain("$__orgFilter(t)")
		expect(LIVENESS_SQL).toMatch(/k8s\[\.\]\(deployment\|/)
	})
})
