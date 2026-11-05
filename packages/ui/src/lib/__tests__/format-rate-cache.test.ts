import { afterEach, describe, expect, it, vi } from "vitest"

import { formatNumber } from "@maple/domain/format"
import { formatRate, formatThroughput } from "../format"

afterEach(() => vi.restoreAllMocks())

describe("rate formatter reuse", () => {
	it.each([
		-1000,
		-999.5,
		-100,
		-99.99,
		-1,
		-0.9999,
		-0.0123,
		-0,
		0,
		Number.MIN_VALUE,
		0.000001234,
		0.0123,
		0.995,
		0.9999,
		1,
		1.05,
		12.3456,
		99.95,
		99.99,
		100,
		100.5,
		999.5,
		999.99,
		1000,
		999960,
	])("preserves the original locale and rounding contract for %s", (value) => {
		const abs = Math.abs(value)
		const expected =
			abs >= 1000
				? formatNumber(value)
				: abs >= 100
					? Math.round(value).toLocaleString()
					: abs >= 1
						? value.toLocaleString(undefined, { maximumFractionDigits: 1 })
						: value.toLocaleString(undefined, { maximumSignificantDigits: 2 })
		expect(formatRate(value)).toBe(expected)
		expect(formatThroughput(value, "/s")).toBe(`${expected}/s`)
	})

	it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
		"keeps non-finite values as the placeholder: %s",
		(value) => expect(formatRate(value)).toBe("—"),
	)

	it("does not construct locale formatters through Number.toLocaleString on the tick path", () => {
		const locale = vi.spyOn(Number.prototype, "toLocaleString")
		for (let i = 0; i < 100; i++) {
			expect(formatRate(0.0123)).toBe("0.012")
			expect(formatRate(12.3456)).toBe("12.3")
			expect(formatRate(123.4)).toBe("123")
		}
		expect(locale).not.toHaveBeenCalled()
	})
})
