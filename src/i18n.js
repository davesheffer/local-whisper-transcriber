// UI language (English / Hebrew): a React context plus a module-level t() for code
// outside components. Strings live in ./locales/<lang>.js as flat dotted keys.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import en from './locales/en';
import he from './locales/he';

const LOCALES = { en, he };
const STORAGE_KEY = 'app.uiLang';

function initialLang() {
  let saved = null;
  try { saved = localStorage.getItem(STORAGE_KEY); } catch { /* storage unavailable */ }
  if (saved && LOCALES[saved]) return saved;
  const nav = typeof navigator !== 'undefined' ? String(navigator.language || '') : '';
  return nav.toLowerCase().startsWith('he') ? 'he' : 'en';
}

let current = initialLang();

export const getLang = () => current;
export const dirOf = (lang) => (lang === 'he' ? 'rtl' : 'ltr');

function applyDocument(lang) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = lang;
  document.documentElement.dir = dirOf(lang);
}
applyDocument(current);

function plural(lang, count) {
  try { return new Intl.PluralRules(lang).select(count); } catch { return count === 1 ? 'one' : 'other'; }
}

// Raw template for a key: current language first, then English, then the key itself.
// With a numeric vars.count, `<key>_<category>` / `<key>_other` are tried first.
function resolve(lang, key, vars) {
  const hasCount = vars && typeof vars.count === 'number';
  for (const l of lang === 'en' ? ['en'] : [lang, 'en']) {
    const table = LOCALES[l] || {};
    const keys = hasCount ? [`${key}_${plural(l, vars.count)}`, `${key}_other`, key] : [key];
    for (const k of keys) if (Object.prototype.hasOwnProperty.call(table, k)) return table[k];
  }
  return key;
}

function interpolate(str, vars) {
  if (!vars) return str;
  return str.replace(/\{(\w+)\}/g, (m, name) => (name in vars && vars[name] != null ? String(vars[name]) : m));
}

// Template -> React nodes: `{name}` takes vars[name] (string or element), `<b>…</b>` is bold.
function toNodes(str, vars, keyBase = 'n') {
  const out = [];
  const re = /<b>(.*?)<\/b>|\{(\w+)\}/g;
  let last = 0;
  let i = 0;
  let m;
  while ((m = re.exec(str))) {
    if (m.index > last) out.push(str.slice(last, m.index));
    const key = `${keyBase}${i++}`;
    if (m[1] != null) {
      out.push(<b key={key}>{toNodes(m[1], vars, `${key}-`)}</b>);
    } else {
      const v = vars && m[2] in vars ? vars[m[2]] : m[0];
      out.push(React.isValidElement(v) ? React.cloneElement(v, { key }) : String(v ?? ''));
    }
    last = re.lastIndex;
  }
  if (last < str.length) out.push(str.slice(last));
  return out;
}

export const translate = (lang, key, vars) => interpolate(resolve(lang, key, vars), vars);
// Plain lookup in the current UI language (for code outside components).
export const t = (key, vars) => translate(current, key, vars);

const I18nContext = createContext({
  lang: current,
  dir: dirOf(current),
  setLang: () => {},
  t,
  rich: (key, vars) => toNodes(resolve(current, key, vars), vars),
});

export function I18nProvider({ children }) {
  const [lang, setLangState] = useState(current);
  const setLang = useCallback((next) => {
    if (!LOCALES[next]) return;
    current = next;
    setLangState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* storage unavailable */ }
  }, []);
  useEffect(() => {
    applyDocument(lang);
    document.title = translate(lang, 'header.title');
  }, [lang]);
  const value = useMemo(() => ({
    lang,
    dir: dirOf(lang),
    setLang,
    t: (key, vars) => translate(lang, key, vars),
    // Like t(), but returns React nodes so vars can be elements (<bdi>, <code>) and <b> stays bold.
    rich: (key, vars) => toNodes(resolve(lang, key, vars), vars),
  }), [lang, setLang]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
