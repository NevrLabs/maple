import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/infra/atlas`: MongoDB Atlas by project and cluster, then each cluster's members (NevrLabs selfhost). */
export const page = definePage(
	"InfraAtlas",
	{ Model, Message },
	{
		routes: ["InfraAtlas"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: () => [{ label: "Infrastructure", href: "/infra" }, { label: "MongoDB Atlas" }],
	},
)
