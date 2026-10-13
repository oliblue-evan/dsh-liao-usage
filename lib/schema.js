/**
 * 极简结构校验器 —— 用来替代 zod。
 *
 * 【为什么要自己写这一个】
 *   宿主插件的**裸模块名**（如 `zod`）按插件的**真实路径**解析，而本插件是
 *   `link:` 安装的（真实路径在工作区），profile 的 `autoInstallPeers` 又是关闭的 ——
 *   一旦解析不到，`import` 会在模块加载期抛出，**整个宿主半边都起不来**（不是降级）。
 *   相对路径 import 永远安全，所以这里自带一个校验器，让宿主半边不含任何裸模块名。
 *   回归门禁见 `test/no-bare-imports.test.mjs`。
 *
 * 【框架对 schema 的全部要求】
 *   查过 `@deepseek-ai/dsh-session-projection` 的实现：`register()` 只把 schema
 *   原样存下，运行时**只调用 `.parse(value)`** ——
 *     · 不合法就抛错（checkpoint 恢复处会捕获并跳过该单元）；
 *     · 合法则返回用于后续计算的值。
 *   所以这里只需要实现 `.parse`，并保持"非法即抛"的语义（不做静默兜底）。
 */

/** 把值描述成一句人话，用于报错。 */
function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * 抛出一个带路径的校验错误。
 * @param path - 出错字段路径。
 * @param expected - 期望的形状。
 * @param value - 实际值。
 */
function fail(path, expected, value) {
  throw new TypeError(
    'usage-pill schema: ' + (path === '' ? '<root>' : path) + ' 应为 ' + expected + '，实际是 ' + describe(value),
  );
}

/** 任意有限数字。 */
export function num() {
  return { parse: (value, path = '') => (typeof value === 'number' && Number.isFinite(value) ? value : fail(path, 'number', value)) };
}

/** 非负数字（金额用）。 */
export function nonNeg() {
  return { parse: (value, path = '') => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fail(path, '非负 number', value)) };
}

/** 非负整数（计数与 turn/step 用）。 */
export function count() {
  return { parse: (value, path = '') => (Number.isSafeInteger(value) && value >= 0 ? value : fail(path, '非负整数', value)) };
}

/** 字符串。 */
export function str() {
  return { parse: (value, path = '') => (typeof value === 'string' ? value : fail(path, 'string', value)) };
}

/** 指定长度的字符串（币种代码用）。 */
export function strLen(length) {
  return {
    parse: (value, path = '') => {
      if (typeof value !== 'string' || value.length !== length) fail(path, length + ' 位 string', value);
      return value;
    },
  };
}

/** 布尔。 */
export function bool() {
  return { parse: (value, path = '') => (typeof value === 'boolean' ? value : fail(path, 'boolean', value)) };
}

/** 可空。 */
export function nullableOf(inner) {
  return { parse: (value, path = '') => (value === null ? null : inner.parse(value, path)) };
}

/**
 * 严格对象：未声明的字段一律拒绝（等价 zod 的 `.strict()`）。
 * @param shape - 字段名 → 子校验器。
 * @returns 校验器。
 */
export function object(shape) {
  const keys = Object.keys(shape);
  return {
    parse: (value, path = '') => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'object', value);
      const out = {};
      for (const key of keys) out[key] = shape[key].parse(value[key], path === '' ? key : path + '.' + key);
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(shape, key)) fail(path === '' ? key : path + '.' + key, '未声明的字段', value[key]);
      }
      return out;
    },
  };
}

/** 会被当成对象键来污染原型的名字（模型名理论可取这些值，一律拒绝）。 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * 动态键对象：`{ [任意字符串]: 子校验器 }`。
 *
 * 【为什么需要】`object()` 是严格的（未声明字段一律拒绝），而"按模型累计"的键是
 * **模型名** —— 事先不知道有哪些。zod 对应的是 `z.record(...)`。
 *
 * @param valueSchema - 值的校验器。
 * @returns 校验器（parse 返回一个只含合法键值的新对象）。
 */
export function recordOf(valueSchema) {
  return {
    parse: (value, path = '') => {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'object', value);
      const out = {};
      for (const key of Object.keys(value)) {
        if (DANGEROUS_KEYS.has(key)) fail(path + '.' + key, '非原型污染的键名', value[key]);
        out[key] = valueSchema.parse(value[key], path === '' ? key : path + '.' + key);
      }
      return out;
    },
  };
}
