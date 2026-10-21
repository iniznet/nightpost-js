import { Session } from 'node:inspector';
import { promisify } from 'node:util';

/**
 * V8 sampling-profiler capture for code-level attribution (#145 Increment 6).
 *
 * The Node inspector Session is started before `resolve()` and stopped after
 * the response is built, ONLY on the deep-profiled fraction of requests
 * (MONITOR_PROFILE_RATE, default 0.5%) — never blanket-on. Nodes are folded
 * into per-function self time exactly like the xhprof ingest folds edges:
 * hitCount is self samples; self_ms is allocated from the profile's total
 * duration proportionally to hitCount.
 */

export interface V8Profile {
	nodes: Array<{
		id: number;
		callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
		hitCount: number;
		children?: number[];
	}>;
	samples?: number[];
	timeDeltas?: number[];
}

/** Wire shape the monitor stores as profiles.tree (#181) — mirrors store.TreeNode. */
export interface TreeNode {
	n: string;
	s: number;
	i: number;
	c?: number;
	k?: TreeNode[];
}

interface ActiveProfile {
	session: Session;
	startedAt: number;
}

export async function startV8Profile(): Promise<ActiveProfile | null> {
	try {
		const session = new Session();
		const post = promisify(session.post.bind(session)) as (m: string) => Promise<unknown>;
		session.connect();
		await post('Profiler.enable');
		await post('Profiler.start');
		return { session, startedAt: performance.now() };
	} catch {
		// Profiling is best-effort; the inspector may be unavailable.
		return null;
	}
}

export async function stopV8Profile(
	active: ActiveProfile | null,
	durationMs: number
): Promise<{ hotspots: HotspotLike[]; tree: TreeNode[] }> {
	if (!active) return { hotspots: [], tree: [] };
	try {
		const post = promisify(active.session.post.bind(active.session)) as unknown as (
			m: string
		) => Promise<{ profile: V8Profile }>;
		const { profile } = await post('Profiler.stop');
		return { hotspots: collapseNodes(profile, durationMs), tree: buildV8Tree(profile, durationMs) };
	} catch {
		return { hotspots: [], tree: [] };
	} finally {
		try {
			active.session.disconnect();
		} catch {
			/* already disconnected */
		}
	}
}

export interface HotspotLike {
	function: string;
	file?: string;
	self_ms: number;
}

/**
 * Pure folding of a V8 CPU profile into top-N hotspots. Exported for tests.
 * Self time = hitCount share of the profile duration; file derived from the
 * call frame URL (stripping protocol + query), never throwing.
 */
export function collapseNodes(profile: V8Profile, durationMs: number, topN = 50): HotspotLike[] {
	const totalHits = profile.nodes.reduce((sum, n) => sum + (n.hitCount || 0), 0);
	if (totalHits === 0 || durationMs <= 0) return [];

	const msPerHit = durationMs / totalHits;
	const rows = profile.nodes
		.filter((n) => n.hitCount > 0 && n.callFrame.functionName)
		.map((n) => ({
			function: n.callFrame.functionName,
			file: fileFromUrl(n.callFrame.url),
			self_ms: Math.round(n.hitCount * msPerHit * 100) / 100
		}))
		.filter((h) => h.self_ms > 0)
		.sort((a, b) => b.self_ms - a.self_ms)
		.slice(0, topN);

	return rows;
}

const TREE_MAX_DEPTH = 12;
const TREE_MAX_CHILDREN = 20;
const TREE_MIN_ABS_MS = 2;

/**
 * Pure reconstruction of a pruned call tree from a V8 CPU profile (#181).
 * Inclusive time = subtree hitCount share of the duration (sampling
 * approximation, not timestamps); below-floor subtrees fold silently into the
 * parent's self, wide tails collapse into an "(other xN)" bucket, depth is
 * capped — the same shape and caps the monitor enforces server-side.
 * Exported for tests.
 */
export function buildV8Tree(profile: V8Profile, durationMs: number): TreeNode[] {
	const totalHits = profile.nodes.reduce((sum, n) => sum + (n.hitCount || 0), 0);
	if (totalHits === 0 || durationMs <= 0) return [];
	const byId = new Map(profile.nodes.map((n) => [n.id, n]));
	const msPerHit = durationMs / totalHits;
	const floor = Math.max(durationMs / 100, TREE_MIN_ABS_MS);

	const inclCache = new Map<number, number>();
	const inclHits = (id: number, seen: Set<number>): number => {
		const cached = inclCache.get(id);
		if (cached !== undefined) return cached;
		const node = byId.get(id);
		if (!node || seen.has(id)) return 0;
		seen.add(id);
		let sum = node.hitCount || 0;
		for (const child of node.children ?? []) sum += inclHits(child, seen);
		seen.delete(id);
		inclCache.set(id, sum);
		return sum;
	};

	const referenced = new Set<number>();
	for (const n of profile.nodes) for (const c of n.children ?? []) referenced.add(c);
	const roots = profile.nodes.filter((n) => !referenced.has(n.id));

	const expand = (node: (typeof profile.nodes)[number], depth: number): TreeNode => {
		const incl = inclHits(node.id, new Set()) * msPerHit;
		const name =
			node.callFrame.functionName ||
			(fileFromUrl(node.callFrame.url)
				? `${fileFromUrl(node.callFrame.url)}:${node.callFrame.lineNumber}`
				: '(anonymous)');
		if (depth >= TREE_MAX_DEPTH) {
			return { n: name, s: round2(incl), i: round2(incl) };
		}
		const kids = (node.children ?? [])
			.map((id) => byId.get(id))
			.filter((k): k is (typeof profile.nodes)[number] => k !== undefined)
			.sort((a, b) => inclHits(b.id, new Set()) - inclHits(a.id, new Set()));
		const kept: TreeNode[] = [];
		let widthMs = 0;
		let widthCalls = 0;
		let widthCount = 0;
		let selfMs = (node.hitCount || 0) * msPerHit;
		kids.forEach((k, i) => {
			const kIncl = inclHits(k.id, new Set()) * msPerHit;
			if (i >= TREE_MAX_CHILDREN) {
				widthMs += kIncl;
				widthCalls += k.hitCount || 0;
				widthCount++;
			} else if (kIncl < floor) {
				selfMs += kIncl;
			} else {
				kept.push(expand(k, depth + 1));
			}
		});
		if (widthCount > 0) {
			kept.push({
				n: `(other x${widthCount})`,
				s: round2(widthMs),
				i: round2(widthMs),
				c: widthCalls
			});
		}
		const out: TreeNode = { n: name, s: round2(selfMs), i: round2(incl) };
		if (kept.length) out.k = kept;
		return out;
	};

	return roots.map((r) => expand(r, 0)).filter((t) => t.i >= floor || (t.k && t.k.length > 0));
}

function round2(v: number): number {
	return Math.round(v * 100) / 100;
}

function fileFromUrl(url: string): string | undefined {
	if (!url) return undefined;
	try {
		return url.replace(/^file:\/\//, '').split('?')[0] || undefined;
	} catch {
		return undefined;
	}
}
