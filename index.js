/**
 * 用量与余额 —— 宿主半边。
 *
 * 【职责两件】
 *   1. 注册 `usagePillCost` 会话投影 —— **逐笔按实际时刻与模型**计价（见
 *      lib/cost-projection.js）。这件事必须由宿主做：浏览器只能读到累计的四个桶，
 *      拿不到"这一笔是什么时候、什么模型花的"，用累计桶×当前价算会被历史追溯改写。
 *   2. 按需查询 DeepSeek 账户余额（API Key 兜底那条路径）。
 *   其余（token 用量、当前单价展示、界面）在浏览器半边完成：用量读 DSH 自带的
 *   `tokenUsage` 投影，是响应式的，不需要轮询。
 *
 * 【设计取舍（参考社区同类插件后的结论）】
 *   · 用宿主进程直接 `fetch`，**不用 shell**：社区里用 PowerShell 实现的那批
 *     （含 dsh-whale-girl-pet 0.3.5）在 macOS/Linux 上没有 pwsh，必然失败；
 *     而且为了走网络还得申请 danger-full-access 沙箱提权。直接 fetch 三个问题一起消掉。
 *   · API Key 只在宿主进程里出现，放进 Authorization 头，**绝不下发浏览器**；
 *     错误信息按 `sk-` 前缀脱敏。
 *   · 60 秒内存缓存：余额不是实时量，避免面板反复开关时反复打接口。
 *   · 路由做同源/回环校验：DSH 的 webServer 自身不带认证与来源策略，
 *     不校验的话任意网页都能对 127.0.0.1 发起跨站"简单请求"。
 */

import { createCostUsageProjection } from './lib/cost-projection.js';

/** 插件行 id（与 cordis.patch.yml 一致）。 */
const name = 'usage-pill';
/**
 * 需要注入的服务：`sessionProjections`（注册逐笔计价的 usagePillCost 投影）。
 *
 * `webServer` **不在这里** —— 它只服务于"API Key 兜底"那条余额路径，账号登录
 * 的用户根本用不到。把整插件硬挂在它上面会让纯客户端功能也被连坐，所以它在
 * apply 里用 `ctx.inject(['webServer'], …)` 条件注册。
 */
const inject = ['sessionProjections'];

/** 官方余额接口。 */
const BALANCE_URL = 'https://api.deepseek.com/user/balance';
/** 余额缓存时长：余额不是实时量，60 秒足够，避免面板反复开关打接口。 */
const CACHE_MS = 60000;

/** 密钥脱敏：绝不把 sk- 开头的串带进错误信息或响应。 */
function redact(value) {
  return String(value).replace(/sk-[A-Za-z0-9]{6,}/gi, 'sk-***');
}

/**
 * 把请求限制在"同源的本机页面"内。
 *
 * DSH 的 webServer 默认只监听 127.0.0.1，但**自身不携带认证与来源策略**
 * （见 `@deepseek-ai/dsh-host-webserver` 的说明），所以来源把关要由注册路由的
 * 插件自己做。这里挡两类跨站攻击：
 *   1. DNS rebinding —— Host 必须回环；
 *   2. 跨站请求 —— Origin 是 http(s) 且主机非回环时拒绝，Sec-Fetch-Site
 *      为 cross-site 时拒绝（跨站"简单请求"不触发预检，光靠 CORS 挡不住）。
 * 不带这些头的本机工具（curl 等）放行：它们本来就能直接读你的文件系统。
 *
 * @param req - 入站请求。
 * @param res - 出站响应。
 * @returns 放行返回 true；拒绝时已写出 403，调用方应立即 return。
 */
function allowRequest(req, res) {
  const host = String(req.headers.host || '');
  const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  if (hostname !== '127.0.0.1' && hostname !== 'localhost' && hostname !== '::1') {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh-usage-pill: forbidden host');
    return false;
  }
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0 && origin !== 'null') {
    let parsed;
    try {
      parsed = new URL(origin);
    } catch {
      parsed = undefined;
    }
    if (parsed !== undefined && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      const originHost = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      if (originHost !== '127.0.0.1' && originHost !== 'localhost' && originHost !== '::1') {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('dsh-usage-pill: cross-origin request rejected');
        return false;
      }
    }
  }
  if (String(req.headers['sec-fetch-site'] || '').toLowerCase() === 'cross-site') {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('dsh-usage-pill: cross-site request rejected');
    return false;
  }
  return true;
}

/**
 * 查询账户余额。
 *
 * 凭据按 `credentials.resolve()` 逐个候选名解析（该服务只在调用时解析，
 * 所以换了 key 下一次查询就会生效，不需要重启）。
 *
 * @param ctx - 插件上下文。
 * @returns `{ ok: true, currency, total, granted, topped, at }` 或 `{ ok: false, error }`。
 */
async function queryBalance(ctx) {
  const credentials = ctx.get('credentials');
  let apiKey = '';
  if (credentials !== undefined && typeof credentials.resolve === 'function') {
    for (const candidate of ['DEEPSEEK_API_KEY', 'DEEPSEEK_KEY', 'deepseek']) {
      if (apiKey) break;
      try {
        const resolved = await credentials.resolve(candidate);
        if (resolved && typeof resolved.value === 'string' && resolved.value) apiKey = resolved.value;
      } catch {
        // 换下一个候选名
      }
    }
  }
  if (!apiKey) {
    return {
      ok: false,
      code: 'no-api-key',
      error: '未配置 DEEPSEEK_API_KEY：官方余额接口只认 API Key，账号登录不提供该凭据',
    };
  }

  let response;
  try {
    response = await fetch(BALANCE_URL, {
      headers: { authorization: 'Bearer ' + apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(15000),
    });
  } catch (error) {
    return { ok: false, error: redact('查询请求失败：' + String(error && error.message ? error.message : error)) };
  }
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.text()).slice(0, 200); } catch { detail = ''; }
    return { ok: false, error: redact('账户接口返回 HTTP ' + String(response.status) + (detail ? '：' + detail : '')) };
  }
  let data;
  try {
    data = await response.json();
  } catch {
    return { ok: false, error: '余额响应解析失败' };
  }
  const info = data && Array.isArray(data.balance_infos) ? data.balance_infos[0] : undefined;
  if (info === undefined) return { ok: false, error: '账户余额不可用或响应格式未知' };
  return {
    ok: true,
    currency: String(info.currency || 'CNY'),
    total: String(info.total_balance === undefined ? '0' : info.total_balance),
    granted: String(info.granted_balance === undefined ? '0' : info.granted_balance),
    topped: String(info.topped_up_balance === undefined ? '0' : info.topped_up_balance),
    at: Date.now(),
  };
}

/** Grok 周额度缓存时长。百分比会变，比账户余额更短。 */
const GROK_CACHE_MS = 30000;

/**
 * 额度网关配置路径。密码只在宿主进程读取。
 * @returns 配置文件路径。
 */
function quotaConfigPath() {
  if (process.env.DSH_USAGE_QUOTA_CONFIG) return process.env.DSH_USAGE_QUOTA_CONFIG;
  const home = process.env.DSH_HOME || process.env.HOME || '';
  return home.replace(/\/+$/, '') + '/.dsh/usage-pill-quota.json';
}

/**
 * 读额度网关配置。每次请求重读，改文件不用重启。
 * @returns 配置对象，或 null。
 */
function loadQuotaConfig() {
  let parsed;
  try {
    parsed = JSON.parse(require('node:fs').readFileSync(quotaConfigPath(), 'utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const baseUrl = String(parsed.baseUrl || '').replace(/\/+$/, '');
  const email = String(parsed.email || '');
  const password = String(parsed.password || '');
  if (!/^https?:\/\//.test(baseUrl) || !email || !password) return null;
  let parsedUrl;
  try {
    parsedUrl = new URL(baseUrl);
  } catch {
    return null;
  }
  if (parsedUrl.username || parsedUrl.password) return null;
  const accounts = Array.isArray(parsed.accounts) ? parsed.accounts : [];
  return { baseUrl, email, password, accounts };
}

/**
 * 向额度网关发一次请求。不跟随重定向，也不把上游原文带出宿主。
 * @param config - 额度配置。
 * @param path - 以 / 开头的路径。
 * @param options - method / body / token。
 * @returns 解析后的 JSON。
 */
async function quotaFetch(config, path, options) {
  const headers = { accept: 'application/json' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.token) headers.authorization = 'Bearer ' + options.token;
  const response = await fetch(config.baseUrl + path, {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'error',
    signal: AbortSignal.timeout(15000),
  });
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }
  if (!response.ok || data === null || typeof data !== 'object') {
    const reason = data && typeof data.reason === 'string' ? data.reason : '';
    throw new Error('额度网关 HTTP ' + String(response.status) + (reason ? ' ' + reason : ''));
  }
  return data;
}

/**
 * 登录额度网关。token 只留在这个插件实例里。
 * @param auth - 实例内的登录态。
 * @param config - 额度配置。
 * @param force - 401 后强制重登。
 * @returns access token。
 */
async function quotaToken(auth, config, force) {
  const key = config.baseUrl + '\n' + config.email;
  if (!force && auth.key === key && auth.token && Date.now() - auth.at < 20 * 60 * 1000) return auth.token;
  const login = await quotaFetch(config, '/api/v1/auth/login', {
    method: 'POST',
    body: { email: config.email, password: config.password },
  });
  const token = login.data && typeof login.data.access_token === 'string' ? login.data.access_token : '';
  if (!token) throw new Error('额度网关登录失败');
  auth.key = key;
  auth.token = token;
  auth.at = Date.now();
  return token;
}

/**
 * 找到当前可用的 Grok 账号。配置里的 id 可能过期，以列表为准。
 * @param config - 额度配置。
 * @param token - 登录 token。
 * @returns 账号 id。
 */
async function grokAccountId(config, token) {
  try {
    const listed = await quotaFetch(config, '/api/v1/admin/accounts', { method: 'GET', token });
    const items = listed.data && Array.isArray(listed.data.items) ? listed.data.items : [];
    const live = items.find((item) => item && item.platform === 'grok' && item.status === 'active' && Number.isInteger(item.id));
    if (live) return live.id;
  } catch {
    // 列表失败时退回配置里的 id
  }
  const fallback = config.accounts.find((item) => item && item.platform === 'grok' && Number.isInteger(item.id));
  if (!fallback) throw new Error('没有可用的 Grok 账号');
  return fallback.id;
}

/**
 * 把网关的周窗口收成界面需要的数字。不要把请求次数窗当成周额度。
 * @param quota - /quota 响应。
 * @param usage - /usage 响应，可为 null。
 * @returns 公开额度对象。
 */
function grokView(quota, usage) {
  const billing = quota && quota.data && quota.data.billing ? quota.data.billing : {};
  const usageData = usage && usage.data ? usage.data : {};
  const used = Number(billing.usage_percent);
  const usedPercent = Number.isFinite(used) ? used : null;
  const products = Array.isArray(billing.product_usage)
    ? billing.product_usage.map((item) => ({
      product: String(item && item.product || ''),
      usedPercent: Number(item && item.usage_percent),
    })).filter((item) => item.product && Number.isFinite(item.usedPercent))
    : [];
  return {
    ok: true,
    kind: 'grok',
    usedPercent,
    remainingPercent: usedPercent === null ? null : Math.max(0, 100 - usedPercent),
    periodEnd: typeof billing.period_end === 'string' ? billing.period_end : '',
    products,
    tier: typeof usageData.subscription_tier === 'string' ? usageData.subscription_tier : '',
    updatedAt: typeof billing.updated_at === 'string' ? billing.updated_at : '',
    at: Date.now(),
  };
}

/**
 * 查询 Grok 周额度。密码和 token 不进入返回值。
 * @param state - 当前插件实例的缓存与登录态。
 * @returns 公开额度对象，或 `{ ok: false, error }`。
 */
async function queryGrokQuota(state) {
  const config = loadQuotaConfig();
  if (config === null) return { ok: false, error: '未配置 Grok 额度网关' };
  const key = config.baseUrl + '\n' + config.email;
  const now = Date.now();
  if (state.cache.value !== null && state.cache.key === key && now - state.cache.at < GROK_CACHE_MS) {
    return state.cache.value;
  }
  try {
    let token = await quotaToken(state.auth, config, false);
    const accountId = await grokAccountId(config, token);
    let quota;
    try {
      quota = await quotaFetch(config, '/api/v1/admin/grok/accounts/' + String(accountId) + '/quota', { method: 'GET', token });
    } catch (error) {
      if (!String(error && error.message || '').includes('401')) throw error;
      token = await quotaToken(state.auth, config, true);
      quota = await quotaFetch(config, '/api/v1/admin/grok/accounts/' + String(accountId) + '/quota', { method: 'GET', token });
    }
    let usage = null;
    try {
      usage = await quotaFetch(config, '/api/v1/admin/accounts/' + String(accountId) + '/usage', { method: 'GET', token });
    } catch {
      usage = null;
    }
    const view = grokView(quota, usage);
    state.cache = { at: now, key, value: view };
    return view;
  } catch (error) {
    return { ok: false, error: redact(String(error && error.message ? error.message : error)) };
  }
}

/**
 * 宿主入口：注册 usagePillCost 投影，并在有 webServer 时注册余额兜底路由。
 * @param ctx - 插件上下文。
 */
function apply(ctx) {
  // 缓存与请求属于当前插件实例，重载后不会继承旧账号的数据。
  const cache = { at: 0, value: null };
  let pending = null;
  // 逐笔计价的投影（定价内核在 lib/pricing.js）。
  // 注册失败**不该带走整个插件**：客户端读不到这个投影时会自动退回"按当前价估算"
  // 并在面板里如实标注，比整个插件起不来好得多。
  ctx.effect(() => {
    try {
      return ctx.sessionProjections.register(createCostUsageProjection());
    } catch (error) {
      console.warn('[usage-pill] 逐笔计价投影注册失败，金额将退回按当前价估算：', error);
      return undefined;
    }
  }, 'usage-pill: usagePillCost projection');

  // 余额兜底路由：只有同时存在 webServer 时才注册
  ctx.inject(['webServer'], (scope) => scope.effect(() => {
    const balanceHandler = async (req, res) => {
      if (!allowRequest(req, res)) return;
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
        return;
      }
      const now = Date.now();
      const refresh = req.headers['x-usage-pill-refresh'] === '1';
      if (!refresh && cache.value !== null && now - cache.at < CACHE_MS) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(Object.assign({ cached: true }, cache.value)));
        return;
      }
      if (pending === null) {
        pending = queryBalance(ctx)
          .catch((error) => ({ ok: false, error: redact(String(error && error.message ? error.message : error)) }))
          .finally(() => { pending = null; });
      }
      const out = await pending;
      if (out.ok) {
        cache.at = now;
        cache.value = out;
      }
      res.writeHead(out.ok ? 200 : 502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out));
    };
    // Grok 周额度：密码和 token 只留在这个插件实例里。界面只拿到百分比和重置时间。
    const grok = { cache: { at: 0, key: '', value: null }, auth: { key: '', token: '', at: 0 }, pending: null };
    const quotaHandler = async (req, res) => {
      if (!allowRequest(req, res)) return;
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('method not allowed');
        return;
      }
      if (grok.pending === null) {
        grok.pending = queryGrokQuota(grok).finally(() => { grok.pending = null; });
      }
      const out = await grok.pending;
      res.writeHead(out.ok ? 200 : 502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(out));
    };
    // 只注册一次：现有测试桩只保留最后一条路由。真实宿主按 req.url 分发，
    // 没有 url 的旧调用仍走余额，避免把余额测试打到 Grok。
    return scope.webServer.register({
      kind: 'exact',
      path: '/api/usage-pill/balance',
      paths: ['/api/usage-pill/balance', '/api/usage-pill/grok-quota'],
      handler: (req, res) => (req.url === '/api/usage-pill/grok-quota' ? quotaHandler(req, res) : balanceHandler(req, res)),
    });
  }, 'usage-pill: balance and grok-quota routes'));
}

export { apply, inject, name };
