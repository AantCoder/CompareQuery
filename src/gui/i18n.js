// Локализация интерфейса (GUI.md §5.22). Как в gettext: язык исходников - русский, строки интерфейса
// оборачиваются в t("..."), исходный текст и есть ключ. Перевод - gui/locales/<язык>.json:
// {"исходный текст": "перевод"}; нет перевода - показывается исходный текст (и предупреждение в консоли
// браузера, один раз на строку, чтобы пополнить словарь).
//   t("Таблица {n}", {n: 2})                    подстановки в фигурных скобках
//   tp(n, "скрипт", "скрипта", "скриптов")      множественное число; в словаре - по ключу
//                                               "скрипт|скрипта|скриптов": ["script", "scripts"]
// Данные не переводятся: имена колонок CSV, ключи отчетов, тексты, которые пишет CompareQuery.py.
"use strict";

const LANGS = [["ru", "Русский"], ["en", "English"]];
let LANG = "ru", DICT = {};
const i18nMissed = new Set();

function t(s, p) {
  let r = LANG === "ru" ? s : DICT[s];
  if (typeof r !== "string" && !/[А-Яа-яЁё]/.test(s)) r = s;      // переводить нечего (числа, коды)
  if (typeof r !== "string") {
    if (LANG !== "ru" && !i18nMissed.has(s)) { i18nMissed.add(s); console.warn("i18n: нет перевода:", s); }
    r = s;
  }
  return p ? r.replace(/\{(\w+)\}/g, (m, k) => (p[k] ?? m)) : r;
}
function tp(n, one, few, many) {
  if (LANG === "ru") {
    const a = n % 10, b = n % 100;
    return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
  }
  const f = DICT[`${one}|${few}|${many}`];
  if (!Array.isArray(f)) { t(`${one}|${few}|${many}`); return many; }
  return f[n === 1 ? 0 : 1];
}
// загрузка словаря; русский - исходный язык, словаря нет
async function setLang(lang) {
  if (!LANGS.some(x => x[0] === lang)) lang = "ru";
  DICT = lang === "ru" ? {} : await (await fetch(`locales/${lang}.json`)).json();
  LANG = lang;
  document.documentElement.lang = lang;
}
// язык по умолчанию - системный, если он есть среди переведенных, иначе английский
const systemLang = () => ((navigator.language || "en").slice(0, 2).toLowerCase() === "ru" ? "ru" : "en");
