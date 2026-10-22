'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

function load(overrides = {}) {
  const filename = path.join(__dirname, '..', 'tariff-scrape.js');
  const realRequire = createRequire(filename);
  const context = {
    require: (name) => name === 'puppeteer-core' ? {} : realRequire(name),
    __dirname: path.dirname(filename),
    process: { env: {}, stdout: { isTTY: false } },
    console: { log() {}, error() {} },
    setTimeout: (fn) => { queueMicrotask(fn); },
    ...overrides,
  };
  const source = fs.readFileSync(filename, 'utf8');
  vm.runInNewContext(source.slice(0, source.lastIndexOf('(async () => {')), context, { filename });
  return context;
}

test('scroll safety limit rejects incomplete results', async () => {
  const api = load();
  const page = {
    mouse: { move: async () => {}, wheel: async () => {} },
    keyboard: { press: async () => {} },
    evaluate: async () => ({ cards: 10, pending: 1 }),
  };
  await assert.rejects(api.loadAllCards(page), /完整|上限/);
});

test('stable cards with no pending requests still complete', async () => {
  const api = load();
  const page = {
    mouse: { move: async () => {}, wheel: async () => {} },
    keyboard: { press: async () => {} },
    evaluate: async () => ({ cards: 10, pending: 0 }),
  };
  assert.equal(await api.loadAllCards(page), 10);
});

test('a tariff-type-only first run cannot seed a partial snapshot', () => {
  const writes = [];
  const realRequire = createRequire(__filename);
  const api = load({ require: (name) => name === 'fs' ? {
    existsSync: () => false, writeFileSync: (file) => writes.push(file),
  } : name === 'puppeteer-core' ? {} : realRequire(name) });
  api.persistProvince({ outDir: '.', snapshot: true, categories: [], scopes: [],
    tariffTypes: ['套餐'], json: false, html: false, top: 0 }, '北京市', [], [], []);
  assert.equal(writes.length, 0);
});

test('malformed snapshot items cannot be used as a baseline', () => {
  const realRequire = createRequire(__filename);
  const api = load({ require: (name) => name === 'fs' ? {
    existsSync: () => true, readFileSync: () => '{"items":[]}',
  } : name === 'puppeteer-core' ? {} : realRequire(name) });
  assert.equal(api.loadSnapshot('snapshot.json').ok, false);
});

test('missing tab controls cannot yield a successful empty scrape', async () => {
  const api = load();
  api.selectProvince = async () => true;
  api.readTabs = async () => ({ categories: [], ranges: [] });
  await assert.rejects(api.scrapeProvince({ evaluate: async () => 0 }, '北京市', {
    categories: [], scopes: [], tariffTypes: [],
  }), /页签|匹配/);
});

test('a previously discovered tab disappearing must fail the scrape', async () => {
  const api = load();
  api.selectProvince = async () => true;
  api.readTabs = async () => ({ categories: ['个人资费'], ranges: ['全网资费'] });
  api.clickTab = async () => false;
  await assert.rejects(api.scrapeProvince({ evaluate: async () => 0 }, '北京市', {
    categories: [], scopes: [], tariffTypes: [],
  }), /页签/);
});

test('invalid calendar dates do not roll over into a different month', () => {
  const api = load();
  assert.equal(api.parseCnDate('2026-02-31'), null);
  assert.equal(api.isoDate(api.parseCnDate('2024年2月29日')), '2024-02-29');
});

test('reusing an XHR does not double-decrement pending requests or count unrelated calls', async () => {
  const api = load();
  const window = {};
  class FakeXHR {
    constructor() { this.listeners = []; this.status = 200; }
    open() {}
    addEventListener(event, fn, options) { this.listeners.push({ fn, once: options && options.once }); }
    send() {
      const current = [...this.listeners];
      this.listeners = this.listeners.filter((l) => !l.once);
      for (const listener of current) listener.fn();
    }
  }
  const page = {
    setViewport: async () => {}, goto: async () => {}, waitForSelector: async () => {},
    evaluateOnNewDocument: async (fn) => vm.runInNewContext(`(${fn.toString()})()`, {
      navigator: {}, window, XMLHttpRequest: FakeXHR,
    }),
  };
  await api.openPage({ newPage: async () => page });
  const xhr = new FakeXHR();
  xhr.open('POST', '/getTariffListInfo'); xhr.send();
  xhr.open('POST', '/getTariffListInfo'); xhr.send();
  xhr.open('POST', '/unrelated'); xhr.send();
  assert.equal(window.__LIST_CALLS__, 2);
  assert.equal(window.__LIST_PENDING__, 0);
});
