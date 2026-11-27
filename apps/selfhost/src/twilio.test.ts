import { describe, expect, test } from "bun:test"
import { maskNumber, selectNew, severityOf, toLogRecord, toOtlpLogs } from "./twilio"

const MESSAGE = {
	sid: "SM" + "0123456789abcdef0123456789abcdef",
	status: "undelivered",
	from: "+15005550006",
	to: "+6281234567890",
	direction: "outbound-api",
	date_created: "2026-11-27T10:00:00Z",
	date_sent: "2026-11-27T10:00:01Z",
	date_updated: "2026-11-27T10:05:00Z",
	error_code: 30007,
	error_message: "Carrier violation",
	price: "-0.05",
	price_unit: "USD",
	num_segments: 1,
}

describe("Twilio exporter", () => {
	test("a failed delivery is an error, a call nobody took a warning, the rest information", () => {
		expect(severityOf("message", "undelivered")).toBe("error")
		expect(severityOf("message", "failed")).toBe("error")
		expect(severityOf("message", "delivered")).toBe("info")
		expect(severityOf("call", "no-answer")).toBe("warn")
		expect(severityOf("call", "busy")).toBe("warn")
		expect(severityOf("call", "completed")).toBe("info")
		expect(severityOf("call", "failed")).toBe("error")
	})

	test("a log line hides a number's middle digits, and the record keeps what Maple groups on", () => {
		expect(maskNumber("+6281234567890")).toBe("+628•••7890")
		expect(maskNumber("1234")).toBe("1234")
		const record = toLogRecord("message", MESSAGE)
		expect([record.severityNumber, record.severityText, record.body.stringValue]).toEqual([
			17,
			"ERROR",
			"SMS to +628•••7890 undelivered (30007: Carrier violation)",
		])
		// Dated by the status change, so a late failure lands when it happened.
		expect(record.timeUnixNano).toBe(`${Date.parse("2026-11-27T10:05:00Z")}000000`)
		const attributes = Object.fromEntries(
			record.attributes.map((attribute) => [attribute.key, attribute.value.stringValue]),
		)
		expect(attributes).toMatchObject({
			"event.name": "twilio.message",
			"twilio.status": "undelivered",
			"twilio.to": "+6281234567890",
			"twilio.error_code": "30007",
			"twilio.price": "-0.05",
			"twilio.message.latency_ms": "1000",
		})
		expect(Object.keys(attributes).some((key) => key.includes("body"))).toBe(false)
		const call = toLogRecord("call", {
			sid: "CA" + "0123456789abcdef0123456789abcdef",
			status: "completed",
			to: "+6281234567890",
			direction: "outbound-api",
			date_created: "2026-11-27T10:00:00Z",
			start_time: "2026-11-27T10:00:02Z",
			date_updated: "2026-11-27T10:03:00Z",
			duration: "178",
			price: "-0.27",
			price_unit: "USD",
		})
		expect([call.severityNumber, call.body.stringValue]).toEqual([
			9,
			"Call to +628•••7890 completed (178s)",
		])
	})

	test("a poll takes records created since the cursor, minus an overlap, that it has not pushed in that status", () => {
		const since = "2026-11-27T10:00:00Z"
		const older = { ...MESSAGE, sid: "SMolder", date_created: "2026-11-27T09:00:00Z" }
		const inOverlap = { ...MESSAGE, sid: "SMoverlap", date_created: "2026-11-27T09:57:00Z" }
		const same = { ...MESSAGE, sid: "SMagain", date_created: "2026-11-27T10:01:00Z" }
		const changed = {
			...MESSAGE,
			sid: "SMagain",
			status: "delivered",
			date_updated: "2026-11-27T10:06:00Z",
			date_created: "2026-11-27T10:01:00Z",
		}
		const seen = new Set([`${same.sid}|${same.status}|${same.date_updated}`])
		expect(selectNew([older, inOverlap, same, changed], since, seen).map((record) => record.sid)).toEqual(
			["SMoverlap", "SMagain"],
		)
	})

	test("the batch is one OTLP log export under the twilio service", () => {
		const envelope = toOtlpLogs([toLogRecord("message", MESSAGE)])
		expect(envelope.resourceLogs[0]?.resource.attributes[0]).toEqual({
			key: "service.name",
			value: { stringValue: "twilio" },
		})
		expect(envelope.resourceLogs[0]?.scopeLogs[0]?.logRecords).toHaveLength(1)
	})
})
