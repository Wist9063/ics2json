import chokidar from 'chokidar';
import { access, constants } from 'node:fs/promises';
import { FeedStore } from './src/feeds.js';
import { createEventsService } from './src/events.js';
import { createApp } from './src/server.js';

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`invalid ${name}=${raw}, falling back to ${fallback}`);
    return fallback;
  }
  return n;
}

const FEEDS_DIR = process.env.FEEDS_DIR || '/app/feeds';
const PORT = intEnv('PORT', 8000);
const WINDOW_MS = intEnv('WINDOW_DAYS', 30) * 24 * 60 * 60 * 1000;
const CACHE_TTL_MS = intEnv('CACHE_TTL_MINUTES', 10) * 60 * 1000;
const FETCH_TIMEOUT_MS = intEnv('FETCH_TIMEOUT_SECONDS', 10) * 1000;
const MAX_EVENTS = intEnv('MAX_EVENTS', 50);

const log = (level, feed_name, event, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, feed_name, event, ...extra }));

const events = createEventsService({
  windowMs: WINDOW_MS,
  cacheTtlMs: CACHE_TTL_MS,
  fetchTimeoutMs: FETCH_TIMEOUT_MS,
});
const store = new FeedStore({
  feedsDir: FEEDS_DIR,
  log,
  onUrlChanged: (url) => events._cache.delete(url),
});

const healthCheck = async () => {
  await access(FEEDS_DIR, constants.R_OK);
  return true;
};

const app = createApp({
  store,
  getEvents: events.eventsFromFeed,
  log,
  maxEvents: MAX_EVENTS,
  healthCheck,
});

(async () => {
  await store.loadAll();
  const watcher = chokidar.watch(FEEDS_DIR, {
    ignoreInitial: true,
    ignored: (p) => p.endsWith('.sample'),
  });
  watcher
    .on('add', (p) => store.loadFile(p))
    .on('change', (p) => store.loadFile(p))
    .on('unlink', (p) => store.unloadFile(p));

  app.listen(PORT, '0.0.0.0', () => {
    log('info', '-', 'listening', {
      port: PORT,
      feeds: store.size(),
      window_days: WINDOW_MS / 86_400_000,
      cache_ttl_min: CACHE_TTL_MS / 60_000,
      fetch_timeout_s: FETCH_TIMEOUT_MS / 1000,
      max_events: MAX_EVENTS,
    });
  });
})();
