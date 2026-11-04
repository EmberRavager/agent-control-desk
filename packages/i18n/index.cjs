const englishMessages = Object.freeze({
  ...require("./common.cjs"),
  ...require("./ai.cjs"),
  ...require("./core.cjs"),
  ...require("./desktop-main.cjs"),
  ...require("./desktop-tools.cjs"),
  ...require("./cli.cjs"),
});
function normalizeLocale(value) {
  return typeof value === "string" && /^en(?:[-_]|$)/i.test(value)
    ? "en"
    : "zh-CN";
}
function translate(locale, source, values = {}) {
  const template =
    normalizeLocale(locale) === "en"
      ? (englishMessages[source] ?? source)
      : source;
  return template.replace(/\{(\w+)\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(values, key)
      ? String(values[key])
      : whole,
  );
}
exports.normalizeLocale = normalizeLocale;
exports.translate = translate;
exports.englishMessages = englishMessages;
exports.dateLocale = (locale) =>
  normalizeLocale(locale) === "en" ? "en-US" : "zh-CN";
exports.languageInstruction = (locale) =>
  normalizeLocale(locale) === "en"
    ? "Write all generated natural-language text in English. Preserve user quotations, code, IDs, JSON keys, enum values, paths and protocol fields exactly. Do not translate or reinterpret native approval option IDs."
    : "所有生成的自然语言文字使用简体中文。保留用户引用、代码、ID、JSON 字段名、枚举值、路径和协议字段；不要翻译或改写原生授权选项 ID。";
