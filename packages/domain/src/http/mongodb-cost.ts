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

/** Far above a service account's client ID and secret: it only bounds what the request carries. */
export const MONGODB_COST_CREDENTIAL_MAX_LENGTH = 512

/** A MongoDB Atlas service account as one paste: its client ID and secret, separated by whitespace. */
export class MongodbCostCredentialRequest extends Schema.Class<MongodbCostCredentialRequest>(
	"MongodbCostCredentialRequest",
)({
	credential: Schema.String.check(Schema.isMaxLength(MONGODB_COST_CREDENTIAL_MAX_LENGTH)),
}) {}

/** Saving a service account makes the org's MongoDB Atlas cost source, replacing one keeps it, removing deletes it. */
export class MongodbCostApiGroup extends HttpApiGroup.make("mongodbCost")
	.add(
		HttpApiEndpoint.put("set", "/", {
			payload: MongodbCostCredentialRequest,
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
	.prefix("/internal/cost/mongodb")
	.middleware(SessionAuthorization)
	.annotate(EndpointAccess, handlerChecks("integrations:manage")) {}
