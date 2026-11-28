import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import {
	CostConnectionForbiddenError,
	CostConnectionPersistenceError,
	CostConnectionRemoved,
	CostConnectionSaved,
	CostConnectionValidationError,
} from "./cost-connections"
import { SessionAuthorization } from "./current-tenant"
import { EndpointAccess, handlerChecks } from "./endpoint-access"

/** Far above an Account SID and an auth token: it only bounds what the request carries. */
export const TWILIO_COST_CREDENTIAL_MAX_LENGTH = 512

/** A Twilio account as one paste: its Account SID and auth token, separated by whitespace. */
export class TwilioCostCredentialRequest extends Schema.Class<TwilioCostCredentialRequest>(
	"TwilioCostCredentialRequest",
)({
	credential: Schema.String.check(Schema.isMaxLength(TWILIO_COST_CREDENTIAL_MAX_LENGTH)),
}) {}

/** Saving an account makes the org's Twilio cost source, replacing one keeps it, removing deletes it. */
export class TwilioCostApiGroup extends HttpApiGroup.make("twilioCost")
	.add(
		HttpApiEndpoint.put("set", "/", {
			payload: TwilioCostCredentialRequest,
			success: CostConnectionSaved,
			error: [
				CostConnectionPersistenceError,
				CostConnectionForbiddenError,
				CostConnectionValidationError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("remove", "/", {
			success: CostConnectionRemoved,
			error: [CostConnectionPersistenceError, CostConnectionForbiddenError],
		}),
	)
	.prefix("/internal/cost/twilio")
	.middleware(SessionAuthorization)
	.annotate(EndpointAccess, handlerChecks("integrations:manage")) {}
