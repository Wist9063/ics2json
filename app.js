// ics2json — fetches one or more ICS feeds and exposes upcoming events as JSON.
//
// Feed config: drop a YAML file into ./feeds/. Filename (sans extension) is the
// display name unless overridden. Format:
//   url: https://...    (required, must be https://)
//   color: "#rrggbb"    (optional)
//   name: "..."         (optional, default = filename)
//
// Hot-reloads on file add/change/unlink. No URL ever leaves this process via
// HTTP responses or logs.

import express from "express";
import chokidar from "chokidar";
import yaml from "yaml";
import ical from "node-ical";
import { readFile, readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { createHash } from "node:crypto";

const FEEDS_DIR = "/app/feeds";
const PORT = 8000;
const WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const CACHE_TTL_MS = 10 * 60 * 1000;        // 10 minutes
const FETCH_TIMEOUT_MS = 10_000;
const MAX_EVENTS = 50;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DEFAULT_COLOR = "#888888";

/** @type {Map<string, {name:string,url:string,color:string}>} key = filename */
const feeds = new Map();
/** @type {Map<string, {at:number, events:any[]}>} key = url */
const cache = new Map();

const log = (level, feed_name, event, extra = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, feed_name, event, ...extra }));

function deterministicColor(name) {
  // Stable pastel-ish color from name hash; only used when no `color:` provided.
  const h = createHash("sha256").update(name).digest();
  return "#" + [h[0], h[1], h[2]].map((b) => (128 + (b >> 1)).toString(16).padStart(2, "0")).join("");
}

async function loadFeed(filePath) {
  const file = basename(filePath);
  if (!file.endsWith(".yml") && !file.endsWith(".yaml")) return;
  let raw;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (e) {
    log("warn", file, "read_failed", { message: e.message });
    return;
  }
  let doc;
  try {
    doc = yaml.parse(raw) ?? {};
  } catch (e) {
    log("warn", file, "yaml_parse_failed", { message: e.message });
    return;
  }
  const url = String(doc.url ?? "").trim();
  if (!url) {
    log("warn", file, "missing_url");
    return;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    log("warn", file, "invalid_url");
    return;
  }
  if (parsed.protocol !== "https:") {
    log("warn", file, "non_https_url");
    return;
  }
  const fallbackName = basename(file, extname(file)).slice(0, 64);
  const name = String(doc.name ?? fallbackName).slice(0, 64);
  const color = COLOR_RE.test(doc.color ?? "") ? doc.color : deterministicColor(name);
  const prev = feeds.get(file);
  if (prev && prev.url !== url) cache.delete(prev.url);
  feeds.set(file, { name, url, color });
  log("info", name, "feed_loaded");
}

async function unloadFeed(filePath) {
  const file = basename(filePath);
  const prev = feeds.get(file);
  if (!prev) return;
  cache.delete(prev.url);
  feeds.delete(file);
  log("info", prev.name, "feed_removed");
}

async function loadAllFeeds() {
  let entries;
  try {
    entries = await readdir(FEEDS_DIR);
  } catch (e) {
    log("error", "-", "feeds_dir_unreadable", { message: e.message });
    return;
  }
  for (const entry of entries) {
    if (entry.endsWith(".sample")) continue;
    await loadFeed(join(FEEDS_DIR, entry));
  }
}

function isAllDayEvent(item) {
  // node-ical sets datetype to 'date' for all-day events.
  return item?.datetype === "date";
}

/**
 * Format a millisecond delta as "in 1d 2h 3m", 
 * omitting any zero units so a far-out event with no leftover hours reads "in 5d 17m" and an event under an
 * hour out collapses to just "in 17m".
 */
function formatRelative(ms) {
  if (ms <= 0) return "now";
  const totalMin = Math.floor(ms / 60000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;
  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (mins > 0) parts.push(`${mins}m`);
  return parts.length ? `in ${parts.join(" ")}` : "now";
}

async function eventsFromFeed(feed) {
  const now = Date.now();
  const cached = cache.get(feed.url);
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.events;

  const data = await Promise.race([
    ical.async.fromURL(feed.url),
    new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), FETCH_TIMEOUT_MS)),
  ]);

  const windowStart = new Date(now);
  const windowEnd = new Date(now + WINDOW_MS);
  const out = [];

  for (const k of Object.keys(data)) {
    const item = data[k];
    if (!item || item.type !== "VEVENT") continue;
    const summary = String(item.summary ?? "(no title)").slice(0, 200);
    const allDay = isAllDayEvent(item);

    const location = String(item.location ?? "").slice(0, 200);

    if (item.rrule) {
      const occurrences = item.rrule.between(windowStart, windowEnd, true);
      const durationMs = item.end?.getTime?.() && item.start?.getTime?.()
        ? item.end.getTime() - item.start.getTime()
        : 0;
      for (const occ of occurrences) {
        // Honor per-occurrence overrides (recurrences keyed by occurrence date string).
        const key = occ.toISOString().substring(0, 10);
        const override = item.recurrences?.[key];
        const start = override?.start ?? occ;
        const end = override?.end ?? new Date(occ.getTime() + durationMs);
        out.push({
          summary: String(override?.summary ?? summary).slice(0, 200),
          start: start.toISOString(),
          end: end.toISOString(),
          all_day: allDay,
          location: String(override?.location ?? location).slice(0, 200),
          calendar: feed.name,
          color: feed.color,
        });
      }
    } else if (item.start instanceof Date) {
      if (item.start >= windowStart && item.start < windowEnd) {
        out.push({
          summary,
          start: item.start.toISOString(),
          end: (item.end instanceof Date ? item.end : item.start).toISOString(),
          all_day: allDay,
          location,
          calendar: feed.name,
          color: feed.color,
        });
      }
    }
  }

  cache.set(feed.url, { at: now, events: out });
  return out;
}

const app = express();

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, feeds: feeds.size });
});

app.get("/events.json", async (_req, res) => {
  const feedList = [...feeds.values()];
  const results = await Promise.allSettled(feedList.map(eventsFromFeed));
  const events = [];
  const errors = [];
  const now = Date.now();
  results.forEach((r, i) => {
    const feed = feedList[i];
    if (r.status === "fulfilled") {
      for (const ev of r.value) {
        const ms = new Date(ev.start).getTime() - now;
        if (ms < 0) continue; // already started; skip
        // relative_label is computed per-request so it stays fresh even though
        // the parsed events are cached for ~10 min.
        events.push({ ...ev, relative_label: formatRelative(ms) });
      }
    } else {
      // Sanitize: never include the URL.
      const message = String(r.reason?.message ?? r.reason ?? "unknown error").slice(0, 200);
      errors.push({ name: feed.name, message });
      log("warn", feed.name, "fetch_failed", { message });
    }
  });
  events.sort((a, b) => a.start.localeCompare(b.start));
  res.json({ events: events.slice(0, MAX_EVENTS), errors });
});

(async () => {
  await loadAllFeeds();
  // Watch for hot-reload and ignore the .sample doc.
  const watcher = chokidar.watch(FEEDS_DIR, {
    ignoreInitial: true,
    ignored: (p) => p.endsWith(".sample"),
  });
  watcher.on("add", loadFeed).on("change", loadFeed).on("unlink", unloadFeed);

  app.listen(PORT, "0.0.0.0", () => {
    log("info", "-", "listening", { port: PORT, feeds: feeds.size });
  });
})();
