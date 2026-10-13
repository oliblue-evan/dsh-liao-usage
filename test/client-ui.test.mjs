import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import * as ReactDOM from 'react-dom';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

function fixture(account) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="mount"></div></body></html>', { url: 'http://localhost' });
  const { window } = dom;
  const prior = {};
  for (const key of ['window', 'document', 'HTMLElement', 'IS_REACT_ACT_ENVIRONMENT']) {
    prior[key] = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: key === 'IS_REACT_ACT_ENVIRONMENT' ? true : window[key] || window });
  }
  let factory;
  let fetcher = async () => ({ json: async () => ({ ok: true, total: 37, granted: 0, at: Date.now() }) });
  let height = 240;
  const frames = new Map();
  let frameId = 0;
  window.requestAnimationFrame = (cb) => { frames.set(++frameId, cb); return frameId; };
  window.cancelAnimationFrame = (id) => frames.delete(id);
  Object.defineProperties(window, { innerWidth: { value: 1200, configurable: true }, innerHeight: { value: 800, configurable: true } });
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains('umPanel')
      ? { left: 0, top: 0, width: 300, height, right: 300, bottom: height }
      : { left: 1000, top: 760, width: 100, height: 22, right: 1100, bottom: 782 };
  };
  const observers = [];
  class ResizeObserver {
    constructor(cb) { this.cb = cb; this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
  }
  vm.runInNewContext(source.replace("      inject: ['slots', 'locale'],", "      __test: { UsageMeter, UsageMeterSettings, requestBalance },\n      inject: ['slots', 'locale'],"), {
    window: Object.assign(window, { __ModuleLoader__: { load: (entry) => { factory = entry.factory; } } }),
    document: window.document, ResizeObserver, AbortController, console,
    fetch: (...args) => fetcher(...args),
  });
  const plugin = factory((name) => name === 'react' ? React : ReactDOM);
  const effects = [];
  const scope = {
    remote: { account },
    effect(callback) { const dispose = callback(); if (typeof dispose === 'function') effects.push(dispose); },
  };
  plugin.apply({
    get: () => ({ getSnapshot: () => ({ active: 'zh-CN' }) }),
    inject: (_names, cb) => cb(scope),
    effect: scope.effect,
    locale: { register() {} },
    slots: { inject: (_name, cb) => cb(), register: () => () => {} },
  });
  const root = createRoot(window.document.getElementById('mount'));
  const button = () => window.document.querySelector('.umPill');
  const panel = () => window.document.querySelector('.umPanel');
  const click = async (node) => act(async () => node.dispatchEvent(new window.MouseEvent('click', { bubbles: true })));
  return {
    window, plugin, scope, button, panel, click, frames, observers,
    async renderSettings(view = 'page', withMeter = true) {
      await act(async () => root.render(React.createElement(React.Fragment, null,
        React.createElement(plugin.__test.UsageMeterSettings, { view }),
        withMeter && React.createElement(plugin.__test.UsageMeter, { sessionId: 'settings-test',
          useProjection: (name) => name === 'tokenUsage' ? { uncachedInputTokens: 20, outputTokens: 30 } : undefined }))));
    },
    fetchWith: (fn) => { fetcher = fn; },
    async render(overrides = {}) {
      await act(async () => root.render(React.createElement(plugin.__test.UsageMeter, {
        sessionId: 'test',
        useProjection: (name) => name === 'tokenUsage' ? { cacheReadTokens: 1000, uncachedInputTokens: 20, cacheWriteTokens: 0, outputTokens: 30 } : undefined,
        ...overrides,
      })));
    },
    async resize(nextHeight) {
      height = nextHeight;
      await act(async () => {
        observers.forEach((observer) => { if (!observer.disconnected) observer.cb(); });
        const pending = [...frames.values()]; frames.clear(); pending.forEach((cb) => cb());
      });
    },
    async cleanup() {
      await act(async () => root.unmount());
      effects.forEach((fn) => fn());
      window.close();
      for (const key of Object.keys(prior)) {
        if (prior[key]) Object.defineProperty(globalThis, key, prior[key]); else delete globalThis[key];
      }
    },
  };
}

test('打开首帧完成定位，重复开关不依赖延迟帧，内容变高后仍贴住入口', async () => {
  const f = fixture();
  try {
    await f.render();
    for (let i = 0; i < 3; i++) {
      await f.click(f.button());
      assert.equal(f.panel().style.visibility, 'visible');
      assert.equal(f.panel().style.left, '888px'); // 1200 - 300 - 12
      assert.equal(f.panel().style.top, '512px');
      assert.equal(f.button().getAttribute('aria-controls'), f.panel().id);
      await f.click(f.button());
      assert.equal(f.panel(), null);
    }
    await f.click(f.button());
    await f.resize(360);
    assert.equal(f.panel().style.top, '392px');
  } finally { await f.cleanup(); }
  assert.equal(f.frames.size, 0);
  assert.ok(f.observers.every((observer) => observer.disconnected));
});

test('弹层内部操作不关闭，Escape 和关闭按钮返回入口焦点，外点关闭', async () => {
  const f = fixture();
  try {
    await f.render();
    await f.click(f.button());
    const refresh = f.panel().querySelector('.umRefresh');
    await act(async () => refresh.dispatchEvent(new f.window.Event('pointerdown', { bubbles: true })));
    await f.click(refresh);
    assert.ok(f.panel());
    await act(async () => f.window.document.dispatchEvent(new f.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    assert.equal(f.panel(), null);
    assert.equal(f.window.document.activeElement, f.button());
    await f.click(f.button());
    await f.click(f.panel().querySelector('.umClose'));
    assert.equal(f.panel(), null);
    assert.equal(f.window.document.activeElement, f.button());
    await f.click(f.button());
    await act(async () => f.window.document.body.dispatchEvent(new f.window.Event('pointerdown', { bubbles: true })));
    assert.equal(f.panel(), null);
  } finally { await f.cleanup(); }
});

test('余额失败仍有重试按钮，重试成功后显示余额，再次失败保留并标注上次数据', async () => {
  const f = fixture();
  let fail = true;
  let calls = 0;
  f.fetchWith(async () => { calls++; return { json: async () => fail
    ? { ok: false, error: 'Network down sk-1234567890' }
    : { ok: true, total: 37, granted: 0, at: Date.now() } }; });
  try {
    await f.render();
    await f.click(f.button());
    assert.match(f.panel().textContent, /余额暂不可用/);
    const refresh = f.panel().querySelector('.umRefresh');
    assert.equal(refresh.getAttribute('aria-label'), '重试查询余额');
    assert.ok(!refresh.title.includes('sk-1234567890'));
    fail = false;
    await f.click(refresh);
    assert.match(f.panel().textContent, /¥37.00/);
    fail = true;
    await f.click(f.panel().querySelector('.umRefresh'));
    assert.match(f.panel().textContent, /¥37.00/);
    assert.match(f.panel().textContent, /刷新失败/);
    assert.ok(calls >= 3);
  } finally { await f.cleanup(); }
});

test('进行中的余额请求去重，成功结果复用', async () => {
  const f = fixture();
  let resolve;
  let calls = 0;
  f.fetchWith(() => { calls++; return new Promise((done) => { resolve = done; }); });
  try {
    const one = f.plugin.__test.requestBalance(true);
    const two = f.plugin.__test.requestBalance(true);
    assert.equal(one, two);
    await Promise.resolve(); await Promise.resolve();
    resolve({ json: async () => ({ ok: true, total: 8, at: Date.now() }) });
    const result = await one;
    assert.equal(result.balance.wallets[0].total, 8);
    await f.plugin.__test.requestBalance(false);
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});


test('账号返回失败保留真实原因，API Key 兜底成功仍可用', async () => {
  const f = fixture({ getBalance: async () => ({ ok: false, error: { message: 'Account offline' } }) });
  try {
    const result = await f.plugin.__test.requestBalance(true);
    assert.equal(result.accountError, 'Account offline');
    assert.equal(result.balance.wallets[0].total, 37);
    assert.equal(result.error, null);
  } finally { await f.cleanup(); }
});

test('余额接口超时结束查询并中止请求，后续允许重试', async () => {
  const f = fixture();
  let timeout;
  let signal;
  const originalTimeout = f.window.setTimeout;
  f.window.setTimeout = (cb) => { timeout = cb; return 1; };
  f.window.clearTimeout = () => {};
  f.fetchWith((_url, options) => { signal = options.signal; return new Promise(() => {}); });
  try {
    const request = f.plugin.__test.requestBalance(true);
    await Promise.resolve(); await Promise.resolve();
    timeout();
    const result = await request;
    assert.match(result.error, /timed out/);
    assert.equal(signal.aborted, true);
    f.window.setTimeout = originalTimeout;
    f.fetchWith(async () => ({ json: async () => ({ ok: true, total: 5 }) }));
    assert.equal((await f.plugin.__test.requestBalance(true)).balance.wallets[0].total, 5);
  } finally { await f.cleanup(); }
});


test('仅显示余额但查询失败时保留费用入口', async () => {
  const f = fixture();
  f.window.localStorage.setItem('usage-pill.settings.v1', JSON.stringify({ pillPeriod: false, pillCost: false, pillBalance: true }));
  f.fetchWith(async () => ({ json: async () => ({ ok: false, error: 'Network unavailable' }) }));
  try {
    await f.render();
    assert.match(f.button().textContent, /¥/);
    await f.click(f.button());
    assert.ok(f.panel());
  } finally { await f.cleanup(); }
});

test('人民币余额优先展示，美元不按数字大小混为主币种', async () => {
  const f = fixture({ getBalance: async () => ({ ok: true, value: {
    status: 'ready', value: [{ currency: 'USD', balance: 100 }, { currency: 'CNY', balance: 10 }], bonusWallets: [],
  } }) });
  try {
    await f.render();
    assert.match(f.button().getAttribute('aria-label'), /余 ¥10.00/);
    await f.click(f.button());
    assert.match(f.panel().textContent, /\+\$100.00/);
  } finally { await f.cleanup(); }
});


test('历史计价标为参考费用，余额仍显示接口返回值', async () => {
  const f = fixture();
  try {
    await f.render({ useProjection: (name) => name === 'usagePillCost'
      ? { pricedRequests: 1, unpricedRequests: 0, totalCny: 2, missCny: 2 } : undefined });
    assert.match(f.button().textContent, /≈¥2.00/);
    assert.match(f.button().textContent, /余 ¥37.00/);
    await f.click(f.button());
    assert.match(f.panel().textContent, /本会话参考费用/);
    assert.match(f.panel().textContent, /渠道账单可能不同/);
  } finally { await f.cleanup(); }
});

test('设置开关同步真实胶囊与示例，恢复默认只改变显示偏好', async () => {
  const f = fixture();
  try {
    let calls = 0;
    f.fetchWith(async () => { calls++; throw new Error('preview must not fetch'); });
    f.window.document.querySelector('style[data-dsh-style="usage-pill"]').remove();
    await f.renderSettings('page', false);
    assert.ok(f.window.document.querySelector('style[data-dsh-style="usage-pill"]').textContent.includes('.umSettingsCard'), '独立重挂载设置槽也能恢复样式');
    assert.equal(calls, 0, '设置示例自身不查询账号');
    await f.renderSettings();
    const before = calls;
    const settings = () => f.window.document.querySelector('.umSettings');
    const switchFor = (name) => [...settings().querySelectorAll('[role="switch"]')].find((node) => node.getAttribute('aria-label') === name);
    const reset = () => settings().querySelector('.umSettingsButton');
    assert.equal(reset().disabled, true);
    assert.ok(settings().querySelector('.umPreviewPill svg'));
    await f.click(switchFor('徽标显示时段图标'));
    assert.equal(settings().querySelector('.umPreviewPill svg'), null);
    assert.equal(f.button().querySelector('svg'), null);
    await f.click(switchFor('徽标显示参考费用'));
    await f.click(switchFor('徽标显示账户余额'));
    assert.ok(settings().querySelector('.umPreviewPill').textContent.includes('≈¥'));
    assert.ok(f.button().textContent.includes('≈¥'), '全部关闭仍有真实详情入口');
    await f.click(switchFor('隐藏没有用量的项目'));
    assert.ok(settings().querySelector('.umDetailPreview').textContent.includes('缓存写入'));
    await f.click(switchFor('显示「缓存已省」'));
    assert.ok(!settings().querySelector('.umDetailPreview').textContent.includes('缓存已省'));
    assert.equal(calls, before, '修改设置不额外查询账号');
    await f.click(reset());
    assert.ok([...settings().querySelectorAll('[role="switch"]')].every((node) => node.getAttribute('aria-checked') === 'true'));
    assert.ok(settings().querySelector('[role="status"]').textContent.includes('已恢复'));
    assert.equal(reset().disabled, true);
    const persisted = JSON.parse(f.window.localStorage.getItem('usage-pill.settings.v1'));
    assert.deepEqual(Object.keys(persisted).sort(), ['pillPeriod', 'pillCost', 'pillBalance', 'hideEmptyBuckets', 'showSaved'].sort());
    assert.ok(Object.values(persisted).every((value) => value === true));
    assert.ok(f.button().querySelector('svg'));
  } finally { await f.cleanup(); }
});

test('设置仅显示在详情页，重新挂载保留显示偏好', async () => {
  const f = fixture();
  try {
    await f.renderSettings();
    await f.click(f.window.document.querySelector('[aria-label="徽标显示时段图标"]'));
    await f.render();
    await f.renderSettings();
    assert.equal(f.window.document.querySelector('[aria-label="徽标显示时段图标"]').getAttribute('aria-checked'), 'false');
    await f.renderSettings('row');
    assert.equal(f.window.document.querySelector('.umSettings'), null);
  } finally { await f.cleanup(); }
});
