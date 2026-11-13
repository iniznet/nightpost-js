/**
 * Route PATTERNS for the browser producer (WIRE_SPEC v2 `route`, iniznet/nightpost#9).
 *
 * An issue, a slow endpoint and a session group by the route that produced
 * them, never by the row a reader happened to request: `/chapters/1` and
 * `/chapters/2` are one route, so one defect is one issue and one endpoint is
 * one chart line. The value is derived from `location`, so what leaves the
 * page is the pattern and not the URL the reader was on.
 */

/** What a collapsed dynamic segment becomes; the server stores this verbatim. */
export const ID_PLACEHOLDER = '[id]';

/**
 * Segments that carry an opaque row identity rather than a route's own word.
 * Deliberately narrow: a false positive merges two real routes, so a plain
 * slug (`/tags/fantasy`) stays as it is.
 */
const ID_SEGMENT = [
	/^\d+$/, // /chapters/7
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, // uuid
	/^[0-9a-f]{8,}$/i, // hex key or short sha
	/^[0-9A-HJKMNP-TV-Z]{26}$/, // ulid
	/^[a-z][a-z-]*-\d+$/i // chapter-12, a slug carrying the row's number
];

/** Past this the server refuses a session payload, so the route is capped here. */
export const MAX_ROUTE_LENGTH = 255;

const BASE = 'http://nightpost.invalid';

/**
 * Normalise a path, a relative href or an absolute URL into a route pattern:
 * no origin, no query, no fragment, one trailing-slash form, ids collapsed.
 * Idempotent — a pattern already normalised comes back unchanged.
 */
export function normaliseRoute(input: string): string {
	const segments = pathname(input).split('/').filter((segment) => segment !== '');
	if (segments.length === 0) {
		return '/';
	}
	const route = `/${segments.map(collapseSegment).join('/')}`;
	return route.length > MAX_ROUTE_LENGTH ? route.slice(0, MAX_ROUTE_LENGTH) : route;
}

function pathname(input: string): string {
	const raw = input.split('#')[0] ?? '';
	try {
		return new URL(raw, BASE).pathname;
	} catch {
		return raw.split('?')[0] ?? '';
	}
}

function collapseSegment(segment: string): string {
	const word = decode(segment);
	return ID_SEGMENT.some((pattern) => pattern.test(word)) ? ID_PLACEHOLDER : word;
}

function decode(segment: string): string {
	try {
		// Decode before matching, so an encoded id is still recognised as one.
		return decodeURIComponent(segment);
	} catch {
		return segment;
	}
}
