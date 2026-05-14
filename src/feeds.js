import yaml from 'yaml';
import { readFile, readdir } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { createHash } from 'node:crypto';

const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_NAME_LEN = 64;

export function deterministicColor(name) {
  const h = createHash('sha256').update(name).digest();
  return '#' + [h[0], h[1], h[2]].map((b) => (128 + (b >> 1)).toString(16).padStart(2, '0')).join('');
}

const noopLog = () => {};

export class FeedStore {
  constructor({ feedsDir, log = noopLog, onUrlChanged = () => {} } = {}) {
    if (!feedsDir) throw new Error('FeedStore: feedsDir required');
    this.feedsDir = feedsDir;
    this.log = log;
    this.onUrlChanged = onUrlChanged;
    this.feeds = new Map();         // key: filename → {name, url, color}
  }

  list() {
    return [...this.feeds.values()];
  }

  size() {
    return this.feeds.size;
  }

  async loadFile(filePath) {
    const file = basename(filePath);
    if (!file.endsWith('.yml') && !file.endsWith('.yaml')) return;
    let raw;
    try {
      raw = await readFile(filePath, 'utf8');
    } catch (e) {
      this.log('warn', file, 'read_failed', { message: e.message });
      return;
    }
    let doc;
    try {
      doc = yaml.parse(raw) ?? {};
    } catch (e) {
      this.log('warn', file, 'yaml_parse_failed', { message: e.message });
      return;
    }
    const url = String(doc.url ?? '').trim();
    if (!url) {
      this.log('warn', file, 'missing_url');
      return;
    }
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      this.log('warn', file, 'invalid_url');
      return;
    }
    if (parsed.protocol !== 'https:') {
      this.log('warn', file, 'non_https_url');
      return;
    }
    const fallbackName = basename(file, extname(file)).slice(0, MAX_NAME_LEN);
    const name = String(doc.name ?? fallbackName).slice(0, MAX_NAME_LEN);
    const color = COLOR_RE.test(doc.color ?? "") ? doc.color : deterministicColor(name);
    const prev = this.feeds.get(file);
    if (prev && prev.url !== url) this.onUrlChanged(prev.url);
    this.feeds.set(file, { name, url, color });
    this.log('info', name, 'feed_loaded');
  }

  async unloadFile(filePath) {
    const file = basename(filePath);
    const prev = this.feeds.get(file);
    if (!prev) return;
    this.onUrlChanged(prev.url);
    this.feeds.delete(file);
    this.log('info', prev.name, 'feed_removed');
  }

  async loadAll() {
    let entries;
    try {
      entries = await readdir(this.feedsDir);
    } catch (e) {
      this.log('error', '-', 'feeds_dir_unreadable', { message: e.message });
      return;
    }
    for (const entry of entries) {
      if (entry.endsWith('.sample')) continue;
      await this.loadFile(join(this.feedsDir, entry));
    }
  }
}
