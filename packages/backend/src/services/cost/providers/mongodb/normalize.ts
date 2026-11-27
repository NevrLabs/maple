// Atlas invoice line items as `cost_daily` rows: one per usage day, resource and SKU. The usage-dated
// view already bills a line item to one day, so nothing is spread; lines of the same day, resource and
// description are summed. The resource is `<project>/<cluster>`: a cluster's name repeats across
// projects, and a charge that names no cluster belongs to its project alone.
import { Array as Arr, Option, Record as Rec, Result, String as Str } from "effect"
import type { CostPullRow, CostPullWindow } from "../../CostProvider"
import type { UsageLineItem } from "./mongodb-costs-api"

/** FOCUS `ServiceCategory` of every Atlas charge. */
const SERVICE_CATEGORY = "Databases"
/** The service of a line item that names none. */
const UNNAMED_SERVICE = "MongoDB Atlas"

const text = (value: string | null | undefined): string => value ?? ""

/** The resource a line item charges: `<project>/<cluster>` with a cluster, else its project, else nothing. */
export const resourceOf = (line: UsageLineItem): Readonly<{ resourceId: string; resourceType: string }> => {
	const project = text(line.groupId)
	const cluster = text(line.clusterName)
	if (cluster !== "") return { resourceId: `${project}/${cluster}`, resourceType: "cluster" }
	return project === ""
		? { resourceId: "", resourceType: "" }
		: { resourceId: project, resourceType: "project" }
}

/** The UTC day a line item's usage fell on, `YYYY-MM-DD`; its billing day when the usage day is missing. */
export const dayOf = (line: UsageLineItem): string => Str.slice(0, 10)(text(line.usageDate ?? line.billDate))

interface Charge {
	readonly day: string
	readonly resourceId: string
	readonly resourceType: string
	readonly description: string
	readonly cloudProvider: string
	readonly cents: number
	readonly quantity: number
	readonly unitPriceDollars: number | null
}

const sum = <A>(items: ReadonlyArray<A>, of: (item: A) => number): number =>
	Arr.reduce(items, 0, (total, item) => total + of(item))

/**
 * The window's charges. A line item without a price, or with one of zero, is not a charge. One with
 * a price that is not a finite number fails: it cannot be stored as cost. Days from `openDay` on
 * are not final, as every provider's newest days are: charges post the day after their usage.
 */
export const toCostRows = (
	lines: ReadonlyArray<UsageLineItem>,
	accountId: string,
	window: CostPullWindow,
	openDay: string,
): Result.Result<ReadonlyArray<CostPullRow>, string> => {
	const charges = Arr.flatMap(lines, (line): ReadonlyArray<Charge> => {
		const cents = line.totalPriceCents
		if (cents === null || cents === undefined || cents === 0) return []
		const day = dayOf(line)
		if (day < window.startDay || day > window.endDay) return []
		const { resourceId, resourceType } = resourceOf(line)
		return [
			{
				day,
				resourceId,
				resourceType,
				description: text(line.description),
				cloudProvider: text(line.cloudProvider),
				cents,
				quantity: line.quantity ?? 0,
				unitPriceDollars: line.unitPriceDollars ?? null,
			},
		]
	})
	const bad = Arr.findFirst(charges, (charge) => !Number.isFinite(charge.cents))
	if (Option.isSome(bad)) {
		return Result.fail(`MongoDB Atlas reported a price that is not a number on ${bad.value.day}`)
	}
	// A day's rows are replaced whole and read per key, so two rows of one key would count once.
	const groups = Arr.groupBy(charges, (charge) =>
		Arr.join([charge.day, charge.resourceId, charge.description], "\u0000"),
	)
	return Result.succeed(
		Arr.map(Rec.values(groups), (group): CostPullRow => {
			const first = Arr.headNonEmpty(group)
			const usd = sum(group, (charge) => charge.cents) / 100
			return {
				day: first.day,
				accountId,
				cloudService: first.description === "" ? UNNAMED_SERVICE : first.description,
				serviceCategory: SERVICE_CATEGORY,
				usageType: first.description,
				region: "global",
				resourceId: first.resourceId,
				resourceType: first.resourceType,
				serviceName: "",
				chargeCategory: "usage",
				basis: "billed",
				currency: "USD",
				billedCost: usd,
				effectiveCost: usd,
				// The list price where Atlas named one per unit, else what it billed.
				listCost: sum(group, (charge) =>
					charge.unitPriceDollars === null
						? charge.cents / 100
						: charge.unitPriceDollars * charge.quantity,
				),
				consumedQuantity: sum(group, (charge) => charge.quantity),
				// The usage-dated view carries no unit, so quantities of one SKU add up unqualified.
				consumedUnit: "",
				tags: first.cloudProvider === "" ? {} : { cloudProvider: first.cloudProvider },
				estimated: first.day >= openDay,
			}
		}),
	)
}
