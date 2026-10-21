/**
 * Fire-and-forget HTTP POST for the Nightpost ingest endpoints. Transport is
 * the caller's own fetch (Node 18+ global); every send is bounded by a 1s
 * timeout and swallow-on-failure — an unreachable monitor is never a request
 * error.
 */
import type { EnvLike } from './env.js';
import { nv } from './env.js';

export function post(env: EnvLike, path: string, payload: unknown): void {
	const url = `${(nv(env, 'URL') ?? '').replace(/\/+$/, '')}${path}`;
	void fetch(url, {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			// Per-project ingest key from the monitor's /keys page (#198).
			// Omitted while the project is unsigned (legacy admission).
			...(nv(env, 'KEY') ? { 'x-monitor-key': nv(env, 'KEY') } : {})
		},
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(1000)
	}).catch(() => {
		// Telemetry is best-effort: an unreachable monitor is not a request error.
	});
}
