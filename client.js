/**
 * 用量与余额 —— 客户端半边。
 *
 * 【这一版和原鲸鱼娘插件最大的不同：不自己折叠会话事件】
 *   token 用量直接读 DSH 自带的 `tokenUsage` 会话投影（`@deepseek-ai/dsh-token-meter`）：
 *   它是宿主已经折叠好的响应式数据（4 个桶：未缓存输入 / 缓存读 / 缓存写 / 输出），
 *   所以本插件**没有任何轮询**、没有账本、不需要扫历史会话，用量一变界面就跟着变。
 *   原插件为了做"今日花费"自己维护了 700 行账本 + 启动全量扫盘，这里完全不需要。
 *
 * 【其余设计取舍（参考社区同类插件后确定）】
 *   · 费用按 **峰谷 + 模型档位** 换算：价格表与时间线来自官方定价页；
 *     本文件的价目与社区插件 dsh-token-billing 的内置表逐位一致
 *     （flash 空闲 0.02/1/4、高峰 0.04/2/8；pro 空闲 0.15/4.5/13.5、高峰 0.3/9/27），
 *     两个独立实现互相印证。
 *   · 余额走宿主路由（POST + 同源校验），密钥只在宿主进程里出现。
 *   · 弹层样式对齐宿主原生的统计弹层，避免和旁边那个原生胶囊"两个画风"。
 *
 * 【本文件的组织方式】
 *   客户端 bundle **必须是单文件**：宿主把各插件的 bundle 拼接成一个 combo 脚本、
 *   以**传统脚本**执行（`window.__ModuleLoader__` 处于 queue 模式，只登记工厂函数），
 *   在这里写 ES 相对 import 并不成立。所以用「目录 + 显式 region 标记」代替拆文件：
 *
 *     1. 时段规则        峰谷判定、价目分段、四桶计价          ┐ 纯逻辑
 *     2. 展示辅助        格式化、余额归一化                    ┘
 *     3. 文案            中英词典（框架 t + 本地回退）
 *     4. 样式            CSS，数值抄自宿主原生弹层
 *     5. 浮层定位与关闭   位置计算、点外点击 / Esc
 *     6. 组件            徽标、面板、倒计时、两个图标、设置卡（插件页）
 *
 *   第 1、2 节包在 `#region 纯逻辑` 里，`test/extract-client.mjs` 按标记抽取后直接
 *   单测（那段不含 React/DOM）。顺序若被改动，测试会**报错而不是静默取到半截**。
 */

window.__ModuleLoader__.load({
  id: 'dsh-usage-pill',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useLayoutEffect, useRef, useCallback, useId } = React;
    const { createPortal } = require('react-dom');

    /**
     * apply() 时拿到的东西：
     *   · ACCOUNT —— 账号 Remote 的 `account` 命名空间。官方账号页就是用
     *     `ctx.remote.account.getBalance()` 读余额的，走**已登录的账号授权**，
     *     不需要 API Key。它是**可选能力**：cordis 要求跨服务取属性前先声明
     *     （`inject: ['remote', 'remote.account']`），但那会让整个插件硬依赖账号
     *     控制器 —— 用量部分本不需要它，所以这里改用 `ctx.inject([...], scope => …)`
     *     做条件捕获，拿不到就退化为 API Key 兜底。
     *   · LOCALE —— 账号接口要带请求方语言（`AccountClientMetadata.locale`）。
     */
    let ACCOUNT = undefined;
    let LOCALE = undefined;

    /** 语言命名空间，与 register 时给的 locale 对应。 */
    const NS = 'usage-pill';
    /** 槽位条目 id。 */
    const CELL = 'usage-pill';
    /** 余额接口。 */
    const BALANCE_API = '/api/usage-pill/balance';
    /** 余额视为"新鲜"的时长；超过就在面板打开时重取（宿主侧另有 60 秒缓存）。 */
    const BALANCE_FRESH_MS = 60000;

    // ========================================================================
    // 1. 时段规则（与官方定价页口径一致）
    // ========================================================================

    // #region 纯逻辑 —— 不含 React/DOM，供 test/extract-client.mjs 抽取后单测

    /** 北京时间 = UTC+8，中国无夏令时。 */
    const BJ_OFFSET_MS = 8 * 3600e3;
    /** 高峰窗口，单位是"北京时间当天第几分钟"，左闭右开。 */
    const PEAK_WINDOWS = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]];
    /** 峰谷状态只可能在这四个边界上翻转（升序）：09:00 / 12:00 / 14:00 / 18:00。 */
    const PEAK_BOUNDARIES = PEAK_WINDOWS.flat();

    /**
     * 中国法定节假日（北京时间日期）——官方把节假日整天算空闲。
     * 【维护点】按年扩表（依据国办发明电〔2025〕7 号）；缺的年份只会把法定假日
     * 误判成高峰，不会反向多算。
     */
    const CN_STATUTORY_HOLIDAYS = new Set([
      '2026-01-01', '2026-01-02', '2026-01-03',
      '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
      '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
      '2026-04-04', '2026-04-05', '2026-04-06',
      '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
      '2026-06-19', '2026-06-20', '2026-06-21',
      '2026-09-25', '2026-09-26', '2026-09-27',
      '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
      '2026-10-05', '2026-10-06', '2026-10-07',
    ]);

    /**
     * 价格政策时间线：每档给出生效时刻与空闲单价（元 / 百万 tokens）。
     * `peakMultiplier` 为 1 表示该档不分峰谷。缓存写入按"未命中"单价计（官方口径）。
     * 【维护点】官方调价时在对应档位追加一条 `{ from: Date.UTC(...), ... }`。
     */
    const PRICE_SCHEDULES = {
      flash: [
        { from: 0, hit: 0.02, miss: 1, out: 2, peakMultiplier: 1 },
        { from: Date.UTC(2026, 7, 16, 16, 0, 0), hit: 0.05, miss: 1.5, out: 4.5, peakMultiplier: 2 },
        { from: Date.UTC(2026, 8, 10, 4, 0, 0), hit: 0.02, miss: 1, out: 4, peakMultiplier: 2 },
      ],
      pro: [
        { from: 0, hit: 0.025, miss: 3, out: 6, peakMultiplier: 1 },
        { from: Date.UTC(2026, 7, 16, 16, 0, 0), hit: 0.15, miss: 4.5, out: 13.5, peakMultiplier: 2 },
      ],
    };

    /** 北京时间当天日期串（YYYY-MM-DD）。 */
    function beijingDate(timeMs) {
      return new Date(timeMs + BJ_OFFSET_MS).toISOString().slice(0, 10);
    }

    /**
     * 该时刻是否处于高峰。
     * @param timeMs - UTC 毫秒。
     * @returns 高峰 true；周末、法定节假日、窗口外 false。
     */
    function isPeakAt(timeMs) {
      if (!Number.isFinite(timeMs)) return false;
      if (CN_STATUTORY_HOLIDAYS.has(beijingDate(timeMs))) return false;
      const shifted = new Date(timeMs + BJ_OFFSET_MS);
      const weekday = shifted.getUTCDay();
      if (weekday === 0 || weekday === 6) return false;
      const minutes = shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
      return PEAK_WINDOWS.some(([start, end]) => minutes >= start && minutes < end);
    }

    /** 北京时间当天的分钟数与星期（用 UTC getter 读偏移后的时间）。 */
    function beijingClock(timeMs) {
      const shifted = new Date(timeMs + BJ_OFFSET_MS);
      return {
        weekday: shifted.getUTCDay(),
        minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
        seconds: shifted.getUTCSeconds(),
      };
    }

    /**
     * 下一次峰谷切换的时刻。
     *
     * 峰谷状态只在每天四个边界上变化，所以按时间顺序扫这些边界，取第一个
     * "状态与现在不同"的即可 —— 周末与节假日造成的跨天跳变会被自然跳过
     * （那些边界的状态与现在相同）。
     *
     * @param timeMs - 当前时刻。
     * @returns 切换时刻（UTC 毫秒）；十天之内找不到时返回 undefined。
     */
    function nextSwitchAt(timeMs) {
      const nowPeak = isPeakAt(timeMs);
      const startOfToday = Math.floor((timeMs + BJ_OFFSET_MS) / 86400e3) * 86400e3;
      for (let day = 0; day <= 10; day += 1) {
        for (const minute of PEAK_BOUNDARIES) {
          const candidate = startOfToday + day * 86400e3 + minute * 60000 - BJ_OFFSET_MS;
          if (candidate > timeMs && isPeakAt(candidate) !== nowPeak) return candidate;
        }
      }
      return undefined;
    }

    /** 模型名 → 价目档位：含 flash 走 flash 档，其余（pro / 未知）走 pro 档。 */
    function tierOfModel(model) {
      return String(model || '').toLowerCase().includes('flash') ? 'flash' : 'pro';
    }

    /** 某档位在某时刻生效的价格档与倍率。 */
    function scheduleAt(tier, timeMs) {
      const schedules = PRICE_SCHEDULES[tier] || PRICE_SCHEDULES.pro;
      let chosen = schedules[0];
      for (const schedule of schedules) {
        if (schedule.from <= timeMs) chosen = schedule;
      }
      const peak = chosen.peakMultiplier !== 1 && isPeakAt(timeMs);
      const multiplier = peak ? chosen.peakMultiplier : 1;
      return {
        flat: chosen.peakMultiplier === 1,
        peak,
        multiplier,
        hit: chosen.hit * multiplier,
        miss: chosen.miss * multiplier,
        out: chosen.out * multiplier,
      };
    }

    /**
     * 把四个 token 桶换算成钱（元）。缓存写入按未命中单价计。
     * @param buckets - `{ uncachedInputTokens, cacheReadTokens, cacheWriteTokens, outputTokens }`。
     * @param tier - 价目档位。
     * @param timeMs - 计价时刻。
     * @returns 每个桶的金额与合计。
     */
    function costOf(buckets, tier, timeMs) {
      const rate = scheduleAt(tier, timeMs);
      const per = (tokens, price) => (Number(tokens) || 0) / 1e6 * price;
      const hit = per(buckets && buckets.cacheReadTokens, rate.hit);
      const miss = per(buckets && buckets.uncachedInputTokens, rate.miss);
      const write = per(buckets && buckets.cacheWriteTokens, rate.miss);
      const out = per(buckets && buckets.outputTokens, rate.out);
      return { rate, hit, miss, write, out, total: hit + miss + write + out };
    }

    /** 四个桶的 token 合计。 */
    function totalTokens(buckets) {
      if (!buckets) return 0;
      return (Number(buckets.uncachedInputTokens) || 0)
        + (Number(buckets.cacheReadTokens) || 0)
        + (Number(buckets.cacheWriteTokens) || 0)
        + (Number(buckets.outputTokens) || 0);
    }

    // ========================================================================
    // 2. 展示辅助
    // ========================================================================

    /** 把毫秒差格式化成 1:23:45 / 23:45 / 2d 1:23:45。 */
    function fmtCountdown(ms) {
      if (ms === null || ms === undefined || !Number.isFinite(ms)) return '--';
      const total = Math.max(0, Math.floor(ms / 1000));
      const days = Math.floor(total / 86400);
      const hours = Math.floor((total % 86400) / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = total % 60;
      const pad = (n) => (n < 10 ? '0' + n : String(n));
      if (days > 0) return days + 'd ' + hours + ':' + pad(minutes) + ':' + pad(seconds);
      if (hours > 0) return hours + ':' + pad(minutes) + ':' + pad(seconds);
      return pad(minutes) + ':' + pad(seconds);
    }

    /** 北京时间 MM-DD HH:mm。 */
    function fmtBeijing(timeMs) {
      const shifted = new Date(timeMs + BJ_OFFSET_MS);
      const pad = (n) => (n < 10 ? '0' + n : String(n));
      return pad(shifted.getUTCMonth() + 1) + '-' + pad(shifted.getUTCDate())
        + ' ' + pad(shifted.getUTCHours()) + ':' + pad(shifted.getUTCMinutes());
    }

    /** 精确 token（带千分位）：1234567 → 1,234,567。 */
    function fmtExactTokens(n) {
      return (Number(n) || 0).toLocaleString('en-US');
    }

    /** 金额：小额多给几位有效数字，别把 ¥0.0003 显示成 ¥0。 */
    function fmtMoney(value, symbol) {
      const sign = symbol || '¥';
      const n = Number(value) || 0;
      if (!(n > 0)) return sign + '0';
      if (n < 0.0001) return sign + '<0.0001';
      // 一分钱以上两位小数就够了；更小的金额才需要 4 位（否则会显示成 ¥0）
      if (n < 0.01) return sign + String(Number(n.toFixed(4)));
      return sign + n.toFixed(2);
    }

    /**
     * 金额归一到 4 位小数。
     *
     * 钱包余额是字符串，求和只能走浮点，于是会出现 `0.1 + 0.2 = 0.30000000000000004`
     * 这种噪声。显示层虽然抹得掉，但值本身该干净 —— 否则它会被带进比较和格式化。
     * @param value - 任意金额。
     * @returns 4 位小数以内的数值。
     */
    function roundMoney(value) {
      const n = Number(value);
      return Number.isFinite(n) ? Math.round(n * 1e4) / 1e4 : 0;
    }

    /**
     * 账号链路（`AccountDetails['balance']`）→ 统一形状。
     * 充值钱包是 `value`，赠金是 `bonusWallets`（官方口径：赠金不计入充值余额）。
     * @param details - 账号余额明细。
     * @returns `{ source, currency, total, bonus, at }`；不是 ready 时返回 null。
     */
    function fromAccountBalance(details) {
      if (details === null || details === undefined || details.status !== 'ready') return null;
      const recharge = Array.isArray(details.value) ? details.value : [];
      const bonusWallets = Array.isArray(details.bonusWallets) ? details.bonusWallets : [];
      const currencies = [];
      const push = (list) => {
        for (const wallet of list) {
          const currency = String((wallet && wallet.currency) || 'CNY').toUpperCase();
          if (!currencies.includes(currency)) currencies.push(currency);
        }
      };
      push(recharge);
      push(bonusWallets);
      // 钱包是**分币种**的：跨币种直接相加会得到没有意义的数，所以按币种各算一份。
      const wallets = currencies.map((currency) => {
        const sumOf = (list) => roundMoney(list
          .filter((wallet) => String((wallet && wallet.currency) || 'CNY').toUpperCase() === currency)
          .reduce((acc, wallet) => acc + (Number(wallet && wallet.balance) || 0), 0));
        return { currency, total: sumOf(recharge), bonus: sumOf(bonusWallets) };
      });
      if (wallets.length === 0) wallets.push({ currency: 'CNY', total: 0, bonus: 0 });
      return { source: 'account', wallets, at: Date.now() };
    }

    /** 宿主路由（API Key 链路）→ 统一形状。 */
    function fromKeyBalance(data) {
      return {
        source: 'key',
        wallets: [{
          currency: String(data.currency || 'CNY').toUpperCase(),
          total: roundMoney(data.total),
          bonus: roundMoney(data.granted),
        }],
        at: Number(data.at) || Date.now(),
      };
    }

    /** 余额接口返回的币种 → 符号。 */
    function symbolOf(currency) {
      return String(currency || 'CNY').toUpperCase() === 'USD' ? '$' : '¥';
    }

    /**
     * 该显示哪些桶行。
     *
     * 结构性恒为 0 的桶**不该占位**。典型例子是"缓存写入"：DeepSeek 的上下文缓存是
     * **服务端自动**的，写进缓存不另收费、也从不回报（provider 适配器只从
     * `prompt_tokens_details.cache_write_tokens` 取这个值，而那是 OpenAI / Anthropic
     * 那套**显式缓存**的字段）——所以它对 DeepSeek 永远是 0。
     *
     * 规则按**数据**判定而不是写死厂商名：有 token 或有金额就显示，否则隐藏。
     * 这样将来某个真会回报缓存写入的 provider 出现时，那一行会自动回来。
     *
     * @param rows - `[键, 当前单价, 本会话金额, token 数]` 四元组数组。
     * @param hasUsage - 用量投影是否可用；拿不到时不过滤（全部显示为破折号，如实表达"不知道"）。
     * @returns 需要显示的行。
     */
    function visibleRows(rows, hasUsage) {
      if (!hasUsage) return rows;
      return rows.filter(([, , money, tokens]) => (Number(tokens) || 0) > 0 || (Number(money) || 0) > 0);
    }

    /**
     * 分模型金额 → 展示行 `[[模型, 金额], …]`，按金额从大到小。
     *
     * 【只有一个模型时返回空数组】那一块与上面的合计完全重复，只会让面板变长。
     * 金额为 0 的模型也丢掉（通常是刚被替换回退掉的）。
     *
     * @param view - 宿主投影视图（可能为 null / 缺字段）。
     * @returns 展示行；不适用时为空数组。
     */
    function modelRowsOf(view) {
      if (view === null || typeof view !== 'object') return [];
      const byModel = view.byModel;
      if (byModel === null || typeof byModel !== 'object' || Array.isArray(byModel)) return [];
      const rows = [];
      for (const name of Object.keys(byModel)) {
        const money = byModel[name];
        const total = money !== null && typeof money === 'object' ? Number(money.totalCny) || 0 : 0;
        if (total > 0) rows.push([name, total]);
      }
      if (rows.length <= 1) return [];
      rows.sort((left, right) => right[1] - left[1]);
      return rows;
    }

    /**
     * 胶囊各段之间该不该放分隔点。
     *
     * **只有文字段之间才放**：图标不是一段文字，`🌙 · ¥8.18` 里那个点是多余的。
     * 间距不用这里操心 —— `.umPill` 自带 `gap:6px`，去掉点之后图标与数字仍有自然间距
     * （原先那个点额外还带 `margin:0 6px`，所以两边的间距会显得比别处宽）。
     *
     * @param kinds - 各段类型，`'icon'` 或 `'text'`，顺序与渲染顺序一致。
     * @returns 与入参等长的布尔数组；第 i 项表示"第 i 段**之前**要不要放点"。
     */
    function separatorBefore(kinds) {
      const out = [];
      let seenText = false;
      for (const kind of kinds) {
        out.push(kind === 'text' && seenText);
        if (kind === 'text') seenText = true;
      }
      return out;
    }

    /** 设置项的默认值；键名同时是持久化字段名。 */
    const SETTINGS_DEFAULTS = {
      pillPeriod: true,
      pillCost: true,
      pillBalance: true,
      hideEmptyBuckets: true,
      showSaved: true,
    };

    /**
     * 把持久化的原始值归一成一份完整设置。
     *
     * 存储里可能出现：旧版本残留的键、被手改坏的 JSON、非布尔的脏值。这里**逐项按
     * 默认值兜底**，未知键直接丢弃 —— 既不整体信任，也不整体丢弃。
     *
     * @param raw - 从存储读到的任意值。
     * @returns 完整设置（键与 {@link SETTINGS_DEFAULTS} 一致）。
     */
    function normalizeSettings(raw) {
      const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
      const out = {};
      for (const key of Object.keys(SETTINGS_DEFAULTS)) {
        out[key] = typeof source[key] === 'boolean' ? source[key] : SETTINGS_DEFAULTS[key];
      }
      return out;
    }

    // #endregion 纯逻辑

    // ========================================================================
    // 3. 文案
    // ========================================================================

    const ZH = {
      'pill.tokens': 'tok',
      'pill.balance': '余',
      'pill.hint': '☀ 高峰 / 🌙 空闲 · 点击查看用量、费用与账户余额',
      'settings.title': '显示设置',
      'settings.note': '修改立即生效，只调整显示方式，偏好保存在当前浏览器。',
      'settings.pillPeriod': '徽标显示时段图标',
      'settings.pillPeriodHint': '太阳表示高峰、月亮表示空闲；关闭后不显示图标',
      'settings.pillCost': '徽标显示参考费用',
      'settings.pillCostHint': '按 DeepSeek 价表换算，渠道账单可能不同',
      'settings.pillBalance': '徽标显示账户余额',
      'settings.pillBalanceHint': '取不到余额时该段自动消失',
      'settings.hideEmptyBuckets': '隐藏没有用量的项目',
      'settings.hideEmptyBucketsHint': '明细中只保留有 token 用量的输入、输出和缓存项目',
      'settings.showSaved': '显示「缓存已省」',
      'settings.showSavedHint': '命中的 token 若按未命中价计要多花多少',
      'settings.pillGroup': '底部胶囊',
      'settings.detailGroup': '展开后的明细',
      'settings.preview': '效果预览',
      'settings.sample': '示例数据',
      'settings.fallback': '所有内容关闭，或只开余额但余额不可用时，仍显示参考费用，保留详情入口。',
      'settings.reset': '恢复默认',
      'settings.resetDone': '已恢复默认显示设置。',
      'settings.explain': '费用与余额怎么看',
      'settings.explainCost': '≈ 表示参考费用：按 DeepSeek 价表和历史模型档位换算，第三方渠道的实际账单可能不同。',
      'settings.explainBalance': '余额来自已登录账号，API Key 作为兜底。查询失败时标明上次结果，可在详情里重试。',
      'settings.explainSaved': '「缓存已省」是缓存命中相对未命中的估算节省，不是余额增加。',
      'panel.title': '用量与余额',
      'panel.close': '关闭用量详情',
      'panel.session': '本会话',
      'panel.balanceFailed': '余额暂不可用',
      'panel.retry': '重试查询余额',
      'panel.stale': '刷新失败 · 显示上次余额',
      'panel.balance': '账户余额',
      'panel.balanceBonus': '含赠送',
      'panel.sourceAccount': '账号',
      'panel.sourceKey': 'API Key',
      'panel.accountFailed': '账号查询失败',
      'panel.keyFailed': 'API Key 兜底也未配置',
      'panel.balanceLoading': '查询中…',
      'panel.balanceRefresh': '刷新余额',
      'panel.hit': '缓存命中',
      'panel.miss': '缓存未命中',
      'panel.write': '缓存写入',
      'panel.out': '输出',
      'panel.breakdown': '本会话参考费用',
      'panel.noUsageYet': '本会话暂无用量',
      'panel.unit': '元 / 百万 tokens',
      'panel.afterSwitch': '后切换',
      'panel.saved': '缓存已省',
      'panel.savedNote': '按当前价',
      'panel.actual': '参考费用：按每笔用量的时刻与模型档位套用 DeepSeek 价表，非渠道账单',
      'panel.estimated': '参考费用：累计用量 × 当前 DeepSeek 单价（历史计价不可用）',
      'panel.noUsage': '用量投影不可用，暂时算不出金额',
      'panel.tierUnknown': '未识别到模型 · 按 {tier} 档计',
      'panel.byModel': '按模型 · 参考费用',
      'panel.unitMulti': '单价是当前模型（{model}）的价；上面的金额是全部模型累计的',
      'panel.currentRates': '采用 DeepSeek 价表 · 渠道账单可能不同',
      'panel.beijing': '北京时间',
      'panel.timeline': '今日时段轴（北京时间）',
            'panel.peakTimes': '高峰单价 ×{mult}',
      'panel.peak': '高峰',
      'panel.off': '空闲',
          };

    const EN = {
      'pill.tokens': 'tok',
      'pill.balance': 'bal.',
      'pill.hint': '☀ peak / 🌙 off-peak · click for usage, cost and balance',
      'settings.title': 'Display settings',
      'settings.note': 'Changes apply immediately to display only. Preferences stay in this browser.',
      'settings.pillPeriod': 'Period icon on the pill',
      'settings.pillPeriodHint': 'Sun = peak, moon = off-peak; disabling hides the icon',
      'settings.pillCost': 'Cost on the pill',
      'settings.pillCostHint': 'Reference cost using DeepSeek rates; channel invoices may differ',
      'settings.pillBalance': 'Balance on the pill',
      'settings.pillBalanceHint': 'The segment hides itself when unavailable',
      'settings.hideEmptyBuckets': 'Hide unused items',
      'settings.hideEmptyBucketsHint': 'Only show input, output and cache items with token usage',
      'settings.showSaved': 'Show "saved by cache"',
      'settings.showSavedHint': 'What cache hits would have cost at the miss price',
      'settings.pillGroup': 'Bottom pill',
      'settings.detailGroup': 'Expanded details',
      'settings.preview': 'Preview',
      'settings.sample': 'Sample data',
      'settings.fallback': 'If all segments are off, or only balance is on but unavailable, reference cost keeps the details entry visible.',
      'settings.reset': 'Restore defaults',
      'settings.resetDone': 'Default display settings restored.',
      'settings.explain': 'Understanding cost and balance',
      'settings.explainCost': '≈ marks reference cost using DeepSeek rates and historical model tiers. Third-party invoices may differ.',
      'settings.explainBalance': 'Balance comes from the signed-in account, with API Key fallback. Failed refreshes mark the last result; retry in the details.',
      'settings.explainSaved': 'Saved by cache estimates savings compared with cache misses; it does not increase your balance.',
      'panel.title': 'Usage & balance',
      'panel.close': 'Close usage details',
      'panel.session': 'This session',
      'panel.balanceFailed': 'Balance unavailable',
      'panel.retry': 'Retry balance query',
      'panel.stale': 'Refresh failed · showing last balance',
      'panel.balance': 'Balance',
      'panel.balanceBonus': 'incl. bonus',
      'panel.sourceAccount': 'account',
      'panel.sourceKey': 'API key',
      'panel.accountFailed': 'Account lookup failed',
      'panel.keyFailed': 'API key fallback also unavailable',
      'panel.balanceLoading': 'Loading…',
      'panel.balanceRefresh': 'Refresh balance',
      'panel.hit': 'Cache hit',
      'panel.miss': 'Cache miss',
      'panel.write': 'Cache write',
      'panel.out': 'Output',
      'panel.breakdown': 'Session reference cost',
      'panel.noUsageYet': 'No usage yet in this session',
      'panel.unit': 'CNY / million tokens',
      'panel.afterSwitch': 'until switch',
      'panel.saved': 'Saved by cache',
      'panel.savedNote': 'at current rates',
      'panel.actual': 'Reference cost at each request time and tier using DeepSeek rates, not a channel invoice',
      'panel.estimated': 'Cost estimated at current rates (host projection unavailable)',
      'panel.noUsage': 'Usage projection unavailable; cost cannot be computed',
      'panel.tierUnknown': 'model unknown \u00b7 priced as {tier}',
      'panel.byModel': 'By model · reference cost',
      'panel.unitMulti': 'Unit price is for the current model ({model}); the amounts above total every model',
      'panel.currentRates': 'Uses DeepSeek rates · channel invoices may differ',
      'panel.beijing': 'Beijing time',
      'panel.timeline': 'Today in Beijing time',
            'panel.peakTimes': 'peak ×{mult}',
      'panel.peak': 'peak',
      'panel.off': 'off-peak',
          };

    // ========================================================================
    // 4. 样式 —— 与宿主原生统计弹层同一套数值（见 dsh-client-ui-chat 的
    // stat-dialog.module.css / StatsPills.module.css）。类名用 um 前缀，
    // 避免与页面上其它插件（比如 peak-valley 的 pv- 前缀）相互覆盖。
    // ========================================================================

    const CSS = `
.umRoot{box-sizing:border-box;min-width:0;max-width:100%;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);
  line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));justify-content:center;gap:12px;display:flex}
.umAnchor{min-width:0;display:inline-flex}
.umPill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;
  font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;
  border-radius:999px;corner-shape:round;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}
.umPill svg{flex:none;width:14px;height:14px}
.umPill:hover,.umPill[aria-expanded="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.umPill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.umLabel{text-overflow:ellipsis;min-width:0;overflow:hidden}
.umModelName{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;
  color:var(--dsw-alias-label-secondary);text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}
/* 分隔点的间距**只有**这 6px：官方把它放在 inline 的 label 里，pill 的 gap 不作用于它。
   若把点做成 pill 的平级 flex 子元素，gap:6px 会叠加成 12px。数值与官方原件一致。 */
.umSep{color:var(--dsw-alias-separator-primary);margin:0 6px}
.umPanel{z-index:1100;max-height:calc(100dvh - 24px);overflow-y:auto;overscroll-behavior:contain;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);
  width:max-content;min-width:min(300px,100vw - 24px);max-width:min(440px,100vw - 24px);
  backdrop-filter:var(--dsw-menu-backdrop-filter);
  --dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);
  color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:16px;font-size:12px;line-height:18px;position:fixed}
.umTitle{color:var(--dsw-alias-label-primary);justify-content:space-between;gap:16px;margin-bottom:8px;
  font-weight:500;display:flex}
.umTitleRule{border-top:.5px solid var(--dsw-alias-border-l2);margin-bottom:10px}
.umTitleValue{font-variant-numeric:tabular-nums}
.umClose{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:20px;line-height:24px;flex:none;width:24px;height:24px;border-radius:5px;cursor:pointer}
.umClose:hover{background:var(--dsw-alias-interactive-bg-hover)}
.umClose:focus-visible,.umRefresh:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.umTitleValue{margin-left:auto}
.umTitleLabel{align-items:center;gap:6px;min-width:0;display:inline-flex}
.umTitleLabel svg{flex:none;width:14px;height:14px}
.umDetails{color:var(--dsw-alias-label-tertiary);grid-template-columns:minmax(76px,auto) minmax(0,1fr);
  gap:8px 16px;margin:0;display:grid}
.umDetails dt,.umDetails dd{min-width:0;margin:0}
.umDetails dd{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;text-align:right}
.umDetails dd em{font-style:normal;color:var(--dsw-alias-label-tertiary)}
.umDot{width:8px;height:8px;border-radius:50%;corner-shape:round;display:inline-block;vertical-align:middle;margin-right:5px}
.umDot.umPeak{background:var(--dsw-alias-state-warn-primary)}
.umDot.umOff{background:var(--dsw-alias-state-success-primary)}
.umIconPeak{color:var(--dsw-alias-state-warn-primary)}
.umIconOff{color:var(--dsw-alias-state-success-primary)}
.umSect{color:var(--dsw-alias-label-tertiary);margin:0 0 8px}
.umMeta{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;margin:2px 0 6px}
.umSaved{color:var(--dsw-alias-state-success-primary);font-variant-numeric:tabular-nums}
.umCostLine{white-space:nowrap}
.umEmpty{color:var(--dsw-alias-label-tertiary);grid-column:1 / -1}
.umUnit{color:var(--dsw-alias-label-tertiary);font-size:11px;margin-left:6px}
.umTrack{position:relative;height:14px;border-radius:3px;background:var(--dsw-alias-border-l1);overflow:hidden}
.umBand{position:absolute;top:0;bottom:0;background:var(--dsw-alias-state-warn-primary);opacity:.35}
.umNow{position:absolute;top:-2px;bottom:-2px;width:2px;background:var(--dsw-alias-brand-primary)}
.umAxis{display:flex;justify-content:space-between;color:var(--dsw-alias-label-tertiary);
  font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.umNote{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-top:8px}
.umSettings{display:grid;gap:16px}
.umSettingsHead{display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap}
.umSettingsIntro{display:grid;gap:4px;flex:1;min-width:180px}
.umSettingsCard{display:grid;gap:12px;padding:16px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.18));border-radius:12px}
.umSettingsCard .umSetting{padding:10px 0}
.umSettingsCard .umSetting:last-child{padding-bottom:0;border-bottom:0}
.umSettingsPreview{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 14px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.07));border-radius:9px}
.umPreviewPill{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-primary);font-size:13px;font-variant-numeric:tabular-nums;line-height:20px}
.umPreviewPill svg{width:14px;height:14px;flex:none}
.umSettingsButton{font:inherit;font-size:12px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:6px 12px;min-height:32px;background:transparent;cursor:pointer}
.umSettingsButton:disabled{opacity:.45;cursor:default}
.umSettingsButton:focus-visible,.umSettings summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}
.umSettings summary{font-size:13px;font-weight:500;cursor:pointer}
.umSettingsHelp{display:grid;gap:8px;padding-top:12px}
.umDetailPreview{display:grid;gap:5px;padding:12px 14px;border-radius:9px;background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.07))}
.umDetailPreviewRow{display:flex;justify-content:space-between;gap:16px;font-variant-numeric:tabular-nums}
.umSettingsTitle{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;line-height:20px}
.umSettingsNote{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
.umSetting{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l2)}
.umSetting:last-child{border-bottom:0;padding-bottom:0}
.umSettingText{display:grid;gap:2px;min-width:0}
.umSettingLabel{color:var(--dsw-alias-label-primary);font-size:13px;line-height:18px}
.umSettingHint{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}
/* 开关：照抄官方 @deepseek-ai/dsh-client-ui-primitives 的 Switch.module.css。
   注意 corner-shape:round —— 主题对**所有元素**施加 corner-shape:superellipse(1.5)，
   胶囊与真圆必须显式退出，否则超椭圆会让圆角两侧显得偏方（官方原件里就写了这一行）。
   （36×20、padding 2px、圆钮 16 + 位移 16、关=--dsw-alias-border-l3、开=--dsw-alias-brand-primary），
   只把类名换成 um 前缀。官方用的是 <button role="switch" aria-checked>，
   不是 input[type=checkbox] —— 后者会被宿主的全局 input 样式压掉（第一版就是这么坏的）。 */
.umSwitch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;
  background:var(--dsw-alias-border-l3);cursor:pointer;transition:background .12s ease}
.umSwitch[aria-checked='true']{background:var(--dsw-alias-brand-primary)}
.umSwitch:disabled{cursor:default;opacity:.5}
.umSwitch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.umSwitchThumb{display:block;width:16px;height:16px;border-radius:50%;corner-shape:round;background:var(--dsw-alias-switch-thumb);
  transition:transform .12s ease}
.umSwitch[aria-checked='true'] .umSwitchThumb{background:var(--dsw-alias-label-primary-foreground);transform:translateX(16px)}
.umRefresh{margin-left:8px;padding:2px;border:0;border-radius:4px;background:0 0;cursor:pointer;color:var(--dsw-alias-label-tertiary);
  display:inline-flex;align-items:center;vertical-align:-2px}
.umRefresh svg{width:13px;height:13px;flex:none}
.umRefresh:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.umRefresh[disabled]{cursor:default;opacity:.45;background:0 0}
`;

    // ========================================================================
    // 5. 浮层定位与关闭（宿主同类弹层用 primitives 的两个 hook；官方约定插件
    // 不要 require Harness 客户端包，所以按同一套数值自己实现：间距 8px、
    // 离视口边缘留白 12px、上方放不下翻到下方）
    // ========================================================================

    function installStyles() {
      let style = document.querySelector('style[data-dsh-style="usage-pill"]');
      if (style === null) {
        style = document.createElement('style');
        style.setAttribute('data-dsh-style', 'usage-pill');
        (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = CSS;
    }

    const PANEL_GAP = 8;
    const PANEL_MARGIN = 12;
    const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };

    /**
     * 把面板锚定在触发元素上方并钳制在视口内。
     * @param open - 是否展开。
     * @param anchorRef - 触发元素。
     * @param panelRef - 面板（position:fixed）。
     * @returns 定位样式；未量到尺寸时返回 null。
     */
    /**
     * 分模型的 dt/dd 节点。
     *
     * 提成函数是为了让面板那处**不套三层括号** —— 内联写时括号数极易数错。
     *
     * 【为什么在组件区而不是纯逻辑区】它调用 `h()` / `React.Fragment`；放进纯逻辑区
     * 会破坏"那段可被 node 直接求值"的前提（结构测试会抓 —— 实际就抓到了）。
     *
     * @param rows - `modelRowsOf` 的结果。
     * @returns 一组 dt/dd 片段。
     */
    function modelRowNodes(rows) {
      return rows.map((row) => h(React.Fragment, { key: row[0] },
        h('dt', null, h('span', { className: 'umModelName', title: row[0] }, row[0])),
        h('dd', null, fmtMoney(row[1]))));
    }

    function useAnchoredPosition(open, anchorRef, panelRef) {
      const [pos, setPos] = useState(null);
      useLayoutEffect(() => {
        if (!open) { setPos(null); return undefined; }
        let frame = 0;
        let disposed = false;
        const place = () => {
          if (disposed) return;
          const anchor = anchorRef.current;
          const panel = panelRef.current;
          if (!anchor || !panel) return;
          const box = anchor.getBoundingClientRect();
          const size = panel.getBoundingClientRect();
          const viewport = window.visualViewport;
          const width = viewport ? viewport.width : window.innerWidth;
          const height = viewport ? viewport.height : window.innerHeight;
          const offsetLeft = viewport ? viewport.offsetLeft : 0;
          const offsetTop = viewport ? viewport.offsetTop : 0;
          const minLeft = offsetLeft + PANEL_MARGIN;
          const minTop = offsetTop + PANEL_MARGIN;
          const maxLeft = Math.max(minLeft, offsetLeft + width - size.width - PANEL_MARGIN);
          const left = Math.min(Math.max(box.left + box.width / 2 - size.width / 2, minLeft), maxLeft);
          let top = box.top - size.height - PANEL_GAP;
          if (top < minTop) {
            const below = box.bottom + PANEL_GAP;
            top = below + size.height + PANEL_MARGIN <= offsetTop + height
              ? below : Math.max(minTop, offsetTop + height - size.height - PANEL_MARGIN);
          }
          const next = { left: Math.round(left), top: Math.round(top), visibility: 'visible' };
          setPos((previous) => previous && previous.left === next.left && previous.top === next.top
            && previous.visibility === next.visibility ? previous : next);
        };
        const schedule = () => {
          if (frame || disposed) return;
          frame = window.requestAnimationFrame(() => { frame = 0; place(); });
        };
        // 在首次绘制前完成定位，避免隐藏的 backdrop-filter 层延迟绘制。
        place();
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
        if (observer) {
          observer.observe(anchorRef.current);
          observer.observe(panelRef.current);
        }
        window.addEventListener('resize', schedule);
        window.addEventListener('scroll', schedule, true);
        const viewport = window.visualViewport;
        if (viewport) {
          viewport.addEventListener('resize', schedule);
          viewport.addEventListener('scroll', schedule);
        }
        return () => {
          disposed = true;
          if (frame) window.cancelAnimationFrame(frame);
          if (observer) observer.disconnect();
          window.removeEventListener('resize', schedule);
          window.removeEventListener('scroll', schedule, true);
          if (viewport) {
            viewport.removeEventListener('resize', schedule);
            viewport.removeEventListener('scroll', schedule);
          }
        };
      }, [open]);
      return pos;
    }

    /** 两个 DOM 子树共同组成弹层；Escape 返回触发按钮，外点保留新焦点。 */
    function useDismissOnOutsidePointer(open, setOpen, rootRef, panelRef) {
      useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
          if ([rootRef.current, panelRef.current].some((node) => node
            && (path.includes(node) || node.contains(event.target)))) return;
          setOpen(false);
        };
        const onKeyDown = (event) => {
          if (event.key !== 'Escape') return;
          event.stopPropagation();
          setOpen(false);
          rootRef.current?.querySelector('button')?.focus({ preventScroll: true });
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        document.addEventListener('keydown', onKeyDown, true);
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true);
          document.removeEventListener('keydown', onKeyDown, true);
        };
      }, [open, setOpen]);
    }

    /** 余额请求共享缓存与进行中的 Promise，切换会话不会重复请求。 */
    let balanceCache = null;
    let balanceRequest = null;
    const REQUEST_TIMEOUT_MS = 15000;
    const errorText = (error) => String(error?.message || error || 'Unknown error')
      .replace(/sk-[A-Za-z0-9]{6,}/gi, 'sk-***');

    function withDeadline(task) {
      let timer;
      return Promise.race([
        Promise.resolve().then(task),
        new Promise((_, reject) => { timer = window.setTimeout(() => reject(new Error('Balance request timed out')), REQUEST_TIMEOUT_MS); }),
      ]).finally(() => window.clearTimeout(timer));
    }

    function requestBalance(force = false) {
      if (balanceRequest) return balanceRequest;
      if (!force && balanceCache && Date.now() - balanceCache.at < BALANCE_FRESH_MS) {
        return Promise.resolve({ balance: balanceCache, error: null, accountError: null });
      }
      balanceRequest = (async () => {
        let accountError = null;
        try {
          if (ACCOUNT && typeof ACCOUNT.getBalance === 'function') {
            let localeId = 'zh-CN';
            try { localeId = LOCALE?.getSnapshot()?.active || localeId; } catch { /* 默认语言 */ }
            const result = await withDeadline(() => ACCOUNT.getBalance({
              version: '0.2.0-rc.2', locale: localeId,
              timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
            }));
            if (result?.ok) {
              const normalized = fromAccountBalance(result.value);
              if (normalized) {
                balanceCache = normalized;
                return { balance: normalized, error: null, accountError: null };
              }
            } else if (result) accountError = errorText(result.error || 'Account balance unavailable');
          }
        } catch (error) { accountError = errorText(error); }
        const controller = new AbortController();
        try {
          const data = await withDeadline(async () => {
            const response = await fetch(BALANCE_API, { method: 'POST', signal: controller.signal,
              headers: force ? { 'x-usage-pill-refresh': '1' } : undefined });
            return response.json();
          });
          const normalized = data?.ok ? fromKeyBalance(data) : null;
          if (!normalized) throw new Error(data?.error || 'Balance unavailable');
          balanceCache = normalized;
          return { balance: normalized, error: null, accountError };
        } catch (error) {
          return { balance: balanceCache, error: errorText(error), accountError };
        } finally { controller.abort(); }
      })().finally(() => { balanceRequest = null; });
      return balanceRequest;
    }

    function useBalance(open) {
      const [result, setResult] = useState(() => ({ balance: balanceCache, error: null, accountError: null }));
      const [busy, setBusy] = useState(false);
      const alive = useRef(false);
      const load = useCallback(async (force = true) => {
        if (alive.current) setBusy(true);
        const next = await requestBalance(force);
        if (alive.current) { setResult(next); setBusy(false); }
      }, []);
      useEffect(() => {
        alive.current = true;
        load(false);
        return () => { alive.current = false; };
      }, [load]);
      useEffect(() => {
        if (open) load(false);
      }, [open, load]);
      return { balance: result.balance, balanceError: result.error, accountError: result.accountError,
        balanceBusy: busy, loadBalance: () => load(true) };
    }

    // ========================================================================
    // 6. 组件
    // ========================================================================

    /**
     * 峰谷切换倒计时。
     *
     * 【为什么单独抽成组件】它需要每秒刷新，而面板其余部分（四桶明细、单价表、
     * 时段轴）跟着每秒重渲染纯属浪费。把跳秒状态关在这里之后，父组件只在每 30 秒
     * 对齐一次峰谷状态即可。
     *
     * @param props.target - 切换时刻（UTC 毫秒），undefined 表示十天之内没有切换。
     * @param props.t - 文案函数。
     * @returns 一行倒计时 + 切换时刻。
     */
    function Countdown({ target, t, prefix }) {
      const [now, setNow] = useState(() => Date.now());
      useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
      }, []);
      return h('div', {
        className: 'umMeta',
        title: target === undefined ? undefined : fmtBeijing(target) + ' ' + t('panel.beijing'),
      },
      (prefix === undefined || prefix === '' ? '' : prefix + ' · ')
        + fmtCountdown(target === undefined ? null : target - now) + ' ' + t('panel.afterSwitch'));
    }

    /**
     * 时段图标：**高峰画太阳、空闲画月亮** —— 一眼看出现在贵不贵，
     * 同时用状态色（高峰琥珀 / 空闲绿）强化。
     * 与宿主图标同一套描边语言（16 视框、currentColor、圆头圆角）。
     * @param props.peak - 是否处于高峰。
     * @returns 内联 SVG。
     */
    function PeriodIcon({ peak }) {
      // 【为什么写死宽高】CSS 不在时，一个只有 viewBox 的 SVG 会撑满容器 ——
      // 那正是"胶囊变成巨型月亮"的放大器。宽高与 CSS 声明一致，样式在时视觉不变。
      // 【线宽 1】照官方图标契约 ICON_REGULAR_STROKE = 1（medium 才 1.3）；
      // 原先的 1.5 比全应用任何图标都重，看起来就是"不像宿主的东西"。
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round',
        className: peak ? 'umIconPeak' : 'umIconOff',
      }, peak
        ? [h('circle', { key: 'disc', cx: 8, cy: 8, r: 3.1 }),
          h('path', {
            key: 'rays',
            d: 'M8 1.4v1.7M8 12.9v1.7M1.4 8h1.7M12.9 8h1.7M3.4 3.4l1.2 1.2M11.4 11.4l1.2 1.2M12.6 3.4l-1.2 1.2M4.6 11.4l-1.2 1.2',
          })]
        : h('path', { d: 'M13.2 9.6A5.6 5.6 0 0 1 6.4 2.8 5.7 5.7 0 1 0 13.2 9.6z' }));
    }

    /**
     * 刷新图标：自绘 SVG，不用 `⟳` 这类字符 —— 字体缺字时会退化成奇怪的形状。
     * 与宿主图标同一套描边语言（16 视框、currentColor、圆头圆角）。
     * @returns 内联 SVG。
     */
    function RefreshIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('path', { d: 'M13 8a5 5 0 1 1-1.55-3.6' }),
      h('path', { d: 'M13.3 2.5v2.7h-2.7' }));
    }

    /** 图标：与宿主同一套描边语言（16 视框、currentColor、圆头）。 */
    function MeterIcon() {
      return h('svg', {
        viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round',
      },
      h('ellipse', { cx: 8, cy: 4.2, rx: 4.8, ry: 2.2 }),
      h('path', { d: 'M3.2 4.2v7.6c0 1.2 2.1 2.2 4.8 2.2s4.8-1 4.8-2.2V4.2' }),
      h('path', { d: 'M3.2 8c0 1.2 2.1 2.2 4.8 2.2S12.8 9.2 12.8 8' }));
    }

    /** 设置的持久化键（带版本，结构变了就升版本，避免读到旧形状）。 */
    const SETTINGS_KEY = 'usage-pill.settings.v1';
    /** 设置的内存快照；localStorage 只在首次读取与写入时碰。 */
    let settingsSnapshot = null;
    /** 设置订阅者（组件）。 */
    const settingsListeners = new Set();

    /**
     * 读设置（带内存缓存）。存储不可用（隐私模式等）时静默用默认值。
     * @returns 完整设置。
     */
    function readSettings() {
      if (settingsSnapshot !== null) return settingsSnapshot;
      let raw;
      try {
        raw = JSON.parse(window.localStorage.getItem(SETTINGS_KEY));
      } catch {
        raw = undefined;
      }
      settingsSnapshot = normalizeSettings(raw);
      return settingsSnapshot;
    }

    /**
     * 改一项设置并落盘，然后通知订阅者。
     * @param key - 设置名（{@link SETTINGS_DEFAULTS} 的键）。
     * @param value - 新值。
     */
    function writeSetting(key, value) {
      writeSettings({ ...readSettings(), [key]: value });
    }

    /** 原子更新整份显示设置（恢复默认只广播一次）。 */
    function writeSettings(value) {
      settingsSnapshot = normalizeSettings(value);
      try {
        window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settingsSnapshot));
      } catch {
        // 存储不可用就只在内存里生效，不打扰用户
      }
      for (const listener of settingsListeners) listener(settingsSnapshot);
    }

    /** 在组件里订阅设置。 */
    function useSettings() {
      const [value, setValue] = useState(readSettings);
      useEffect(() => {
        const listener = (next) => setValue(next);
        settingsListeners.add(listener);
        setValue(readSettings());
        return () => { settingsListeners.delete(listener); };
      }, []);
      return value;
    }

    /**
     * 文案函数：优先框架绑定的 t（走 `locale: NS` 注册的词典），缺词典时退回本地中文。
     * @param props - 槽位属性，可能带 `t`。
     * @returns 取词函数。
     */
    function translator(props) {
      return (key, params) => {
        let text;
        if (typeof props.t === 'function') {
          try { text = props.t(key, params); } catch { text = undefined; }
        }
        if (typeof text !== 'string' || text.length === 0 || text === key) {
          text = ZH[key] !== undefined ? ZH[key] : key;
        }
        if (params) {
          for (const name of Object.keys(params)) text = text.split('{' + name + '}').join(String(params[name]));
        }
        return text;
      };
    }

    /**
     * 开关：与官方 `@deepseek-ai/dsh-client-ui-primitives` 的 Switch 同构 ——
     * `<button role="switch" aria-checked>` + 一个圆钮 span，样式见 CSS 里的 `.umSwitch`。
     *
     * 不用 `<input type="checkbox">`：宿主有它的全局样式，特异性压得过类选择器，
     * 而且无法表达"开关"这一语义（`role="switch"` 才是对应的无障碍角色）。
     *
     * @param props.checked - 是否打开。
     * @param props.label - 无障碍名称。
     * @param props.onChange - 切换回调。
     * @returns 开关按钮。
     */
    function Switch({ checked, label, onChange }) {
      return h('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': checked,
        'aria-label': label,
        className: 'umSwitch',
        onClick: () => onChange(!checked),
      }, h('span', { className: 'umSwitchThumb' }));
    }

    /**
     * 设置卡片。
     *
     * 注册进 `plugins.bundle.config`（key 用包名），渲染在**本 bundle 的插件页**上、
     * 描述与组件列表之间 —— 这是官方给 bundle 配置指定的槽位，官方 voice-input
     * bundle 用的就是它（`plugins.item` 是给"一个官方命名空间一个伴侣包"的设置页用的）。
     *
     * 数值存在浏览器本地（localStorage）：这些都是**展示偏好**，不是宿主状态，
     * 没必要走宿主；也因此宿主半边缺席时设置照常可用。
     *
     * @param props - 槽位属性（`view` / `t`）。
     * @returns 卡片内容。
     */
    function UsageMeterSettings(props) {
      const t = translator(props);
      const settings = useSettings();
      useLayoutEffect(() => { if (props.view === 'page') installStyles(); }, [props.view]);
      const [restored, setRestored] = useState(false);
      if (props.view !== 'page') return null;
      const isDefault = Object.keys(SETTINGS_DEFAULTS).every((key) => settings[key] === SETTINGS_DEFAULTS[key]);
      const renderRow = (key) => h('div', { key, className: 'umSetting' },
        h('span', { className: 'umSettingText' },
          h('span', { className: 'umSettingLabel' }, t('settings.' + key)),
          h('span', { className: 'umSettingHint' }, t('settings.' + key + 'Hint'))),
        h(Switch, { checked: settings[key], label: t('settings.' + key),
          onChange: (next) => { setRestored(false); writeSetting(key, next); } }));
      // 示例只展示格式，不查询账号或改动会话数据；与真实胶囊使用相同的兜底规则。
      const previewCost = settings.pillCost || (!settings.pillPeriod && !settings.pillBalance);
      const detailRow = (key, value) => h('div', { key, className: 'umDetailPreviewRow' },
        h('span', null, t(key)), h('span', null, value));
      return h('div', { className: 'umSettings' },
        h('div', { className: 'umSettingsHead' },
          h('div', { className: 'umSettingsIntro' },
            h('div', { className: 'umSettingsTitle' }, t('settings.title')),
            h('div', { className: 'umSettingsNote' }, t('settings.note'))),
          h('button', { className: 'umSettingsButton', type: 'button', disabled: isDefault,
            onClick: () => { writeSettings(SETTINGS_DEFAULTS); setRestored(true); } }, t('settings.reset'))),
        restored ? h('div', { className: 'umSettingsNote', role: 'status' }, t('settings.resetDone')) : null,
        h('section', { className: 'umSettingsCard', 'aria-label': t('settings.pillGroup') },
          h('div', { className: 'umSettingsTitle' }, t('settings.pillGroup')),
          h('div', { className: 'umSettingsPreview', 'aria-label': t('settings.preview') },
            h('div', { className: 'umSettingsNote' }, t('settings.preview') + ' · ' + t('settings.sample')),
            h('div', { className: 'umPreviewPill' },
              settings.pillPeriod ? h(PeriodIcon, { peak: false }) : null,
              h('span', null, previewCost ? '≈¥0.12' : '',
                previewCost && settings.pillBalance ? h('span', { className: 'umSep', 'aria-hidden': true }, '·') : null,
                settings.pillBalance ? t('pill.balance') + ' ¥37.00' : ''))),
          ...['pillPeriod', 'pillCost', 'pillBalance'].map(renderRow),
          h('div', { className: 'umSettingsNote' }, t('settings.fallback'))),
        h('section', { className: 'umSettingsCard', 'aria-label': t('settings.detailGroup') },
          h('div', { className: 'umSettingsTitle' }, t('settings.detailGroup')),
          h('div', { className: 'umDetailPreview umSettingsNote', 'aria-label': t('settings.preview') + ' · ' + t('settings.detailGroup') },
            h('div', null, t('settings.sample')),
            detailRow('panel.miss', '1,200 tok'), detailRow('panel.out', '600 tok'),
            !settings.hideEmptyBuckets ? detailRow('panel.write', '0 tok') : null,
            settings.showSaved ? detailRow('panel.saved', '≈¥0.04') : null),
          ...['hideEmptyBuckets', 'showSaved'].map(renderRow)),
        h('details', { className: 'umSettingsCard' }, h('summary', null, t('settings.explain')),
          h('div', { className: 'umSettingsHelp umSettingsNote' },
            ...['settings.explainCost', 'settings.explainBalance', 'settings.explainSaved'].map((key) => h('div', { key }, t(key))))));
    }

    /**
     * 用量与余额徽标 + 详情弹层。
     * @param props - 槽位属性（useProjection / useSessions / sessionId / t）。
     * @returns 徽标（展开时一并渲染面板）。
     */
    function UsageMeter(props) {
      useLayoutEffect(installStyles, []);
      const t = translator(props);
      /** 展示偏好（插件页里可改，见 UsageMeterSettings）。 */
      const settings = useSettings();

      // 宿主投影：tokenUsage 是响应式的（4 个桶），所以本插件不需要任何轮询。
      const useProjection = typeof props.useProjection === 'function' ? props.useProjection : () => undefined;
      const usage = useProjection('tokenUsage');
      // 宿主 usagePillCost 投影：逐笔计价的**实际发生额**（按每笔用量自己的时刻与模型算），
      // 与 tokenUsage 的区别见 README「金额口径」一节。
      const costView = useProjection('usagePillCost');
      // 当前模型（决定 flash / pro 档）：与官方 client-ui-agent-team 读 modelSelection
      // 的路径一致；取不到就按 pro 档并在面板里说明，不静默乱猜。
      const useSessions = typeof props.useSessions === 'function' ? props.useSessions : () => undefined;
      const sessionId = props.sessionId;
      const model = useSessions((state) => {
        try {
          const entry = state && state.projectionsBySession && sessionId !== undefined
            ? state.projectionsBySession[sessionId] : undefined;
          const selection = entry && entry.values ? entry.values.modelSelection : undefined;
          return selection && selection.next ? selection.next.model : undefined;
        } catch {
          return undefined;
        }
      });

      const [now, setNow] = useState(() => Date.now());
      const [open, setOpen] = useState(false);
      const { balance, balanceError, accountError, balanceBusy, loadBalance } = useBalance(open);
      const rootRef = useRef(null);
      const panelRef = useRef(null);
      const panelId = useId();
      const pos = useAnchoredPosition(open, rootRef, panelRef);
      useDismissOnOutsidePointer(open, setOpen, rootRef, panelRef);
      const closePanel = () => {
        setOpen(false);
        rootRef.current?.querySelector('button')?.focus({ preventScroll: true });
      };

      // 计时：30 秒一格 —— 够跟上峰谷切换与时段轴上的"现在"。倒计时的每秒刷新
      // 由子组件 Countdown 自理，整个面板不必每秒重渲染。
      // 页面在后台时暂停，回到前台立即补一次。
      useEffect(() => {
        const period = 30000;
        let timer = 0;
        const tick = () => setNow(Date.now());
        const start = () => { if (timer === 0) timer = window.setInterval(tick, period); };
        const stop = () => { if (timer !== 0) { window.clearInterval(timer); timer = 0; } };
        const onVisibility = () => {
          if (document.hidden === true) stop();
          else { tick(); start(); }
        };
        if (document.hidden !== true) start();
        document.addEventListener('visibilitychange', onVisibility);
        return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
      }, []);

      const tier = tierOfModel(model);
      const hasUsage = usage !== undefined && usage !== null;
      // 当前生效单价：这是"此刻的价"，本来就该按浏览器此刻算，用于计价口径展示。
      const estimate = costOf(hasUsage ? usage : undefined, tier, now);
      const rate = estimate.rate;
      const stateText = rate.peak ? t('panel.peak') : t('panel.off');
      const nextSwitch = nextSwitchAt(now);

      // 金额来源优先级：宿主逐笔计价（实际发生额）> 按当前价估算 > 无。
      // 绝不把估算冒充账单 —— 面板里会写清用的是哪一种。
      const pricedView = costView !== undefined && costView !== null
        && (Number(costView.pricedRequests) + Number(costView.unpricedRequests)) > 0
        ? costView
        : null;
      const money = pricedView !== null
        ? {
          hit: Number(pricedView.cacheReadCny) || 0,
          miss: Number(pricedView.missCny) || 0,
          write: Number(pricedView.writeCny) || 0,
          out: Number(pricedView.outputCny) || 0,
          total: Number(pricedView.totalCny) || 0,
        }
        : (hasUsage
          ? { hit: estimate.hit, miss: estimate.miss, write: estimate.write, out: estimate.out, total: estimate.total }
          : null);
      const totalMoney = money === null ? null : money.total;
      /** 分模型行：只在宿主逐笔计价可用且真的换过模型时非空。 */
      const modelRows = pricedView === null ? [] : modelRowsOf(pricedView);
      const tokens = hasUsage ? totalTokens(usage) : null;
      /** 金额文案：拿不到用量时显示破折号，而不是 ¥0（那会被读成"免费"）。 */
      const moneyText = (value) => (value === null || value === undefined ? '—' : fmtMoney(value));
      const totalText = totalMoney === null ? '—' : '≈' + fmtMoney(totalMoney);
      /** token 数只在 tooltip 里给精确值 —— 面板正文放 1.45 亿这种数字只会抢视线。 */
      const tokenTitle = (value) => (value === null || value === undefined
        ? undefined
        : fmtExactTokens(value) + ' ' + t('pill.tokens'));
      /** 缓存已省：命中的 token 若按未命中价计要多花多少（按当前价算）。 */
      const saved = hasUsage && rate.miss > rate.hit
        ? ((Number(usage.cacheReadTokens) || 0) * (rate.miss - rate.hit)) / 1e6
        : null;
      /** 金额口径说明：正常（逐笔实际）只进 tooltip，估算时才占一行提示。 */
      const moneySource = pricedView !== null
        ? t('panel.actual')
        : (hasUsage ? t('panel.estimated') : t('panel.noUsage'));
      const moneyNote = pricedView === null
        ? h('div', { className: 'umNote' }, moneySource)
        : null;
      /** 表头 tooltip：口径 + 精确 token 总量。 */
      const totalTitle = [moneySource, tokenTitle(tokens)].filter(Boolean).join(' · ');

      const wallets = balance === null ? [] : balance.wallets;
      // 元计费界面优先显示人民币；其它币种分别列出，不比较跨币种面额。
      const primary = wallets.length > 0
        ? (wallets.find((wallet) => wallet.currency === 'CNY') || wallets[0])
        : null;
      const balanceText = primary === null ? null : fmtMoney(primary.total, symbolOf(primary.currency));
      const bonusText = primary !== null && primary.bonus > 0 ? fmtMoney(primary.bonus, symbolOf(primary.currency)) : null;
      const otherWallets = wallets.filter((wallet) => wallet !== primary);
      const sourceText = balance === null ? '' : (balance.source === 'account' ? t('panel.sourceAccount') : t('panel.sourceKey'));
      // 余额取不到时的说明：**可见文案保持简短**（两条技术错误拼一行会撑破版面），
      // 完整原因进 tooltip —— 既不丢信息，也不破坏排版。
      const balanceFailure = balanceError !== null ? t('panel.balanceFailed') : t('panel.balanceLoading');
      const balanceFailureTitle = [accountError, balanceError].filter(Boolean).join(' · ');

      /** 计价表：一行一个桶 —— 名称 / 当前单价 / 本会话花费（token 数进 tooltip）。 */
      const tableRows = [
        ['hit', rate.hit, money === null ? null : money.hit, hasUsage ? usage.cacheReadTokens : undefined],
        ['miss', rate.miss, money === null ? null : money.miss, hasUsage ? usage.uncachedInputTokens : undefined],
        ['write', rate.miss, money === null ? null : money.write, hasUsage ? usage.cacheWriteTokens : undefined],
        ['out', rate.out, money === null ? null : money.out, hasUsage ? usage.outputTokens : undefined],
      ];
      /** 只显示真正发生过的桶（见 visibleRows 的说明）。 */
      const shownRows = visibleRows(tableRows, hasUsage && settings.hideEmptyBuckets);
      /** 模型文案：认得出就只显示模型名（档位从名字就能看出），认不出才解释。 */
      const modelText = model === undefined || model === null || model === ''
        ? t('panel.tierUnknown', { tier: tier })
        : String(model);

      /** 单价列的口径提示：换过模型时，单价是**当前模型**的、金额是**全部模型**累计的。 */
      const unitNote = t('panel.unitMulti', { model: modelText });
      /**
       * 分模型区块。合计是跨模型累加的，换过模型之后这一块才说清"各花了多少"；
       * 只有一个模型时 `modelRowsOf` 返回空，整块不渲染。
       */
      const modelSection = modelRows.length === 0 ? null : h(React.Fragment, null,
        h('div', { className: 'umTitleRule', 'aria-hidden': true }),
        h('div', { className: 'umSect' }, t('panel.byModel')),
        h('dl', { className: 'umDetails' }, modelRowNodes(modelRows)));

      const portalHost = typeof document === 'undefined' ? null : (document.body || document.documentElement);
      const panel = open && portalHost !== null ? createPortal(h('div', {
        ref: panelRef,
        id: panelId, tabIndex: -1,
        className: 'umPanel',
        role: 'dialog',
        'aria-label': t('panel.title'),
        style: pos === null ? MEASURE_STYLE : pos,
      },
      h('div', { className: 'umTitle' },
        h('span', { className: 'umTitleLabel' }, h(MeterIcon), t('panel.title')),
        h('span', { className: 'umTitleValue', title: totalTitle }, totalText),
        h('button', { className: 'umClose', type: 'button', title: t('panel.close'),
          'aria-label': t('panel.close'), onClick: closePanel }, '×')),
      h('div', { className: 'umSect', title: tokenTitle(tokens) }, t('panel.session') + ' · ' + (tokens === null ? '—' : fmtExactTokens(tokens) + ' tok')),
      h('div', { className: 'umTitleRule', 'aria-hidden': true }),
      // 概览：账户余额（可刷新）与缓存省下的钱 —— 这两条是"状态"，不是"构成"
      h('dl', { className: 'umDetails' },
        h('dt', null, t('panel.balance')),
        h('dd', null,
          balanceText !== null
            ? h(React.Fragment, null,
              h('span', { title: sourceText }, balanceText + (bonusText === null ? '' : '（' + t('panel.balanceBonus') + ' ' + bonusText + '）')),
              otherWallets.map((wallet) => h('div', { key: wallet.currency }, '+' + fmtMoney(wallet.total, symbolOf(wallet.currency)))))
            : h('span', { title: balanceFailureTitle || undefined }, balanceBusy ? t('panel.balanceLoading') : balanceFailure),
          h('button', { type: 'button', className: 'umRefresh',
            title: balanceFailureTitle || t('panel.balanceRefresh'),
            'aria-label': balanceError ? t('panel.retry') : t('panel.balanceRefresh'),
            disabled: balanceBusy, onClick: loadBalance }, h(RefreshIcon)),
          balanceText !== null && balanceError ? h('div', { className: 'umNote', role: 'status', title: balanceFailureTitle }, t('panel.stale')) : null),
        saved === null || !settings.showSaved ? null : h(React.Fragment, null,
          h('dt', null, t('panel.saved')),
          h('dd', null, h('span', { className: 'umSaved', title: t('panel.savedNote') }, fmtMoney(saved))))),
      h('div', { className: 'umTitleRule', 'aria-hidden': true }),
      // 花费构成：沿用宿主统计弹层的 dt/dd 两列，一行一个桶；精确 token 数进 tooltip
      h('div', { className: 'umSect' }, t('panel.breakdown') + '（' + t('panel.unit') + '）'),
      pricedView !== null ? h('div', { className: 'umNote', style: { marginTop: 0, marginBottom: 8 } }, t('panel.currentRates')) : null,
      h('dl', { className: 'umDetails' },
        shownRows.length === 0
          ? h('dd', { className: 'umEmpty' }, t('panel.noUsageYet'))
          : null,
        shownRows.map(([key, unitPrice, spent, bucketTokens]) => h(React.Fragment, { key: key },
          h('dt', null, t('panel.' + key)),
          h('dd', null, h('span', { className: 'umCostLine' },
            h('span', { title: tokenTitle(bucketTokens) }, moneyText(spent)),
            h('span', { className: 'umUnit', title: unitNote }, ' @' + fmtMoney(unitPrice))))))),
      modelSection,
      h('div', { className: 'umTitleRule', 'aria-hidden': true }),
      // 时段：一行说清"现在什么价、还能用多久"。倒计时部分自带 1 秒刷新。
      h(Countdown, {
        target: nextSwitch,
        t: t,
        prefix: stateText + ' · ' + modelText
          + (rate.peak ? ' · ' + t('panel.peakTimes', { mult: rate.multiplier }) : ''),
      }),
      h('div', { className: 'umSect', style: { marginTop: 4 } }, t('panel.timeline')),
      h('div', { className: 'umTrack' },
        PEAK_WINDOWS.map(([start, end], index) => h('div', {
          key: 'band' + index, className: 'umBand',
          style: { left: (start / 1440 * 100) + '%', width: ((end - start) / 1440 * 100) + '%' },
        })),
        h('div', { className: 'umNow', style: { left: (beijingClock(now).minutes / 1440 * 100) + '%' } })),
      h('div', { className: 'umAxis' },
        h('span', null, '00:00'), h('span', null, '06:00'), h('span', null, '12:00'),
        h('span', null, '18:00'), h('span', null, '24:00')),
      moneyNote), portalHost) : null;

      // 三段全关或仅显示余额但余额不可用时，费用段兜底，保留可见入口。
      const showCost = settings.pillCost || (!settings.pillPeriod && (!settings.pillBalance || balanceText === null));
      /** 各段：`[类型, 内容]`。图标与文字分开标注，才能只给文字段之间放点。 */
      const pillSegments = [];
      if (settings.pillPeriod) {
        pillSegments.push(['icon', h(PeriodIcon, { key: 'period', peak: rate.peak })]);
      }
      if (showCost) pillSegments.push(['text', totalText]);
      if (settings.pillBalance && balanceText !== null) {
        pillSegments.push(['text', t('pill.balance') + ' ' + balanceText]);
      }
      const dots = separatorBefore(pillSegments.map(([kind]) => kind));
      // **按官方结构组装**：图标是 pill 的 flex 子元素，文字段与分隔点则**同包在一个
      // label span 里**（label 是 inline，不是 flex 容器）。
      // 若把分隔点也做成平级 flex 子元素，pill 的 gap:6px 会**叠加**在它的
      // margin:0 6px 上 —— 点两侧各 12px，正好是官方 6px 的两倍（实测截图确认过）。
      let pillIcon = null;
      const labelParts = [];
      pillSegments.forEach(([kind, content], index) => {
        if (kind === 'icon') {
          pillIcon = content;
          return;
        }
        if (dots[index]) {
          labelParts.push(h('span', { key: 'sep' + index, className: 'umSep', 'aria-hidden': true }, '·'));
        }
        labelParts.push(content);
      });
      const pillChildren = [pillIcon, labelParts.length === 0 ? null : h('span', { key: 'label', className: 'umLabel' }, labelParts)];

      return h('div', { className: 'umRoot', ref: rootRef },
        h('span', { className: 'umAnchor' },
          h('button', {
            type: 'button',
            className: 'umPill',
            title: t('pill.hint'),
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            'aria-label': totalText + ' · ' + stateText
              + (balanceText === null ? '' : ' · ' + t('pill.balance') + ' ' + balanceText),
            'aria-controls': open ? panelId : undefined,
            onClick: () => setOpen((previous) => !previous),
          },
          pillChildren)),
        panel);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        LOCALE = ctx.get('locale');
        // 可选注入账号 Remote：只有它真的可用时才捕获，拿不到不影响插件其余部分。
        try {
          ctx.inject(['remote', 'remote.account'], (scope) => {
            ACCOUNT = scope.remote.account;
            const captured = ACCOUNT;
            scope.effect(() => () => { if (ACCOUNT === captured) { ACCOUNT = undefined; balanceCache = null; } });
          });
        } catch (error) {
          ACCOUNT = undefined;
        }
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'usage-pill: dictionaries');
        // 样式注入：**幂等 + 带键 + 不随 dispose 移除**。
        //
        // 【踩过的坑 1】原先把 <style> 放在徽标组件树里 —— 设置卡是在**另一个槽位**
        // （插件页的 plugins.bundle.config）渲染的，那边一个样式都拿不到，于是整张卡
        // 退化成裸文字 + 原生复选框。所以必须插件级注入。
        //
        // 【踩过的坑 2】原先是"每次 apply 建一个新 <style>、dispose 时移除"。一旦出现
        // 孤儿注册（旧实例被 dispose 而注册泄漏下来，HMR 重载期间就会发生），页面就进入
        // 「组件还在、样式没了」的状态 —— 视觉上就是胶囊变成撑满容器的巨型图标。
        // 现在按**键**复用同一个 <style> 并在每次 apply 刷新内容：重复 apply 不会叠加，
        // 卸载后残留的那几 KB 样式匹配不到任何元素（下次刷新自然消失），
        // 而这个失败模式的代价比留一份样式表难看得多。官方客户端插件也是先 querySelector
        // 找同键样式再注入。
        ctx.effect(installStyles, 'usage-pill: styles');
        // 设置卡：bundle 自己的配置槽，key 用包名（官方给 bundle 配置指定的位置，
        // 渲染在本 bundle 插件页的描述与组件列表之间）。
        // 【踩过的坑】`slots.inject` 返回的是 dispose 函数，**必须**用 `ctx.effect` 包住
        // —— 官方每一个客户端插件都是这么写的。不包住就会这样：插件被 dispose 时，
        // 由 effect 管理的 <style> 被移除，而这个注入却**泄漏**下来继续渲染，
        // 结果是「组件还在、样式没了」：胶囊退化成撑满容器的巨型图标 + 挤在一起的文字。
        ctx.effect(() => ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: 'dsh-usage-pill',
          locale: NS,
        }, UsageMeterSettings)), 'usage-pill: settings card');
        ctx.effect(() => ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: CELL,
          order: 10,
          locale: NS,
        }, UsageMeter)), 'usage-pill: dock cell');
      },
    };
  },
});
