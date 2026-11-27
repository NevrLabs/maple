import { Result, Schema, Array as Arr } from "effect"
import { describe, expect, it } from "vitest"
import { UsageLineItem } from "./mongodb-costs-api"
import { toCostRows } from "./normalize"

const ORG = "68d4c8f1b1c2d3e4f5a6b7c8"
const WINDOW = { startDay: "2026-10-20", endDay: "2026-11-10" }
/** The two newest days of a pull on 2026-11-11 can still change. */
const OPEN_DAY = "2026-11-09"

const rows = (lines: ReadonlyArray<unknown>) =>
	toCostRows(Schema.decodeUnknownSync(Schema.Array(UsageLineItem))(lines), ORG, WINDOW, OPEN_DAY)

const okRows = (lines: ReadonlyArray<unknown>) => {
	const result = rows(lines)
	if (Result.isFailure(result)) return expect.fail(result.failure)
	return result.success
}

/** A line item as Atlas answers it, with the fields Maple does not read. */
const line = (usageDate: string, totalPriceCents: number, extra: Record<string, unknown> = {}) => ({
	usageStartDate: `${usageDate}T00:00:00Z`,
	usageDate,
	billDate: `${usageDate}T00:00:00Z`,
	groupId: "proj_abc",
	clusterName: "Cluster0",
	cloudProvider: "AWS",
	sku: "M10",
	description: "M10 Atlas Data Transfer",
	quantity: 2,
	unitPriceDollars: 0.045,
	totalPriceCents,
	...extra,
})

describe("MongoDB Atlas line items as cost rows", () => {
	it("makes one row per usage day, resource and SKU, in cents as dollars", () => {
		const made = okRows([
			line("2026-10-20", 150),
			// A second line of the same day, resource and SKU is summed into the row.
			line("2026-10-20", 50),
			line("2026-10-31", 200, {
				groupId: "proj_def",
				sku: "M30",
				description: "M30 Storage",
				unitPriceDollars: null,
			}),
		])
		expect(made).toHaveLength(2)
		expect(made[0]).toMatchObject({
			day: "2026-10-20",
			accountId: ORG,
			cloudService: "M10 Atlas Data Transfer",
			serviceCategory: "Databases",
			usageType: "M10 Atlas Data Transfer",
			region: "global",
			resourceId: "proj_abc/Cluster0",
			resourceType: "cluster",
			billedCost: 2,
			effectiveCost: 2,
			listCost: 0.18,
			consumedQuantity: 4,
			currency: "USD",
			estimated: false,
			tags: { cloudProvider: "AWS" },
		})
		expect(made[1]).toMatchObject({
			resourceId: "proj_def/Cluster0",
			billedCost: 2,
			// No unit price named: the list cost is what was billed.
			listCost: 2,
		})
	})

	it("leaves out the days outside the window and lines that charge nothing", () => {
		expect(
			Arr.map(
				okRows([
					line("2026-10-19", 900),
					line("2026-11-11", 900),
					line("2026-10-21", 0),
					line("2026-10-22", 0, { totalPriceCents: null }),
					line("2026-10-23", 300),
				]),
				(row) => row.day,
			),
		).toEqual(["2026-10-23"])
	})

	it("bills a charge that names no cluster to its project, and one that names neither to nothing", () => {
		const made = okRows([
			line("2026-10-20", 100, { clusterName: null, description: "Atlas Support", quantity: null }),
			line("2026-10-21", 200, {
				clusterName: null,
				groupId: null,
				description: null,
				cloudProvider: null,
				quantity: null,
			}),
		])
		expect(
			Arr.map(made, (row) => [
				row.resourceId,
				row.resourceType,
				row.cloudService,
				row.consumedQuantity,
				row.tags,
			]),
		).toEqual([
			["proj_abc", "project", "Atlas Support", 0, { cloudProvider: "AWS" }],
			["", "", "MongoDB Atlas", 0, {}],
		])
	})

	it("marks the newest days estimated, and fails a price that is not a number", () => {
		const made = okRows([line("2026-11-08", 100), line("2026-11-09", 100), line("2026-11-10", 100)])
		expect(Arr.map(made, (row) => [row.day, row.estimated])).toEqual([
			["2026-11-08", false],
			["2026-11-09", true],
			["2026-11-10", true],
		])
		const failed = rows([line("2026-10-20", Number.POSITIVE_INFINITY)])
		expect(Result.isFailure(failed) && failed.failure).toBe(
			"MongoDB Atlas reported a price that is not a number on 2026-10-20",
		)
	})
})
