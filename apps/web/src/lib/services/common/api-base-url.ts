import { Option } from "effect"

const configuredApiBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim()

/**
 * selfhost (PATCHES.md #2): a path-only value (`/_api`) resolves against the page's origin at
 * runtime, so one web image serves every hostname behind a same-origin proxy.
 */
const sameOrigin = (url: string): string =>
	url.startsWith("/") && typeof globalThis.location !== "undefined" ? `${globalThis.location.origin}${url}` : url


export const apiBaseUrl =
	configuredApiBaseUrl && configuredApiBaseUrl.length > 0
		? sameOrigin(configuredApiBaseUrl).replace(/\/$/, "")
		: "http://127.0.0.1:3472"

const configuredApiPublicUrl = import.meta.env.VITE_API_PUBLIC_URL?.trim()

/** The API's real URL, for what users copy. `apiBaseUrl` can be the same-origin proxy. */
export const apiPublicUrl =
	configuredApiPublicUrl && configuredApiPublicUrl.length > 0
		? configuredApiPublicUrl.replace(/\/$/, "")
		: apiBaseUrl

const originOf = Option.liftThrowable((url: string) => new URL(url).origin)

/** The origins the API answers on: its own, and the proxy's when `apiBaseUrl` is same-origin. */
export const apiOrigins: ReadonlyArray<string> = [apiBaseUrl, apiPublicUrl].flatMap((url) =>
	Option.toArray(originOf(url)),
)
