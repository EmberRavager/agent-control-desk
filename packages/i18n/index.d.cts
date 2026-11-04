export type Locale = "zh-CN" | "en";
export function normalizeLocale(value: unknown): Locale;
export function translate(
  locale: Locale | string | undefined,
  source: string,
  values?: Record<string, unknown>,
): string;
export const englishMessages: Readonly<Record<string, string>>;
export function dateLocale(
  locale: Locale | string | undefined,
): "en-US" | "zh-CN";
export function languageInstruction(
  locale: Locale | string | undefined,
): string;
