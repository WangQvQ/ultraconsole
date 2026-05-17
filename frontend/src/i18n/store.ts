import { create } from 'zustand'

export type Locale = 'zh' | 'en'

interface LocaleState {
  locale: Locale
  setLocale: (l: Locale) => void
}

const STORAGE_KEY = 'ultraconsole.locale'

function detectDefault(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (saved === 'zh' || saved === 'en') return saved
  } catch { /* ignore */ }
  const lang = navigator.language || ''
  return lang.startsWith('zh') ? 'zh' : 'en'
}

export const useLocaleStore = create<LocaleState>((set) => ({
  locale: detectDefault(),
  setLocale: (l) => {
    try { localStorage.setItem(STORAGE_KEY, l) } catch { /* ignore */ }
    set({ locale: l })
  },
}))
