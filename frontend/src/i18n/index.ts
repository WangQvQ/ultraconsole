import { useCallback } from 'react'
import { useLocaleStore, type Locale } from './store'
import zh from './locales/zh.json'
import en from './locales/en.json'

const dicts: Record<Locale, Record<string, Record<string, string>>> = { zh, en }

function lookup(locale: Locale, key: string): string {
  const dict = dicts[locale] ?? dicts.zh
  const dot = key.indexOf('.')
  if (dot < 0) return key
  const section = key.slice(0, dot)
  const prop = key.slice(dot + 1)
  return dict[section]?.[prop] ?? dicts.zh[section]?.[prop] ?? key
}

function interpolate(template: string, params?: Record<string, string | number>): string {
  if (!params) return template
  let result = template
  for (const [k, v] of Object.entries(params)) {
    result = result.replaceAll(`{{${k}}}`, String(v))
  }
  return result
}

/** Plain `t()` for use outside React components (e.g. in hooks/callbacks). Reads current locale from store. */
export function t(key: string, params?: Record<string, string | number>): string {
  return interpolate(lookup(useLocaleStore.getState().locale, key), params)
}

/** Hook: returns a `t(key, params?)` function that re-renders the component on locale change. */
export function useT() {
  const locale = useLocaleStore((s) => s.locale)
  return useCallback(
    (key: string, params?: Record<string, string | number>) => interpolate(lookup(locale, key), params),
    [locale],
  )
}
