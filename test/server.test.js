import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp, DEFAULT_MAX_EVENTS as MAX_EVENTS } from '../src/server.js';

const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);

function stubStore(feeds) {
  return { list: () => feeds, size: () => feeds.length };
}

function ev(feedName, color, offsetMs, summary = 'x') {
  const start = new Date(NOW + offsetMs).toISOString();
  return {
    summary,
    start,
    end: start,
    all_day: false,
    location: '',
    calendar: feedName,
    color,
  };
}

test('GET /healthz returns ok with feed count', async () => {
  const app = createApp({
    store: stubStore([{ name: 'a' }, { name: 'b' }]),
    getEvents: async () => [],
    now: () => NOW,
  });
  const res = await request(app).get('/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { ok: true, feeds: 2 });
});

test('GET /healthz returns 500 when healthCheck throws', async () => {
  const app = createApp({
    store: stubStore([]),
    getEvents: async () => [],
    healthCheck: async () => { throw new Error('EACCES'); },
  });
  const res = await request(app).get('/healthz');
  assert.equal(res.status, 500);
  assert.equal(res.body.ok, false);
});

test('GET /healthz returns 500 when healthCheck returns false', async () => {
  const app = createApp({
    store: stubStore([]),
    getEvents: async () => [],
    healthCheck: async () => false,
  });
  const res = await request(app).get('/healthz');
  assert.equal(res.status, 500);
  assert.equal(res.body.ok, false);
});

test('GET /events.json merges multiple feeds, sorted by start', async () => {
  const feeds = [
    { name: 'work', color: '#111111', url: 'https://example.invalid/w.ics' },
    { name: 'home', color: '#222222', url: 'https://example.invalid/h.ics' },
  ];
  const app = createApp({
    store: stubStore(feeds),
    getEvents: async (f) => {
      if (f.name === 'work') return [ev('work', '#111111', 3 * 3600_000, 'later')];
      return [ev('home', '#222222', 1 * 3600_000, 'earlier')];
    },
    now: () => NOW,
  });
  const res = await request(app).get('/events.json');
  assert.equal(res.status, 200);
  assert.equal(res.body.events.length, 2);
  assert.equal(res.body.events[0].summary, 'earlier');
  assert.equal(res.body.events[1].summary, 'later');
  assert.equal(res.body.errors.length, 0);
});

test('GET /events.json: failing feed shows up in errors[] without leaking URL', async () => {
  const SECRET_URL = 'https://example.invalid/SECRET-bearer-token-abc123.ics';
  const feeds = [{ name: 'broken', color: '#333333', url: SECRET_URL }];
  const app = createApp({
    store: stubStore(feeds),
    getEvents: async () => {
      const e = new Error(`failed to fetch ${SECRET_URL}: ETIMEDOUT`);
      throw e;
    },
    now: () => NOW,
  });
  const res = await request(app).get('/events.json');
  assert.equal(res.status, 200);
  assert.equal(res.body.errors.length, 1);
  assert.equal(res.body.errors[0].name, 'broken');
  // Critical: the URL must not appear anywhere in the response.
  const body = JSON.stringify(res.body);
  assert.equal(body.includes(SECRET_URL), false, 'URL leaked in response body');
  assert.equal(body.includes('SECRET-bearer-token-abc123'), false, 'token leaked');
});

test('GET /events.json: already-started events filtered out', async () => {
  const feeds = [{ name: 'a', color: '#444444', url: 'x' }];
  const app = createApp({
    store: stubStore(feeds),
    getEvents: async () => [
      ev('a', '#444444', -3600_000, 'past'),    // started 1h ago
      ev('a', '#444444', 3600_000, 'future'),   // starts in 1h
    ],
    now: () => NOW,
  });
  const res = await request(app).get('/events.json');
  assert.equal(res.body.events.length, 1);
  assert.equal(res.body.events[0].summary, 'future');
});

test('GET /events.json: MAX_EVENTS cap honored', async () => {
  const feeds = [{ name: 'a', color: '#555555', url: 'x' }];
  const many = Array.from({ length: MAX_EVENTS + 20 }, (_, i) =>
    ev('a', '#555555', (i + 1) * 60_000, `e${i}`),
  );
  const app = createApp({
    store: stubStore(feeds),
    getEvents: async () => many,
    now: () => NOW,
  });
  const res = await request(app).get('/events.json');
  assert.equal(res.body.events.length, MAX_EVENTS);
});

test('GET /events.json: relative_label uses injected now, not wall clock', async () => {
  const feeds = [{ name: 'a', color: '#666666', url: 'x' }];
  const app = createApp({
    store: stubStore(feeds),
    getEvents: async () => [ev('a', '#666666', 17 * 60_000, 'soon')],
    now: () => NOW,
  });
  const res = await request(app).get('/events.json');
  assert.equal(res.body.events[0].relative_label, 'in 17m');
});

test('GET /events.json: empty store → empty arrays, no error', async () => {
  const app = createApp({
    store: stubStore([]),
    getEvents: async () => [],
    now: () => NOW,
  });
  const res = await request(app).get('/events.json');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { events: [], errors: [] });
});

test('GET /events.json: mixed success+failure includes both', async () => {
  const feeds = [
    { name: 'ok', color: '#777777', url: 'x' },
    { name: 'fail', color: '#888888', url: 'y' },
  ];
  const app = createApp({
    store: stubStore(feeds),
    getEvents: async (f) => {
      if (f.name === 'ok') return [ev('ok', '#777777', 3600_000, 'kept')];
      throw new Error('boom');
    },
    now: () => NOW,
  });
  const res = await request(app).get('/events.json');
  assert.equal(res.body.events.length, 1);
  assert.equal(res.body.events[0].summary, 'kept');
  assert.equal(res.body.errors.length, 1);
  assert.equal(res.body.errors[0].name, 'fail');
  assert.equal(res.body.errors[0].message, 'boom');
});
