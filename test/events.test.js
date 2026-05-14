import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventsService } from '../src/events.js';

const FEED = { name: 'test', url: 'https://example.invalid/cal.ics', color: '#abcdef' };
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0); // 2026-01-15T12:00:00Z

function fakeFetcher(data) {
  return () => Promise.resolve(data);
}

test('VEVENT inside window is included', async () => {
  const start = new Date(NOW + 24 * 60 * 60 * 1000);
  const end = new Date(start.getTime() + 60 * 60 * 1000);
  const { eventsFromFeed } = createEventsService({
    fetcher: fakeFetcher({
      a: { type: 'VEVENT', summary: 'Meeting', start, end, datetype: 'date-time' },
    }),
    now: () => NOW,
  });
  const events = await eventsFromFeed(FEED);
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, 'Meeting');
  assert.equal(events[0].calendar, 'test');
  assert.equal(events[0].color, '#abcdef');
  assert.equal(events[0].all_day, false);
});

test('VEVENT outside window is excluded', async () => {
  const start = new Date(NOW + 60 * 24 * 60 * 60 * 1000); // 60 days out
  const { eventsFromFeed } = createEventsService({
    fetcher: fakeFetcher({
      a: { type: 'VEVENT', summary: 'Far', start, end: start, datetype: 'date-time' },
    }),
    now: () => NOW,
  });
  const events = await eventsFromFeed(FEED);
  assert.equal(events.length, 0);
});

test('all-day event flagged via datetype=date', async () => {
  const start = new Date(NOW + 24 * 60 * 60 * 1000);
  const { eventsFromFeed } = createEventsService({
    fetcher: fakeFetcher({
      a: { type: 'VEVENT', summary: 'Holiday', start, end: start, datetype: 'date' },
    }),
    now: () => NOW,
  });
  const events = await eventsFromFeed(FEED);
  assert.equal(events[0].all_day, true);
});

test('summary and location truncated at 200 chars', async () => {
  const start = new Date(NOW + 24 * 60 * 60 * 1000);
  const { eventsFromFeed } = createEventsService({
    fetcher: fakeFetcher({
      a: {
        type: 'VEVENT',
        summary: 'x'.repeat(500),
        location: 'y'.repeat(500),
        start,
        end: start,
        datetype: 'date-time',
      },
    }),
    now: () => NOW,
  });
  const events = await eventsFromFeed(FEED);
  assert.equal(events[0].summary.length, 200);
  assert.equal(events[0].location.length, 200);
});

test('missing summary falls back to (no title)', async () => {
  const start = new Date(NOW + 60 * 60 * 1000);
  const { eventsFromFeed } = createEventsService({
    fetcher: fakeFetcher({
      a: { type: 'VEVENT', start, end: start, datetype: 'date-time' },
    }),
    now: () => NOW,
  });
  const events = await eventsFromFeed(FEED);
  assert.equal(events[0].summary, '(no title)');
});

test('non-VEVENT entries are skipped', async () => {
  const start = new Date(NOW + 60 * 60 * 1000);
  const { eventsFromFeed } = createEventsService({
    fetcher: fakeFetcher({
      a: { type: 'VTODO', summary: 'skip me', start, end: start },
      b: { type: 'VEVENT', summary: 'keep me', start, end: start, datetype: 'date-time' },
      c: null,
    }),
    now: () => NOW,
  });
  const events = await eventsFromFeed(FEED);
  assert.equal(events.length, 1);
  assert.equal(events[0].summary, 'keep me');
});

test('RRULE expands occurrences inside window', async () => {
  const baseStart = new Date(NOW + 24 * 60 * 60 * 1000); // tomorrow
  const baseEnd = new Date(baseStart.getTime() + 60 * 60 * 1000);
  // Fake rrule: 3 daily occurrences starting baseStart.
  const occ = [
    baseStart,
    new Date(baseStart.getTime() + 1 * 24 * 60 * 60 * 1000),
    new Date(baseStart.getTime() + 2 * 24 * 60 * 60 * 1000),
  ];
  const rrule = {
    between: (_a, _b, _inc) => occ,
  };
  const { eventsFromFeed } = createEventsService({
    fetcher: fakeFetcher({
      a: {
        type: 'VEVENT',
        summary: 'Standup',
        start: baseStart,
        end: baseEnd,
        rrule,
        datetype: 'date-time',
      },
    }),
    now: () => NOW,
  });
  const events = await eventsFromFeed(FEED);
  assert.equal(events.length, 3);
  for (const ev of events) {
    const d = new Date(ev.end).getTime() - new Date(ev.start).getTime();
    assert.equal(d, 60 * 60 * 1000, 'duration preserved');
    assert.equal(ev.summary, 'Standup');
  }
});

test('RRULE per-occurrence override wins', async () => {
  const baseStart = new Date(NOW + 24 * 60 * 60 * 1000);
  const baseEnd = new Date(baseStart.getTime() + 60 * 60 * 1000);
  const second = new Date(baseStart.getTime() + 1 * 24 * 60 * 60 * 1000);
  const overrideKey = second.toISOString().substring(0, 10);
  const rrule = { between: () => [baseStart, second] };
  const { eventsFromFeed } = createEventsService({
    fetcher: fakeFetcher({
      a: {
        type: 'VEVENT',
        summary: 'Original',
        start: baseStart,
        end: baseEnd,
        rrule,
        recurrences: {
          [overrideKey]: {
            summary: 'Overridden!',
            start: second,
            end: new Date(second.getTime() + 30 * 60 * 1000),
            location: 'New Room',
          },
        },
        datetype: 'date-time',
      },
    }),
    now: () => NOW,
  });
  const events = await eventsFromFeed(FEED);
  assert.equal(events.length, 2);
  assert.equal(events[0].summary, 'Original');
  assert.equal(events[1].summary, 'Overridden!');
  assert.equal(events[1].location, 'New Room');
});

test('fetch timeout rejects', async () => {
  const { eventsFromFeed } = createEventsService({
    fetcher: () => new Promise(() => {}), // never resolves
    now: () => NOW,
    fetchTimeoutMs: 20,
  });
  await assert.rejects(() => eventsFromFeed(FEED), /timeout/);
});

test('cache short-circuits second call', async () => {
  let calls = 0;
  const start = new Date(NOW + 60 * 60 * 1000);
  const { eventsFromFeed } = createEventsService({
    fetcher: () => {
      calls++;
      return Promise.resolve({
        a: { type: 'VEVENT', summary: 'Cached', start, end: start, datetype: 'date-time' },
      });
    },
    now: () => NOW,
  });
  await eventsFromFeed(FEED);
  await eventsFromFeed(FEED);
  assert.equal(calls, 1);
});
