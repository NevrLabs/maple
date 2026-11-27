import type { SourcePlatform } from "@maple/primitives"
import {
	type FrameworkId,
	fillSnippet,
	HTTP_PROTOCOL_LINE,
	type SdkSnippet,
	sdkSnippets,
} from "../../kit/sdk-snippets"
import { ingestUrl } from "../../../platform/ingest-url"
import {
	ALCHEMY_FILE,
	alchemyDeployCommand,
	alchemyStack,
	dockerCommand,
	HOST_CONFIG,
	helmCommand,
	hostCommand,
	TERRAFORM_FILE,
	terraformApplyCommand,
	terraformConfig,
} from "../../infra/kit/install-snippets"
import type { IconName } from "@maple/views/ui/icon"
import { Array as Arr, String as Str, Option } from "effect"

export interface SourceSnippet {
	readonly id: string
	readonly label: string
	readonly language: string
	readonly code: string
	/** The tool's mark in the snippet's tab, when the tabs name tools. */
	readonly icon?: IconName
}

const envSnippet = (token: string, serviceName: string, needsHttp = false): SourceSnippet => ({
	id: "env",
	label: "Environment",
	language: "shell",
	code: Arr.join(
		[
			`export OTEL_EXPORTER_OTLP_ENDPOINT="${ingestUrl}"`,
			`export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${token}"`,
			`export OTEL_SERVICE_NAME="${serviceName}"`,
			...(needsHttp ? [HTTP_PROTOCOL_LINE] : []),
		],
		"\n",
	),
})

const collectorSnippet = (token: string): SourceSnippet => ({
	id: "collector",
	label: "Collector",
	language: "yaml",
	code: `exporters:\n  otlphttp/maple:\n    endpoint: ${ingestUrl}\n    headers:\n      Authorization: "Bearer ${token}"`,
})

// Reuses the quick-start SDK setups for the languages that have one: install, then run. They read
// the env snippet above.
const sdkFramework = (platform: SourcePlatform): FrameworkId | null =>
	platform === "nodejs" || platform === "python" || platform === "go" ? platform : null

const sdkOf = (platform: SourcePlatform): SdkSnippet | null => {
	const framework = sdkFramework(platform)
	return framework === null
		? null
		: Option.getOrNull(Arr.findFirst(sdkSnippets, (entry) => entry.language === framework))
}

const setupSnippets = (snippet: SdkSnippet, token: string): ReadonlyArray<SourceSnippet> => [
	{
		id: "install",
		label: "Install",
		language: "shell",
		code:
			typeof snippet.install === "string"
				? snippet.install
				: `npm install ${Arr.join(snippet.install.packages, " ")}`,
	},
	{
		id: "sdk",
		label: snippet.code.label === "Run" ? `Run with the ${snippet.label} SDK` : snippet.code.label,
		language: snippet.code.lang,
		code: fillSnippet(snippet.code.code, ingestUrl, token),
	},
]

const browserSnippet = (token: string, serviceName: string): SourceSnippet => ({
	id: "browser",
	label: "Browser SDK",
	language: "typescript",
	code: `import { MapleBrowser } from "@maple-dev/browser"\n\nMapleBrowser.init({\n  ingestKey: "${token}",\n  endpoint: "${ingestUrl}",\n  serviceName: "${serviceName}",\n})`,
})

const claudeCodeSnippet = (token: string): SourceSnippet => ({
	id: "claude-code",
	label: "Claude Code",
	language: "shell",
	code: Arr.join(
		[
			"export CLAUDE_CODE_ENABLE_TELEMETRY=1",
			"export OTEL_LOGS_EXPORTER=otlp",
			"export OTEL_METRICS_EXPORTER=otlp",
			"export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
			`export OTEL_EXPORTER_OTLP_ENDPOINT="${ingestUrl}"`,
			`export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer%20${token}"`,
		],
		"\n",
	),
})

/** NevrLabs selfhost: the three infrastructure sources, as each sender is configured in the homelab/Noovoleum. */
const ingestHost = (): { server: string; port: string; protocol: string } => {
	const url = new URL(ingestUrl)
	const https = url.protocol === "https:"
	return {
		server: url.hostname,
		port: url.port || (https ? "443" : "80"),
		protocol: https ? "https" : "http",
	}
}

/** PVE 9's OpenTelemetry metric server: headers are base64 JSON, and the payload is OTLP/HTTP JSON. */
const proxmoxSnippets = (token: string): ReadonlyArray<SourceSnippet> => {
	const { server, port, protocol } = ingestHost()
	return [
		{
			id: "pvesh",
			label: "pvesh (any node)",
			language: "shell",
			code: Arr.join(
				[
					`HEADERS=$(printf '{"Authorization":"Bearer %s"}' '${token}' | base64 -w0)`,
					"pvesh create /cluster/metrics/server/maple --type opentelemetry \\",
					`  --server ${server} --port ${port} --otel-protocol ${protocol} \\`,
					"  --otel-path /v1/metrics --otel-compression gzip --otel-timeout 5 \\",
					'  --otel-headers "$HEADERS"',
				],
				"\n",
			),
		},
		{
			id: "status-cfg",
			label: "/etc/pve/status.cfg",
			language: "text",
			code: `opentelemetry: maple\n\tserver ${server}\n\tport ${port}\n\totel-protocol ${protocol}\n\totel-path /v1/metrics\n\totel-compression gzip\n\totel-headers <base64 of {"Authorization":"Bearer ${token}"}>`,
		},
	]
}

/** Atlas's Prometheus integration (Project → Integrations → Prometheus), scraped by any collector you run. */
const atlasSnippet = (token: string): SourceSnippet => ({
	id: "collector",
	label: "Collector",
	language: "yaml",
	code: `receivers:
  prometheus:
    config:
      scrape_configs:
        - job_name: atlas
          scheme: https
          scrape_interval: 30s
          basic_auth: { username: <prometheus user>, password_file: /etc/secrets/atlas-prom-password }
          http_sd_configs:
            - url: https://cloud.mongodb.com/prometheus/v1.0/groups/<project id>/discovery?targetScheme=PRIVATE
              basic_auth: { username: <prometheus user>, password_file: /etc/secrets/atlas-prom-password }
exporters:
  otlphttp/maple:
    endpoint: ${ingestUrl}
    headers: { Authorization: "Bearer ${token}" }
service:
  pipelines:
    metrics: { receivers: [prometheus], exporters: [otlphttp/maple] }`,
})

/** The selfhost `twilio` exporter: the Maple-side service that polls Twilio's logs with this source's token. */
const twilioSnippet = (token: string): SourceSnippet => ({
	id: "exporter",
	label: "Maple selfhost exporter",
	language: "yaml",
	code: `# maple-selfhost image (apps/selfhost compose), service twilio-exporter
services:
  twilio-exporter:
    image: ghcr.io/nevrlabs/maple-selfhost:<tag>
    command: ["bun", "/app/twilio.js"]
    restart: unless-stopped
    environment:
      TWILIO_ACCOUNT_SID: ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx   # Twilio Console → Account Info
      TWILIO_AUTH_TOKEN: <auth token>
      MAPLE_INGEST_URL: http://ingest:3474
      MAPLE_TWILIO_TOKEN: "${token}"
      TWILIO_STATE_PATH: /var/lib/maple-twilio/state.json
    volumes: ["twilio-state:/var/lib/maple-twilio"]
# Every message and call lands as a log under the twilio service; undelivered and failed ones as errors.`,
})

/** One collector per instance: the postgresql receiver (role with pg_monitor), plus Patroni's /metrics when present. */
const postgresSnippets = (token: string): ReadonlyArray<SourceSnippet> => [
	{
		id: "role",
		label: "Monitoring role",
		language: "sql",
		code: "CREATE ROLE maple_monitor LOGIN PASSWORD '<password>';\nGRANT pg_monitor TO maple_monitor;",
	},
	{
		id: "collector",
		label: "Collector",
		language: "yaml",
		code: `receivers:
  postgresql:
    endpoint: 127.0.0.1:5432
    username: maple_monitor
    password: \${env:PG_MONITOR_PASSWORD}
    collection_interval: 60s
    tls: { insecure: true }
    metrics:
      postgresql.blks_hit: { enabled: true }
      postgresql.blks_read: { enabled: true }
      postgresql.deadlocks: { enabled: true }
      postgresql.wal.delay: { enabled: true }
  # Patroni clusters only: roles, timeline, replay position
  prometheus:
    config:
      scrape_configs:
        - job_name: patroni
          scrape_interval: 60s
          static_configs: [{ targets: ["127.0.0.1:8008"] }]
processors:
  resourcedetection: { detectors: [env, system] }
exporters:
  otlphttp/maple:
    endpoint: ${ingestUrl}
    headers: { Authorization: "Bearer ${token}" }
service:
  pipelines:
    metrics: { receivers: [postgresql, prometheus], processors: [resourcedetection], exporters: [otlphttp/maple] }`,
	},
]

/** The service name the env snippet suggests: the source name, slugged. */
const serviceNameOf = (name: string): string =>
	Str.replace(/^-|-$/g, "")(Str.replace(/[^a-z0-9]+/g, "-")(Str.toLowerCase(Str.trim(name)))) ||
	"my-service"

/**
 * Setup snippets for a push platform, most specific first. `token` is the full token right
 * after create or roll, otherwise a masked placeholder built from the prefix.
 */
export const sourceSnippets = (
	platform: SourcePlatform,
	token: string,
	name: string,
): ReadonlyArray<SourceSnippet> => {
	const serviceName = serviceNameOf(name)
	switch (platform) {
		case "kubernetes":
			return [
				{ id: "helm", label: "Helm", language: "shell", code: helmCommand(token), icon: "HelmIcon" },
				{
					id: "alchemy",
					label: `Alchemy ${ALCHEMY_FILE}`,
					language: "typescript",
					code: alchemyStack(),
					icon: "AlchemyIcon",
				},
				{
					id: "alchemy-deploy",
					label: "Alchemy deploy",
					language: "shell",
					code: alchemyDeployCommand(token),
					icon: "AlchemyIcon",
				},
				{
					id: "terraform",
					label: `Terraform ${TERRAFORM_FILE}`,
					language: "hcl",
					code: terraformConfig(),
					icon: "TerraformIcon",
				},
				{
					id: "terraform-apply",
					label: "Terraform apply",
					language: "shell",
					code: terraformApplyCommand(token),
					icon: "TerraformIcon",
				},
			]
		case "docker":
			return [{ id: "docker", label: "docker run", language: "shell", code: dockerCommand(token) }]
		case "host":
			return [
				{ id: "host-config", label: "config.yaml", language: "yaml", code: HOST_CONFIG },
				{ id: "host-run", label: "Run", language: "shell", code: hostCommand(token) },
			]
		case "browser":
			return [browserSnippet(token, serviceName)]
		case "claude_code":
			return [claudeCodeSnippet(token)]
		case "proxmox":
			return proxmoxSnippets(token)
		case "mongodb_atlas":
			return [atlasSnippet(token)]
		case "postgresql":
			return postgresSnippets(token)
		case "twilio":
			return [twilioSnippet(token)]
		case "opentelemetry":
		case "cloudflare_ai_gateway":
			return [envSnippet(token, serviceName), collectorSnippet(token)]
		default: {
			const sdk = sdkOf(platform)
			if (sdk === null) return [envSnippet(token, serviceName)]
			const needsHttp = sdk.env !== null && Str.includes(HTTP_PROTOCOL_LINE)(sdk.env.code)
			return [envSnippet(token, serviceName, needsHttp), ...setupSnippets(sdk, token)]
		}
	}
}

/** Stands in for the token once it can no longer be shown. */
export const maskedToken = (prefix: string | null): string =>
	`${prefix ?? "maple_src_"}${Str.repeat(16)("•")}`
