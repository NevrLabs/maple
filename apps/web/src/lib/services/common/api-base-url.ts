import { Option, Array as Arr, String as Str } from "effect"

const configuredApiBaseUrl = Option.map(
	Option.fromNullishOr(import.meta.env.VITE_API_BASE_URL),
	Str.trim,
).pipe(Option.getOrUndefined)

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

const configuredApiPublicUrl = Option.map(
	Option.fromNullishOr(import.meta.env.VITE_API_PUBLIC_URL),
	Str.trim,
).pipe(Option.getOrUndefined)

/** The API's real URL, for what users copy. `apiBaseUrl` can be the same-origin proxy. */
export const apiPublicUrl =
	configuredApiPublicUrl && configuredApiPublicUrl.length > 0
		? Str.replace(/\/$/, "")(configuredApiPublicUrl)
		: apiBaseUrl

const originOf = Option.liftThrowable((url: string) => new URL(url).origin)

/** The origins the API answers on: its own, and the proxy's when `apiBaseUrl` is same-origin. */
export const apiOrigins: ReadonlyArray<string> = Arr.flatMap([apiBaseUrl, apiPublicUrl], (url) =>
	Option.toArray(originOf(url)),
)
