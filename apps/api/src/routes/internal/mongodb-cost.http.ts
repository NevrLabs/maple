import { HttpApiBuilder } from "effect/http-api"
import { MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { MongodbCostConnectionService } from "@maple/backend/services/cost/MongodbCostConnectionService"
import { removeCostConnection, saveCostConnection } from "./cost-connection-handlers"

export const HttpMongodbCostLive = HttpApiBuilder.group(MapleInternalApi, "mongodbCost", (handlers) =>
	Effect.gen(function* () {
		const connections = yield* MongodbCostConnectionService

		return handlers
			.handle("set", ({ payload }) =>
				saveCostConnection("mongodb", (orgId, userId) =>
					connections.set(orgId, userId, payload.credential),
				).pipe(Effect.withSpan("HttpMongodbCost.set")),
			)
			.handle("remove", () =>
				removeCostConnection("mongodb", connections.remove).pipe(
					Effect.withSpan("HttpMongodbCost.remove"),
				),
			)
	}),
)
