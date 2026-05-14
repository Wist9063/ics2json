import ical from 'node-ical';

export const DEFAULTS = {
  windowMs: 30 * 24 * 60 * 60 * 1000,
  cacheTtlMs: 10 * 60 * 1000,
  fetchTimeoutMs: 10_000,
  maxSummaryLen: 200,
  maxLocationLen: 200,
};

export function isAllDayEvent(item) {
  return item?.datetype === "date";
}

export function formatRelative(ms) {
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

const defaultFetcher = (url) => ical.async.fromURL(url);

export function createEventsService({
  fetcher = defaultFetcher,
  now = () => Date.now(),
  windowMs = DEFAULTS.windowMs,
  cacheTtlMs = DEFAULTS.cacheTtlMs,
  fetchTimeoutMs = DEFAULTS.fetchTimeoutMs,
} = {}) {
  const cache = new Map();

  async function eventsFromFeed(feed) {
    const t = now();
    const cached = cache.get(feed.url);
    if (cached && t - cached.at < cacheTtlMs) return cached.events;

    let timeoutId;
    const data = await Promise.race([
      Promise.resolve(fetcher(feed.url)),
      new Promise((_, rej) => {
        timeoutId = setTimeout(() => rej(new Error("timeout")), fetchTimeoutMs);
      }),
    ]).finally(() => clearTimeout(timeoutId));

    const windowStart = new Date(t);
    const windowEnd = new Date(t + windowMs);
    const out = [];

    for (const k of Object.keys(data)) {
      const item = data[k];
      if (!item || item.type !== "VEVENT") continue;
      const summary = String(item.summary ?? '(no title)').slice(0, DEFAULTS.maxSummaryLen);
      const allDay = isAllDayEvent(item);
      const location = String(item.location ?? '').slice(0, DEFAULTS.maxLocationLen);

      if (item.rrule) {
        const occurrences = item.rrule.between(windowStart, windowEnd, true);
        const durationMs = item.end?.getTime?.() && item.start?.getTime?.()
          ? item.end.getTime() - item.start.getTime()
          : 0;
        for (const occ of occurrences) {
          const key = occ.toISOString().substring(0, 10);
          const override = item.recurrences?.[key];
          const start = override?.start ?? occ;
          const end = override?.end ?? new Date(occ.getTime() + durationMs);
          out.push({
            summary: String(override?.summary ?? summary).slice(0, DEFAULTS.maxSummaryLen),
            start: start.toISOString(),
            end: end.toISOString(),
            all_day: allDay,
            location: String(override?.location ?? location).slice(0, DEFAULTS.maxLocationLen),
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

    cache.set(feed.url, { at: t, events: out });
    return out;
  }

  return { eventsFromFeed, _cache: cache };
}
