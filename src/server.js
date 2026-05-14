import express from 'express';
import { formatRelative } from './events.js';

const DEFAULT_MAX_EVENTS = 50;

export function sanitizeError(reason, feedUrl) {
  let msg = String(reason?.message ?? reason ?? 'unknown error');
  if (feedUrl) {
    msg = msg.split(feedUrl).join('(url)');
    try {
      const host = new URL(feedUrl).host;
      if (host) msg = msg.split(host).join('(host)');
    } catch { /* feedUrl wasn't a URL */ }
  }
  return msg.slice(0, 200);
}

export function createApp({
  store,
  getEvents,
  now = () => Date.now(),
  log = () => {},
  maxEvents = DEFAULT_MAX_EVENTS,
  healthCheck = async () => true,
}) {
  const app = express();

  app.get('/healthz', async (_req, res) => {
    let ok = false;
    try {
      ok = (await healthCheck()) === true;
    } catch {
      ok = false;
    }
    res.status(ok ? 200 : 500).json({ ok, feeds: store.size() });
  });

  app.get('/events.json', async (_req, res) => {
    const feedList = store.list();
    const results = await Promise.allSettled(feedList.map((f) => getEvents(f)));
    const events = [];
    const errors = [];
    const t = now();
    results.forEach((r, i) => {
      const feed = feedList[i];
      if (r.status === "fulfilled") {
        for (const ev of r.value) {
          const ms = new Date(ev.start).getTime() - t;
          if (ms < 0) continue;
          events.push({ ...ev, relative_label: formatRelative(ms) });
        }
      } else {
        const message = sanitizeError(r.reason, feed.url);
        errors.push({ name: feed.name, message });
        log("warn", feed.name, "fetch_failed", { message });
      }
    });
    events.sort((a, b) => a.start.localeCompare(b.start));
    res.json({ events: events.slice(0, maxEvents), errors });
  });

  return app;
}

export { DEFAULT_MAX_EVENTS };
