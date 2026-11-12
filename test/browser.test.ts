import { afterEach, describe, expect, it, vi } from 'vitest';
import { normaliseRoute, MAX_ROUTE_LENGTH } from '../src/route.js';
import {
  beacon,
  createSession,
  errorPayload,
  installSession,
  serviceLabel,
  sessionId,
  sessionPayload
} from '../src/browser.js';

const ENV = { NIGHTPOST_URL: 'http://m:8000', NIGHTPOST_PROJECT_KEY: 'front' };

function memory(): { getItem(k: string): string | null; setItem(k: string, v: string): void } {
  const map = new Map<string, string>();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v) };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('route normalisation (WIRE_SPEC v2 route)', () => {
  it('collapses a row id, whatever the URL it came in on', () => {
    expect(normaliseRoute('/chapters/7')).toBe('/chapters/[id]');
    expect(normaliseRoute('https://wire.example.com/chapters/7?utm=x#top')).toBe('/chapters/[id]');
    expect(normaliseRoute('chapters/7')).toBe('/chapters/[id]');
  });

  it('collapses uuids, hex keys, ulids and numbered slugs', () => {
    expect(normaliseRoute('/reader/3f2b8c1a-0d4e-4a1b-9f2c-7d6e5f4a3b2c')).toBe('/reader/[id]');
    expect(normaliseRoute('/share/9f86d081884c7d65')).toBe('/share/[id]');
    expect(normaliseRoute('/s/01ARZ3NDEKTSV4RRFFQ69G5FAV')).toBe('/s/[id]');
    expect(normaliseRoute('/chapters/quest-12')).toBe('/chapters/[id]');
  });

  it('keeps route words, drops the trailing slash and the query, and is idempotent', () => {
    expect(normaliseRoute('/tags/fantasy/')).toBe('/tags/fantasy');
    expect(normaliseRoute('/chapters/[id]')).toBe('/chapters/[id]');
    expect(normaliseRoute('/')).toBe('/');
    expect(normaliseRoute('')).toBe('/');
    expect(normaliseRoute('https://wire.example.com')).toBe('/');
    expect(normaliseRoute('/chapters/7?page=2')).toBe('/chapters/[id]');
  });

  it('caps the pattern at the server limit, so a long path is never a 422', () => {
    expect(normaliseRoute(`/${'segment/'.repeat(60)}`).length).toBe(MAX_ROUTE_LENGTH);
  });
});

describe('session beacon payload', () => {
  it('carries the v2 session fields, in spec order, and nothing else', () => {
    const payload = sessionPayload(
      { NIGHTPOST_SERVICE: 'front-web' },
      {
        session_id: 'wire-s1',
        status: 'crashed',
        route: '/chapters/7',
        duration_ms: 8120.4,
        release: '2026.10.10-b2c3d4',
        origin: 'https://wire.example.com'
      }
    );
    expect(Object.keys(payload)).toEqual([
      'session_id',
      'release',
      'status',
      'route',
      'duration_ms',
      'service'
    ]);
    expect(payload).toEqual({
      session_id: 'wire-s1',
      release: '2026.10.10-b2c3d4',
      status: 'crashed',
      route: '/chapters/[id]',
      duration_ms: 8120,
      service: 'front-web'
    });
  });

  it('defaults the service to the origin label and omits an absent release', () => {
    const payload = sessionPayload(
      {},
      { session_id: 's2', status: 'ok', route: '/', duration_ms: 10, origin: 'https://wire.example.com:8443' }
    );
    expect('release' in payload).toBe(false);
    expect(payload.service).toBe('wire.example.com:8443');
    expect(serviceLabel({ NIGHTPOST_PROJECT_KEY: 'acme' }, undefined)).toBe('acme');
    expect(serviceLabel({ NIGHTPOST_SERVICE: 'edge', NIGHTPOST_PROJECT_KEY: 'acme' }, 'https://a.example.com')).toBe('edge');
  });

  it('repairs a negative duration here rather than being refused there, and sends no spans', () => {
    const payload = sessionPayload({}, { session_id: 's3', status: 'abnormal', route: '/x', duration_ms: -5 });
    expect(payload.duration_ms).toBe(0);
    expect('spans' in payload).toBe(false);
  });
});

describe('session lifecycle', () => {
  const page = { origin: 'https://wire.example.com', pathname: '/chapters/9' };

  it('ok, with the page lifetime as its duration', () => {
    let clock = 1000;
    const session = createSession({ env: {}, location: page, now: () => clock });
    session.ready();
    clock = 2500;
    expect(session.status).toBe('ok');
    expect(session.end()).toEqual({
      session_id: session.id,
      status: 'ok',
      route: '/chapters/[id]',
      duration_ms: 1500,
      service: 'wire.example.com'
    });
  });

  it('crashed when the page reported an unhandled error, even after it loaded', () => {
    const session = createSession({ env: {}, location: page, now: () => 0 });
    session.ready();
    session.crashed();
    expect(session.status).toBe('crashed');
    expect(session.end().status).toBe('crashed');
  });

  it('abnormal when the navigation never completed', () => {
    const session = createSession({ env: {}, location: page, now: () => 0 });
    expect(session.status).toBe('abnormal');
    expect(session.end().status).toBe('abnormal');
  });

  it('keeps one random session id per tab, and mints without storage', () => {
    const storage = memory();
    const first = createSession({ env: {}, storage, now: () => 0 });
    const second = createSession({ env: {}, storage, now: () => 0 });
    expect(second.id).toBe(first.id);
    expect(first.id).not.toBe('');

    const hostile = {
      getItem(): string | null {
        throw new Error('storage disabled');
      },
      setItem(): void {
        throw new Error('storage disabled');
      }
    };
    expect(sessionId(hostile)).toMatch(/\S/);
  });
});

describe('browser error payload (WIRE_SPEC v2 service + route)', () => {
  it('carries the configured service and the pattern, never the raw path', () => {
    const payload = errorPayload(
      { NIGHTPOST_SERVICE: 'front-web' },
      {
        message: 'boom',
        stack: 'TypeError: boom',
        environment: 'production',
        release: '2026.10.10-b2c3d4',
        location: { origin: 'https://wire.example.com', pathname: '/chapters/7' }
      }
    );
    expect(payload).toEqual({
      message: 'boom',
      stack: 'TypeError: boom',
      url: 'https://wire.example.com/chapters/7',
      route: '/chapters/[id]',
      service: 'front-web',
      environment: 'production',
      release: '2026.10.10-b2c3d4'
    });
    // url stays the concrete page (the v1 field, as the wire vector has it);
    // route is the pattern and never the row a reader was on.
    expect(payload?.route).not.toContain('7');
  });

  it('defaults the service to the origin label', () => {
    const payload = errorPayload({}, { message: 'boom', location: { origin: 'https://wire.example.com', pathname: '/' } });
    expect(payload?.service).toBe('wire.example.com');
    expect(payload?.route).toBe('/');
  });

  it('refuses to build a payload the server would reject', () => {
    expect(errorPayload({}, { message: '   ' })).toBeNull();
  });
});

describe('beacon transport', () => {
  it('prefers navigator.sendBeacon, with a JSON blob', async () => {
    const sendBeacon = vi.fn(() => true);
    const fetchSpy = vi.fn();
    vi.stubGlobal('navigator', { sendBeacon });
    vi.stubGlobal('fetch', fetchSpy);

    expect(beacon(ENV, '/ingest/front/session', { session_id: 's1' })).toBe(true);
    const [url, body] = sendBeacon.mock.calls[0] as unknown as [string, Blob];
    expect(url).toBe('http://m:8000/ingest/front/session');
    expect(body.type).toBe('application/json');
    expect(await body.text()).toBe('{"session_id":"s1"}');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back to a keepalive fetch when sendBeacon declines or is absent', () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('offline')));
    vi.stubGlobal('navigator', { sendBeacon: vi.fn(() => false) });
    vi.stubGlobal('fetch', fetchSpy);

    expect(beacon(ENV, '/ingest/front/session', { session_id: 's1' })).toBe(true);
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://m:8000/ingest/front/session');
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
    expect(JSON.parse(String(init.body))).toEqual({ session_id: 's1' });
  });

  it('is inert, not noisy, without a URL', () => {
    expect(beacon({}, '/ingest/front/session', {})).toBe(false);
  });
});

describe('installSession wiring', () => {
  it('turns page events into the session outcome and sends on pagehide', () => {
    const fetchSpy = vi.fn(() => Promise.resolve(new Response('')));
    vi.stubGlobal('navigator', {});
    vi.stubGlobal('fetch', fetchSpy);
    const listeners = new Map<string, () => void>();
    const win = {
      addEventListener: (type: string, listener: () => void) => void listeners.set(type, listener),
      location: { origin: 'https://wire.example.com', pathname: '/chapters/9' },
      sessionStorage: null
    };

    const session = installSession(ENV, win, { release: 'r-1' });
    expect(session).not.toBeNull();
    listeners.get('load')?.();
    listeners.get('pagehide')?.();

    expect(session?.status).toBe('ok');
    const [url, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://m:8000/ingest/front/session');
    expect(JSON.parse(String(init.body))).toMatchObject({
      release: 'r-1',
      status: 'ok',
      route: '/chapters/[id]',
      service: 'wire.example.com'
    });
  });

  it('stays inert where there is no page', () => {
    expect(installSession(ENV, null)).toBeNull();
    expect(installSession({}, { addEventListener: () => {} })).toBeNull();
  });
});
