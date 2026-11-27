import {
	ANTHROPIC_COST_KEY_MAX_LENGTH,
	CLOUDFLARE_COST_TOKEN_MAX_LENGTH,
	MONGODB_COST_CREDENTIAL_MAX_LENGTH,
	TWILIO_COST_CREDENTIAL_MAX_LENGTH,
	MORPH_COST_KEY_MAX_LENGTH,
	OPENAI_COST_KEY_MAX_LENGTH,
	OPENROUTER_KEY_MAX_LENGTH,
} from "@maple/domain/http"
import type { Command } from "foldkit"
import type { Resources } from "../../platform/resources"
import {
	RemoveAnthropicCostKey,
	RemoveCloudflareCostToken,
	RemoveMorphCostKey,
	RemoveMongodbCostCredential,
	RemoveTwilioCostCredential,
	RemoveOpenAiCostKey,
	RemoveOpenRouterCostKey,
	SaveAnthropicCostKey,
	SaveCloudflareCostToken,
	SaveMorphCostKey,
	SaveMongodbCostCredential,
	SaveTwilioCostCredential,
	SaveOpenAiCostKey,
	SaveOpenRouterCostKey,
} from "./command"
import type { Message } from "./message"
import type { CredentialProvider } from "./providers"

type Cmd = Command.Command<Message, never, Resources>

/**
 * Cloudflare's "Create Token" page with the name filled in and one permission ticked, Account >
 * Billing > Read. It starts on all accounts: the reader still picks the one.
 */
const CLOUDFLARE_BILLING_TOKEN_URL =
	"https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=%5B%7B%22key%22%3A%22billing%22%2C%22type%22%3A%22read%22%7D%5D&name=Maple%20cost%20source%20%28billing%20read%29&accountId=*&zoneId=all"

/**
 * A cost source added by pasting a credential: everything its dialog steps, its Sources row and
 * its toasts say, and the commands that save and remove it. The form itself is shared.
 */
/** What adding a provider read back three months brings in, as the sync profile serves it. */
const THREE_MONTHS_ADD =
	"Maple reads this month and the last at once, then the two months before, and every day from here on."

export type CredentialSource = Readonly<{
	/** The line under the provider's name in the list, and once its source exists. */
	pick: Readonly<{ meta: string; addedMeta: string }>
	field: Readonly<{
		label: string
		placeholder: string
		maxLength: number
		/** Shown when the text is longer than `maxLength`, which the request would refuse to carry. */
		tooLong: string
		/** The help under the field: `before`, a link to where the credential is made, then `after`. */
		help: Readonly<{ before: string; link: string; href: string; after: string }>
	}>
	add: Readonly<{ title: string; description: string; toast: string }>
	replace: Readonly<{
		title: string
		description: string
		/** The Sources row's action and the form's submit. */
		label: string
		toast: string
	}>
	remove: Readonly<{ title: string; description: string }>
	save: (secret: string) => Cmd
	delete: () => Cmd
}>

export const CREDENTIAL_SOURCES = {
	openrouter: {
		pick: {
			meta: "Daily spend by model and serving provider",
			addedMeta: "Replace its key in the Sources panel",
		},
		field: {
			label: "Management key",
			placeholder: "sk-or-v1-...",
			maxLength: OPENROUTER_KEY_MAX_LENGTH,
			tooLong: "That is too long to be an OpenRouter key.",
			help: {
				before: "Create one under ",
				link: "Management keys",
				href: "https://openrouter.ai/settings/management-keys",
				after: " in OpenRouter. A regular API key cannot read spend. Maple checks the key with OpenRouter, then stores it encrypted.",
			},
		},
		add: {
			title: "Add OpenRouter",
			description: "Maple reads the last four weeks at once, then every day from here on.",
			toast: "OpenRouter added",
		},
		replace: {
			title: "Replace the OpenRouter key",
			description: "The source and its history stay. Use a key from the same OpenRouter account.",
			label: "Replace key",
			toast: "OpenRouter key replaced",
		},
		remove: {
			title: "Remove the OpenRouter source?",
			description:
				"Maple deletes the key and stops reading the account's spend, and its cost leaves this page. Adding OpenRouter again brings back the last four weeks only.",
		},
		save: (apiKey) => SaveOpenRouterCostKey({ apiKey }),
		delete: () => RemoveOpenRouterCostKey(),
	},
	cloudflare: {
		pick: {
			meta: "Daily charges by product, plus plan fees",
			addedMeta: "Replace its token in the Sources panel",
		},
		field: {
			label: "API token",
			placeholder: "Cloudflare API token",
			maxLength: CLOUDFLARE_COST_TOKEN_MAX_LENGTH,
			tooLong: "That is too long to be a Cloudflare API token.",
			help: {
				before: "",
				link: "Create a token with only Billing: Read",
				href: CLOUDFLARE_BILLING_TOKEN_URL,
				after: " in Cloudflare. Under Account Resources pick the one account, set an expiry if you want one, then create it and paste it here. Maple refuses a token it finds can read more than billing, then stores it encrypted.",
			},
		},
		add: {
			title: "Add Cloudflare",
			description:
				"Maple reads this month and the last at once, then older months back to a year, and every day from here on.",
			toast: "Cloudflare added",
		},
		replace: {
			title: "Replace the Cloudflare token",
			description: "The source and its history stay. Use a token for the same Cloudflare account.",
			label: "Replace token",
			toast: "Cloudflare token replaced",
		},
		remove: {
			title: "Remove the Cloudflare source?",
			description:
				"Maple deletes the token and stops reading the account's charges, and its cost leaves this page. Adding Cloudflare again reads the last year again.",
		},
		save: (apiToken) => SaveCloudflareCostToken({ apiToken }),
		delete: () => RemoveCloudflareCostToken(),
	},
	// Neither vendor offers a key that reads only cost, so the help says what the key can do.
	anthropic: {
		pick: {
			meta: "Daily API spend by model and workspace",
			addedMeta: "Replace its key in the Sources panel",
		},
		field: {
			label: "Admin API key",
			placeholder: "sk-ant-admin...",
			maxLength: ANTHROPIC_COST_KEY_MAX_LENGTH,
			tooLong: "That is too long to be an Anthropic Admin API key.",
			help: {
				before: "Create one under ",
				link: "Admin keys",
				href: "https://platform.claude.com/settings/admin-keys",
				after: " in the Claude Console. Anthropic has no read-only admin key, so this one can also manage your organization: Maple only reads its cost report and name with it, and stores it encrypted. Make one just for Maple so you can revoke it on its own.",
			},
		},
		add: {
			title: "Add Anthropic",
			description: THREE_MONTHS_ADD,
			toast: "Anthropic added",
		},
		replace: {
			title: "Replace the Anthropic key",
			description: "The source and its history stay. Use a key from the same Anthropic organization.",
			label: "Replace key",
			toast: "Anthropic key replaced",
		},
		remove: {
			title: "Remove the Anthropic source?",
			description:
				"Maple deletes the key and stops reading the organization's spend, and its cost leaves this page. Revoke the key in the Claude Console too if nothing else uses it.",
		},
		save: (apiKey) => SaveAnthropicCostKey({ apiKey }),
		delete: () => RemoveAnthropicCostKey(),
	},
	openai: {
		pick: {
			meta: "Daily API spend by model and project",
			addedMeta: "Replace its key in the Sources panel",
		},
		field: {
			label: "Admin API key",
			placeholder: "sk-admin-...",
			maxLength: OPENAI_COST_KEY_MAX_LENGTH,
			tooLong: "That is too long to be an OpenAI Admin API key.",
			help: {
				before: "Create one under ",
				link: "Admin keys",
				href: "https://platform.openai.com/settings/organization/admin-keys",
				after: " in OpenAI. A project API key cannot read spend, and OpenAI has no read-only admin key, so this one can also manage your organization: Maple only reads its costs with it, and stores it encrypted. Make one just for Maple so you can revoke it on its own.",
			},
		},
		add: {
			title: "Add OpenAI",
			description: THREE_MONTHS_ADD,
			toast: "OpenAI added",
		},
		replace: {
			title: "Replace the OpenAI key",
			description: "The source and its history stay. Use a key from the same OpenAI organization.",
			label: "Replace key",
			toast: "OpenAI key replaced",
		},
		remove: {
			title: "Remove the OpenAI source?",
			description:
				"Maple deletes the key and stops reading the organization's spend, and its cost leaves this page. Revoke the key in OpenAI too if nothing else uses it.",
		},
		save: (apiKey) => SaveOpenAiCostKey({ apiKey }),
		delete: () => RemoveOpenAiCostKey(),
	},
	morph: {
		pick: {
			meta: "Daily spend by model",
			addedMeta: "Replace its key in the Sources panel",
		},
		field: {
			label: "API key",
			placeholder: "sk-...",
			maxLength: MORPH_COST_KEY_MAX_LENGTH,
			tooLong: "That is too long to be a Morph API key.",
			help: {
				before: "Create one under ",
				link: "API keys",
				href: "https://www.morphllm.com/dashboard/api-keys",
				after: " in Morph. A key of your organization reads the organization's spend, a personal key your own. Morph has no read-only key, so this one can also run models: Maple only reads spend with it, and stores it encrypted.",
			},
		},
		add: {
			title: "Add Morph",
			description: THREE_MONTHS_ADD,
			toast: "Morph added",
		},
		replace: {
			title: "Replace the Morph key",
			description: "The source and its history stay. Use a key of the same Morph account.",
			label: "Replace key",
			toast: "Morph key replaced",
		},
		remove: {
			title: "Remove the Morph source?",
			description:
				"Maple deletes the key and the spend it has read, and its cost leaves this page. Morph keeps no history, so adding it again starts from that day. Revoke the key in Morph too if nothing else uses it.",
		},
		save: (apiKey) => SaveMorphCostKey({ apiKey }),
		delete: () => RemoveMorphCostKey(),
	},
	mongodb: {
		pick: {
			meta: "Daily charges by cluster and project",
			addedMeta: "Replace its service account in the Sources panel",
		},
		field: {
			label: "Service account",
			placeholder: "client ID and secret, separated by a space",
			maxLength: MONGODB_COST_CREDENTIAL_MAX_LENGTH,
			tooLong: "That is too long to be a service account's client ID and secret.",
			help: {
				before: "Create one under ",
				link: "Organization Service Accounts",
				href: "https://cloud.mongodb.com/v2#/org/settings/serviceAccounts",
				after: " in MongoDB Atlas with the Organization Billing Viewer role, and add Maple's address to its API access list. Copy its client ID and secret into this field, separated by a space. Maple checks the account with MongoDB Atlas, then stores it encrypted.",
			},
		},
		add: {
			title: "Add MongoDB Atlas",
			description:
				"Maple reads this month's invoice and the last, then the ten months before, and every day from here on.",
			toast: "MongoDB Atlas added",
		},
		replace: {
			title: "Replace the MongoDB Atlas service account",
			description:
				"The source and its history stay. Use a service account of the same MongoDB Atlas organization.",
			label: "Replace service account",
			toast: "MongoDB Atlas service account replaced",
		},
		remove: {
			title: "Remove the MongoDB Atlas source?",
			description:
				"Maple deletes the service account and stops reading the organization's charges, and its cost leaves this page. Adding MongoDB Atlas again brings back the last twelve months only. Revoke the service account in MongoDB Atlas too if nothing else uses it.",
		},
		save: (credential) => SaveMongodbCostCredential({ credential }),
		delete: () => RemoveMongodbCostCredential(),
	},
	twilio: {
		pick: {
			meta: "Daily charges by product category",
			addedMeta: "Replace its credentials in the Sources panel",
		},
		field: {
			label: "Account SID and auth token",
			placeholder: "Account SID and auth token, separated by a space",
			maxLength: TWILIO_COST_CREDENTIAL_MAX_LENGTH,
			tooLong: "That is too long to be an Account SID and auth token.",
			help: {
				before: "Copy both from the Account Info box of the ",
				link: "Twilio Console",
				href: "https://console.twilio.com/",
				after: " into this field, Account SID first, separated by a space. Maple checks the account and reads one day of its usage records, then stores the credential encrypted.",
			},
		},
		add: {
			title: "Add Twilio",
			description:
				"Maple reads this month's usage records and the last, then the ten months before, and every day from here on.",
			toast: "Twilio added",
		},
		replace: {
			title: "Replace the Twilio credential",
			description:
				"The source and its history stay. Use the Account SID and auth token of the same Twilio account.",
			label: "Replace credential",
			toast: "Twilio credential replaced",
		},
		remove: {
			title: "Remove the Twilio source?",
			description:
				"Maple deletes the credential and stops reading the account's usage records, and its cost leaves this page. Adding Twilio again brings back the last twelve months only.",
		},
		save: (credential) => SaveTwilioCostCredential({ credential }),
		delete: () => RemoveTwilioCostCredential(),
	},
} satisfies Record<CredentialProvider, CredentialSource>
