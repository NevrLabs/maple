// Twilio usage records as `cost_daily` rows: one per usage day and product category. `Daily` already
// aggregates per day, so nothing is spread; records of the same day and category are summed. Twilio
// reports a category and its subcategories side by side (`sms` next to `sms-inbound` and
// `sms-outbound`, each with the parent's price), and summary categories on top, so a subcategory is
// dropped whenever its parent is reported too, and the summaries always: kept, they would count the
// same money twice. A hyphenated name with no parent present is a product of its own and stays.
import { Array as Arr, Option, Record as Rec, Result, String as Str } from "effect"
import type { CostPullRow, CostPullWindow } from "../../CostProvider"
import type { UsageRecord } from "./twilio-costs-api"

/** FOCUS `ServiceCategory` of every Twilio charge. */
const SERVICE_CATEGORY = "Communication"
/** The service of a record that names none. */
const UNNAMED_SERVICE = "Twilio"
/** Twilio's summary categories, which repeat what the product categories already carry. */
const SUMMARY_CATEGORIES = new Set(["total", "totalprice"])

/** The name before the first hyphen: `sms-outbound-longcode` is read as a child of `sms`. */
const parentOf = (category: string): string => {
	const at = Str.indexOf("-")(category)
	return Option.isSome(at) ? Str.slice(0, at.value)(category) : category
}

/**
 * Whether a category is counted: never a summary, and a hyphenated one only when its parent is not
 * reported beside it (`categories` is every category of the window).
 */
export const isProductCategory = (category: string, categories: ReadonlySet<string>): boolean =>
	!SUMMARY_CATEGORIES.has(category) && (!Str.includes("-")(category) || !categories.has(parentOf(category)))

/** A wire number as Twilio writes it (mostly strings); anything that is not finite reads as null. */
export const numberOf = (value: string | number | null | undefined): number | null => {
	if (value === null || value === undefined) return null
	const parsed = typeof value === "number" ? value : Number(Str.trim(value))
	return Number.isFinite(parsed) ? parsed : null
}

interface Charge {
	readonly day: string
	readonly category: string
	readonly description: string
	readonly currency: string
	readonly micros: number
	readonly quantity: number
	readonly unit: string
}

const sum = <A>(items: ReadonlyArray<A>, of: (item: A) => number): number =>
	Arr.reduce(items, 0, (total, item) => total + of(item))

/**
 * The window's charges. Twilio writes a charge as a negative price, so a zero or positive one (a
 * credit, or usage it does not bill) is not a charge. A price that is not a finite number fails: it
 * cannot be stored as cost. Days from `openDay` on are not final: a day's records close the day after.
 */
export const toCostRows = (
	records: ReadonlyArray<UsageRecord>,
	accountId: string,
	window: CostPullWindow,
	openDay: string,
): Result.Result<ReadonlyArray<CostPullRow>, string> => {
	const categories = new Set(Arr.map(records, (record) => record.category))
	const charges = Arr.flatMap(records, (record): ReadonlyArray<Charge> => {
		if (!isProductCategory(record.category, categories)) return []
		if (record.price === null || record.price === undefined) return []
		const price = typeof record.price === "number" ? record.price : Number(Str.trim(record.price))
		// Twilio writes a charge as a negative price, so a zero or positive one (a credit, or usage it
		// does not bill) is not a charge. An unreadable one is NaN, which the check below fails.
		if (price >= 0) return []
		const day = Str.slice(0, 10)(record.start_date)
		if (day < window.startDay || day > window.endDay) return []
		const count = numberOf(record.count)
		return [
			{
				day,
				category: record.category,
				description: record.description ?? "",
				currency: record.price_unit ?? "USD",
				micros: Math.round(-price * 1_000_000),
				quantity: count ?? numberOf(record.usage) ?? 0,
				unit: record.count_unit ?? record.usage_unit ?? "",
			},
		]
	})
	const bad = Arr.findFirst(charges, (charge) => !Number.isFinite(charge.micros))
	if (Option.isSome(bad)) {
		return Result.fail(`Twilio reported a price that is not a number on ${bad.value.day}`)
	}
	// A day's rows are replaced whole and read per key, so two rows of one key would count once.
	const groups = Arr.groupBy(charges, (charge) =>
		Arr.join([charge.day, charge.category, charge.description], "\u0000"),
	)
	return Result.succeed(
		Arr.map(Rec.values(groups), (group): CostPullRow => {
			const first = Arr.headNonEmpty(group)
			// Twilio prices a message in fractions of a cent, so a row sums micro-dollars, not cents.
			const usd = sum(group, (charge) => charge.micros) / 1_000_000
			return {
				day: first.day,
				accountId,
				cloudService:
					first.description !== ""
						? first.description
						: first.category === ""
							? UNNAMED_SERVICE
							: first.category,
				serviceCategory: SERVICE_CATEGORY,
				usageType: first.category,
				region: "global",
				resourceId: "",
				resourceType: "",
				serviceName: "",
				chargeCategory: "usage",
				basis: "billed",
				currency: first.currency,
				billedCost: usd,
				effectiveCost: usd,
				listCost: usd,
				consumedQuantity: sum(group, (charge) => charge.quantity),
				// Twilio names no unit for every category, so a blank unit adds up unqualified.
				consumedUnit: first.unit,
				tags: { category: first.category },
				estimated: first.day >= openDay,
			}
		}),
	)
}
