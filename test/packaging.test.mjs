/**
 * 打包契约：插件页的「介绍」与图标能不能被宿主读到，取决于 package.json 里几处声明。
 *
 * 我在这里翻过一次车：`exports` 只开了 `.` 和 `./client`，于是
 * `dsh-liao-usage/package.json` 与 `dsh-liao-usage/locale/en.json` 都被 Node 的
 * ESM 解析器拒掉（`ERR_PACKAGE_PATH_NOT_EXPORTED`），而 `dsh-app-boot` 的
 * `resolvePluginResource` 恰恰把「不可解析」当作「资源缺失」→ 元数据整体为 undefined
 * → 插件页既不显示介绍、也不显示图标，却**不报任何错**。所以这里把契约钉死。
 *
 * 另外 mirrors 了 `iconOf` 的校验规则（相对路径、SVG/PNG/JPEG/WebP、≤256 KiB、在包内），
 * 免得图标在运行时被静默丢弃。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, relative, isAbsolute, resolve as resolvePath } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

test('exports 暴露元数据子路径（否则插件页没有介绍/图标，且静默失败）', () => {
  const exports = pkg.exports;
  assert.ok(exports !== null && typeof exports === 'object', 'exports 必须是对象');
  // `.` 与 `./client` 是装载器与客户端 bundle 的入口，缺一不可
  assert.equal(exports['.'], './index.js');
  assert.equal(exports['./client'], './client.js');
  // 元数据管线要读这两个（readPluginMeta 的 optionalResourcePath）
  assert.equal(exports['./package.json'], './package.json', 'readPluginMeta 要解析 <包>/package.json');
  assert.ok(exports['./locale/*.json'], 'readPluginMeta 要解析 <包>/locale/<语言>.json');
});

test('介绍文案：locale/en.json 必须存在，且各语言文件同目录、字段非空', () => {
  const localeDir = join(ROOT, 'locale');
  const files = readdirSync(localeDir).filter((name) => name.endsWith('.json'));
  assert.ok(files.includes('en.json'), 'en.json 是必需的 —— 没有它，字典整个不生效（title/description 回退到 package.json）');
  for (const name of files) {
    const language = name.slice(0, -5);
    assert.match(language, /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, name + ' 的文件名必须是语言 id');
    const parsed = JSON.parse(readFileSync(join(localeDir, name), 'utf8'));
    assert.equal(typeof parsed.meta, 'object', name + ' 需要 { meta: { title, description } }');
    for (const field of ['title', 'description']) {
      const value = parsed.meta[field];
      assert.equal(typeof value, 'string', name + ' meta.' + field + ' 必须是字符串');
      assert.ok(value.trim() !== '', name + ' meta.' + field + ' 不能为空（空串会被 iconOf/textOf 判为非法）');
    }
  }
});

test('图标声明满足 iconOf 的全部规则', () => {
  assert.equal(typeof pkg.icon, 'string', 'package.json 需要 icon 字段');
  assert.ok(!isAbsolute(pkg.icon), 'icon 必须是相对路径');
  assert.ok(!/^[A-Za-z][A-Za-z\d+.-]*:/u.test(pkg.icon), 'icon 不能是绝对 URL');
  const media = { '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
  assert.ok(media[extname(pkg.icon).toLowerCase()] !== undefined, 'icon 必须是 SVG/PNG/JPEG/WebP');
  const file = resolvePath(ROOT, pkg.icon);
  assert.ok(statSync(file).isFile(), 'icon 必须是常规文件');
  assert.ok(statSync(file).size <= 262144, 'icon 不能超过 256 KiB');
  const local = relative(realpathSync(ROOT), realpathSync(file));
  assert.ok(!local.startsWith('..') && !isAbsolute(local), 'icon 必须留在包目录内');
});

test('语言文件名遵循官方约定：en.json + zh.json（不是 zh-CN.json）', () => {
  // 官方 bundle 用的是 locale/en.json + locale/zh.json；解析器按键查表，
  // 而 readPluginMeta 会把文件名小写化（zh-CN -> zh-cn），与官方约定的 'zh' 不一致。
  const files = readdirSync(join(ROOT, 'locale')).filter((name) => name.endsWith('.json'));
  assert.ok(files.includes('en.json'), '必须有 en.json —— 没有它整个字典不生效');
  assert.ok(files.includes('zh.json'), '中文文件名应是官方约定的 zh.json');
  assert.ok(!files.includes('zh-CN.json'), '不要用 zh-CN.json：键会变成 zh-cn，与官方约定不符');
});
