/**
 * 投影的注册契约与框架行为对齐（**这是不重启也能验证宿主半边的关键测试**）。
 *
 * 我查过 `@deepseek-ai/dsh-session-projection` 的实现，它对投影单元只做三件事：
 *   1. `register()` 校验 `stateVersion` 是"非负安全整数"，同键不同版本会直接抛错；
 *   2. 恢复 checkpoint 时 `stateSchema.parse(row.val)`（失败则跳过该单元）；
 *   3. 出视图时 `viewSchema.parse(view(state))`。
 * 这里就把这三条逐一跑一遍，外加 JSON 往返 —— 状态要真能过自己的 schema。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createCostUsageProjection } from '../lib/cost-projection.js';

const def = createCostUsageProjection();
/** 北京时间某时刻对应的 UTC 毫秒。 */
const bj = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh - 8, mm);

test('注册契约：字段齐备、stateVersion 合法、key 带自己的命名空间', () => {
  assert.equal(def.key, 'usagePillCost', '键名必须带命名空间，避免与别的插件共享同一个 unit');
  assert.ok(Number.isSafeInteger(def.stateVersion) && def.stateVersion >= 0, '框架会校验这一条');
  // v2 = 状态与视图新增 byModel。**形状变了必须升版本**：框架对 `ver` 与 stateVersion
  // 不符的 checkpoint 是"读时丢弃、从事件重建"（dsh-session-projection-cache）。
  // 不升版本的话，旧缓存缺 byModel 会在 stateSchema.parse 上抛错 → 整个单元静默失效，
  // 面板退化成"按当前价估算"，而且没人知道为什么。
  assert.equal(def.stateVersion, 2, '改状态形状时必须升 stateVersion');
  assert.equal(typeof def.init, 'function');
  assert.equal(typeof def.apply, 'function');
  assert.equal(typeof def.stateSchema.parse, 'function');
  assert.equal(typeof def.wire.view, 'function');
  assert.equal(typeof def.wire.viewSchema.parse, 'function');
});

test('状态始终能过自己的 schema（含 checkpoint 的 JSON 往返）', () => {
  const events = [
    { type: 'request/header', time: bj(2026, 9, 29, 10, 0), data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4-flash' } } } },
    { type: 'assistant/message', time: bj(2026, 9, 29, 10, 0), data: { turn: 1, step: 1, usage: { inputTokens: 1e6, cacheReadTokens: 1e6, outputTokens: 1e6 } } },
    { type: 'assistant/message', time: bj(2026, 9, 29, 8, 0), data: { turn: 2, step: 1, usage: { inputTokens: 5e5, outputTokens: 2e5 } } },
    { type: 'llm/retry-started', time: bj(2026, 9, 29, 8, 0), data: { turn: 2, step: 1 } },
    { type: 'assistant/message', time: bj(2026, 9, 29, 8, 0), data: { turn: 2, step: 1, usage: { inputTokens: 5e5, outputTokens: 2e5 } } },
  ];
  let state = def.init();
  // 初始状态（还没路由）也要合法
  def.stateSchema.parse(state);
  for (const event of events) {
    state = def.apply(state, event);
    def.stateSchema.parse(state);
    // 框架恢复 checkpoint 时会先 JSON 序列化再 parse，这里照样来一遍
    def.stateSchema.parse(JSON.parse(JSON.stringify(state)));
  }
  assert.notEqual(state.route, null, 'request/header 之后应记下路由');
});

test('视图能过 viewSchema，且数字与折叠结果一致', () => {
  const state = [
    { type: 'request/header', time: bj(2026, 9, 29, 10, 0), data: { header: { config: { provider: 'deepseek', model: 'deepseek-v4-flash' } } } },
    { type: 'assistant/message', time: bj(2026, 9, 29, 10, 0), data: { turn: 1, step: 1, usage: { inputTokens: 1e6, cacheReadTokens: 1e6, outputTokens: 1e6 } } },
  ].reduce((acc, event) => def.apply(acc, event), def.init());
  const view = def.wire.viewSchema.parse(def.wire.view(state));
  assert.equal(view.currency, 'CNY');
  assert.equal(view.totalCny, 10.04, '高峰 flash：命中 .04 + 未命中 2 + 输出 8');
  assert.equal(view.pricedRequests, 1);
  assert.deepEqual(Object.keys(view).sort(), [
    'byModel', 'cacheReadCny', 'currency', 'missCny', 'offPeakCny', 'outputCny',
    'peakCny', 'pricedRequests', 'totalCny', 'unpricedRequests', 'writeCny',
  ].sort(), 'view 的字段应与客户端读取的一致');
  assert.deepEqual(Object.keys(view.byModel), ['deepseek-v4-flash'], '按模型 id 分组');
  assert.deepEqual(Object.keys(view.byModel['deepseek-v4-flash']).sort(), [
    'cacheReadCny', 'missCny', 'outputCny', 'totalCny', 'writeCny',
  ].sort(), '每个模型的分桶与顶层同名，界面可直接复用渲染');
});

test('未识别的键不会误判：apply 遇到无关事件返回原状态引用', () => {
  const state = def.init();
  assert.equal(def.apply(state, { type: 'tool/result', time: Date.now(), data: {} }), state, '无关事件不该产生新对象');
});

test('缺 byModel 的旧版本 checkpoint 会被 parse 拒绝（从而触发重建）', () => {
  // 钉住"为什么必须升 stateVersion"：不升就会拿旧形状去 parse 新 schema，
  // 结果是投影单元静默不可用，面板悄悄退化成估算。
  const legacy = {
    route: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    totals: {
      cacheReadCny: 0, missCny: 0, writeCny: 0, outputCny: 0, peakCny: 0, offPeakCny: 0,
      pricedRequests: 0, unpricedRequests: 0,
    },
    last: null,
  };
  assert.throws(() => def.stateSchema.parse(legacy), /byModel/, '缺 byModel 的旧状态应被拒绝');
});
