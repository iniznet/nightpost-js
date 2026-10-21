/**
 * Transport-layer failure signatures (#186): a rejected upstream fetch with one
 * of these shapes is the expected signature of a deploy restart window or an
 * unreachable dependency — router traffic, not an unhandled defect — so the
 * reporter must not ship it as a monitor JSError issue. Outage visibility stays
 * with request profiles and timings.
 */
const TRANSPORT_ERROR_CODES = new Set([
	'ENOTFOUND',
	'EAI_AGAIN',
	'ECONNREFUSED',
	'ECONNRESET',
	'EHOSTUNREACH',
	'ENETUNREACH',
	'ETIMEDOUT',
	'UND_ERR_CONNECT_TIMEOUT',
	'UND_ERR_SOCKET',
	'UND_ERR_HEADERS_TIMEOUT',
	'UND_ERR_BODY_TIMEOUT'
]);

const TRANSPORT_MESSAGE_RE =
	/fetch failed|getaddrinfo|econn(refused|reset|aborted)|etimedout|socket connection was closed|unable to connect/i;

export function isTransportOutage(err: unknown): boolean {
	if (!(err instanceof Error)) {
		return false;
	}
	if (err.name === 'AbortError' || err.name === 'TimeoutError') {
		return true;
	}
	let cause: unknown = err;
	for (let depth = 0; cause instanceof Error && depth < 6; depth++) {
		const code = (cause as { code?: unknown }).code;
		if (typeof code === 'string' && TRANSPORT_ERROR_CODES.has(code)) {
			return true;
		}
		cause = (cause as Error).cause;
	}
	return TRANSPORT_MESSAGE_RE.test(err.message);
}
