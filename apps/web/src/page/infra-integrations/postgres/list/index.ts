import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/infra/postgres`: PostgreSQL instances and their Patroni roles (NevrLabs selfhost). */
export const page = definePage(
	"InfraPostgres",
	{ Model, Message },
	{
		routes: ["InfraPostgres"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: () => [{ label: "Infrastructure", href: "/infra" }, { label: "PostgreSQL" }],
	},
)
