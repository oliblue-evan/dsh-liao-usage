/**
 * `usagePillCost` 会话投影（宿主半侧）—— 接线层。
 *
 * 折叠逻辑本身在 `cost-fold.js`（纯函数、可单测）；这里只放 schema 与
 * `ctx.sessionProjections.register()` 需要的定义形状。
 *
 * schema 用的是自带的 `schema.js` 而不是 zod —— 原因见那个文件的注释：
 * 裸模块名在 `link:` 安装下解析不到会让整个宿主半边加载失败。
 *
 * 【为什么必须有这个投影】
 *   浏览器只能读到 `tokenUsage` 投影的**累计四个桶**，拿不到"这一笔是什么时候、
 *   什么模型花的"。用累计桶 × 当前价 × 当前时刻去算，会犯两个错：
 *     · 跨过峰谷边界后，历史花费被追溯改写（高峰那部分按空闲价重算）；
 *     · 会话中途换模型后，整段历史按新档位计价（pro 的未命中价是 flash 的 4.5 倍）。
 *   本投影按每条事件**自身的时刻**与它前面那条 `request/header` 的模型计价，
 *   所以金额是实际发生额，不随之后的时间或模型变化。
 */

import { applyEvent, initState, viewOf } from './cost-fold.js';
import { bool, count, nonNeg, nullableOf, object, recordOf, str, strLen } from './schema.js';

/** 计价货币。 */
const CURRENCY = 'CNY';

/** 金额字段（元）。 */
const moneyFields = {
  cacheReadCny: nonNeg(),
  missCny: nonNeg(),
  writeCny: nonNeg(),
  outputCny: nonNeg(),
  peakCny: nonNeg(),
  offPeakCny: nonNeg(),
};

/**
 * 一个样本（已定价或未定价）。
 *
 * `model` 记录这笔归属的模型 —— 替换/回退时要按**当初**的模型退回分桶累计，
 * 不能按"现在这个模型"（中途换过模型时两者不同）。未定价时为 null。
 */
const sampleSchema = object({ ...moneyFields, model: nullableOf(str()), priced: bool() });

/** 一个模型的分桶累计（折叠态）。 */
const modelMoneySchema = object({ ...moneyFields });

/** 折叠状态 schema。 */
const stateSchema = object({
  route: nullableOf(object({ provider: str(), model: str() })),
  totals: object({
    ...moneyFields,
    pricedRequests: count(),
    unpricedRequests: count(),
  }),
  /** 按模型分组（键 = 模型 id）。`totals` 是跨模型累加的，换过模型后看不出各花了多少。 */
  byModel: recordOf(modelMoneySchema),
  /** 替换槽：同一 turn+step 上一个样本，后到时先减掉它。 */
  last: nullableOf(object({
    turn: count(),
    step: count(),
    sample: sampleSchema,
  })),
});

/** 线上视图 schema。 */
const viewSchema = object({
  currency: strLen(3),
  ...moneyFields,
  totalCny: nonNeg(),
  pricedRequests: count(),
  unpricedRequests: count(),
  /** 按模型分组的金额（界面据此显示"每个模型各花多少"）。 */
  byModel: recordOf(object({
    cacheReadCny: nonNeg(),
    missCny: nonNeg(),
    writeCny: nonNeg(),
    outputCny: nonNeg(),
    totalCny: nonNeg(),
  })),
});

/**
 * 构建 `usagePillCost` 投影单元。
 * @returns 投影定义（交给 `ctx.sessionProjections.register`）。
 */
export function createCostUsageProjection() {
  return {
    key: 'usagePillCost',
    // v2：状态与视图新增 `byModel`（按模型分组累计）。**形状变了必须升版本** ——
    // 框架对 `ver` 与 stateVersion 不符的 checkpoint 是"读时丢弃、从事件重建"
    // （见 dsh-session-projection-cache），于是旧缓存里缺 byModel 的状态会被重建，
    // 而不是在 `stateSchema.parse` 上抛错、让整个单元静默不可用。
    stateVersion: 2,
    stateSchema,
    init: initState,
    apply: applyEvent,
    wire: {
      viewSchema,
      view: (state) => viewOf(state, CURRENCY),
    },
  };
}
