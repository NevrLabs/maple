/**
 * MongoDB Atlas as a cost provider: an organization's daily charges by cluster, project and SKU,
 * read from the usage-dated line items of its invoices with a service account the org saved.
 */
import {
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	Redacted,
	Ref,
	Result,
	Array as Arr,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import {
	type CostProviderAdapter,
	CostProviderError,
	type CostPull,
	type CostPullSource,
	type CostPullWindow,
} from "../../CostProvider"
import { CostConnectionStore, loadFailureOf } from "../../CostConnectionStore"
import { addDays, utcToday } from "../../sync-plan"
import * as Atlas from "./mongodb-costs-api"
import { toCostRows } from "./normalize"

/** Pages of line items one pull reads at most, over every invoice of the window. */
export const MAX_PULL_PAGES = 60
/** The newest days Atlas may still be counting: charges post the day after their usage. */
const OPEN_DAYS = 2
/** Days before the window an invoice can have started and still bill days in it: a monthly invoice. */
const INVOICE_OVERLAP_DAYS = 31
/** Days after the window an invoice can end: the open invoice ends with its month. */
const INVOICE_END_SLACK_DAYS = 400
/** A token is requested afresh this long before Atlas would refuse it. */
const TOKEN_REFRESH_MARGIN_MS = 60_000
const TOKEN_LIFETIME_MS = 3_600_000

type Reason = CostProviderError["reason"]

// Atlas does not bill for API requests, so no failure counts any.
const failed = (reason: Reason, message: string) =>
	new CostProviderError({ message, provider: "mongodb", reason, requests: 0 })

/** Atlas's failures, as what the sync does next and the Cost page shows. */
const toCostProviderError = (error: Atlas.MongodbCostsError): CostProviderError => {
	switch (error.kind) {
		case "unauthorized":
			return failed(
				"auth",
				"MongoDB Atlas rejected the saved service account. Replace it to resume the sync.",
			)
		// The account passed this check when it was saved: its role or access list changed since.
		case "forbidden":
			return failed(
				"not_ready",
				"MongoDB Atlas does not let the saved service account read the organization's invoices. Give it the Organization Billing Viewer role, and keep Maple's address on its API access list.",
			)
		case "invalid_response":
			return failed("invalid_response", "MongoDB Atlas's cost answer could not be read.")
		case "rate_limited":
			return failed("rate_limited", "MongoDB Atlas is rate limiting cost requests.")
		// A 400 is a request Maple wrote wrong, which a retry does not fix but a deploy does.
		default:
			return failed("upstream", "MongoDB Atlas did not answer the cost request.")
	}
}

/** The stored credential as it was saved, `<clientId> <clientSecret>`; `null` when it is not shaped like one. */
export const serviceAccountOf = (secret: Redacted.Redacted): Atlas.ServiceAccount | null => {
	const parts = Arr.filter(Str.split(" ")(Str.trim(Redacted.value(secret))), (part) => part !== "")
	if (parts.length !== 2) return null
	const [clientId = "", clientSecret = ""] = parts
	return { clientId: Redacted.make(clientId), clientSecret: Redacted.make(clientSecret) }
}

/** Whether an invoice's period touches `window`: an open invoice has no end yet, so it is taken to run on. */
const billsWindow = (invoice: Atlas.AtlasInvoice, window: CostPullWindow): boolean => {
	const start = Str.slice(0, 10)(invoice.startDate ?? "")
	const end = Str.slice(0, 10)(invoice.endDate ?? "")
	return (start === "" || start <= window.endDay) && (end === "" || end >= window.startDay)
}

interface CachedToken {
	readonly token: Redacted.Redacted
	readonly expiresAtMs: number
}

export class MongodbCostProvider extends Context.Service<MongodbCostProvider, CostProviderAdapter>()(
	"@maple/backend/services/cost/MongodbCostProvider",
	{
		make: Effect.gen(function* () {
			const connections = yield* CostConnectionStore
			const httpClient = yield* HttpClient.HttpClient
			// One token per source: a replaced service account is another credential under the same ref.
			const tokens = yield* Ref.make(new Map<string, CachedToken>())

			const freshToken = (key: string, account: Atlas.ServiceAccount) =>
				Effect.gen(function* () {
					const now = yield* Clock.currentTimeMillis
					const token = yield* Atlas.serviceAccountToken(httpClient, account)
					yield* Ref.modify(tokens, (held) => {
						const next = new Map(held)
						next.set(key, { token, expiresAtMs: now + TOKEN_LIFETIME_MS })
						return [undefined, next] as const
					})
					return token
				})

			const cachedToken = (key: string, account: Atlas.ServiceAccount, force: boolean) =>
				Effect.gen(function* () {
					const held = (yield* Ref.get(tokens)).get(key)
					const now = yield* Clock.currentTimeMillis
					if (!force && held !== undefined && held.expiresAtMs - now > TOKEN_REFRESH_MARGIN_MS) {
						return held.token
					}
					return yield* freshToken(key, account)
				})

			/** `read` with the cached token; a token Atlas now refuses is replaced once and the read retried. */
			const withToken = <A>(
				key: string,
				account: Atlas.ServiceAccount,
				read: (
					token: Redacted.Redacted,
				) => Effect.Effect<A, Atlas.MongodbCostsError | CostProviderError>,
			) =>
				Effect.flatMap(cachedToken(key, account, false), read).pipe(
					Effect.catchIf(
						(error): error is Atlas.MongodbCostsError =>
							Atlas.isMongodbCostsError(error) && error.kind === "unauthorized",
						() => Effect.flatMap(cachedToken(key, account, true), read),
					),
				)

			/** Atlas's failures as the sync's; Maple's own (a window too large) pass as they are. */
			const mapAtlas = <A>(effect: Effect.Effect<A, Atlas.MongodbCostsError | CostProviderError>) =>
				effect.pipe(
					Effect.catchIf(Atlas.isMongodbCostsError, (error) =>
						Effect.fail(toCostProviderError(error)),
					),
				)

			const pull = Effect.fn("MongodbCostProvider.pull")(
				function* (source: CostPullSource, window: CostPullWindow) {
					yield* Effect.annotateCurrentSpan({
						orgId: source.orgId,
						"maple.cost.provider": "mongodb",
						"maple.cost.start_day": window.startDay,
						"maple.cost.end_day": window.endDay,
					})
					const credential = yield* connections
						.load("mongodb", source)
						.pipe(Effect.mapError(loadFailureOf("mongodb")))
					if (Option.isNone(credential)) {
						return yield* failed(
							"auth",
							"No MongoDB Atlas service account is saved for this source.",
						)
					}
					const account = serviceAccountOf(credential.value.secret)
					if (account === null) {
						return yield* failed(
							"auth",
							"The saved MongoDB Atlas service account is not shaped like one. Replace it to resume the sync.",
						)
					}
					const orgId = credential.value.accountId
					const now = yield* Clock.currentTimeMillis
					const openDay = addDays(utcToday(now), -OPEN_DAYS)
					const usage: Atlas.UsageWindow = {
						usageStartDate: window.startDay,
						usageEndDate: window.endDay,
					}

					const invoices = yield* withToken(source.connectionRef, account, (token) =>
						Atlas.invoicePage(
							httpClient,
							token,
							orgId,
							{
								fromDate: addDays(window.startDay, -INVOICE_OVERLAP_DAYS),
								toDate: addDays(window.endDay, INVOICE_END_SLACK_DAYS),
							},
							1,
						),
					).pipe(mapAtlas)
					// One page holds far more invoices than a window crosses; a full one is not a window Maple asks for.
					if (invoices.length >= Atlas.MAX_INVOICES_PER_PAGE) {
						return yield* failed(
							"too_large",
							"MongoDB Atlas lists more invoices for this window than a pull reads.",
						)
					}
					const billing = Arr.filter(invoices, (invoice) => billsWindow(invoice, window))

					let pages = 0
					const lineItemsOf = (invoiceId: string) =>
						withToken(source.connectionRef, account, (token) =>
							Effect.gen(function* () {
								const held: Array<Atlas.UsageLineItem> = []
								for (let page = 1; ; page++) {
									pages += 1
									if (pages > MAX_PULL_PAGES) {
										return yield* failed(
											"too_large",
											`MongoDB Atlas's line items for this window take more than ${MAX_PULL_PAGES} pages.`,
										)
									}
									const items = yield* Atlas.lineItemsPage(
										httpClient,
										token,
										orgId,
										invoiceId,
										usage,
										page,
									)
									// The last page is a short one; a full one is followed by the next.
									if (items.length < Atlas.MAX_LINE_ITEMS_PER_PAGE)
										return [...held, ...items]
									held.push(...items)
								}
							}),
						).pipe(mapAtlas)
					const listed = yield* Effect.forEach(billing, (invoice) => lineItemsOf(invoice.id), {
						concurrency: "unbounded",
					})
					const lines = Arr.flatten(listed)

					const normalized = toCostRows(lines, orgId, window, openDay)
					if (Result.isFailure(normalized)) {
						return yield* failed("invalid_response", normalized.failure)
					}
					const rows = normalized.success
					yield* Effect.annotateCurrentSpan({
						"maple.cost.mongodb.invoices": billing.length,
						"maple.cost.mongodb.pages": pages,
						"maple.cost.rows": rows.length,
					})
					return { rows, requests: 0 } satisfies CostPull
				},
				Effect.tapError((error) =>
					Effect.annotateCurrentSpan({ "maple.cost.error_reason": error.reason }),
				),
			)

			return { provider: "mongodb", pull } satisfies CostProviderAdapter
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(FetchHttpClient.layer, CostConnectionStore.layer)),
	)
}
