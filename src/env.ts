/**
 * Environment config for the Nightpost JS reporter (github.com/iniznet/nightpost).
 *
 * Same posture as Sentry SDKs and the Laravel MonitorClient: capture in
 * process, serialize, ship fire-and-forget to a dedicated ingest. Nothing
 * here ever blocks or breaks a request — with the URL unset the module is
 * inert.
 *
 * Dual-read (iniznet/fenrirealm-tracker#278 §3): the product namespace
 * NIGHTPOST_* wins, the original MONITOR_* leg keeps working, so an existing
 * install never needs a coordinated env cutover.
 */

export type EnvLike = Record<string, string | undefined>;

export interface MonitorConfig {
	url: string;
	projectKey: string;
	ingestKey: string;
	sampleRate: number;
	profileRate: number;
	forcedDeepCap: number;
}

export function nv(env: EnvLike, name: string): string | undefined {
	return env[`NIGHTPOST_${name}`] ?? env[`MONITOR_${name}`];
}

export function readConfig(env: EnvLike): MonitorConfig {
	return {
		url: (nv(env, 'URL') ?? '').replace(/\/+$/, ''),
		projectKey: nv(env, 'PROJECT_KEY') ?? 'front',
		ingestKey: nv(env, 'KEY') ?? '',
		sampleRate: Number(nv(env, 'SAMPLE_RATE') ?? '0.05'),
		profileRate: Number(nv(env, 'PROFILE_RATE') ?? '0.005'),
		forcedDeepCap: Number(nv(env, 'FORCED_DEEP_CAP') ?? '2')
	};
}

export function monitorEnabled(env: EnvLike): boolean {
	return readConfig(env).url !== '';
}

export function shouldSample(env: EnvLike): boolean {
	const rate = readConfig(env).sampleRate;
	return Number.isFinite(rate) && Math.random() < rate;
}

export function shouldProfile(env: EnvLike): boolean {
	const rate = readConfig(env).profileRate;
	return Number.isFinite(rate) && Math.random() < rate;
}

// #181: a sampled SSR request also force-starts the V8 callgraph (so every
// trace carries a stack tree) bounded by an in-process per-minute ceiling —
// the inspector overhead rides the ENTRY's decision, never blanket-on.
let deepMinute = -1;
let deepCount = 0;

export function forcedDeepAllowed(env: EnvLike): boolean {
	const cap = readConfig(env).forcedDeepCap;
	if (!Number.isFinite(cap) || cap <= 0) return false;
	const minute = Math.floor(Date.now() / 60000);
	if (minute !== deepMinute) {
		deepMinute = minute;
		deepCount = 0;
	}
	if (deepCount >= cap) return false;
	deepCount++;
	return true;
}
