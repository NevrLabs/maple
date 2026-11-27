// The MongoDB Atlas service account an org's Atlas spend is read with: checked with Atlas, then kept
// in the shared cost connection store. A service account can be limited to billing reads, which the
// Cost page says.
import {
	CostConnectionPersistenceError,
	CostConnectionValidationError,
	MONGODB_COST_CREDENTIAL_MAX_LENGTH,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import { Clock, Context, Duration, Effect, Layer, Redacted, Array as Arr, String as Str } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { CostConnectionStore, type CostConnectionStoreError } from "./CostConnectionStore"
import { addDays, utcToday } from "./sync-plan"
import * as Atlas from "./providers/mongodb/mongodb-costs-api"

const VALIDATE_TIMEOUT = Duration.seconds(20)
/** The invoices the check lists, around today: it only proves the account may read them. */
const VALIDATE_INVOICE_DAYS = 31

const refused = (message: string) => new CostConnectionValidationError({ message })

const toPersistenceError = (error: CostConnectionStoreError) =>
	new CostConnectionPersistenceError({ message: error.message })

/**
 * Atlas's refusals, as what the Cost page shows. A 403 differs by where it comes from: the token
 * endpoint refuses the address, the API the role, so each call says which it was. An outage or a
 * request Atlas calls invalid answers a fixed sentence.
 */
const toCredentialError = (
	error: Atlas.MongodbCostsError,
	forbidden: string,
): CostConnectionValidationError | CostConnectionPersistenceError => {
	switch (error.kind) {
		case "unauthorized":
			return refused(
				"MongoDB Atlas rejected this service account. Create one in the organization's settings and paste its client ID and secret.",
			)
		case "forbidden":
			return refused(forbidden)
		case "bad_request":
			return refused("MongoDB Atlas did not take this service account. Check the client ID and secret.")
		default:
			return new CostConnectionPersistenceError({
				message: "Could not check this service account with MongoDB Atlas. Try again.",
			})
	}
}

export interface MongodbCostConnectionServiceApi {
	/** Saves the service account and answers the MongoDB Atlas organization it reads. */
	readonly set: (
		orgId: OrgId,
		userId: UserId,
		credential: string,
	) => Effect.Effect<
		{ readonly accountId: string; readonly accountLabel: string },
		CostConnectionPersistenceError | CostConnectionValidationError
	>
	readonly remove: (orgId: OrgId) => Effect.Effect<void, CostConnectionPersistenceError>
}

export class MongodbCostConnectionService extends Context.Service<
	MongodbCostConnectionService,
	MongodbCostConnectionServiceApi
>()("@maple/backend/services/cost/MongodbCostConnectionService", {
	make: Effect.gen(function* () {
		const connections = yield* CostConnectionStore
		const httpClient = yield* HttpClient.HttpClient

		/**
		 * The organization the service account acts in, proven by reading one page of its invoices: a
		 * service account belongs to one organization, so two names leave no telling which one it reads.
		 */
		const validateWithAtlas = Effect.fn("MongodbCostConnectionService.validateWithAtlas")(function* (
			account: Atlas.ServiceAccount,
		) {
			const token = yield* Atlas.serviceAccountToken(httpClient, account).pipe(
				Effect.mapError((error) =>
					toCredentialError(
						error,
						"MongoDB Atlas refuses this service account from Maple's address. Add Maple's address to the service account's API access list.",
					),
				),
			)
			const organizations = yield* Atlas.listOrganizations(httpClient, token).pipe(
				Effect.mapError((error) =>
					toCredentialError(
						error,
						"This service account cannot read its organization. Give it the Organization Billing Viewer role.",
					),
				),
			)
			const [organization, ...others] = organizations
			if (organization === undefined || others.length > 0) {
				return yield* refused(
					organization === undefined
						? "MongoDB Atlas names no organization for this service account, so there is nothing to read."
						: "MongoDB Atlas names more than one organization for this service account, so Maple cannot tell which one it reads.",
				)
			}
			const now = yield* Clock.currentTimeMillis
			const today = utcToday(now)
			yield* Atlas.invoicePage(
				httpClient,
				token,
				organization.id,
				{
					fromDate: addDays(today, -VALIDATE_INVOICE_DAYS),
					toDate: addDays(today, VALIDATE_INVOICE_DAYS),
				},
				1,
			).pipe(
				Effect.mapError((error) =>
					toCredentialError(
						error,
						"This service account cannot read the organization's invoices. Give it the Organization Billing Viewer role.",
					),
				),
			)
			return { accountId: organization.id, accountLabel: organization.name ?? organization.id }
		})

		const set = Effect.fn("MongodbCostConnectionService.set")(function* (
			orgId: OrgId,
			userId: UserId,
			rawCredential: string,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			// Both halves printable and unbroken: nothing else is ever sent to Atlas as a credential.
			const parts = Arr.filter(Str.split(" ")(Str.trim(rawCredential)), (part) => part !== "")
			const isCredentialPaste =
				parts.length === 2 &&
				Arr.every(
					parts,
					(part) =>
						part.length <= MONGODB_COST_CREDENTIAL_MAX_LENGTH && /^[\x21-\x7e]+$/.test(part),
				)
			if (!isCredentialPaste) {
				return yield* refused(
					"Paste the service account's client ID and secret together, separated by a space.",
				)
			}
			const [clientId = "", clientSecret = ""] = parts
			const account: Atlas.ServiceAccount = {
				clientId: Redacted.make(clientId),
				clientSecret: Redacted.make(clientSecret),
			}
			const checked = yield* validateWithAtlas(account).pipe(
				Effect.timeoutOrElse({
					duration: VALIDATE_TIMEOUT,
					orElse: () =>
						Effect.fail(
							new CostConnectionPersistenceError({
								message:
									"Could not reach MongoDB Atlas to check this service account. Try again.",
							}),
						),
				}),
			)
			const saved = yield* connections
				.save({
					orgId,
					userId,
					provider: "mongodb",
					secret: Redacted.make(`${clientId} ${clientSecret}`),
					...checked,
				})
				.pipe(Effect.mapError(toPersistenceError))
			if (saved === "other_account") {
				return yield* refused(
					"This service account belongs to another MongoDB Atlas organization than the source does. Remove the source first to switch organizations.",
				)
			}
			return checked
		})

		const remove = Effect.fn("MongodbCostConnectionService.remove")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			yield* connections.remove(orgId, "mongodb").pipe(Effect.mapError(toPersistenceError))
		})

		return { set, remove } satisfies MongodbCostConnectionServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(FetchHttpClient.layer, CostConnectionStore.layer)),
	)
}
