/**
 * Twilio as a cost provider: an account's daily charges by product category (SMS, voice, phone
 * numbers, Verify...), read from its usage records with the Account SID and auth token the org saved.
 */
import { Clock, Context, Effect, Layer, Option, Redacted, Result, Array as Arr, String as Str } from "effect"
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
import * as Twilio from "./twilio-costs-api"
import { toCostRows } from "./normalize"

/** Pages of usage records one pull reads at most: a month of every category fits in one. */
export const MAX_PULL_PAGES = 20
/** The newest days Twilio may still be counting: a day's records close the day after. */
const OPEN_DAYS = 1

type Reason = CostProviderError["reason"]

// Twilio does not bill for API requests, so no failure counts any.
const failed = (reason: Reason, message: string) =>
	new CostProviderError({ message, provider: "twilio", reason, requests: 0 })

/** Twilio's failures, as what the sync does next and the Cost page shows. */
const toCostProviderError = (error: Twilio.TwilioCostsError): CostProviderError => {
	switch (error.kind) {
		case "unauthorized":
			return failed(
				"auth",
				"Twilio rejected the saved Account SID or auth token. Replace it to resume the sync.",
			)
		// The credential passed this check when it was saved: its permissions changed since.
		case "forbidden":
			return failed(
				"not_ready",
				"Twilio does not let the saved credential read the account's usage records. Use the account's own auth token, or an API key with usage access.",
			)
		case "invalid_response":
			return failed("invalid_response", "Twilio's cost answer could not be read.")
		case "rate_limited":
			return failed("rate_limited", "Twilio is rate limiting cost requests.")
		// A 400 is a request Maple wrote wrong, which a retry does not fix but a deploy does.
		default:
			return failed("upstream", "Twilio did not answer the cost request.")
	}
}

/** The stored credential as it was saved, `<AccountSid> <AuthToken>`; `null` when it is not shaped like one. */
export const accountOf = (secret: Redacted.Redacted): Twilio.TwilioAccount | null => {
	const parts = Arr.filter(Str.split(" ")(Str.trim(Redacted.value(secret))), (part) => part !== "")
	if (parts.length !== 2) return null
	const [accountSid = "", authToken = ""] = parts
	if (!Twilio.ACCOUNT_SID_PATTERN.test(accountSid)) return null
	return { accountSid: Redacted.make(accountSid), authToken: Redacted.make(authToken) }
}

export class TwilioCostProvider extends Context.Service<TwilioCostProvider, CostProviderAdapter>()(
	"@maple/backend/services/cost/TwilioCostProvider",
	{
		make: Effect.gen(function* () {
			const connections = yield* CostConnectionStore
			const httpClient = yield* HttpClient.HttpClient

			/** Twilio's failures as the sync's; Maple's own (a window too large) pass as they are. */
			const mapTwilio = <A>(effect: Effect.Effect<A, Twilio.TwilioCostsError | CostProviderError>) =>
				effect.pipe(
					Effect.catchIf(Twilio.isTwilioCostsError, (error) =>
						Effect.fail(toCostProviderError(error)),
					),
				)

			const pull = Effect.fn("TwilioCostProvider.pull")(
				function* (source: CostPullSource, window: CostPullWindow) {
					yield* Effect.annotateCurrentSpan({
						orgId: source.orgId,
						"maple.cost.provider": "twilio",
						"maple.cost.start_day": window.startDay,
						"maple.cost.end_day": window.endDay,
					})
					const credential = yield* connections
						.load("twilio", source)
						.pipe(Effect.mapError(loadFailureOf("twilio")))
					if (Option.isNone(credential)) {
						return yield* failed(
							"auth",
							"No Twilio Account SID and auth token are saved for this source.",
						)
					}
					const account = accountOf(credential.value.secret)
					if (account === null) {
						return yield* failed(
							"auth",
							"The saved Twilio credential is not shaped like an Account SID and auth token. Replace it to resume the sync.",
						)
					}
					const accountId = credential.value.accountId
					const now = yield* Clock.currentTimeMillis
					const openDay = addDays(utcToday(now), -OPEN_DAYS)
					const query: Twilio.UsageQuery = { startDate: window.startDay, endDate: window.endDay }

					const held: Array<Twilio.UsageRecord> = []
					let page = 0
					for (; ; page++) {
						if (page >= MAX_PULL_PAGES) {
							return yield* failed(
								"too_large",
								`Twilio's usage records for this window take more than ${MAX_PULL_PAGES} pages.`,
							)
						}
						const answer = yield* mapTwilio(Twilio.usagePage(httpClient, account, query, page))
						held.push(...answer.usage_records)
						// The last page has no next one; a full one is followed by the next.
						if (answer.next_page_uri === null || answer.next_page_uri === undefined) break
					}

					const normalized = toCostRows(held, accountId, window, openDay)
					if (Result.isFailure(normalized)) {
						return yield* failed("invalid_response", normalized.failure)
					}
					const rows = normalized.success
					yield* Effect.annotateCurrentSpan({
						"maple.cost.twilio.pages": page + 1,
						"maple.cost.twilio.records": held.length,
						"maple.cost.rows": rows.length,
					})
					return { rows, requests: 0 } satisfies CostPull
				},
				Effect.tapError((error) =>
					Effect.annotateCurrentSpan({ "maple.cost.error_reason": error.reason }),
				),
			)

			return { provider: "twilio", pull } satisfies CostProviderAdapter
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(FetchHttpClient.layer, CostConnectionStore.layer)),
	)
}
