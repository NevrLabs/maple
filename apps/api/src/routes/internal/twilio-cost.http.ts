import { HttpApiBuilder } from "effect/http-api"
import { MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { TwilioCostConnectionService } from "@maple/backend/services/cost/TwilioCostConnectionService"
import { removeCostConnection, saveCostConnection } from "./cost-connection-handlers"

export const HttpTwilioCostLive = HttpApiBuilder.group(MapleInternalApi, "twilioCost", (handlers) =>
	Effect.gen(function* () {
		const connections = yield* TwilioCostConnectionService

		return handlers
			.handle("set", ({ payload }) =>
				saveCostConnection("twilio", (orgId, userId) =>
					connections.set(orgId, userId, payload.credential),
				).pipe(Effect.withSpan("HttpTwilioCost.set")),
			)
			.handle("remove", () =>
				removeCostConnection("twilio", connections.remove).pipe(
					Effect.withSpan("HttpTwilioCost.remove"),
				),
			)
	}),
)
