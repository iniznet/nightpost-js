/**
 * Browser producer half (WIRE_SPEC v2, iniznet/nightpost#9): the entry hop of a
 * journey, and the one place an unhandled error has no server on the stack to
 * catch it. It reports exactly two things:
 *
 *   - one error event per unhandled error, carrying `service` and the
 *     normalised `route`, and
 *   - one session outcome beacon per page, POSTed to
 *     `/ingest/{project}/session`.
 *
 * No spans: the browser is the root of its own trace and child span reporting
 * belongs to the servers it calls. Nothing here blocks a navigation — the
 * beacon rides `navigator.sendBeacon` when the browser has it and a keepalive
 * fetch otherwise, and every payload stays inside the server's small body
 * limit.
 */
import type { EnvLike } from './env.js';
import { monitorEnabled, nv, readConfig } from './env.js';
import { post } from './client.js';
import { normaliseRoute } from './route.js';

export type SessionStatus = 'ok' | 'crashed' | 'abnormal';

/** The slice of `location` a payload needs; injected so the core stays DOM-free. */
export interface PageLocation {
	origin?: string;
	pathname?: string;
}

/** `POST /ingest/{project}/error`: v1 fields plus the v2 identity (service, route). */
export interface BrowserErrorPayload {
	message: string;
	stack?: string;
	url: string;
	route: string;
	service: string;
	environment?: string;
	release?: string;
	user_id?: string;
}

/** `POST /ingest/{project}/session`: one page load and how it ended. */
export interface SessionPayload {
	session_id: string;
	release?: string;
	status: SessionStatus;
	route: string;
	duration_ms: number;
	service: string;
}

export interface ErrorInput {
	message: string;
	stack?: string;
	environment?: string;
	release?: string;
	userId?: string;
	location?: PageLocation | null;
}

export interface SessionInput {
	session_id: string;
	status: SessionStatus;
	route: string;
	duration_ms: number;
	release?: string;
	service?: string;
	origin?: string;
}

/** The page's own location, or null where there is no page (SSR, a worker). */
export function currentLocation(): PageLocation | null {
	const loc = (globalThis as unknown as { location?: PageLocation }).location;
	return loc && typeof loc.pathname === 'string' ? loc : null;
}

/**
 * The producer identity the journey names this hop by: `NIGHTPOST_SERVICE`
 * when configured, else the label of the origin the script was served from,
 * else the project key — never the raw URL and never a reader identifier.
 */
export function serviceLabel(env: EnvLike, origin?: string): string {
	const configured = nv(env, 'SERVICE')?.trim();
	if (configured) {
		return configured;
	}
	return hostLabel(origin) ?? readConfig(env).projectKey;
}

/** The error event's payload, or null when there is nothing the server would accept. */
export function errorPayload(env: EnvLike, input: ErrorInput): BrowserErrorPayload | null {
	const message = input.message.trim();
	if (message === '') {
		return null;
	}
	const loc = input.location ?? currentLocation();
	const pathname = loc?.pathname ?? '/';
	const origin = (loc?.origin ?? '').replace(/\/+$/, '');
	const payload: BrowserErrorPayload = {
		message,
		// The query string and fragment are dropped: a token or an id in either
		// is exactly what a telemetry payload must not carry.
		url: `${origin}${pathname}`,
		route: normaliseRoute(pathname),
		service: serviceLabel(env, origin)
	};
	if (input.stack) payload.stack = input.stack;
	if (input.environment) payload.environment = input.environment;
	if (input.release) payload.release = input.release;
	if (input.userId) payload.user_id = input.userId;
	return payload;
}

/** Ship one unhandled error; returns the payload it sent, or null when the module is inert. */
export function reportBrowserError(env: EnvLike, input: ErrorInput): BrowserErrorPayload | null {
	if (!monitorEnabled(env)) {
		return null;
	}
	const payload = errorPayload(env, input);
	if (payload === null) {
		return null;
	}
	post(env, `/ingest/${encodeURIComponent(readConfig(env).projectKey)}/error`, payload);
	return payload;
}

/**
 * The beacon body. Key order follows the wire spec so a captured body reads the
 * way the vectors do; an absent release is omitted, not sent empty, and a
 * negative or fractional duration is repaired here rather than refused there.
 */
export function sessionPayload(env: EnvLike, input: SessionInput): SessionPayload {
	const release = input.release?.trim();
	return {
		session_id: input.session_id,
		...(release ? { release } : {}),
		status: input.status,
		route: normaliseRoute(input.route),
		duration_ms: Math.max(0, Math.round(input.duration_ms)),
		service: input.service ?? serviceLabel(env, input.origin)
	};
}

/**
 * Fire-and-forget POST that survives the page going away: `sendBeacon` where
 * the browser has it (a queued request the unload cannot cancel), a keepalive
 * fetch where it does not. Returns false only when the module is inert.
 */
export function beacon(env: EnvLike, path: string, payload: unknown): boolean {
	const base = nv(env, 'URL');
	if (!base) {
		return false;
	}
	const url = `${base.replace(/\/+$/, '')}${path}`;
	const body = JSON.stringify(payload);
	const navigatorRef = (globalThis as unknown as BeaconNavigator).navigator;
	if (navigatorRef?.sendBeacon) {
		try {
			// A Blob carries the JSON content type; a bare string arrives as text/plain.
			if (navigatorRef.sendBeacon(url, new Blob([body], { type: 'application/json' }))) {
				return true;
			}
		} catch {
			// A full queue or a hostile sendBeacon: the fetch leg still runs.
		}
	}
	void fetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(nv(env, 'KEY') ? { 'x-monitor-key': nv(env, 'KEY') } : {})
		},
		body,
		// Never awaited: the page is leaving and a beacon must not hold it.
		keepalive: true
	}).catch(() => {
		// Telemetry is best-effort, exactly like post().
	});
	return true;
}

interface BeaconNavigator {
	navigator?: { sendBeacon?: (url: string, body: Blob) => boolean };
}

const SESSION_ID_KEY = 'nightpost_session_id';

/** The subset of `sessionStorage` a session needs. */
export interface SessionStorageLike {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/**
 * The tab's session id: random, minted once, kept in sessionStorage so every
 * page load of one tab reports the same session. It is the producer's own key —
 * never a reader identity — so a storage-disabled page falls back to a
 * per-page id and stays a valid session.
 */
export function sessionId(storage?: SessionStorageLike | null, mint: () => string = mintId): string {
	if (!storage) {
		return mint();
	}
	try {
		const existing = storage.getItem(SESSION_ID_KEY);
		if (existing) {
			return existing;
		}
		const minted = mint();
		storage.setItem(SESSION_ID_KEY, minted);
		return minted;
	} catch {
		return mint();
	}
}

function mintId(): string {
	const cryptoRef = (globalThis as unknown as { crypto?: { randomUUID?: () => string } }).crypto;
	if (typeof cryptoRef?.randomUUID === 'function') {
		return cryptoRef.randomUUID();
	}
	// An insecure origin has no randomUUID; a session key is not a secret.
	return `s${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export interface SessionOptions {
	env: EnvLike;
	release?: string;
	location?: PageLocation | null;
	storage?: SessionStorageLike | null;
	now?: () => number;
}

/**
 * One page load's outcome. The transitions the wire spec's vocabulary names:
 * `ready()` when the navigation completed, `crashed()` when the page reported
 * an unhandled error or rejection, and `end()` at unload — a page that ends
 * without ever completing its navigation is `abnormal`.
 */
export interface Session {
	readonly id: string;
	readonly status: SessionStatus;
	crashed(): void;
	ready(): void;
	end(): SessionPayload;
}

export function createSession(options: SessionOptions): Session {
	const now = options.now ?? (() => performance.now());
	const startedAt = now();
	const loc = options.location ?? currentLocation();
	const route = normaliseRoute(loc?.pathname ?? '');
	const id = sessionId(options.storage);
	let completed = false;
	let fatal = false;

	const status = (): SessionStatus => (fatal ? 'crashed' : completed ? 'ok' : 'abnormal');

	return {
		id,
		get status(): SessionStatus {
			return status();
		},
		crashed(): void {
			fatal = true;
		},
		ready(): void {
			completed = true;
		},
		end(): SessionPayload {
			const payload = sessionPayload(options.env, {
				session_id: id,
				status: status(),
				route,
				duration_ms: now() - startedAt,
				release: options.release,
				origin: loc?.origin
			});
			beacon(options.env, sessionPath(options.env), payload);
			return payload;
		}
	};
}

/** The page surface a session needs; `window` is one. */
export interface PageWindow {
	addEventListener(type: string, listener: () => void): void;
	location?: PageLocation;
	sessionStorage?: SessionStorageLike | null;
}

export interface InstallOptions {
	release?: string;
	now?: () => number;
}

/**
 * Wire the beacon to the page: `load` completes the navigation, an unhandled
 * `error` or `unhandledrejection` marks it crashed, `pagehide` sends the
 * outcome. Returns null where there is no page or the module is unconfigured,
 * so an unconfigured install is inert rather than noisy.
 */
export function installSession(
	env: EnvLike,
	win?: PageWindow | null,
	options: InstallOptions = {}
): Session | null {
	const page = win === undefined ? pageWindow() : win;
	if (!page || !monitorEnabled(env)) {
		return null;
	}
	const session = createSession({
		env,
		release: options.release,
		location: page.location ?? null,
		storage: page.sessionStorage ?? null,
		now: options.now
	});
	page.addEventListener('load', () => session.ready());
	page.addEventListener('error', () => session.crashed());
	page.addEventListener('unhandledrejection', () => session.crashed());
	page.addEventListener('pagehide', () => {
		session.end();
	});
	return session;
}

function pageWindow(): PageWindow | null {
	const win = globalThis as unknown as { addEventListener?: unknown };
	return typeof win?.addEventListener === 'function' ? (win as unknown as PageWindow) : null;
}

function sessionPath(env: EnvLike): string {
	return `/ingest/${encodeURIComponent(readConfig(env).projectKey)}/session`;
}

function hostLabel(origin?: string): string | undefined {
	if (!origin) {
		return undefined;
	}
	try {
		return new URL(origin).host || undefined;
	} catch {
		return undefined;
	}
}
