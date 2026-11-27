import { randomBytes } from "node:crypto"
import {
	type CreateSourceRequest,
	IngestKeyEncryptionError,
	IsoDateTimeString,
	type OrgId,
	Source,
	SourceHealth,
	SOURCE_LIMITS,
	SourceNotFoundError,
	SourcePersistenceError,
	SourceValidationError,
	SourceWithSecret,
	type UpdateSourceRequest,
	UserId,
} from "@maple/domain/http"
import {
	SourceId,
	type SourcePlatform,
	sourceTokenPrefix,
	type SourceResourceAttribute,
	type SourceSignal,
} from "@maple/primitives"
import { hashIngestKey } from "../../platform/credential-tokens"
import * as Orm from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Sources, type SourceRow } from "@maple/db/tables"
import { CH, formatWarehouseDateTime } from "@maple/query-engine"
import {
	Array as Arr,
	Clock,
	DateTime,
	Context,
	Effect,
	Layer,
	Option,
	Order,
	Record as Rec,
	Result,
	Schema,
	String as Str,
} from "effect"
import type { SourceHealthResult } from "@maple/domain/source-health"
import { Database, type DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { systemTenant } from "@maple/backend/services/auth/system-tenant"
import { readSourceOwners } from "@maple/backend/services/integrations/integration-sources"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import {
	defaultSourceRow,
	newSourceId,
	type SourceHealthOverrides,
	sourceRowHealth,
	statusOf,
} from "./source-rows"
import { ingestKeyLookupHmacKey } from "@maple/backend/platform/Crypto"

const {
	maxSourcesPerOrg: MAX_SOURCES_PER_ORG,
	maxResourceAttributes: MAX_RESOURCE_ATTRIBUTES,
	maxRateLimitRps: MAX_RATE_LIMIT_RPS,
} = SOURCE_LIMITS
const MAX_NAME_LENGTH = 100
const MAX_DESCRIPTION_LENGTH = 500
const MAX_ATTRIBUTE_KEY_LENGTH = 255
const MAX_ATTRIBUTE_VALUE_LENGTH = 1024
// `maple_` attributes are stamped by the gateway and must never be overridable.
const RESERVED_ATTRIBUTE_KEYS = new Set(["org_id"])
const RESERVED_ATTRIBUTE_PREFIX = "maple_"

const toPersistenceError = (error: DatabaseError) => new SourcePersistenceError({ message: error.message })
const invalid = (message: string) => new SourceValidationError({ message })

const decodeIsoSync = Schema.decodeUnknownSync(IsoDateTimeString)
const toIso = (epochMs: number) => decodeIsoSync(new Date(epochMs).toISOString())

// A browser source gets a public token (`maple_src_pk_`), safe in client code; the gateway treats both alike.
const generateSecret = (platform: SourcePlatform) => {
	const prefix = sourceTokenPrefix(platform)
	const secret = `${prefix}${randomBytes(24).toString("base64url")}`
	return { secret, keyPrefix: Str.slice(0, prefix.length + 5)(secret) }
}

const isoOrNull = (epochMs: number | null) => (epochMs === null ? null : toIso(epochMs))

const toSourceHealth = (health: SourceHealthResult) =>
	new SourceHealth({
		status: health.status,
		lastDataAt: isoOrNull(health.lastDataAt),
		problem: health.problem,
		resources: health.resources ?? null,
	})

interface SourceOwner {
	/** The integration row an integration source stands for. */
	readonly integrationId: string | null
	/** What the integration adds to its health. */
	readonly overrides: SourceHealthOverrides | undefined
}
const NO_OWNER: SourceOwner = { integrationId: null, overrides: undefined }

/**
 * NevrLabs selfhost: the infrastructure push platforms and the series that proves each receives.
 * A collector the org already runs sends them, often under another of its keys (the default
 * source's), so `sources.last_used_at` cannot date their arrival; the warehouse can.
 */
const PUSH_INFRA_SIGNAL = {
	proxmox: { table: "gauge", metric: "proxmox_node_uptime" },
	mongodb_atlas: { table: "gauge", metric: "mongodb_up" },
	postgresql: { table: "sum", metric: "postgresql.backends" },
} as const
type PushInfraPlatform = keyof typeof PUSH_INFRA_SIGNAL
const PUSH_INFRA_PLATFORMS: ReadonlySet<string> = new Set(Rec.keys(PUSH_INFRA_SIGNAL))
const isPushInfra = (platform: SourcePlatform): platform is PushInfraPlatform =>
	PUSH_INFRA_PLATFORMS.has(platform)
/** The push platforms' stale window in `@maple/domain/source-health`. */
const ARRIVAL_WINDOW_MS = 24 * 60 * 60 * 1000
/** The attribution id of the presence reads that date an infrastructure push source's arrival. */
const SOURCES_SYSTEM_USER_ID = UserId.make("system-sources")

const withArrival = (owner: SourceOwner, arrival: SourceHealthOverrides | undefined): SourceOwner =>
	arrival === undefined ? owner : { ...owner, overrides: { ...owner.overrides, ...arrival } }

const rowToSource = (row: SourceRow, now: number, owner: SourceOwner = NO_OWNER): Source => {
	const status = statusOf(row, now)
	return new Source({
		id: row.id,
		name: row.name,
		description: row.description,
		platform: row.platform,
		kind: row.kind,
		keyPrefix: row.keyPrefix,
		integrationId: owner.integrationId,
		status,
		allowedSignals: row.allowedSignals,
		rateLimitRps: row.rateLimitRps,
		resourceAttributes: row.resourceAttributes,
		expiresAt: isoOrNull(row.expiresAt),
		// A pause that already ended reads as not paused.
		pausedAt: status === "paused" ? isoOrNull(row.pausedAt) : null,
		pausedUntil: status === "paused" ? isoOrNull(row.pausedUntil) : null,
		lastUsedAt: isoOrNull(row.lastUsedAt),
		rolledAt: isoOrNull(row.rolledAt),
		createdAt: toIso(row.createdAt),
		updatedAt: toIso(row.updatedAt),
		health: toSourceHealth(sourceRowHealth(row, now, owner.overrides)),
	})
}

const normalizeName = Effect.fnUntraced(function* (name: string) {
	const trimmed = Str.trim(name)
	if (trimmed.length === 0) return yield* invalid("Name must not be empty")
	if (trimmed.length > MAX_NAME_LENGTH) {
		return yield* invalid(`Name must be at most ${MAX_NAME_LENGTH} characters`)
	}
	return trimmed
})

const normalizeDescription = Effect.fnUntraced(function* (description: string | null) {
	const trimmed = typeof description === "string" ? Str.trim(description) : ""
	if (trimmed.length > MAX_DESCRIPTION_LENGTH) {
		return yield* invalid(`Description must be at most ${MAX_DESCRIPTION_LENGTH} characters`)
	}
	return trimmed.length === 0 ? null : trimmed
})

const normalizeSignals = Effect.fnUntraced(function* (signals: ReadonlyArray<SourceSignal> | null) {
	if (signals === null) return null
	const unique = Arr.dedupe(signals)
	if (unique.length === 0) return yield* invalid("Allow at least one signal, or null for every signal")
	return unique
})

/** The same signal set, in any order; `null` (every signal) only equals `null`. */
const sameSignals = (a: ReadonlyArray<SourceSignal> | null, b: ReadonlyArray<SourceSignal> | null): boolean =>
	a === null || b === null ? a === b : a.length === b.length && Arr.every(a, (signal) => b.includes(signal))

const normalizeRateLimit = Effect.fnUntraced(function* (rps: number | null) {
	if (rps === null) return null
	if (rps < 1 || rps > MAX_RATE_LIMIT_RPS) {
		return yield* invalid(`Rate limit must be between 1 and ${MAX_RATE_LIMIT_RPS} requests per second`)
	}
	return rps
})

const normalizeAttributes = Effect.fnUntraced(function* (attributes: ReadonlyArray<SourceResourceAttribute>) {
	if (attributes.length > MAX_RESOURCE_ATTRIBUTES) {
		return yield* invalid(`At most ${MAX_RESOURCE_ATTRIBUTES} resource attributes per source`)
	}
	const normalized = Arr.map(attributes, (attribute) => ({
		key: Str.trim(attribute.key),
		value: attribute.value,
		mode: attribute.mode,
	}))
	yield* Effect.forEach(normalized, (attribute) =>
		Effect.gen(function* () {
			if (attribute.key.length === 0) return yield* invalid("Attribute keys must not be empty")
			if (attribute.key.length > MAX_ATTRIBUTE_KEY_LENGTH) {
				return yield* invalid(`Attribute keys must be at most ${MAX_ATTRIBUTE_KEY_LENGTH} characters`)
			}
			if (attribute.value.length === 0)
				return yield* invalid(`Attribute "${attribute.key}" needs a value`)
			if (attribute.value.length > MAX_ATTRIBUTE_VALUE_LENGTH) {
				return yield* invalid(
					`Attribute values must be at most ${MAX_ATTRIBUTE_VALUE_LENGTH} characters`,
				)
			}
			const lower = Str.toLowerCase(attribute.key)
			if (RESERVED_ATTRIBUTE_KEYS.has(lower) || Str.startsWith(RESERVED_ATTRIBUTE_PREFIX)(lower)) {
				return yield* invalid(`"${attribute.key}" is reserved by Maple and cannot be overridden`)
			}
		}),
	)
	const keys = Arr.map(normalized, (attribute) => attribute.key)
	if (Arr.dedupe(keys).length !== keys.length)
		return yield* invalid("Each attribute key can only be listed once")
	return normalized
})

// `current` is the stored expiry: sending it back unchanged is allowed even once it has passed.
const normalizeExpiry = Effect.fnUntraced(function* (
	expiresAtMs: number | null,
	now: number,
	current: number | null = null,
) {
	if (expiresAtMs === null || expiresAtMs === current) return expiresAtMs
	if (expiresAtMs <= now) return yield* invalid("Expiry must be in the future")
	return expiresAtMs
})

/** The HTTP request, or an integration minting a token source under its own platform. */
export type CreateSourceInput = Omit<CreateSourceRequest, "platform"> & { readonly platform: SourcePlatform }

// Rules are enforced by the gateway on a source's own token, so only token sources take them.
const RULE_FIELDS = ["allowedSignals", "rateLimitRps", "resourceAttributes", "expiresAtMs"] as const

const tokenSourceOnly = (row: SourceRow, action: string) =>
	row.kind === "default"
		? invalid(`The default source uses the organization's ingest keys and cannot ${action}`)
		: invalid(`${row.name} is collected by an integration and cannot ${action}`)

// Every source but the default one pauses: the gateway drops a paused token's data and the
// resources a poller sends under a paused integration source.
const defaultSourceCannot = (action: string) =>
	invalid(`The default source uses the organization's ingest keys and cannot ${action}`)

export class SourcesService extends Context.Service<SourcesService>()(
	"@maple/backend/services/SourcesService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "SourcesService", toPersistenceError)
			const env = yield* Env
			// Optional: only the API's and the MCP runtime's graphs carry the warehouse; elsewhere
			// (tests, the removal paths) an infrastructure push source reads off its own row.
			const warehouse = yield* Effect.serviceOption(WarehouseQueryService)
			const lookupHmacKey = yield* ingestKeyLookupHmacKey(
				env,
				(message) => new IngestKeyEncryptionError({ message }),
			)

			const notFound = (sourceId: SourceId) =>
				new SourceNotFoundError({ sourceId, message: "Source not found" })

			// NevrLabs selfhost: each infrastructure push source's newest sample of its series, as the
			// `deliveredAt` of its health. No series in a day leaves the source on its own `last_used_at`.
			const arrivalsOf = Effect.fnUntraced(function* (
				orgId: OrgId,
				rows: ReadonlyArray<SourceRow>,
				now: number,
			) {
				const pushRows = Arr.filterMap(rows, (row) =>
					isPushInfra(row.platform)
						? Result.succeed({ id: row.id, platform: row.platform })
						: Result.failVoid,
				)
				const arrivals = new Map<SourceId, SourceHealthOverrides>()
				if (Option.isNone(warehouse) || pushRows.length === 0) return arrivals
				const tenant = systemTenant(orgId, SOURCES_SYSTEM_USER_ID)
				const window = {
					orgId,
					startTime: formatWarehouseDateTime(now - ARRIVAL_WINDOW_MS),
					endTime: formatWarehouseDateTime(now),
				}
				const options = { profile: "list", context: "sourceArrival" } as const
				const platforms = Arr.dedupe(Arr.map(pushRows, (row) => row.platform))
				const newest = yield* Effect.forEach(
					platforms,
					(platform) => {
						const signal = PUSH_INFRA_SIGNAL[platform]
						const read =
							signal.table === "gauge"
								? warehouse.value.compiledQuery(
										tenant,
										CH.compile(CH.gaugeMetricLastSeenQuery(signal.metric), window),
										options,
									)
								: warehouse.value.compiledQuery(
										tenant,
										CH.compile(CH.sumMetricLastSeenQuery(signal.metric), window),
										options,
									)
						// A failed presence read is a missing date, not a failed list.
						return read.pipe(Effect.orElseSucceed(() => []))
					},
					{ concurrency: "unbounded" },
				)
				for (const row of pushRows) {
					// No sample in the window reads as the epoch start.
					const sample = newest[platforms.indexOf(row.platform)]?.[0]?.lastSeen
					const at = sample === undefined ? 0 : DateTime.toEpochMillis(sample)
					if (at >= now - ARRIVAL_WINDOW_MS) arrivals.set(row.id, { deliveredAt: at })
				}
				return arrivals
			})

			const requireRow = Effect.fnUntraced(function* (orgId: OrgId, sourceId: SourceId) {
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(Sources)
							.select()
							.where(($) => [$.orgId.eq(orgId), $.id.eq(sourceId)])
							.limit(1),
					),
				)
				const row = rows[0]
				if (row === undefined) return yield* notFound(sourceId)
				return row
			})

			const updateRow = Effect.fnUntraced(function* (
				orgId: OrgId,
				sourceId: SourceId,
				set: Partial<Omit<SourceRow, "id" | "orgId">>,
			) {
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.update(Sources)
							.set(set)
							.where(($) => [$.orgId.eq(orgId), $.id.eq(sourceId)])
							.returning(),
					),
				)
				const row = rows[0]
				if (row === undefined) return yield* notFound(sourceId)
				return row
			})

			// Orgs created before sources existed get their default source on first list.
			const ensureDefault = (orgId: OrgId, now: number) =>
				dbExecute((db) =>
					db.run(PG.insertInto(Sources).values(defaultSourceRow(orgId, now)).onConflictDoNothing()),
				)

			const selectAll = (orgId: OrgId) =>
				dbExecute((db) =>
					db.run(
						PG.from(Sources)
							.select()
							.where(($) => [$.orgId.eq(orgId)])
							.orderBy(($) => [
								[$.createdAt, "desc"],
								[$.id, "desc"],
							]),
					),
				)

			const ownerOf = (
				owners: Effect.Success<ReturnType<typeof readSourceOwners>>,
				id: SourceId,
			): SourceOwner => ({
				integrationId: owners.integrationIds.get(id) ?? null,
				overrides: owners.overrides.get(id),
			})

			// The default source first, then newest first as selected.
			const toSources = (
				rows: ReadonlyArray<SourceRow>,
				owners: Effect.Success<ReturnType<typeof readSourceOwners>>,
				arrivals: ReadonlyMap<SourceId, SourceHealthOverrides>,
				now: number,
			) =>
				Arr.map(
					Arr.sortWith(rows, (row) => (row.kind === "default" ? 0 : 1), Order.Number),
					(row) =>
						rowToSource(row, now, withArrival(ownerOf(owners, row.id), arrivals.get(row.id))),
				)

			// An integration source answers with its integration row and that row's switches.
			const toSource = Effect.fnUntraced(function* (orgId: OrgId, row: SourceRow, now: number) {
				const owners =
					row.kind === "integration"
						? yield* dbExecute((db) => readSourceOwners(db, orgId, now))
						: undefined
				const owner: SourceOwner = owners === undefined ? NO_OWNER : ownerOf(owners, row.id)
				const arrivals = yield* arrivalsOf(orgId, [row], now)
				return rowToSource(row, now, withArrival(owner, arrivals.get(row.id)))
			})

			const list = Effect.fn("SourcesService.list")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				const now = yield* Clock.currentTimeMillis
				const [before, owners] = yield* Effect.all(
					[selectAll(orgId), dbExecute((db) => readSourceOwners(db, orgId, now))],
					{ concurrency: "unbounded" },
				)
				const missingDefault = !Arr.some(before, (row) => row.kind === "default")
				if (missingDefault) yield* ensureDefault(orgId, now)
				const rows = missingDefault ? yield* selectAll(orgId) : before
				const arrivals = yield* arrivalsOf(orgId, rows, now)
				return toSources(rows, owners, arrivals, now)
			})

			const get = Effect.fn("SourcesService.get")(function* (orgId: OrgId, sourceId: SourceId) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.source.id": sourceId })
				const row = yield* requireRow(orgId, sourceId)
				const nowMs = yield* Clock.currentTimeMillis
				return yield* toSource(orgId, row, nowMs)
			})

			const create = Effect.fn("SourcesService.create")(function* (
				orgId: OrgId,
				userId: UserId,
				request: CreateSourceInput,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.source.platform": request.platform })
				const now = yield* Clock.currentTimeMillis
				const name = yield* normalizeName(request.name)
				const description = yield* normalizeDescription(request.description ?? null)
				const allowedSignals = yield* normalizeSignals(request.allowedSignals ?? null)
				const rateLimitRps = yield* normalizeRateLimit(request.rateLimitRps ?? null)
				const resourceAttributes = yield* normalizeAttributes(request.resourceAttributes ?? [])
				const expiresAt = yield* normalizeExpiry(request.expiresAtMs ?? null, now)

				const id = newSourceId()
				const { secret, keyPrefix } = generateSecret(request.platform)
				yield* Effect.annotateCurrentSpan("maple.source.id", id)
				// The per-org lock makes the source cap hold under concurrent creates.
				const rows = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* db.execute(
								Orm.sql`select pg_advisory_xact_lock(hashtext(${orgId}), hashtext('sources'))`,
							)
							const existing = yield* db.run(
								PG.from(Sources)
									.select(($) => ({ id: $.id }))
									.where(($) => [$.orgId.eq(orgId), $.kind.eq("token")])
									.limit(MAX_SOURCES_PER_ORG),
							)
							if (existing.length >= MAX_SOURCES_PER_ORG) return null
							return yield* db.run(
								PG.insertInto(Sources)
									.values({
										id,
										orgId,
										name,
										description,
										platform: request.platform,
										kind: "token",
										keyHash: hashIngestKey(secret, lookupHmacKey),
										keyPrefix,
										allowedSignals,
										rateLimitRps,
										resourceAttributes,
										expiresAt,
										rolledAt: now,
										createdAt: now,
										updatedAt: now,
										createdBy: userId,
										updatedBy: userId,
									})
									.returning(),
							)
						}),
					),
				)
				if (rows === null) {
					return yield* invalid(`An organization can have at most ${MAX_SOURCES_PER_ORG} sources`)
				}
				const row = rows[0]
				if (row === undefined) {
					return yield* new SourcePersistenceError({ message: "Failed to create source" })
				}
				return new SourceWithSecret({ source: rowToSource(row, now), secret })
			})

			const update = Effect.fn("SourcesService.update")(function* (
				orgId: OrgId,
				userId: UserId,
				sourceId: SourceId,
				request: UpdateSourceRequest,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.source.id": sourceId })
				const existing = yield* requireRow(orgId, sourceId)
				if (
					existing.kind !== "token" &&
					Arr.some(RULE_FIELDS, (field) => request[field] !== undefined)
				) {
					return yield* tokenSourceOnly(existing, "take ingest rules")
				}
				const now = yield* Clock.currentTimeMillis
				const allowedSignals =
					request.allowedSignals === undefined
						? undefined
						: yield* normalizeSignals(request.allowedSignals)
				const rateLimitRps =
					request.rateLimitRps === undefined
						? undefined
						: yield* normalizeRateLimit(request.rateLimitRps)
				// Only a real change of signals or rate limit can lift a refusal.
				const clearsRejection =
					(allowedSignals !== undefined && !sameSignals(allowedSignals, existing.allowedSignals)) ||
					(rateLimitRps !== undefined && rateLimitRps !== existing.rateLimitRps)
				const row = yield* updateRow(orgId, sourceId, {
					updatedAt: now,
					updatedBy: userId,
					name: request.name === undefined ? undefined : yield* normalizeName(request.name),
					description:
						request.description === undefined
							? undefined
							: yield* normalizeDescription(request.description),
					allowedSignals,
					rateLimitRps,
					resourceAttributes:
						request.resourceAttributes === undefined
							? undefined
							: yield* normalizeAttributes(request.resourceAttributes),
					expiresAt:
						request.expiresAtMs === undefined
							? undefined
							: yield* normalizeExpiry(request.expiresAtMs, now, existing.expiresAt),
					lastRejectedAt: clearsRejection ? null : undefined,
					lastRejection: clearsRejection ? null : undefined,
				})
				// Integration sources take their health from the integration, as `get` reads it.
				return yield* toSource(orgId, row, now)
			})

			// `untilMs` null pauses until resumed.
			const pause = Effect.fn("SourcesService.pause")(function* (
				orgId: OrgId,
				userId: UserId,
				sourceId: SourceId,
				untilMs: number | null,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.source.id": sourceId })
				const now = yield* Clock.currentTimeMillis
				if (untilMs !== null && untilMs <= now)
					return yield* invalid("A pause must end in the future")
				const existing = yield* requireRow(orgId, sourceId)
				if (existing.kind === "default") return yield* defaultSourceCannot("be paused")
				const row = yield* updateRow(orgId, sourceId, {
					pausedAt: now,
					pausedUntil: untilMs,
					updatedAt: now,
					updatedBy: userId,
				})
				return yield* toSource(orgId, row, now)
			})

			const resume = Effect.fn("SourcesService.resume")(function* (
				orgId: OrgId,
				userId: UserId,
				sourceId: SourceId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.source.id": sourceId })
				const existing = yield* requireRow(orgId, sourceId)
				if (existing.kind === "default") return yield* defaultSourceCannot("be resumed")
				const now = yield* Clock.currentTimeMillis
				const row = yield* updateRow(orgId, sourceId, {
					pausedAt: null,
					pausedUntil: null,
					updatedAt: now,
					updatedBy: userId,
				})
				return yield* toSource(orgId, row, now)
			})

			const roll = Effect.fn("SourcesService.roll")(function* (
				orgId: OrgId,
				userId: UserId,
				sourceId: SourceId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.source.id": sourceId })
				const existing = yield* requireRow(orgId, sourceId)
				if (existing.kind !== "token") return yield* tokenSourceOnly(existing, "be rolled here")
				const now = yield* Clock.currentTimeMillis
				const { secret, keyPrefix } = generateSecret(existing.platform)
				const row = yield* updateRow(orgId, sourceId, {
					keyHash: hashIngestKey(secret, lookupHmacKey),
					keyPrefix,
					rolledAt: now,
					updatedAt: now,
					updatedBy: userId,
					// The old token's refusals say nothing about the new one.
					lastRejectedAt: null,
					lastRejection: null,
				})
				return new SourceWithSecret({ source: rowToSource(row, now), secret })
			})

			const remove = Effect.fn("SourcesService.delete")(function* (orgId: OrgId, sourceId: SourceId) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.source.id": sourceId })
				const existing = yield* requireRow(orgId, sourceId)
				if (existing.kind !== "token") return yield* tokenSourceOnly(existing, "be deleted here")
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.deleteFrom(Sources)
							.where(($) => [$.orgId.eq(orgId), $.id.eq(sourceId)])
							.returning(),
					),
				)
				const row = rows[0]
				if (row === undefined) return yield* notFound(sourceId)
				const nowMs = yield* Clock.currentTimeMillis
				return rowToSource(row, nowMs)
			})

			return { list, get, create, update, pause, resume, roll, delete: remove }
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
