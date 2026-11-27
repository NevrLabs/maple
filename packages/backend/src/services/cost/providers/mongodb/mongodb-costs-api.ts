// The slice of the MongoDB Atlas Administration API the cost source uses: a service account's access
// token, the one organization it acts as, and that organization's invoices with the usage-dated line
// items of each (a charge per usage day, cluster and SKU). Every failure is one `MongodbCostsError`
// whose `kind` says what the caller does next.
import { Duration, Effect, Redacted, Schema } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"

export const ATLAS_BASE_URL = "https://cloud.mongodb.com"
/** The API version every v2 answer is requested as. */
const API_VERSION = "2025-03-12"
const REQUEST_TIMEOUT = Duration.seconds(30)
/** The most invoices one page lists. */
export const MAX_INVOICES_PER_PAGE = 100
/** The most line items one page of an invoice holds. */
export const MAX_LINE_ITEMS_PER_PAGE = 500

export class MongodbCostsError extends Schema.TaggedError<MongodbCostsError>()(
	"@maple/backend/cost/MongodbCostsError",
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

/** Whether `error` is Atlas's own failure, as a caller that maps several kinds tells them apart. */
export const isMongodbCostsError = (error: unknown): error is MongodbCostsError =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	error._tag === "@maple/backend/cost/MongodbCostsError"

const errorKind = (status: number): MongodbCostsError["kind"] =>
	status === 401
		? "unauthorized"
		: status === 403 || status === 404
			? "forbidden"
			: status === 400 || status === 415
				? "bad_request"
				: status === 429
					? "rate_limited"
					: "upstream"

/** A service account as Atlas issues it: a client ID and a secret, traded for a bearer token. */
export interface ServiceAccount {
	readonly clientId: Redacted.Redacted
	readonly clientSecret: Redacted.Redacted
}

const TokenResponse = Schema.Struct({ access_token: Schema.String, expires_in: Schema.Number })

/**
 * A bearer token for the service account, valid an hour. The credentials travel in the Basic header,
 * as Atlas's own example does; a 403 here is Atlas's IP access list refusing Maple's address.
 */
export const serviceAccountToken = (httpClient: HttpClient.HttpClient, account: ServiceAccount) => {
	const basic = Buffer.from(
		`${Redacted.value(account.clientId)}:${Redacted.value(account.clientSecret)}`,
	).toString("base64")
	const request = HttpClientRequest.post(`${ATLAS_BASE_URL}/api/oauth/token`).pipe(
		HttpClientRequest.setHeader("accept", "application/json"),
		HttpClientRequest.setHeader("authorization", `Basic ${basic}`),
		HttpClientRequest.bodyText("grant_type=client_credentials", "application/x-www-form-urlencoded"),
	)
	return Effect.gen(function* () {
		const response = yield* httpClient.execute(request)
		if (response.status >= 300) {
			return yield* new MongodbCostsError({
				message: `Atlas token endpoint answered ${response.status}`,
				kind: errorKind(response.status),
				status: response.status,
			})
		}
		const body = yield* response.json.pipe(
			Effect.catchTag("HttpClientError", () =>
				Effect.fail(
					new MongodbCostsError({
						message: "Atlas token answer is not JSON",
						kind: "invalid_response",
					}),
				),
			),
		)
		const token = yield* Schema.decodeUnknownEffect(TokenResponse)(body).pipe(
			Effect.catchTag("SchemaError", () =>
				Effect.fail(
					new MongodbCostsError({
						message: "Atlas token answer unreadable",
						kind: "invalid_response",
					}),
				),
			),
		)
		return Redacted.make(token.access_token)
	}).pipe(
		Effect.timeout(REQUEST_TIMEOUT),
		Effect.catchTags({
			HttpClientError: () =>
				Effect.fail(
					new MongodbCostsError({ message: "Atlas token request failed", kind: "upstream" }),
				),
			TimeoutError: () =>
				Effect.fail(
					new MongodbCostsError({ message: "Atlas token request timed out", kind: "upstream" }),
				),
		}),
		// A redirect is not Atlas answering, so the credentials are never followed to another host.
		Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
		Effect.annotateSpans("peer.service", "mongodb-atlas"),
	)
}

/** One `GET` against the v2 API with the token, answered as JSON decoded by `schema`. */
const getJson = <A>(
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted,
	path: string,
	schema: Schema.Codec<A, unknown>,
	body?: { readonly filters: UsageWindow },
) => {
	const base = HttpClientRequest.bearerToken(
		HttpClientRequest.get(`${ATLAS_BASE_URL}${path}`).pipe(
			HttpClientRequest.setHeader("accept", `application/vnd.atlas.${API_VERSION}+json`),
		),
		token,
	)
	return Effect.gen(function* () {
		// A search sends its window as the JSON body; every other read sends nothing.
		const request = yield* body === undefined
			? Effect.succeed(base)
			: HttpClientRequest.bodyJson(base, body).pipe(
					Effect.mapError(
						() =>
							new MongodbCostsError({
								message: `Atlas API body for ${path} could not be encoded`,
								kind: "upstream",
							}),
					),
				)
		const response = yield* httpClient.execute(request)
		if (response.status >= 300) {
			return yield* new MongodbCostsError({
				message: `Atlas API answered ${response.status} for ${path}`,
				kind: errorKind(response.status),
				status: response.status,
			})
		}
		const json = yield* response.json.pipe(
			Effect.catchTag("HttpClientError", () =>
				Effect.fail(
					new MongodbCostsError({
						message: `Atlas API answered ${path} with a body that is not JSON`,
						kind: "invalid_response",
					}),
				),
			),
		)
		return yield* Schema.decodeEffect(schema)(json).pipe(
			Effect.catchTag("SchemaError", () =>
				Effect.fail(
					new MongodbCostsError({
						message: `Atlas API answered ${path} with a body Maple cannot read`,
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
					new MongodbCostsError({ message: `Atlas API request failed: ${path}`, kind: "upstream" }),
				),
			TimeoutError: () =>
				Effect.fail(
					new MongodbCostsError({
						message: `Atlas API request timed out: ${path}`,
						kind: "upstream",
					}),
				),
		}),
		Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
		Effect.annotateSpans("peer.service", "mongodb-atlas"),
	)
}

export const AtlasOrganization = Schema.Struct({
	id: Schema.String,
	name: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type AtlasOrganization = typeof AtlasOrganization.Type

const OrganizationsPage = Schema.Struct({ results: Schema.Array(AtlasOrganization) })

/** The organizations the service account acts in: one, as a service account belongs to a single organization. */
export const listOrganizations = (httpClient: HttpClient.HttpClient, token: Redacted.Redacted) =>
	getJson(
		httpClient,
		token,
		`/api/atlas/v2/orgs?itemsPerPage=${MAX_INVOICES_PER_PAGE}`,
		OrganizationsPage,
	).pipe(Effect.map((page) => page.results))

/** An invoice as the list names it: its period and status; its line items are read separately. */
export const AtlasInvoice = Schema.Struct({
	id: Schema.String,
	startDate: Schema.optionalKey(Schema.NullOr(Schema.String)),
	endDate: Schema.optionalKey(Schema.NullOr(Schema.String)),
	status: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type AtlasInvoice = typeof AtlasInvoice.Type

const InvoicesPage = Schema.Struct({ results: Schema.Array(AtlasInvoice) })

export interface InvoiceQuery {
	/** `YYYY-MM-DD`: invoices whose period starts on or after it. */
	readonly fromDate: string
	/** `YYYY-MM-DD`: invoices whose period ends on or before it. */
	readonly toDate: string
}

/** One page of the organization's invoices, every status included. */
export const invoicePage = (
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted,
	orgId: string,
	query: InvoiceQuery,
	page: number,
) =>
	getJson(
		httpClient,
		token,
		`/api/atlas/v2/orgs/${orgId}/invoices?fromDate=${query.fromDate}&toDate=${query.toDate}&itemsPerPage=${MAX_INVOICES_PER_PAGE}&pageNum=${page}`,
		InvoicesPage,
	).pipe(Effect.map((body) => body.results))

/**
 * One charge on one usage day. Every field but the price is optional: Atlas leaves out what a line
 * item does not have (a support charge names no cluster), and Maple stores what is there.
 */
export const UsageLineItem = Schema.Struct({
	usageDate: Schema.optionalKey(Schema.NullOr(Schema.String)),
	billDate: Schema.optionalKey(Schema.NullOr(Schema.String)),
	groupId: Schema.optionalKey(Schema.NullOr(Schema.String)),
	clusterName: Schema.optionalKey(Schema.NullOr(Schema.String)),
	cloudProvider: Schema.optionalKey(Schema.NullOr(Schema.String)),
	description: Schema.optionalKey(Schema.NullOr(Schema.String)),
	quantity: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	unitPriceDollars: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	totalPriceCents: Schema.optionalKey(Schema.NullOr(Schema.Number)),
})
export type UsageLineItem = typeof UsageLineItem.Type

const LineItemsPage = Schema.Struct({ results: Schema.Array(UsageLineItem) })

export interface UsageWindow {
	/** `YYYY-MM-DD`, inclusive. */
	readonly usageStartDate: string
	/** `YYYY-MM-DD`, inclusive. */
	readonly usageEndDate: string
}

/**
 * One page of an invoice's line items with a usage date in the window. Charges post the day after
 * their usage, so the window's last days fill in on a later pull.
 */
export const lineItemsPage = (
	httpClient: HttpClient.HttpClient,
	token: Redacted.Redacted,
	orgId: string,
	invoiceId: string,
	window: UsageWindow,
	page: number,
) =>
	getJson(
		httpClient,
		token,
		`/api/atlas/v2/orgs/${orgId}/invoices/${invoiceId}/lineItems:search?itemsPerPage=${MAX_LINE_ITEMS_PER_PAGE}&pageNum=${page}`,
		LineItemsPage,
		{ filters: window },
	).pipe(Effect.map((body) => body.results))
