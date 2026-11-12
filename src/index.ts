/**
 * @nightpost/js — the environment-agnostic core of the Nightpost JS reporter:
 * config, transport, trace context, transport-outage classification, the V8
 * sampling profiler and the browser producer (route patterns, the error event
 * and the session beacon). Framework packages (@nightpost/sveltekit) build the
 * request-shaped helpers on top; the wire contract is WIRE_SPEC.md in the
 * monitor repo and is additive-only.
 */
export * from './env.js';
export * from './client.js';
export * from './trace.js';
export * from './outage.js';
export * from './profile.js';
export * from './route.js';
export * from './browser.js';
