import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FeedStore, deterministicColor } from '../src/feeds.js';

let dir;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ics2json-feeds-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(name, body) {
  const p = join(dir, name);
  await writeFile(p, body);
  return p;
}

test('loads a valid YAML feed', async () => {
  const store = new FeedStore({ feedsDir: dir });
  const p = await write('work.yml', 'url: https://example.invalid/a.ics\ncolor: "#abcdef"\n');
  await store.loadFile(p);
  assert.equal(store.size(), 1);
  const [feed] = store.list();
  assert.equal(feed.name, 'work');
  assert.equal(feed.url, 'https://example.invalid/a.ics');
  assert.equal(feed.color, '#abcdef');
});

test("rejects non-https URLs", async () => {
  const store = new FeedStore({ feedsDir: dir });
  const p = await write('bad.yml', 'url: http://example.invalid/a.ics\n');
  await store.loadFile(p);
  assert.equal(store.size(), 0);
});

test("rejects missing url", async () => {
  const store = new FeedStore({ feedsDir: dir });
  const p = await write('bad.yml', 'color: "#abcdef"\n');
  await store.loadFile(p);
  assert.equal(store.size(), 0);
});

test("rejects malformed url", async () => {
  const store = new FeedStore({ feedsDir: dir });
  const p = await write('bad.yml', 'url: "not a url"\n');
  await store.loadFile(p);
  assert.equal(store.size(), 0);
});

test("rejects malformed YAML without throwing", async () => {
  const store = new FeedStore({ feedsDir: dir });
  const p = await write('bad.yml', 'url: https://x\n  bad: : indentation\n');
  await store.loadFile(p);
  assert.equal(store.size(), 0);
});

test("ignores invalid color and falls back to deterministic", async () => {
  const store = new FeedStore({ feedsDir: dir });
  const p = await write('work.yml', 'url: https://example.invalid/a.ics\ncolor: "red"\n');
  await store.loadFile(p);
  const [feed] = store.list();
  assert.match(feed.color, /^#[0-9a-f]{6}$/);
  assert.equal(feed.color, deterministicColor('work'));
});

test("name override beats filename", async () => {
  const store = new FeedStore({ feedsDir: dir });
  const p = await write('work.yml', 'url: https://example.invalid/a.ics\nname: "Personal Cal"\n');
  await store.loadFile(p);
  assert.equal(store.list()[0].name, 'Personal Cal');
});

test("name truncated to 64 chars", async () => {
  const store = new FeedStore({ feedsDir: dir });
  const longName = 'x'.repeat(120);
  const p = await write('work.yml', `url: https://example.invalid/a.ics\nname: "${longName}"\n`);
  await store.loadFile(p);
  assert.equal(store.list()[0].name.length, 64);
});

test("non-yml file is ignored", async () => {
  const store = new FeedStore({ feedsDir: dir });
  const p = await write('README.md', 'url: https://example.invalid/a.ics\n');
  await store.loadFile(p);
  assert.equal(store.size(), 0);
});

test("editing url triggers onUrlChanged with old url", async () => {
  const dropped = [];
  const store = new FeedStore({ feedsDir: dir, onUrlChanged: (u) => dropped.push(u) });
  const p = await write('work.yml', 'url: https://example.invalid/a.ics\n');
  await store.loadFile(p);
  await write('work.yml', 'url: https://example.invalid/b.ics\n');
  await store.loadFile(p);
  assert.deepEqual(dropped, ['https://example.invalid/a.ics']);
  assert.equal(store.list()[0].url, 'https://example.invalid/b.ics');
});

test("unloadFile removes feed and fires onUrlChanged", async () => {
  const dropped = [];
  const store = new FeedStore({ feedsDir: dir, onUrlChanged: (u) => dropped.push(u) });
  const p = await write('work.yml', 'url: https://example.invalid/a.ics\n');
  await store.loadFile(p);
  await unlink(p);
  await store.unloadFile(p);
  assert.equal(store.size(), 0);
  assert.deepEqual(dropped, ['https://example.invalid/a.ics']);
});

test("loadAll skips .sample files and loads .yml", async () => {
  const store = new FeedStore({ feedsDir: dir });
  await write('real.yml', 'url: https://example.invalid/a.ics\n');
  await write('example.yml.sample', 'url: https://example.invalid/b.ics\n');
  await write('notes.txt', 'not a feed');
  await store.loadAll();
  assert.equal(store.size(), 1);
  assert.equal(store.list()[0].name, 'real');
});

test('loadAll on missing dir logs error but doesn\'t throw', async () => {
  const store = new FeedStore({ feedsDir: '/nope/definitely/does/not/exist' });
  await store.loadAll();
  assert.equal(store.size(), 0);
});

test('deterministicColor: stable across calls', () => {
  assert.equal(deterministicColor('hello'), deterministicColor('hello'));
  assert.notEqual(deterministicColor('hello'), deterministicColor('world'));
  assert.match(deterministicColor('anything'), /^#[0-9a-f]{6}$/);
});
