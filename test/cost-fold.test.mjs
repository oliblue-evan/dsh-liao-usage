/**
 * usagePillCost 折叠的断言 —— 这是"金额按实际发生额"这条修复的核心。
 *
 * 重点覆盖三件容易做错的事：
 *   · 每笔用量按**它自己那一刻**的峰谷计价（不是按"现在"）；
 *   · 每笔用量按**它当时那个模型**计价（中途换模型不改写历史）；
 *   · 同一 turn+step 后到替换先到，而 llm/retry-started 之后的重试要累加。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, initState, viewOf } from '../lib/cost-fold.js';

/** 北京时间某时刻对应的 UTC 毫秒。 */
const bj = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh - 8, mm);
/** 周二 10:00（高峰）与 08:00（空闲）。 */
const PEAK = bj(2026, 9, 29, 10, 0);
const OFF = bj(2026, 9, 29, 8, 0);

/** 一条 request/header（provider 默认走 DeepSeek 官方）。 */
const route = (model, provider = 'deepseek') => ({
  type: 'request/header', time: PEAK, data: { header: { config: { provider, model } } },
});
/** 一条带用量的 assistant/message。 */
const message = (turn, step, time, usage) => ({ type: 'assistant/message', time, data: { turn, step, usage } });

/** 每桶各 100 万 token 的用量。 */
const ONE_MILLION_EACH = { inputTokens: 1e6, cacheReadTokens: 1e6, outputTokens: 1e6 };

/** 依次折叠一串事件。 */
function fold(events) {
  return events.reduce((state, event) => applyEvent(state, event), initState());
}

test('按事件自身的时刻计价：高峰与空闲各归各的', () => {
  const state = fold([
    route('deepseek-v4-flash'),
    message(1, 1, PEAK, ONE_MILLION_EACH),
    message(2, 1, OFF, ONE_MILLION_EACH),
  ]);
  const view = viewOf(state, 'CNY');
  // 高峰：hit .04 + miss 2 + out 8 = 10.04；空闲：.02 + 1 + 4 = 5.02
  assert.equal(view.peakCny, 10.04);
  assert.equal(view.offPeakCny, 5.02);
  assert.equal(view.totalCny, 15.06);
  assert.equal(view.pricedRequests, 2);
});

test('按当时的模型计价：中途换档不改写历史', () => {
  const state = fold([
    route('deepseek-v4-flash'),
    message(1, 1, PEAK, ONE_MILLION_EACH),
    route('deepseek-v4-pro'),
    message(2, 1, PEAK, ONE_MILLION_EACH),
  ]);
  // flash 高峰 10.04；pro 高峰 hit .3 + miss 9 + out 27 = 36.3
  assert.equal(viewOf(state, 'CNY').totalCny, 46.34);
});

test('同一 turn+step 后到替换先到（不是累加）', () => {
  const half = { inputTokens: 5e5, cacheReadTokens: 5e5, outputTokens: 5e5 };
  const state = fold([
    route('deepseek-v4-flash'),
    message(1, 1, PEAK, ONE_MILLION_EACH),
    message(1, 1, PEAK, half),
  ]);
  const view = viewOf(state, 'CNY');
  assert.equal(view.totalCny, 5.02, '应只剩后到那一笔的一半金额');
  assert.equal(view.pricedRequests, 1, '替换不应增加请求计数');
});

test('llm/retry-started 之后的重试要累加（那是另一次真实计费调用）', () => {
  const state = fold([
    route('deepseek-v4-flash'),
    message(2, 1, PEAK, ONE_MILLION_EACH),
    { type: 'llm/retry-started', time: PEAK, data: { turn: 2, step: 1 } },
    message(2, 1, PEAK, ONE_MILLION_EACH),
  ]);
  const view = viewOf(state, 'CNY');
  assert.equal(view.totalCny, 20.08, '两次调用都要计费');
  assert.equal(view.pricedRequests, 2);
});

test('缓存写入单独成列，且按未命中单价计', () => {
  const state = fold([
    route('deepseek-v4-flash'),
    message(1, 1, PEAK, { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 1e6, outputTokens: 0 }),
  ]);
  const view = viewOf(state, 'CNY');
  assert.equal(view.writeCny, 2, '1M 写入 × 高峰 miss 价 2');
  assert.equal(view.missCny, 0, '未命中桶不应被写入污染');
  assert.equal(view.totalCny, 2);
});

test('没有路由信息时记为未计价，而不是按 0 价计', () => {
  const state = fold([message(1, 1, PEAK, ONE_MILLION_EACH)]);
  const view = viewOf(state, 'CNY');
  assert.equal(view.pricedRequests, 0);
  assert.equal(view.unpricedRequests, 1);
  assert.equal(view.totalCny, 0);
});

test('视图金额保留 4 位小数', () => {
  const state = fold([
    route('deepseek-v4-flash'),
    // 1 token 输出 → 8 / 1e6 = 0.000008，四舍五入到 4 位应为 0
    message(1, 1, PEAK, { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
  ]);
  assert.equal(viewOf(state, 'CNY').missCny, 0);
  const state2 = fold([
    route('deepseek-v4-flash'),
    message(1, 1, PEAK, { inputTokens: 1000, outputTokens: 0 }),
  ]);
  assert.equal(viewOf(state2, 'CNY').missCny, 0.002);
});

/* ══ 按模型分组累计（跨模型比价的关键）══════════════════════════════════
 * `totals` 是跨模型累加的：换过模型后"本会话花费"里混着几档价，而单价列显示的
 * 是**当前**模型的价 —— 两者一相除得到的 token 数是错的，也没法跨模型比价。
 * `byModel` 让面板能说清"每个模型各花了多少"。
 */

test('分模型累计：各记各的，且之和等于合计', () => {
  const view = viewOf(fold([
    route('deepseek-v4-flash'),
    message(1, 1, PEAK, ONE_MILLION_EACH),        // flash 高峰 10.04
    route('deepseek-v4-pro'),
    message(2, 1, PEAK, ONE_MILLION_EACH),        // pro   高峰 36.30
  ]), 'CNY');
  assert.deepEqual(Object.keys(view.byModel).sort(), ['deepseek-v4-flash', 'deepseek-v4-pro']);
  assert.equal(view.byModel['deepseek-v4-flash'].totalCny, 10.04);
  assert.equal(view.byModel['deepseek-v4-pro'].totalCny, 36.3);
  const sum = view.byModel['deepseek-v4-flash'].totalCny + view.byModel['deepseek-v4-pro'].totalCny;
  assert.equal(Math.round(sum * 1e4) / 1e4, view.totalCny, '分模型之和必须等于合计');
});

test('同模型多次用量累加进同一个键（不按请求拆行）', () => {
  const view = viewOf(fold([
    route('deepseek-v4-flash'),
    message(1, 1, PEAK, ONE_MILLION_EACH),
    message(2, 1, OFF, ONE_MILLION_EACH),         // 同模型、空闲时段
  ]), 'CNY');
  assert.deepEqual(Object.keys(view.byModel), ['deepseek-v4-flash'], '应只有一个键');
  assert.equal(view.byModel['deepseek-v4-flash'].totalCny, view.totalCny);
  assert.equal(view.totalCny, 15.06, '高峰 10.04 + 空闲 5.02');
});

test('替换回退按**当初的模型**退，不是按当前模型', () => {
  // 同一 turn+step 的替换，但两次发生在**不同模型**下（重试时换了模型）。
  // 回退必须从**当初**那个桶（flash）扣 —— 若按"当前模型"（pro）扣，
  // pro 桶会被扣成负数、flash 桶则永远留着那笔已作废的钱。
  const half = { inputTokens: 5e5, cacheReadTokens: 5e5, outputTokens: 5e5 };
  const view = viewOf(fold([
    route('deepseek-v4-flash'),
    message(1, 1, PEAK, ONE_MILLION_EACH),        // flash 高峰 10.04
    route('deepseek-v4-pro'),
    message(1, 1, PEAK, half),                    // 同 turn+step 替换，此刻是 pro
  ]), 'CNY');
  assert.deepEqual(Object.keys(view.byModel), ['deepseek-v4-pro'],
    'flash 桶应被完整回退并删除（回退认的是当初的模型）');
  assert.equal(view.byModel['deepseek-v4-pro'].totalCny, 18.15, 'pro 桶只记新那笔（36.3 的一半）');
  assert.equal(view.totalCny, 18.15, '合计也应只剩这一笔');
  assert.ok(
    Object.values(view.byModel).every((money) => Object.values(money).every((v) => v >= 0)),
    '任何分桶都不该为负',
  );
});

test('金额被完全回退掉的模型键会被删除，不留 0 元占位', () => {
  const view = viewOf(fold([
    route('deepseek-v4-pro'),
    message(1, 1, PEAK, ONE_MILLION_EACH),
    message(1, 1, PEAK, { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }),
    route('deepseek-v4-flash'),
    message(2, 1, PEAK, ONE_MILLION_EACH),
  ]), 'CNY');
  assert.deepEqual(Object.keys(view.byModel), ['deepseek-v4-flash'], 'pro 归零后应被删掉');
});

test('没有路由信息时不产生任何模型键', () => {
  const view = viewOf(fold([message(1, 1, PEAK, ONE_MILLION_EACH)]), 'CNY');
  assert.deepEqual(view.byModel, {}, '未计价的用量不该凭空造一个键');
  assert.equal(view.unpricedRequests, 1);
});

test('第三方 provider 的用量也按模型名归组（当前口径：一律按 DeepSeek 价目折算）', () => {
  const view = viewOf(fold([
    route('qfmodel', 'qodercn'),
    message(1, 1, PEAK, ONE_MILLION_EACH),
  ]), 'CNY');
  assert.deepEqual(Object.keys(view.byModel), ['qfmodel']);
  assert.equal(view.byModel.qfmodel.totalCny, 36.3, '名字不含 flash → 按 pro 档折算');
});
