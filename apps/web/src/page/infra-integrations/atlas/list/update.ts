import { Option } from "effect"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import type { PageContext, PageReturn } from "../../../contract"
import { FetchSnapshot } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>

const fetch = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const generation = model.generation + 1
	const key = requestKey(context.orgId, "atlasSnapshot", { generation })
	return Option.match(Keyed.request(model.snapshot, key, mode), {
		onNone: () => ({ model }),
		onSome: (snapshot) => ({ model: { ...model, snapshot, generation }, commands: [FetchSnapshot({ key })] }),
	})
}

export const init = (_route: unknown, context: PageContext): Return =>
	fetch({ snapshot: Keyed.idle(), generation: 0 }, context, "Load")

export const routeChanged = (model: Model): Return => ({ model })

export const contextChanged = (model: Model): Return => ({ model })

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchSnapshot: ({ key, result }) => ({
			model: { ...model, snapshot: Keyed.accept(model.snapshot, key, result) },
		}),
		TickedRefresh: () => fetch(model, context, "Refresh"),
		ClickedRetry: () => fetch(model, context, "Refresh"),
	})
