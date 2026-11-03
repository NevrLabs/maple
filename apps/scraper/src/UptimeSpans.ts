import { Array as Arr, Option } from "effect"
import {
	MAPLE_SERVICES_NAMESPACE,
	UPTIME_MONITOR_ID_ATTRIBUTE,
	UPTIME_SERVICE_NAME,
	UPTIME_TIMING_ATTRIBUTES,
	type UptimeProbeTarget,
} from "@maple/domain/uptime"
import type { PhaseTimings } from "./UptimePhases"
import type { CheckTraceContext, ProbeOutcome } from "./UptimeProbe"

/** Everything one check span needs; buffered until the org's next flush. */
export interface UptimeCheckSpan {
	readonly ingestKey: string
	readonly monitor: Pick<UptimeProbeTarget, "id" | "name" | "serviceName" | "config">
	readonly trace: CheckTraceContext
	readonly startedAtMs: number
	readonly endedAtMs: number
	readonly outcome: ProbeOutcome
}

export type OtlpAnyValue =
	| { readonly stringValue: string }
	| { readonly boolValue: boolean }
	| { readonly intValue: string }
	| { readonly doubleValue: number }

export interface OtlpKeyValue {
	readonly key: string
	readonly value: OtlpAnyValue
}

export interface OtlpSpan {
	readonly traceId: string
	readonly spanId: string
	readonly name: string
	/** 3 = SPAN_KIND_CLIENT (the check); 2 = SPAN_KIND_SERVER (selfhost target span, PATCHES #8). */
	readonly kind: 2 | 3
	readonly parentSpanId?: string
	readonly startTimeUnixNano: string
	readonly endTimeUnixNano: string
	readonly attributes: ReadonlyArray<OtlpKeyValue>
	/** 0 = STATUS_CODE_UNSET (selfhost target span), 1 = STATUS_CODE_OK, 2 = STATUS_CODE_ERROR. */
	readonly status: { readonly code: 0 | 1 | 2; readonly message?: string }
}

export interface OtlpTraceExportRequest {
	readonly resourceSpans: ReadonlyArray<{
		readonly resource: { readonly attributes: ReadonlyArray<OtlpKeyValue> }
		readonly scopeSpans: ReadonlyArray<{
			readonly scope: { readonly name: string; readonly version: string }
			readonly spans: ReadonlyArray<OtlpSpan>
		}>
	}>
}

const SCOPE = { name: UPTIME_SERVICE_NAME, version: "1.0" } as const

/** NevrLabs selfhost (PATCHES #8): opt-in target spans + environment on check spans. Off = upstream. */
const TARGET_SPANS =
	typeof process !== "undefined" && process.env?.MAPLE_SELFHOST_UPTIME_TARGET_SPANS === "1"

const anyValue = (value: string | number | boolean): OtlpAnyValue => {
	if (typeof value === "string") return { stringValue: value }
	if (typeof value === "boolean") return { boolValue: value }
	return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
}

const keyValues = (attributes: Readonly<Record<string, string | number | boolean>>) =>
	Object.entries(attributes).map(([key, value]): OtlpKeyValue => ({ key, value: anyValue(value) }))

/** Epoch ms as the decimal-string nanos OTLP/JSON uses; BigInt because ns overflow 2^53. */
export const toUnixNano = (ms: number): string => (BigInt(Math.round(ms)) * 1_000_000n).toString()

const parseUrl = (raw: string): Option.Option<URL> => Option.liftThrowable(() => new URL(raw))()

/** `GET /checkout/health`, `TCP db.example.com:5432`, `DNS A example.com`. */
export const checkSpanName = (config: UptimeCheckSpan["monitor"]["config"]): string => {
	switch (config._tag) {
		case "http":
			return Option.match(parseUrl(config.url), {
				onNone: () => config.method,
				onSome: (url) => `${config.method} ${url.pathname}`,
			})
		case "tcp":
			return `TCP ${config.host}:${config.port}`
		case "dns":
			return `DNS ${config.recordType} ${config.hostname}`
	}
}

const targetAttributes = (
	config: UptimeCheckSpan["monitor"]["config"],
): Record<string, string | number | boolean> => {
	switch (config._tag) {
		case "http":
			// The query and fragment may carry credentials, so the span keeps scheme, host and path.
			return Option.match(parseUrl(config.url), {
				onNone: () => ({
					"url.full": config.url.split(/[?#]/u)[0] ?? "",
					"http.request.method": config.method,
				}),
				onSome: (url) => ({
					"url.full": `${url.origin}${url.pathname}`,
					"http.request.method": config.method,
					"server.address": url.hostname,
					"server.port": Number(url.port || (url.protocol === "https:" ? 443 : 80)),
					"network.transport": "tcp",
				}),
			})
		case "tcp":
			return { "server.address": config.host, "server.port": config.port, "network.transport": "tcp" }
		case "dns":
			return {
				"dns.question.name": config.hostname,
				"maple.uptime.dns.record_type": config.recordType,
				"network.transport": "udp",
			}
	}
}

const PHASE_FIELDS = ["dnsMs", "connectMs", "tlsMs", "ttfbMs", "transferMs"] as const satisfies ReadonlyArray<
	keyof PhaseTimings
>

/** An HTTP check's phases in ms to 0.1 ms; a phase that did not happen has no attribute. */
export const timingAttributes = (timings: PhaseTimings | undefined): Record<string, number> =>
	Object.fromEntries(
		PHASE_FIELDS.flatMap((field) => {
			const value = timings?.[field] ?? null
			return value === null ? [] : [[UPTIME_TIMING_ATTRIBUTES[field], Math.round(value * 10) / 10]]
		}),
	)

/** One CLIENT span for a check, ids equal to the `traceparent` the target saw. */
export const toOtlpSpan = (check: UptimeCheckSpan): OtlpSpan => {
	const { outcome } = check
	return {
		traceId: check.trace.traceId,
		spanId: check.trace.spanId,
		name: checkSpanName(check.monitor.config),
		kind: 3,
		startTimeUnixNano: toUnixNano(check.startedAtMs),
		endTimeUnixNano: toUnixNano(check.endedAtMs),
		attributes: keyValues({
			...targetAttributes(check.monitor.config),
			"maple.uptime.kind": check.monitor.config._tag,
			"maple.uptime.ok": outcome.ok,
			...(outcome.statusCode === null
				? undefined
				: { "http.response.status_code": outcome.statusCode }),
			...(outcome.errorType === null ? undefined : { "error.type": outcome.errorType }),
			...(outcome.error === null ? undefined : { "maple.uptime.failure": outcome.error }),
			...timingAttributes(outcome.timings),
		}),
		status: outcome.ok ? { code: 1 } : { code: 2, message: outcome.error ?? "Check failed" },
	}
}

const resourceAttributes = (monitor: UptimeCheckSpan["monitor"]) =>
	keyValues({
		"service.name": UPTIME_SERVICE_NAME,
		"service.namespace": MAPLE_SERVICES_NAMESPACE,
		[UPTIME_MONITOR_ID_ATTRIBUTE]: monitor.id,
		"maple.uptime.monitor_name": monitor.name,
		...(monitor.serviceName === null ? undefined : { "maple.uptime.service_name": monitor.serviceName }),
		// PATCHES #8: selfhost check spans carry the probe's environment (Setup Health RES-03).
		...(TARGET_SPANS ? { "deployment.environment.name": "homelab" } : undefined),
	})

/**
 * NevrLabs selfhost (PATCHES #8): with `MAPLE_SELFHOST_UPTIME_TARGET_SPANS=1`, a monitor that names a
 * service also gets one SERVER span per check under that service (child of the check span), so the
 * target is listed on Services next to its metrics/logs. The check span itself is untouched, so the
 * uptime UI (which reads `maple-uptime` root spans) is unaffected. Off = upstream behaviour.
 */

/** Deterministic 16-hex child span id derived from the check span id (no extra randomness to carry). */
const targetSpanId = (spanId: string): string =>
	spanId
		.split("")
		.map((c) => (Number.parseInt(c, 16) ^ 0xa).toString(16))
		.join("")

const toTargetSpan = (check: UptimeCheckSpan): OtlpSpan => {
	const base = toOtlpSpan(check)
	return {
		...base,
		spanId: targetSpanId(check.trace.spanId),
		parentSpanId: check.trace.spanId,
		name: `uptime ${base.name}`,
		kind: 2,
		attributes: [...base.attributes, ...keyValues({ "maple.uptime.synthetic": true })],
		// PATCHES #12: status UNSET, not Error. A failed probe is the monitor's alert, not an error in the
		// target service (as Error it opened an error-tracking issue + a Discord message per failing monitor).
		status: { code: 0 },
	}
}

/** One export request; checks of the same monitor share a resource. */
export const encodeTraceExport = (checks: ReadonlyArray<UptimeCheckSpan>): OtlpTraceExportRequest => {
	const byMonitor = Arr.groupBy(checks, (check) => check.monitor.id)
	const groups = Object.values(byMonitor)
	const checkSpans = groups.map((group) => ({
		// The newest check names the resource, so a rename shows up at once.
		resource: { attributes: resourceAttributes(Arr.lastNonEmpty(group).monitor) },
		scopeSpans: [{ scope: SCOPE, spans: group.map(toOtlpSpan) }],
	}))
	if (!TARGET_SPANS) return { resourceSpans: checkSpans }
	const targetSpans = groups.flatMap((group) => {
		const monitor = Arr.lastNonEmpty(group).monitor
		if (monitor.serviceName === null || monitor.serviceName === "") return []
		return [
			{
				resource: {
					attributes: keyValues({
						"service.name": monitor.serviceName,
						"deployment.environment.name": "homelab",
						[UPTIME_MONITOR_ID_ATTRIBUTE]: monitor.id,
						"maple.uptime.monitor_name": monitor.name,
					}),
				},
				scopeSpans: [{ scope: SCOPE, spans: group.map(toTargetSpan) }],
			},
		]
	})
	return { resourceSpans: [...checkSpans, ...targetSpans] }
}
