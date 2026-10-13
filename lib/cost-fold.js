/**
 * `usagePillCost` 投影的**纯折叠逻辑**（零依赖之外的唯一 import 是计价内核）。
 *
 * 与 `cost-projection.js` 分开是有意的：那边只负责 zod schema 与注册接线，
 * 这边是纯粹的 state → state 折叠，可以在 workspace 里直接 import 单测
 * （zod 在 DSH 的 asar 里，普通 node 进程解析不到）。
 *
 * 折叠口径：
 *   · `request/header` 记录当前路由（provider/model），供后续用量取价；
 *   · `assistant/message` / `assistant/attempt` 携带用量，按其**自身时刻**计价；
 *   · 同一 turn+step 后到的**替换**先到的（重发一次 = 改一次金额，不叠加）；
 *   · `llm/retry-started` 关闭替换槽，让重试**累加**（那是另一次真实计费调用）。
 */

import { bucketsFromUsage, costOfBuckets, rateAt, usageOfEvent } from './pricing.js';

/** 金额保留 4 位小数。 */
export const round = (value) => Math.round(value * 1e4) / 1e4;

/** 零金额。 */
export function zeroMoney() {
  return { cacheReadCny: 0, missCny: 0, writeCny: 0, outputCny: 0, peakCny: 0, offPeakCny: 0 };
}

/** 零累计。 */
export function zeroTotals() {
  return { ...zeroMoney(), pricedRequests: 0, unpricedRequests: 0 };
}

/**
 * 按模型分组的累计（键 = 模型 id）。
 *
 * 【为什么要它】`totals` 是**跨模型累加**的：换过模型之后，"本会话花费 ¥9.37"
 * 里混着 flash 与 pro（甚至第三方折算）的钱，而单价列显示的却是**当前**模型的价 ——
 * 两者一相除得到的 token 数是错的，也让人无法跨模型比价。
 * 这一层让面板能说清"每个模型各花了多少"。
 *
 * @returns 空的分模型累计。
 */
export function zeroByModel() {
  return {};
}

/** 初始折叠状态。 */
export function initState() {
  return { route: null, totals: zeroTotals(), byModel: zeroByModel(), last: null };
}

/**
 * 取一个样本归属的模型键。
 * @param sample - 样本。
 * @returns 模型 id；没有路由（未计价）时为 null。
 */
function modelKeyOf(sample) {
  return typeof sample.model === 'string' && sample.model !== '' ? sample.model : null;
}

/**
 * 把一份样本加进（或从）分模型累计里移除。
 *
 * 与 `totals` 一样要支持**回退**（同一 turn+step 后到替换先到），所以按样本
 * 当初记录的模型回退，而不是按"现在这个模型" —— 中途换过模型时这两者可能不同。
 *
 * @param byModel - 当前分模型累计。
 * @param sample - 样本。
 * @param direction - 1 加入，-1 移除。
 * @returns 新的分模型累计（不改动入参）。
 */
export function adjustByModel(byModel, sample, direction) {
  const key = modelKeyOf(sample);
  if (key === null) return byModel;
  const current = byModel[key] === undefined ? zeroMoney() : byModel[key];
  const next = {};
  for (const field of Object.keys(current)) next[field] = current[field] + direction * sample[field];
  const updated = { ...byModel, [key]: next };
  // 全部归零的模型删掉，避免"0 元模型"占位（替换/回退后常见）
  if (Object.values(next).every((value) => value === 0)) delete updated[key];
  return updated;
}

/**
 * 把一份样本加进（或从）累计里。
 * @param totals - 当前累计。
 * @param sample - 样本。
 * @param direction - 1 加入，-1 移除。
 * @returns 调整后的累计。
 */
export function adjustTotals(totals, sample, direction) {
  return {
    cacheReadCny: totals.cacheReadCny + direction * sample.cacheReadCny,
    missCny: totals.missCny + direction * sample.missCny,
    writeCny: totals.writeCny + direction * sample.writeCny,
    outputCny: totals.outputCny + direction * sample.outputCny,
    peakCny: totals.peakCny + direction * sample.peakCny,
    offPeakCny: totals.offPeakCny + direction * sample.offPeakCny,
    pricedRequests: totals.pricedRequests + direction * (sample.priced ? 1 : 0),
    unpricedRequests: totals.unpricedRequests + direction * (sample.priced ? 0 : 1),
  };
}

/**
 * 给一笔用量定价。
 * @param route - 当时的 provider/model。
 * @param usage - provider 上报的用量。
 * @param time - 事件时刻（UTC 毫秒）。
 * @returns 已定价样本。
 */
export function sampleFor(route, usage, time) {
  const rate = rateAt(route.model, time);
  const buckets = bucketsFromUsage(usage);
  const cost = costOfBuckets(buckets, rate);
  // costOfBuckets 把"缓存写入"并进了未命中价，这里拆开，便于界面逐行显示
  const writeCny = (buckets.cacheWrite * rate.miss) / 1e6;
  const peak = rate.regime === 'peak';
  return {
    // 记录归属模型：替换/回退时要按**当初**的模型退回，不能按"现在这个模型"
    model: route.model,
    cacheReadCny: cost.hit,
    missCny: cost.miss - writeCny,
    writeCny,
    outputCny: cost.out,
    peakCny: peak ? cost.total : 0,
    offPeakCny: peak ? 0 : cost.total,
    priced: true,
  };
}

/**
 * 折叠一条事件。
 * @param state - 当前状态。
 * @param event - 一条会话事件。
 * @returns 下一个状态。
 */
export function applyEvent(state, event) {
  if (event.type === 'request/header') {
    const call = event.data && event.data.header ? event.data.header.config : undefined;
    if (call === undefined) return state;
    return { ...state, route: { provider: call.provider, model: call.model } };
  }
  if (event.type === 'llm/retry-started') {
    return state.last !== null && state.last.turn === event.data.turn && state.last.step === event.data.step
      ? { ...state, last: null }
      : state;
  }
  if (event.type !== 'assistant/message' && event.type !== 'assistant/attempt') return state;

  const { turn, step } = event.data;
  const usage = usageOfEvent(event);
  if (usage === undefined) return state;

  const previous = state.last !== null && state.last.turn === turn && state.last.step === step
    ? state.last.sample
    : undefined;
  const sample = state.route === null
    ? { ...zeroMoney(), model: null, priced: false }
    : sampleFor(state.route, usage, event.time);
  const base = previous === undefined ? state.totals : adjustTotals(state.totals, previous, -1);
  const baseModel = previous === undefined ? state.byModel : adjustByModel(state.byModel, previous, -1);
  return {
    ...state,
    totals: adjustTotals(base, sample, 1),
    byModel: adjustByModel(baseModel, sample, 1),
    last: { turn, step, sample },
  };
}

/**
 * 折叠状态 → 线上视图（浏览器读到的形状）。
 * @param state - 折叠状态。
 * @param currency - 计价货币。
 * @returns 视图对象。
 */
export function viewOf(state, currency) {
  const totals = state.totals;
  const byModel = state.byModel === undefined || state.byModel === null ? zeroByModel() : state.byModel;
  // 每个模型补一个 totalCny（界面直接用，不必自己加）
  const models = {};
  for (const key of Object.keys(byModel)) {
    const money = byModel[key];
    models[key] = {
      cacheReadCny: round(money.cacheReadCny),
      missCny: round(money.missCny),
      writeCny: round(money.writeCny),
      outputCny: round(money.outputCny),
      totalCny: round(money.cacheReadCny + money.missCny + money.writeCny + money.outputCny),
    };
  }
  return {
    currency,
    cacheReadCny: round(totals.cacheReadCny),
    missCny: round(totals.missCny),
    writeCny: round(totals.writeCny),
    outputCny: round(totals.outputCny),
    totalCny: round(totals.cacheReadCny + totals.missCny + totals.writeCny + totals.outputCny),
    peakCny: round(totals.peakCny),
    offPeakCny: round(totals.offPeakCny),
    pricedRequests: totals.pricedRequests,
    unpricedRequests: totals.unpricedRequests,
    byModel: models,
  };
}
