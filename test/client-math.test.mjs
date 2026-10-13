/**
 * 浏览器半边"纯逻辑"的断言（从 client.js 按章节边界抽出后求值）。
 *
 * 覆盖：时段判定与下次切换、档位取价、四桶计价、格式化边界，
 * 以及两条余额链路的归一化（含**跨币种不再相加**这条修复）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientScope } from './extract-client.mjs';

const c = clientScope([
  'BJ_OFFSET_MS', 'PEAK_WINDOWS', 'CN_STATUTORY_HOLIDAYS', 'PRICE_SCHEDULES',
  'isPeakAt', 'beijingClock', 'nextSwitchAt', 'tierOfModel', 'scheduleAt', 'costOf',
  'totalTokens', 'fmtCountdown', 'fmtBeijing', 'fmtExactTokens', 'fmtMoney', 'symbolOf',
  'fromAccountBalance', 'fromKeyBalance', 'visibleRows', 'normalizeSettings', 'SETTINGS_DEFAULTS',
  'separatorBefore', 'modelRowsOf',
]);

/** 北京时间某时刻对应的 UTC 毫秒。 */
const bj = (y, m, d, hh, mm) => Date.UTC(y, m - 1, d, hh - 8, mm);

test('时段判定：窗口左闭右开，周末与法定节假日整天低峰', () => {
  assert.equal(c.isPeakAt(bj(2026, 9, 29, 8, 59)), false);
  assert.equal(c.isPeakAt(bj(2026, 9, 29, 9, 0)), true);
  assert.equal(c.isPeakAt(bj(2026, 9, 29, 11, 59)), true);
  assert.equal(c.isPeakAt(bj(2026, 9, 29, 12, 0)), false, '12:00 右开');
  assert.equal(c.isPeakAt(bj(2026, 9, 29, 14, 0)), true);
  assert.equal(c.isPeakAt(bj(2026, 9, 29, 18, 0)), false, '18:00 右开');
  assert.equal(c.isPeakAt(bj(2026, 9, 19, 10, 0)), false, '周六');
  assert.equal(c.isPeakAt(bj(2026, 10, 1, 10, 0)), false, '国庆');
  assert.equal(c.isPeakAt(bj(2026, 9, 25, 10, 0)), false, '中秋落在周五也算低峰');
  assert.equal(c.isPeakAt(bj(2026, 10, 8, 10, 0)), true, '节后恢复');
});

test('下次峰谷切换：跨周末、跨整个国庆都算对', () => {
  const at = (ms) => c.fmtBeijing(ms);
  assert.equal(c.beijingClock(bj(2026, 9, 29, 10, 30)).minutes, 630);
  assert.equal(at(c.nextSwitchAt(bj(2026, 9, 29, 10, 30))), '09-29 12:00');
  assert.equal(at(c.nextSwitchAt(bj(2026, 9, 29, 12, 30))), '09-29 14:00');
  assert.equal(at(c.nextSwitchAt(bj(2026, 9, 29, 18, 30))), '09-30 09:00');
  assert.equal(at(c.nextSwitchAt(bj(2026, 9, 18, 17, 0))), '09-18 18:00');
  assert.equal(at(c.nextSwitchAt(bj(2026, 9, 18, 18, 30))), '09-21 09:00', '跨周末到周一');
  assert.equal(at(c.nextSwitchAt(bj(2026, 9, 19, 10, 0))), '09-21 09:00');
  assert.equal(at(c.nextSwitchAt(bj(2026, 9, 30, 18, 30))), '10-08 09:00', '跨整个国庆');
});

test('档位取价与四桶计价（含缓存写入按未命中价）', () => {
  assert.equal(c.tierOfModel('deepseek-v4-flash'), 'flash');
  assert.equal(c.tierOfModel(undefined), 'pro');
  const peak = c.scheduleAt('flash', bj(2026, 9, 29, 10, 0));
  const off = c.scheduleAt('flash', bj(2026, 9, 29, 8, 0));
  assert.deepEqual([off.hit, off.miss, off.out], [0.02, 1, 4]);
  assert.deepEqual([peak.hit, peak.miss, peak.out], [0.04, 2, 8]);
  assert.equal(peak.multiplier, 2);
  const buckets = { uncachedInputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6, outputTokens: 1e6 };
  const costPeak = c.costOf(buckets, 'flash', bj(2026, 9, 29, 10, 0));
  const costOff = c.costOf(buckets, 'flash', bj(2026, 9, 29, 8, 0));
  assert.equal(costPeak.total, 0.04 + 4 + 8);
  assert.equal(costOff.total, 0.02 + 2 + 4);
  assert.equal(costPeak.total, costOff.total * 2, '高峰恰为空闲的 2 倍');
  assert.equal(c.totalTokens(buckets), 4e6);
  assert.equal(c.totalTokens(undefined), 0);
});

test('格式化边界', () => {
  assert.equal(c.fmtCountdown((3600 + 120 + 3) * 1000), '1:02:03');
  assert.equal(c.fmtCountdown((120 + 3) * 1000), '02:03');
  assert.equal(c.fmtCountdown(2 * 86400e3 + 3600e3), '2d 1:00:00');
  assert.equal(c.fmtCountdown(null), '--');
  assert.equal(c.fmtBeijing(bj(2026, 9, 29, 10, 30)), '09-29 10:30');
  assert.equal(c.fmtExactTokens(108000), '108,000');
  assert.equal(c.fmtMoney(0), '¥0');
  assert.equal(c.fmtMoney(0.023), '¥0.02', '一分钱以上只给两位小数');
  assert.equal(c.fmtMoney(0.0023), '¥0.0023', '不足一分才用 4 位，避免显示成 ¥0');
  assert.equal(c.fmtMoney(0.8496), '¥0.85');
  assert.equal(c.fmtMoney(0.00005), '¥<0.0001');
  assert.equal(c.fmtMoney(1.5), '¥1.50');
  assert.equal(c.fmtMoney(1.5, '$'), '$1.50');
  assert.equal(c.symbolOf('USD'), '$');
  assert.equal(c.symbolOf('CNY'), '¥');
});

test('账号余额归一化：按币种分组，不跨币种相加', () => {
  const single = c.fromAccountBalance({
    status: 'ready',
    value: [{ currency: 'CNY', balance: '10.5' }],
    bonusWallets: [{ currency: 'CNY', balance: '2.5' }],
  });
  assert.equal(single.source, 'account');
  assert.deepEqual(single.wallets, [{ currency: 'CNY', total: 10.5, bonus: 2.5 }]);

  const multi = c.fromAccountBalance({
    status: 'ready',
    value: [{ currency: 'CNY', balance: '10' }, { currency: 'USD', balance: '5' }],
    bonusWallets: [{ currency: 'USD', balance: '1' }],
  });
  assert.deepEqual(multi.wallets, [
    { currency: 'CNY', total: 10, bonus: 0 },
    { currency: 'USD', total: 5, bonus: 1 },
  ], '两种币种各算一份，绝不加在一起');

  assert.deepEqual(c.fromAccountBalance({
    status: 'ready', value: [{ currency: 'cny', balance: '0.1' }, { currency: 'CNY', balance: '0.2' }], bonusWallets: [],
  }).wallets, [{ currency: 'CNY', total: 0.3, bonus: 0 }], '同币种大小写不敏感且求和');

  assert.equal(c.fromAccountBalance({ status: 'failed' }), null);
  assert.equal(c.fromAccountBalance(null), null);
  assert.deepEqual(c.fromAccountBalance({ status: 'ready', value: [], bonusWallets: [] }).wallets,
    [{ currency: 'CNY', total: 0, bonus: 0 }], '空钱包也要给一个零值，避免界面无币种可显示');
});

test('API Key 余额归一化：形状与账号链路一致', () => {
  const normalized = c.fromKeyBalance({ currency: 'cny', total: '12.34', granted: '1', at: 123 });
  assert.equal(normalized.source, 'key');
  assert.deepEqual(normalized.wallets, [{ currency: 'CNY', total: 12.34, bonus: 1 }]);
  assert.equal(normalized.at, 123);
  assert.deepEqual(c.fromKeyBalance({}).wallets, [{ currency: 'CNY', total: 0, bonus: 0 }]);
});

test('空桶不占位：结构性恒为 0 的桶（如 DeepSeek 的"缓存写入"）隐藏', () => {
  const rows = [
    ['hit', 0.02, 3.1, 174441216],
    ['miss', 1, 1.03, 1034252],
    ['write', 1, 0, 0],
    ['out', 4, 2.05, 511592],
  ];
  assert.deepEqual(
    c.visibleRows(rows, true).map((row) => row[0]),
    ['hit', 'miss', 'out'],
    '0 token 且 0 金额的桶应隐藏 —— DeepSeek 从不回报缓存写入',
  );
  assert.equal(c.visibleRows(rows, false).length, 4, '拿不到用量时不过滤，全部显示为破折号');
  assert.deepEqual(c.visibleRows([['hit', 0.02, 0, 0]], true), [], '全为空时返回空数组（组件显示"暂无用量"）');
  assert.equal(
    c.visibleRows([['hit', 0.02, 0.5, undefined]], true).length, 1,
    '只要有金额就显示（token 计数缺失但金额有值的情况）',
  );
});

test('设置归一化：逐项按默认兜底，未知键丢弃', () => {
  const defaults = c.SETTINGS_DEFAULTS;
  for (const junk of [undefined, null, 'nope', 42, [], {}]) {
    assert.deepEqual(c.normalizeSettings(junk), defaults, '脏输入应回到默认值');
  }
  assert.equal(c.normalizeSettings({ pillCost: false }).pillCost, false, '合法的 false 要保留');
  assert.deepEqual(
    c.normalizeSettings({ pillCost: 'yes', pillBalance: 0, pillPeriod: null }),
    defaults,
    '非布尔值一律回默认（0 / null / 字符串都算脏）',
  );
  assert.deepEqual(
    Object.keys(c.normalizeSettings({ evil: true, pillCost: false })).sort(),
    Object.keys(defaults).sort(),
    '未知键要丢弃，不能带进设置对象',
  );
});

test('分模型展示行：只有一个模型就不显示，多个则按金额降序', () => {
  const view = (byModel) => ({ byModel });
  assert.deepEqual(c.modelRowsOf(view({ a: { totalCny: 1 } })), [], '单模型与合计重复，不显示');
  assert.deepEqual(c.modelRowsOf(view({})), [], '空对象不显示');
  assert.deepEqual(
    c.modelRowsOf(view({ flash: { totalCny: 10.04 }, pro: { totalCny: 36.3 } })),
    [['pro', 36.3], ['flash', 10.04]], '按金额从大到小');
  // 注意两条规则会叠加：丢掉非正数之后若只剩一个模型，仍然不显示（与合计重复）。
  assert.deepEqual(
    c.modelRowsOf(view({ a: { totalCny: 5 }, zero: { totalCny: 0 } })),
    [], '丢掉 0 金额后只剩一个模型 → 仍不显示');
  assert.deepEqual(
    c.modelRowsOf(view({ a: { totalCny: 5 }, b: { totalCny: 3 }, zero: { totalCny: 0 } })),
    [['a', 5], ['b', 3]], '0 金额（通常是刚被回退的）被丢掉，剩下的按金额降序');
  assert.deepEqual(c.modelRowsOf(null), []);
  assert.deepEqual(c.modelRowsOf(undefined), []);
  assert.deepEqual(c.modelRowsOf({}), [], '缺 byModel 字段');
  assert.deepEqual(c.modelRowsOf(view(null)), [], 'byModel 为 null');
  assert.deepEqual(c.modelRowsOf(view('x')), [], 'byModel 是字符串');
  assert.deepEqual(c.modelRowsOf(view([])), [], 'byModel 是数组');
  assert.deepEqual(c.modelRowsOf(view({ bad: null, ok: { totalCny: 2 }, x: {} })), [],
    '脏项丢掉后只剩一个模型 → 仍不显示');
});

test('胶囊分隔点：只在文字段之间放（图标后面不放）', () => {
  const c2 = c;
  // 图标 + 数字：数字前不放点（截图里的 `🌙 · ¥8.18` 就是这个问题）
  assert.deepEqual(c2.separatorBefore(['icon', 'text']), [false, false]);
  // 图标 + 花费 + 余额：只有第二、三段之间放
  assert.deepEqual(c2.separatorBefore(['icon', 'text', 'text']), [false, false, true]);
  // 没有图标时，两段文字之间照常放点
  assert.deepEqual(c2.separatorBefore(['text', 'text']), [false, true]);
  // 单段、空数组
  assert.deepEqual(c2.separatorBefore(['text']), [false]);
  assert.deepEqual(c2.separatorBefore([]), []);
  // 关掉图标后：花费 · 余额
  assert.deepEqual(c2.separatorBefore(['text', 'text']).filter(Boolean).length, 1);
});
