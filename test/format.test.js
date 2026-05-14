import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatRelative } from '../src/events.js';

test('formatRelative: zero or negative → now', () => {
  assert.equal(formatRelative(0), 'now');
  assert.equal(formatRelative(-1000), 'now');
});

test('formatRelative: sub-hour → just minutes', () => {
  assert.equal(formatRelative(17 * 60_000), 'in 17m');
});

test('formatRelative: hours + minutes, no days', () => {
  assert.equal(formatRelative((2 * 60 + 5) * 60_000), 'in 2h 5m');
});

test('formatRelative: drops zero hours in the middle', () => {
  const ms = (5 * 24 * 60 + 17) * 60_000;
  assert.equal(formatRelative(ms), 'in 5d 17m');
});

test('formatRelative: all three units', () => {
  const ms = ((1 * 24 + 2) * 60 + 3) * 60_000;
  assert.equal(formatRelative(ms), 'in 1d 2h 3m');
});

test('formatRelative: under a minute → now', () => {
  assert.equal(formatRelative(30_000), 'now');
});
