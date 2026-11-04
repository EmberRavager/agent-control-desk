import React, {
  createContext,
  useContext,
  useMemo,
  useEffect,
  type ReactNode,
} from "react";
import {
  normalizeLocale,
  translate,
  dateLocale as localeForDates,
} from "../../packages/i18n/index.cjs";
import type { Locale } from "../../packages/contracts/index.js";
export type Translate = (
  source: string,
  values?: Record<string, string | number>,
) => string;
const LocaleContext = createContext<Locale>("zh-CN");
export function I18nProvider({
  children,
  locale = "zh-CN",
}: {
  children: ReactNode;
  locale?: Locale;
}) {
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  return (
    <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>
  );
}
export function useI18n() {
  const locale = useContext(LocaleContext);
  return useMemo(
    () => ({
      locale,
      dateLocale: localeForDates(locale),
      t: ((source, values) => translate(locale, source, values)) as Translate,
    }),
    [locale],
  );
}
type LocaleStorage = Pick<Storage, "getItem" | "setItem">;
export function scopedLocale(scope?: string) {
  return `acd.locale:${scope || "unavailable-profile"}`;
}
export function readLocale(storage?: LocaleStorage, scope?: string): Locale {
  if (!scope) return "zh-CN";
  try {
    return normalizeLocale(storage?.getItem(scopedLocale(scope)));
  } catch {
    return "zh-CN";
  }
}
export function cacheLocale(
  locale: Locale,
  storage?: LocaleStorage,
  scope?: string,
) {
  if (!scope) return;
  try {
    storage?.setItem(scopedLocale(scope), locale);
  } catch {
    /* Backend remains authoritative when local storage is unavailable. */
  }
}
export async function saveLocalePreference(
  request: (method: string, path: string, body?: unknown) => Promise<unknown>,
  locale: Locale,
  storage?: LocaleStorage,
  scope?: string,
): Promise<Locale> {
  const value = (await request("PUT", "/api/preferences", { locale })) as {
    locale?: unknown;
  } | null;
  if (value?.locale !== locale)
    throw Error(translate(locale, "语言设置尚未确认，请重新连接后重试。"));
  cacheLocale(locale, storage, scope);
  return locale;
}
