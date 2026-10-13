/**
 * 结构契约：`client.js` 的单文件组织方式必须可被测试可靠地切开。
 *
 * 客户端 bundle 是单文件（宿主把它拼进 combo 脚本、以传统脚本执行），所以"纯逻辑"
 * 与"界面"的边界只能靠标记声明。这里把这份约定钉住：
 *   · 标记各出现一次（多了/少了都说明结构被动过）；
 *   · 区块里确实有测试需要的那些符号；
 *   · 区块里**不许出现 React / DOM**（那是它能被 `new Function` 直接求值的前提）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clientSource, pureLogicBlock } from './extract-client.mjs';

/** 测试要用到的符号（`client-math` / `pricing-parity` 都依赖它们）。 */
const REQUIRED = [
  'BJ_OFFSET_MS', 'PEAK_WINDOWS', 'CN_STATUTORY_HOLIDAYS', 'PRICE_SCHEDULES',
  'isPeakAt', 'beijingClock', 'nextSwitchAt', 'tierOfModel', 'scheduleAt', 'costOf',
  'totalTokens', 'fmtCountdown', 'fmtBeijing', 'fmtExactTokens', 'fmtMoney', 'symbolOf',
  'fromAccountBalance', 'fromKeyBalance',
];

test('纯逻辑标记各出现一次', () => {
  const source = clientSource();
  assert.equal(source.split('// #region 纯逻辑').length - 1, 1);
  assert.equal(source.split('// #endregion 纯逻辑').length - 1, 1);
});

test('纯逻辑区块包含测试依赖的全部符号', () => {
  const block = pureLogicBlock();
  const missing = REQUIRED.filter((name) => !new RegExp('(function|const)\\s+' + name + '\\b').test(block));
  assert.deepEqual(missing, [], '这些符号不在纯逻辑区块里了：' + missing.join(', '));
});

test('纯逻辑区块不含 React / DOM（这是它能被直接求值的前提）', () => {
  // 只看代码行：标记行自己就写着"不含 React/DOM"，注释会把自己判成违规
  const code = pureLogicBlock()
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  for (const forbidden of ['React', 'document.', 'window.', 'useState', 'useEffect']) {
    assert.ok(!code.includes(forbidden), '纯逻辑区块里出现了 ' + forbidden + '，应移到界面区块');
  }
});

test('文件头保留了目录与"单文件"理由', () => {
  const source = clientSource();
  assert.ok(source.includes('本文件的组织方式'), '文件头目录被删了');
  assert.ok(/combo 脚本/.test(source), '应说明为什么 bundle 必须是单文件');
});

test('样式是插件级幂等注入：按键复用同一个 <style>，且不塞进某个槽位的组件树里', () => {
  const source = clientSource();
  // 踩过的坑 1：<style> 原先放在徽标组件的返回树里，而设置卡是在**另一个槽位**
  // （插件页的 plugins.bundle.config）渲染的 —— 那边一个样式都拿不到，
  // 整张卡退化成挤成一行的裸文字 + 原生复选框。所以样式必须挂在插件 fiber 上。
  // 踩过的坑 2：原先 dispose 时移除 <style>，一旦出现孤儿注册（HMR 重载期间的旧实例），
  // 页面就变成「组件还在、样式没了」。所以改成按键复用、不随 dispose 移除。
  assert.match(
    source,
    /ctx\.effect\(\(\) => \{\s*let style = document\.querySelector\('style\[data-dsh-style=/,
    '缺少插件级幂等样式注入（按键 querySelector 复用，官方也是这个写法）',
  );
  assert.match(source, /style\.textContent = CSS/, '每次 apply 都应刷新样式内容，否则更新版本会用到旧样式');
  assert.ok(
    !/style\.remove\(\)/.test(source),
    '不应随 dispose 移除：孤儿注册仍需样式，否则页面会变成「组件还在、样式没了」',
  );
  assert.ok(
    !/h\('style', null, CSS\)/.test(source),
    '不应再在组件树里渲染 <style>：其它槽位的组件拿不到它',
  );
});

test('每个内联 SVG 都必须有显式 width/height', () => {
  // 一个只有 viewBox 的 SVG 在没有 CSS 时**会撑满容器** —— 这正是"徽标变成巨型
  // 图标"那个故障的放大器。根因修掉之后，这条门禁保证放大器不会回来。
  const source = clientSource();
  const marker = "h('svg', {";
  const offenders = [];
  let index = source.indexOf(marker);
  while (index !== -1) {
    let depth = 0;
    let end = index + marker.length - 1;
    for (let cursor = end; cursor < source.length; cursor += 1) {
      if (source[cursor] === '{') depth += 1;
      else if (source[cursor] === '}') {
        depth -= 1;
        if (depth === 0) { end = cursor; break; }
      }
    }
    const block = source.slice(index, end + 1);
    if (!/\bwidth:\s*\d/.test(block) || !/\bheight:\s*\d/.test(block)) {
      offenders.push(block.replace(/\s+/g, ' ').slice(0, 70));
    }
    index = source.indexOf(marker, end);
  }
  assert.ok(offenders.length === 0, '这些内联 SVG 缺显式宽高：' + offenders.join(' | '));
});

test('开关与官方 Switch 同构（button + role=switch + 官方 token）', () => {
  const source = clientSource();
  assert.match(source, /role: 'switch'/, '开关应是 role="switch" 的按钮（官方 @deepseek-ai/dsh-client-ui-primitives 的做法）');
  assert.match(source, /'aria-checked': checked/, '状态由 aria-checked 表达，视觉与无障碍同源');
  assert.ok(
    !/className: 'umSettingInput'/.test(source),
    '不应再用 input[type=checkbox]：宿主有它的全局样式，特异性压得过类选择器',
  );
  const start = source.indexOf('.umSwitch{');
  assert.ok(start >= 0, '找不到 .umSwitch 规则');
  const rule = source.slice(start, source.indexOf('}', start) + 1);
  assert.match(rule, /width:36px;height:20px;padding:2px/, '尺寸应与官方 36×20 / padding 2px 一致');
  assert.match(rule, /background:var\(--dsw-alias-border-l3\)/, '关态轨道用官方的 border-l3');
  assert.ok(
    source.includes(".umSwitch[aria-checked='true']{background:var(--dsw-alias-brand-primary)}"),
    '开态轨道用品牌色（官方同款）',
  );
  assert.match(source, /--dsw-alias-switch-thumb/, '圆钮用官方的 switch-thumb token');
});

test('分隔点与官方同构：包在 label 里，不是 pill 的平级 flex 子元素', () => {
  const source = clientSource();
  // 官方把 `·` 放进 inline 的 label span；平级放会让 pill 的 gap:6px 叠加到
  // .umSep 的 margin:0 6px 上，点两侧变成 12px（实测比官方宽一倍）。
  assert.match(
    source,
    /h\('span', \{ (?:key: 'label', )?className: 'umLabel' \}, labelParts\)/,
    '文字段与分隔点应同包在一个 umLabel span 里',
  );
  assert.match(source, /\.umSep\{color:var\(--dsw-alias-separator-primary\);margin:0 6px\}/, '间距数值应与官方一致（0 6px）');
  // 不应再出现"平级塞分隔点"的老写法
  assert.ok(
    !/pillParts\.forEach\(\(node, index\)/.test(source),
    '不应把分隔点平级塞进 pill 的 flex 子元素列表',
  );
});

test('胶囊与真圆必须显式退出全局超椭圆（corner-shape:round）', () => {
  const source = clientSource();
  // 主题对 `*,:before,:after` 施加 corner-shape:superellipse(1.5)（见 dsh-client-ui-theme），
  // 超椭圆会把胶囊两侧压平 —— 官方 Switch.module.css 里正因如此写了 corner-shape:round。
  // 凡是 border-radius:999px 或 50% 的规则都要跟着写，否则开关、胶囊、"现在"圆点会看起来偏方。
  const start = source.indexOf('const CSS = `');
  const css = source.slice(start, source.indexOf('`;', start));
  const rules = css.match(/\{[^{}]*\}/g) ?? [];
  const offenders = rules.filter((rule) => /border-radius:(999px|50%)/.test(rule) && !/corner-shape:round/.test(rule));
  assert.deepEqual(
    offenders,
    [],
    '这些规则用了胶囊/真圆圆角却没写 corner-shape:round：\n' + offenders.map((r) => r.slice(0, 90)).join('\n'),
  );
  assert.ok(
    (css.match(/corner-shape:round/g) ?? []).length >= 4,
    '至少四处：胶囊 .umPill、圆点 .umDot、开关轨道 .umSwitch、开关圆钮 .umSwitchThumb',
  );
});

test('每个 slots.inject 都必须紧贴在 ctx.effect(() => …) 里（否则 dispose 后会泄漏成"组件在、样式没了"）', () => {
  const source = clientSource();
  // 只认**紧贴**的写法：中间除空白外不允许有别的东西。
  // 【教训】先前这版门禁是"往前 160 字符里出现过 ctx.effect( 就算过" —— 变异测试证明它
  // 抓不到回退：有多处注入时，没包住的那处仍能看到前一处的 ctx.effect(。
  const total = [...source.matchAll(/ctx\.slots\.inject\(/g)].length;
  const wrapped = [...source.matchAll(/ctx\.effect\(\(\)\s*=>\s*ctx\.slots\.inject\(/g)].length;
  assert.ok(total > 0, '本插件应当至少有一处 slots.inject');
  assert.equal(wrapped, total, `有 ${total - wrapped} 处 slots.inject 没有紧跟 ctx.effect(() => …)`);
});
