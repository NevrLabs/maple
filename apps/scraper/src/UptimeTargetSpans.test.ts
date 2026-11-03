import { assert, describe, it } from "@effect/vitest"
import { mkUptimeTarget } from "./testing/uptime"
import { succeeded } from "./UptimeProbe"

// NevrLabs selfhost (PATCHES #8): opt-in SERVER span under the monitored service. Set before import:
// the flag is read once at module load.
process.env.MAPLE_SELFHOST_UPTIME_TARGET_SPANS = "1"
const { encodeTraceExport } = await import("./UptimeSpans")

const TRACE = { traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" }
const check = (serviceName: string | null) => ({
	ingestKey: "maple_pk_test",
	monitor: { ...mkUptimeTarget(), serviceName },
	trace: TRACE,
	startedAtMs: 1_761_436_800_000,
	endedAtMs: 1_761_436_800_120,
	outcome: succeeded(120, 200),
})
const resourceService = (rs: { resource: { attributes: ReadonlyArray<{ key: string; value: unknown }> } }) =>
	rs.resource.attributes.find((kv) => kv.key === "service.name")?.value

describe("selfhost target spans", () => {
	it("adds a SERVER child span under the monitor's service, check span unchanged", () => {
		const request = encodeTraceExport([check("postgresql")])
		assert.strictEqual(request.resourceSpans.length, 2)
		const [checkRs, targetRs] = request.resourceSpans
		assert.deepStrictEqual(resourceService(checkRs!), { stringValue: "maple-uptime" })
		assert.deepStrictEqual(resourceService(targetRs!), { stringValue: "postgresql" })
		const env = checkRs!.resource.attributes.find((kv) => kv.key === "deployment.environment.name")?.value
		assert.deepStrictEqual(env, { stringValue: "homelab" })
		const checkSpan = checkRs!.scopeSpans[0]!.spans[0]!
		const target = targetRs!.scopeSpans[0]!.spans[0]!
		assert.strictEqual(checkSpan.kind, 3)
		assert.strictEqual(checkSpan.spanId, TRACE.spanId)
		assert.strictEqual(checkSpan.parentSpanId, undefined)
		assert.strictEqual(target.kind, 2)
		assert.strictEqual(target.traceId, TRACE.traceId)
		assert.strictEqual(target.parentSpanId, TRACE.spanId)
		assert.notStrictEqual(target.spanId, TRACE.spanId)
		assert.match(target.spanId, /^[0-9a-f]{16}$/u)
	})

	// PATCHES #12
	it("leaves the target span status unset on a failed check, so it is no error in the target service", () => {
		const failed = { ...check("postgresql"), outcome: { ...succeeded(120, 200), ok: false, error: "refused" } }
		const [checkRs, targetRs] = encodeTraceExport([failed]).resourceSpans
		assert.strictEqual(checkRs!.scopeSpans[0]!.spans[0]!.status.code, 2)
		assert.deepStrictEqual(targetRs!.scopeSpans[0]!.spans[0]!.status, { code: 0 })
	})

	it("adds nothing for a monitor without a service", () => {
		assert.strictEqual(encodeTraceExport([check(null)]).resourceSpans.length, 1)
	})
})
