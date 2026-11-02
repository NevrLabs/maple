import { Option } from "effect"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import { AppRoute, hrefOf } from "../../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../../contract"
import type { ProxmoxViewState } from "../model"
import { FetchSnapshot } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

type Return = PageReturn<Model, Message>
type Search = Model["search"]

/** The URL's view state, with the defaults the lab uses. */
export const viewStateOf = (search: Search): ProxmoxViewState => ({
	tab: search.tab ?? "overview",
	query: search.q ?? "",
	guestScope: search.scope,
	nodeFilter: search.node,
})

const fetch = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const generation = model.generation + 1
	const key = requestKey(context.orgId, "proxmoxSnapshot", { generation })
	return Option.match(Keyed.request(model.snapshot, key, mode), {
		onNone: () => ({ model }),
		onSome: (snapshot) => ({ model: { ...model, snapshot, generation }, commands: [FetchSnapshot({ key })] }),
	})
}

/** Tab, node and scope push a history entry; typing replaces it so Back is not one step per key. */
const navigate = (model: Model, search: Search, isReplace = false): Return => ({
	model: { ...model, search },
	outMessage: PageOutMessage.RequestedNavigation({ url: hrefOf(AppRoute.InfraProxmox({ search })), isReplace }),
})

export const init = (route: { readonly search: Search }, context: PageContext): Return =>
	fetch({ search: route.search, snapshot: Keyed.idle(), generation: 0 }, context, "Load")

export const routeChanged = (model: Model, route: { readonly search: Search }): Return => ({
	model: { ...model, search: route.search },
})

export const contextChanged = (model: Model): Return => ({ model })

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedFetchSnapshot: ({ key, result }) => ({
			model: { ...model, snapshot: Keyed.accept(model.snapshot, key, result) },
		}),
		TickedRefresh: () => fetch(model, context, "Refresh"),
		ClickedRetry: () => fetch(model, context, "Refresh"),
		ClickedTab: ({ tab }) => navigate(model, { ...model.search, tab: tab === "overview" ? undefined : tab }),
		ChangedQuery: ({ value }) => navigate(model, { ...model.search, q: value === "" ? undefined : value }, true),
		ChangedGuestScope: ({ scope }) => navigate(model, { ...model.search, scope }),
		ClickedNode: ({ node }) =>
			navigate(model, { ...model.search, node: model.search.node === node ? undefined : node, tab: undefined }),
	})
