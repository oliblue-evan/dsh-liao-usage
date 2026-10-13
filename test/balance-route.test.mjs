import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../index.js';

function route() {
  let handler;
  const ctx = {
    get: () => ({ resolve: async () => ({ value: 'test-key' }) }),
    effect: (cb) => cb(),
    sessionProjections: { register: () => () => {} },
    inject: (_keys, cb) => cb({ effect: (effect) => effect(), webServer: { register: (entry) => { handler = entry.handler; } } }),
  };
  apply(ctx);
  return async (headers = {}, method = 'POST') => {
    let status; let body;
    await handler({ method, headers: { host: 'localhost:19387', ...headers } }, {
      writeHead: (value) => { status = value; }, end: (value) => { body = value; },
    });
    return { status, body };
  };
}

test('余额路由保留同源校验与 POST 限制', async () => {
  const send = route();
  assert.equal((await send({ host: 'evil.example' })).status, 403);
  assert.equal((await send({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await send({ 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await send({}, 'GET')).status, 405);
});

test('余额自动查询复用缓存，手动刷新绕过缓存，并发刷新只请求一次', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  let release;
  const response = (balance) => ({ ok: true, json: async () => ({ balance_infos: [{ currency: 'CNY', total_balance: balance }] }) });
  globalThis.fetch = async () => { calls++; return response(String(calls)); };
  try {
    const send = route();
    assert.equal(JSON.parse((await send()).body).total, '1');
    assert.equal(JSON.parse((await send()).body).cached, true);
    assert.equal(calls, 1);
    assert.equal(JSON.parse((await send({ 'x-usage-pill-refresh': '1' })).body).total, '2');
    globalThis.fetch = () => { calls++; return new Promise((resolve) => { release = resolve; }); };
    const one = send({ 'x-usage-pill-refresh': '1' });
    const two = send({ 'x-usage-pill-refresh': '1' });
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    release(response('3'));
    assert.equal(JSON.parse((await one).body).total, '3');
    assert.equal(JSON.parse((await two).body).total, '3');
    assert.equal(calls, 3);
    const newInstance = route();
    globalThis.fetch = async () => { calls++; return response('4'); };
    assert.equal(JSON.parse((await newInstance()).body).total, '4');
  } finally { globalThis.fetch = original; }
});
