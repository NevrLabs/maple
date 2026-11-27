import type { PushSourcePlatform } from "@maple/primitives"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type DocsPage, docsUrl } from "../../kit/docs"
import { flowRail, type RailItem } from "../../kit/connect-flow"
import { platformMeta } from "../kit/platforms"
import type { Message } from "./message"

// The push flow's rail: where the source's data shows up.

type H = HtmlBuilder<Message>

const DOCS_PAGE = {
	opentelemetry: "instrumentation",
	nodejs: "instrumentation",
	python: "instrumentation",
	go: "instrumentation",
	java: "instrumentation",
	dotnet: "instrumentation",
	ruby: "instrumentation",
	php: "instrumentation",
	rust: "instrumentation",
	browser: "browserSdk",
	kubernetes: "kubernetes",
	docker: "docker",
	host: "hosts",
	cloudflare_ai_gateway: "instrumentation",
	claude_code: "agentSessions",
	// NevrLabs selfhost: no maple.dev page; the snippets are the setup.
	proxmox: null,
	mongodb_atlas: null,
	postgresql: null,
} satisfies Record<PushSourcePlatform, DocsPage | null>

const docsOf = (platform: PushSourcePlatform) => {
	const page = DOCS_PAGE[platform]
	return page === null ? null : { label: `${platformMeta(platform).label} setup docs`, href: docsUrl(page) }
}

/** The first place this platform's data lands. */
const LANDS_IN = {
	browser: { icon: "GlobeIcon", title: "Web analytics", detail: "Sessions, replays and events" },
	claude_code: { icon: "ClaudeIcon", title: "Agent sessions", detail: "Each session with its usage" },
	kubernetes: { icon: "ServerIcon", title: "Infrastructure", detail: "Nodes, pods and containers" },
	docker: { icon: "ServerIcon", title: "Infrastructure", detail: "Containers on each host" },
	host: { icon: "ServerIcon", title: "Infrastructure", detail: "CPU, memory, disk and network" },
	proxmox: { icon: "StackPerspectiveIcon", title: "Infrastructure → Proxmox", detail: "Nodes, guests and storage" },
	mongodb_atlas: { icon: "MongodbIcon", title: "Infrastructure → MongoDB Atlas", detail: "Projects, clusters and their members" },
	postgresql: { icon: "PostgresIcon", title: "Infrastructure → PostgreSQL", detail: "One row per instance, Patroni roles" },
} satisfies Partial<Record<PushSourcePlatform, RailItem>>

const landsIn = (platform: PushSourcePlatform): RailItem =>
	platform in LANDS_IN
		? LANDS_IN[platform as keyof typeof LANDS_IN]
		: { icon: "LayersIcon", title: "Services", detail: "One row per service.name" }

export const showsUpRail = (h: H, platform: PushSourcePlatform): Html =>
	flowRail(h, {
		eyebrow: "Where it shows up",
		items: [
			landsIn(platform),
			{
				icon: "ChartLineIcon",
				title: "Explore",
				detail: "Traces, logs and metrics as soon as they arrive",
			},
			{ icon: "GearIcon", title: "Source page", detail: "Rules, Roll token, Pause" },
		],
		timeNote: "Usually under 1 minute",
		docs: docsOf(platform),
	})
