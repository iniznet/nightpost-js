/**
 * Cross-service trace context (#171): the caller mints one per sampled
 * request and runs the whole render pipeline inside it, so downstream fetches
 * can stamp the trace headers and record elapsed spans without threading a
 * parameter through every handler.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

export interface MonitorSpan {
	name: string;
	duration_ms: number;
	start_ms: number;
	tags?: Record<string, string | number>;
}

export interface MonitorTrace {
	id: string;
	startedAt: number;
	spans: MonitorSpan[];
}

const traceStorage = new AsyncLocalStorage<MonitorTrace>();

/** Mint a trace id + context at request start. Random per request — never derived from identity. */
export function mintTrace(): MonitorTrace {
	return { id: crypto.randomUUID(), startedAt: performance.now(), spans: [] };
}

/** Run the request pipeline inside the trace's async context. */
export function runWithTrace<T>(trace: MonitorTrace, fn: () => T | Promise<T>): Promise<T> {
	return Promise.resolve(traceStorage.run(trace, fn));
}

/** The active trace for this async context, if the request was sampled. */
export function currentTrace(): MonitorTrace | undefined {
	return traceStorage.getStore();
}

/** Record one elapsed span (offsets from the request start, same clock as the trace). */
export function recordTraceSpan(
	name: string,
	startMs: number,
	durationMs: number,
	tags?: Record<string, string | number>
): void {
	const trace = traceStorage.getStore();
	if (!trace) {
		return;
	}
	trace.spans.push({
		name,
		duration_ms: Math.round(durationMs * 100) / 100,
		start_ms: Math.round(startMs * 100) / 100,
		tags
	});
}

/** The outbound headers that tell the backend "this request is a sampled trace". */
export function tracePropagationHeaders(): Record<string, string> {
	const trace = traceStorage.getStore();
	if (!trace) {
		return {};
	}
	return { 'x-monitor-trace-id': trace.id, 'x-monitor-profiled': '1' };
}
