// A fake MongoDB Atlas for tests: the service-account token endpoint and the v2 organization, invoice
// and line-item reads answered from a mutable world, with every API call recorded. Like the real API
// it names one organization for a service account, lists the invoices whose period touches the
// range asked, filters line items by usage date, and pages them by `pageNum`.
import { Layer, Option, Schema, Array as Arr, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import type { TestDb } from "@maple/backend/testing/test-pglite"
import { CostConnectionStore } from "../../CostConnectionStore"
import { fakeCostEnvConfig } from "../fake-cost-env"

export const FAKE_ATLAS_ORG = "68d4c8f1b1c2d3e4f5a6b7c8"
const OCTOBER = "67a1b2c3d4e5f60718293a4b"
const NOVEMBER = "67b2c3d4e5f60718293a4b5c"
export const FAKE_ATLAS_INVOICES = [OCTOBER, NOVEMBER] as const

/** One charge on one UTC day. */
export interface FakeLine {
	readonly day: string
	readonly cents: number
	readonly sku: string
	readonly project: string | null
	readonly cluster: string | null
	/** The invoice that bills it. */
	readonly invoice: (typeof FAKE_ATLAS_INVOICES)[number]
}

export interface FakeAtlas {
	/** Status of every API call. */
	status: number
	/** Status of the token endpoint. */
	tokenStatus: number
	/** The organizations the service account acts in. */
	organizations: ReadonlyArray<{ readonly id: string; readonly name: string | null }>
	/** Every line item Atlas holds, or raw text for a malformed line-item answer. */
	lines: ReadonlyArray<FakeLine> | string
	/** Line items one page holds at most, below what the request's `itemsPerPage` asks for. */
	pageSize: number
	/** Tokens an API call with them answers 401, as a token Atlas has retired. */
	rejectTokens: ReadonlySet<string>
	readonly urls: Array<string>
	/** The bearer token of every API call. */
	readonly tokens: Array<string | null>
	/** The Basic credentials of every token request, as sent. */
	readonly basics: Array<string | null>
}

export const makeFakeAtlas = (overrides: Partial<FakeAtlas> = {}): FakeAtlas => ({
	status: 200,
	tokenStatus: 200,
	organizations: [{ id: FAKE_ATLAS_ORG, name: "NevrLabs" }],
	lines: [],
	pageSize: 500,
	rejectTokens: new Set(),
	urls: [],
	tokens: [],
	basics: [],
	...overrides,
})

const INVOICES = [
	{ id: OCTOBER, startDate: "2026-10-01T00:00:00Z", endDate: "2026-10-31T23:59:59Z", status: "PAID" },
	{ id: NOVEMBER, startDate: "2026-11-01T00:00:00Z", endDate: "2026-11-30T23:59:59Z", status: "OPEN" },
]

/** The search body's filters; none when the body is not the JSON Maple sends. */
const SearchBody = Schema.Struct({
	filters: Schema.optionalKey(
		Schema.Struct({
			usageStartDate: Schema.optionalKey(Schema.String),
			usageEndDate: Schema.optionalKey(Schema.String),
		}),
	),
})
/** The search body as text, whatever the client serialized it to (a string, bytes or a stream). */
const bodyTextOf = async (init?: RequestInit): Promise<string> => {
	const body = init?.body
	if (body === undefined || body === null) return "{}"
	return typeof body === "string" ? body : new Response(body).text()
}

const parseBody = async (init?: RequestInit): Promise<typeof SearchBody.Type> =>
	Option.getOrElse(
		Schema.decodeOption(Schema.fromJsonString(SearchBody))(await bodyTextOf(init)),
		() => ({}),
	)

/** A line as the API's `UsageLineItem`, with the fields Maple does not read. */
const wireOf = (line: FakeLine) => ({
	usageDate: `${line.day}T00:00:00Z`,
	billDate: `${line.day}T00:00:00Z`,
	groupId: line.project,
	clusterName: line.cluster,
	cloudProvider: "AWS",
	sku: line.sku,
	description: line.sku,
	quantity: 1,
	unitPriceDollars: null,
	totalPriceCents: line.cents,
})

const fetchStub =
	(world: FakeAtlas): typeof fetch =>
	async (input: string | URL | Request, init?: RequestInit) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		const url = new URL(href)
		const headers = new Headers(init?.headers)
		if (url.pathname === "/api/oauth/token") {
			world.basics.push(headers.get("authorization"))
			if (world.tokenStatus !== 200) {
				return Response.json(
					{ error: "invalid_request", error_description: "Refused" },
					{ status: world.tokenStatus },
				)
			}
			return Response.json({ access_token: `token-${world.basics.length}`, expires_in: 3600 })
		}
		world.urls.push(`${url.pathname}${url.search}`)
		const token = Str.replace("Bearer ", "")(headers.get("authorization") ?? "")
		world.tokens.push(token)
		if (world.rejectTokens.has(token)) {
			return Response.json(
				{ error: 401, detail: "Unauthorized", reason: "Unauthorized" },
				{ status: 401 },
			)
		}
		if (world.status !== 200) {
			return Response.json(
				{ error: world.status, detail: "Refused", reason: "Refused" },
				{ status: world.status },
			)
		}
		if (typeof world.lines === "string") return new Response(world.lines, { status: 200 })
		if (url.pathname === "/api/atlas/v2/orgs") return Response.json({ results: world.organizations })
		// `/api/atlas/v2/orgs/<org>/invoices` and `/api/atlas/v2/orgs/<org>/invoices/<invoice>/lineItems:search`
		const segments = Str.split("/")(url.pathname)
		if (segments[6] !== "invoices") {
			return Response.json({ error: 404, detail: "Not found", reason: "NotFound" }, { status: 404 })
		}
		if (segments.length === 7) {
			const toDate = url.searchParams.get("toDate") ?? ""
			const fromDate = url.searchParams.get("fromDate") ?? ""
			return Response.json({
				results: Arr.filter(
					INVOICES,
					(invoice) =>
						Str.slice(0, 10)(invoice.startDate) <= toDate &&
						Str.slice(0, 10)(invoice.endDate) >= fromDate,
				),
			})
		}
		const invoiceId =
			segments.length === 9 && segments[8] === "lineItems:search"
				? Option.some(segments[7] ?? "")
				: Option.none<string>()
		if (Option.isNone(invoiceId)) {
			return Response.json({ error: 404, detail: "Not found", reason: "NotFound" }, { status: 404 })
		}
		const filters = (await parseBody(init)).filters ?? {}
		const size = Math.min(world.pageSize, Number(url.searchParams.get("itemsPerPage") ?? "500"))
		const page = Number(url.searchParams.get("pageNum") ?? "1")
		const held = Arr.filter(
			world.lines,
			(line) =>
				line.invoice === invoiceId.value &&
				line.day >= (filters.usageStartDate ?? "") &&
				line.day <= (filters.usageEndDate ?? ""),
		)
		return Response.json({ results: Arr.map(Arr.take(Arr.drop(held, (page - 1) * size), size), wireOf) })
	}

/** Everything the MongoDB Atlas cost services need, over the fake and a test database. */
export const fakeAtlasDeps = (testDb: TestDb, world: FakeAtlas) =>
	Layer.effect(CostConnectionStore, CostConnectionStore.make).pipe(
		Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, testDb.layer, Env.layer)),
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchStub(world))),
		Layer.provide(fakeCostEnvConfig()),
	)
