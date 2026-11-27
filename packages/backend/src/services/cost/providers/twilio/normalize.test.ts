import { Array as Arr, Result, Schema } from "effect"
import { describe, expect, it } from "vitest"
import { UsageRecord } from "./twilio-costs-api"
import { isProductCategory, numberOf, toCostRows } from "./normalize"

const ACCOUNT = "AC" + "0123456789abcdef0123456789abcdef"
const WINDOW = { startDay: "2026-10-20", endDay: "2026-11-10" }
/** The window's last day, still open on a pull on 2026-11-11. */
const OPEN_DAY = "2026-11-10"

const rows = (wire: ReadonlyArray<unknown>) =>
	toCostRows(Schema.decodeUnknownSync(Schema.Array(UsageRecord))(wire), ACCOUNT, WINDOW, OPEN_DAY)

const okRows = (wire: ReadonlyArray<unknown>) => {
	const result = rows(wire)
	if (Result.isFailure(result)) return expect.fail(result.failure)
	return result.success
}

/** A usage record as Twilio answers it, with the fields Maple does not read. */
const record = (day: string, price: string, extra: Record<string, unknown> = {}) => ({
	category: "sms",
	description: "Total SMS",
	start_date: day,
	end_date: day,
	usage: "72",
	usage_unit: "messages",
	count: "72",
	count_unit: "messages",
	price,
	price_unit: "USD",
	as_of: null,
	...extra,
})

describe("Twilio usage records as cost rows", () => {
	it("keeps a product category, drops a subcategory beside its parent and the summaries, and keeps a hyphenated product on its own", () => {
		const reported = new Set([
			"sms",
			"sms-outbound",
			"phonenumbers",
			"phonenumbers-local",
			"studio-engagements",
			"total",
			"totalprice",
		])
		expect(isProductCategory("sms", reported)).toBe(true)
		expect(isProductCategory("sms-outbound", reported)).toBe(false)
		expect(isProductCategory("phonenumbers", reported)).toBe(true)
		expect(isProductCategory("phonenumbers-local", reported)).toBe(false)
		expect(isProductCategory("studio-engagements", reported)).toBe(true)
		expect(isProductCategory("total", reported)).toBe(false)
		expect(isProductCategory("totalprice", reported)).toBe(false)
		// With no parent reported, the hyphenated name is the product.
		expect(isProductCategory("sms-outbound", new Set(["sms-outbound"]))).toBe(true)
	})

	it("bills Twilio's negative price as cost, sums a day's records of one category, and skips what it does not charge", () => {
		const made = okRows([
			record("2026-10-21", "-0.72"),
			// A second record of the same day and category is summed into the row.
			record("2026-10-21", "-0.28", { count: "3" }),
			// A subcategory beside its parent, and a summary, repeat what the product category carries.
			record("2026-10-21", "-1", { category: "sms-outbound" }),
			record("2026-10-21", "-5", { category: "total" }),
			// A hyphenated product with no parent reported is its own row.
			record("2026-10-21", "-0.3", {
				category: "studio-engagements",
				description: "Studio Engagements",
				count: "2",
			}),
			// Usage Twilio does not bill, and a credit, are not charges.
			record("2026-10-20", "0"),
			record("2026-10-20", "0.5"),
			record("2026-11-10", "-0.035", { description: null }),
			record("2026-11-12", "-0.5"),
		])
		expect(
			Arr.map(made, (row) => [
				row.day,
				row.cloudService,
				row.usageType,
				row.billedCost,
				row.consumedQuantity,
				row.consumedUnit,
				row.currency,
				row.estimated,
			]),
		).toEqual([
			["2026-10-21", "Total SMS", "sms", 1, 75, "messages", "USD", false],
			["2026-10-21", "Studio Engagements", "studio-engagements", 0.3, 2, "messages", "USD", false],
			["2026-11-10", "sms", "sms", 0.035, 72, "messages", "USD", true],
		])
	})

	it("fails a price that is not a number, and reads Twilio's numeric strings", () => {
		expect([numberOf("-0.5"), numberOf(" 7 "), numberOf("abc"), numberOf(null), numberOf(3)]).toEqual([
			-0.5,
			7,
			null,
			null,
			3,
		])
		const failed = rows([record("2026-10-21", "abc")])
		expect(Result.isFailure(failed) ? failed.failure : "succeeded").toBe(
			"Twilio reported a price that is not a number on 2026-10-21",
		)
	})
})
