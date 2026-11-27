// The slice of the Twilio REST API the cost source uses: the account an Account SID and auth token
// open, and its usage records, aggregated per day and product category with the price of each. Every
// failure is one `TwilioCostsError` whose `kind` says what the caller does next.
import { Duration, Effect, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"

export const TWILIO_BASE_URL = "https://api.twilio.com"
const REQUEST_TIMEOUT = Duration.seconds(30)
/** The most usage records one page lists. */
export const MAX_USAGE_PER_PAGE = 1000
/** An Account SID as Twilio issues it: it travels in the request path, so it is checked before use. */
export const ACCOUNT_SID_PATTERN = /^AC[0-9a-f]{32}$/

export class TwilioCostsError extends Schema.TaggedError<TwilioCostsError>()(
	"@maple/backend/cost/TwilioCostsError",
	{
		message: Schema.String,
		kind: Schema.Literals([
			"unauthorized",
			"forbidden",
			"bad_request",
			"rate_limited",
			"invalid_response",
			"upstream",
		]),
		status: Schema.optionalKey(Schema.Number),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/** Whether `error` is Twilio's own failure, as a caller that maps several kinds tells them apart. */
export const isTwilioCostsError = (error: unknown): error is TwilioCostsError =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	error._tag === "@maple/backend/cost/TwilioCostsError"

const errorKind = (status: number): TwilioCostsError["kind"] =>
	status === 401
		? "unauthorized"
		: status === 403 || status === 404
			? "forbidden"
			: status === 400 || status === 415
				? "bad_request"
				: status === 429
					? "rate_limited"
					: "upstream"

/** A Twilio account as the console shows it: an Account SID and its auth token, sent as Basic auth. */
export interface TwilioAccount {
	readonly accountSid: Redacted.Redacted
	readonly authToken: Redacted.Redacted
}

/** The credentials of every API call, as sent; the SID is checked before it reaches a path. */
const basicAuth = (account: TwilioAccount) =>
	Buffer.from(`${Redacted.value(account.accountSid)}:${Redacted.value(account.authToken)}`).toString(
		"base64",
	)

/** One `GET` under the classic REST API with the account's credentials, answered as JSON decoded by `schema`. */
const getJson = <A>(
	httpClient: HttpClient.HttpClient,
	account: TwilioAccount,
	path: string,
	schema: Schema.Codec<A, unknown>,
) =>
	Effect.gen(function* () {
		const response = yield* httpClient.execute(
			HttpClientRequest.get(`${TWILIO_BASE_URL}${path}`).pipe(
				HttpClientRequest.setHeader("accept", "application/json"),
				HttpClientRequest.setHeader("authorization", `Basic ${basicAuth(account)}`),
			),
		)
		if (response.status >= 300) {
			return yield* new TwilioCostsError({
				message: `Twilio API answered ${response.status} for ${path}`,
				kind: errorKind(response.status),
				status: response.status,
			})
		}
		const json = yield* response.json.pipe(
			Effect.catchTag("HttpClientError", () =>
				Effect.fail(
					new TwilioCostsError({
						message: `Twilio API answered ${path} with a body that is not JSON`,
						kind: "invalid_response",
					}),
				),
			),
		)
		return yield* Schema.decodeEffect(schema)(json).pipe(
			Effect.catchTag("SchemaError", () =>
				Effect.fail(
					new TwilioCostsError({
						message: `Twilio API answered ${path} with a body Maple cannot read`,
						kind: "invalid_response",
					}),
				),
			),
		)
	}).pipe(
		Effect.timeout(REQUEST_TIMEOUT),
		Effect.catchTags({
			HttpClientError: () =>
				Effect.fail(
					new TwilioCostsError({ message: `Twilio API request failed: ${path}`, kind: "upstream" }),
				),
			TimeoutError: () =>
				Effect.fail(
					new TwilioCostsError({
						message: `Twilio API request timed out: ${path}`,
						kind: "upstream",
					}),
				),
		}),
		// A redirect is not Twilio answering, so the credentials are never followed to another host.
		Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
		Effect.annotateSpans("peer.service", "twilio"),
	)

/** The account a credential opens, as its own resource names it. */
export const TwilioAccountInfo = Schema.Struct({
	sid: Schema.String,
	friendly_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type TwilioAccountInfo = typeof TwilioAccountInfo.Type

/** `GET /2010-04-01/Accounts/{Sid}.json`: proves the credential, and names the account. */
export const fetchAccount = (httpClient: HttpClient.HttpClient, account: TwilioAccount) =>
	getJson(
		httpClient,
		account,
		`/2010-04-01/Accounts/${Redacted.value(account.accountSid)}.json`,
		TwilioAccountInfo,
	)

/** A wire number: Twilio writes most of its numbers as strings. */
const WireNumber = Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))

/**
 * One day's usage of one category. Every field but the category and the day is optional: Twilio
 * leaves out what a record does not have, and Maple stores what is there.
 */
export const UsageRecord = Schema.Struct({
	category: Schema.String,
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	start_date: Schema.String,
	end_date: Schema.optionalKey(Schema.NullOr(Schema.String)),
	usage: Schema.optionalKey(WireNumber),
	usage_unit: Schema.optionalKey(Schema.NullOr(Schema.String)),
	count: Schema.optionalKey(WireNumber),
	count_unit: Schema.optionalKey(Schema.NullOr(Schema.String)),
	price: Schema.optionalKey(WireNumber),
	price_unit: Schema.optionalKey(Schema.NullOr(Schema.String)),
	as_of: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type UsageRecord = typeof UsageRecord.Type

const UsagePage = Schema.Struct({
	usage_records: Schema.Array(UsageRecord),
	next_page_uri: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

export interface UsageQuery {
	/** `YYYY-MM-DD`, inclusive. */
	readonly startDate: string
	/** `YYYY-MM-DD`, inclusive. */
	readonly endDate: string
}

/**
 * One page of the account's usage records, aggregated per day and category, zero-based. The records
 * of a day are final the day after, so the window's last days fill in on a later pull.
 */
export const usagePage = (
	httpClient: HttpClient.HttpClient,
	account: TwilioAccount,
	query: UsageQuery,
	page: number,
) =>
	getJson(
		httpClient,
		account,
		`/2010-04-01/Accounts/${Redacted.value(account.accountSid)}/Usage/Records/Daily.json?StartDate=${query.startDate}&EndDate=${query.endDate}&PageSize=${MAX_USAGE_PER_PAGE}&Page=${page}`,
		UsagePage,
	)
