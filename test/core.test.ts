import { describe, expect, it, beforeEach } from 'vitest';
import { forcedDeepAllowed, monitorEnabled, nv, readConfig, shouldSample } from '../src/env.js';
import { isTransportOutage } from '../src/outage.js';
import { currentTrace, mintTrace, recordTraceSpan, tracePropagationHeaders } from '../src/trace.js';
import { collapseNodes } from '../src/profile.js';

describe('env dual-read', () => {
  it('NIGHTPOST_* wins over MONITOR_*', () => {
    expect(nv({ NIGHTPOST_URL: 'https://a', MONITOR_URL: 'https://b' }, 'URL')).toBe('https://a');
    expect(nv({ MONITOR_URL: 'https://b' }, 'URL')).toBe('https://b');
    expect(nv({}, 'URL')).toBeUndefined();
  });

  it('trailing slashes are stripped and defaults hold', () => {
    const cfg = readConfig({ NIGHTPOST_URL: 'http://m:8000/' });
    expect(cfg.url).toBe('http://m:8000');
    expect(cfg.projectKey).toBe('front');
    expect(cfg.sampleRate).toBe(0.05);
  });

  it('the reporter is inert without a URL', () => {
    expect(monitorEnabled({})).toBe(false);
    expect(monitorEnabled({ MONITOR_URL: 'http://m' })).toBe(true);
  });

  it('sample rate 0 never samples, 1 always does', () => {
    expect(shouldSample({ NIGHTPOST_SAMPLE_RATE: '0' })).toBe(false);
    expect(shouldSample({ NIGHTPOST_SAMPLE_RATE: '1' })).toBe(true);
  });

  it('forced-deep cap 0 disables the callgraph ceiling', () => {
    expect(forcedDeepAllowed({ NIGHTPOST_FORCED_DEEP_CAP: '0' })).toBe(false);
  });
});

describe('transport outage classification (#186)', () => {
  it('classifies connection failures as router traffic', () => {
    const err = new Error('fetch failed');
    expect(isTransportOutage(err)).toBe(true);
    expect(isTransportOutage(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isTransportOutage(new Error('business rule violated'))).toBe(false);
    expect(isTransportOutage('not an error')).toBe(false);
  });

  it('walks the cause chain', () => {
    const inner = Object.assign(new Error('connect'), { code: 'ECONNREFUSED' });
    expect(isTransportOutage(new Error('outer', { cause: inner }))).toBe(true);
  });
});

describe('trace context', () => {
  it('records spans only inside the async context', async () => {
    const trace = mintTrace();
    recordTraceSpan('outside', 0, 1);
    expect(trace.spans).toHaveLength(0);
    await new Promise<void>((res) => {
      import('../src/trace.js').then(({ runWithTrace }) => {
        runWithTrace(trace, async () => {
          recordTraceSpan('db', 5, 12.345, { q: 'x' });
          expect(trace.spans).toHaveLength(1);
          expect(trace.spans[0].duration_ms).toBe(12.35);
          expect(tracePropagationHeaders()['x-monitor-trace-id']).toBe(trace.id);
          res();
        });
      });
    });
    expect(tracePropagationHeaders()).toEqual({});
    expect(currentTrace()).toBeUndefined();
  });
});

describe('V8 profile folding', () => {
  it('allocates self time from hitCount and sorts hotspots', () => {
    const profile = {
      nodes: [
        { id: 1, callFrame: { functionName: 'main', url: 'file:///a.ts', lineNumber: 1, columnNumber: 0 }, hitCount: 1 },
        { id: 2, callFrame: { functionName: 'slow', url: '', lineNumber: 2, columnNumber: 0 }, hitCount: 3, children: [] }
      ]
    };
    const hot = collapseNodes(profile as never, 100);
    expect(hot[0].function).toBe('slow');
    expect(hot[0].self_ms).toBe(75);
    expect(hot[1].self_ms).toBe(25);
  });

  it('an empty profile folds to nothing', () => {
    expect(collapseNodes({ nodes: [] }, 100)).toEqual([]);
    expect(collapseNodes({ nodes: [{ id: 1, callFrame: { functionName: 'x', url: '', lineNumber: 0, columnNumber: 0 }, hitCount: 5 }] }, 0)).toEqual([]);
  });
});
