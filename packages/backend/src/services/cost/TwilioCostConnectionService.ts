// The Twilio Account SID and auth token an org's Twilio spend is read with: checked with Twilio, then
// kept in the shared cost connection store. The Cost page says the credential reads usage only.
import {
	CostConnectionPersistenceError,
	CostConnectionValidationError,
	TWILIO_COST_CREDENTIAL_MAX_LENGTH,
	type OrgId,
	type UserId,
} from "@maple/domain/http"
import { Clock, Context, Duration, Effect, Layer, Redacted, Array as Arr, String as Str } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { CostConnectionStore, type CostConnectionStoreError } from "./CostConnectionStore"
import { addDays, utcToday } from "./sync-plan"
import * as Twilio from "./providers/twilio/twilio-costs-api"

const VALIDATE_TIMEOUT = Duration.seconds(20)

const refused = (message: string) => new CostConnectionValidationError({ message })

const toPersistenceError = (error: CostConnectionStoreError) =>
	new CostConnectionPersistenceError({ message: error.message })

/**
 * Twilio's refusals, as what the Cost page shows. The account read says whether the credential is
 * right, the usage read whether it may see the spend. An outage or a request Twilio calls invalid
 * answers a fixed sentence.
 */
const toCredentialError = (
	error: Twilio.TwilioCostsError,
): CostConnectionValidationError | CostConnectionPersistenceError => {
	switch (error.kind) {
		case "unauthorized":
			return refused(
				"Twilio rejected this Account SID or auth token. Copy both from the console's Account Info page.",
			)
		case "forbidden":
			return refused(
				"This credential cannot read the account's usage records. Use the account's own auth token.",
			)
		case "bad_request":
			return refused("Twilio did not take this credential. Check the Account SID and auth token.")
		default:
			return new CostConnectionPersistenceError({
				message: "Could not check this credential with Twilio. Try again.",
			})
	}
}

export interface TwilioCostConnectionServiceApi {
	/** Saves the credential and answers the Twilio account it reads. */
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

export class TwilioCostConnectionService extends Context.Service<
	TwilioCostConnectionService,
	TwilioCostConnectionServiceApi
>()("@maple/backend/services/cost/TwilioCostConnectionService", {
	make: Effect.gen(function* () {
		const connections = yield* CostConnectionStore
		const httpClient = yield* HttpClient.HttpClient

		/**
		 * The account the credential opens, proven by reading its own resource and one day of its
		 * usage records: the first proves the credential, the second that it may read the spend.
		 */
		const validateWithTwilio = Effect.fn("TwilioCostConnectionService.validateWithTwilio")(function* (
			account: Twilio.TwilioAccount,
		) {
			const info = yield* Twilio.fetchAccount(httpClient, account).pipe(
				Effect.mapError(toCredentialError),
			)
			const now = yield* Clock.currentTimeMillis
			const today = utcToday(now)
			yield* Twilio.usagePage(
				httpClient,
				account,
				{ startDate: addDays(today, -1), endDate: today },
				0,
			).pipe(Effect.mapError(toCredentialError))
			return { accountId: info.sid, accountLabel: info.friendly_name ?? info.sid }
		})

		const set = Effect.fn("TwilioCostConnectionService.set")(function* (
			orgId: OrgId,
			userId: UserId,
			rawCredential: string,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			// Both halves printable and unbroken, the SID shaped as Twilio issues it: nothing else is
			// ever sent to Twilio as a credential.
			const parts = Arr.filter(Str.split(" ")(Str.trim(rawCredential)), (part) => part !== "")
			const isCredentialPaste =
				parts.length === 2 &&
				Twilio.ACCOUNT_SID_PATTERN.test(parts[0] ?? "") &&
				Arr.every(
					parts,
					(part) => part.length <= TWILIO_COST_CREDENTIAL_MAX_LENGTH && /^[\x21-\x7e]+$/.test(part),
				)
			if (!isCredentialPaste) {
				return yield* refused(
					"Paste the account's Account SID (it starts with AC) and auth token together, separated by a space.",
				)
			}
			const [accountSid = "", authToken = ""] = parts
			const account: Twilio.TwilioAccount = {
				accountSid: Redacted.make(accountSid),
				authToken: Redacted.make(authToken),
			}
			const checked = yield* validateWithTwilio(account).pipe(
				Effect.timeoutOrElse({
					duration: VALIDATE_TIMEOUT,
					orElse: () =>
						Effect.fail(
							new CostConnectionPersistenceError({
								message: "Could not reach Twilio to check this credential. Try again.",
							}),
						),
				}),
			)
			const saved = yield* connections
				.save({
					orgId,
					userId,
					provider: "twilio",
					secret: Redacted.make(`${accountSid} ${authToken}`),
					...checked,
				})
				.pipe(Effect.mapError(toPersistenceError))
			if (saved === "other_account") {
				return yield* refused(
					"This credential belongs to another Twilio account than the source does. Remove the source first to switch accounts.",
				)
			}
			return checked
		})

		const remove = Effect.fn("TwilioCostConnectionService.remove")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			yield* connections.remove(orgId, "twilio").pipe(Effect.mapError(toPersistenceError))
		})

		return { set, remove } satisfies TwilioCostConnectionServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(FetchHttpClient.layer, CostConnectionStore.layer)),
	)
}
