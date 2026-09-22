import * as Localization from 'expo-localization';
import { create } from 'zustand';
import { api } from '@/lib/api';
import { KEYS, store } from '@/lib/storage';
import { Dict, en, packs } from './translations';

/** Merge an over-the-air catalogue (SUR-GAP-038) into the bundled packs, without an app release. */
function mergeCatalogue(remotePacks: Record<string, any>) {
  for (const [code, dict] of Object.entries(remotePacks ?? {})) {
    packs[code] = { ...(packs[code] ?? en), ...(dict as any) } as Dict;
  }
}

type Path = string;

function deepGet(obj: any, path: Path): any {
  return path.split('.').reduce((acc, k) => (acc == null ? undefined : acc[k]), obj);
}

/**
 * `i18n_missing_key` telemetry (PRD 18.2 §10). Reported once per key per session — a missing
 * string on a screen that re-renders every second would otherwise flood the endpoint, and the
 * second report tells nobody anything the first did not.
 */
const reportedMissing = new Set<string>();

function reportMissingKey(key: Path, lang: string) {
  const id = `${lang}:${key}`;
  if (reportedMissing.has(id)) return;
  reportedMissing.add(id);
  api.track('i18n_missing_key', { key, lang });
}

/** Which keys fell back to English this session — shown on App health. */
export function missingKeyCount(): number {
  return reportedMissing.size;
}

/** Values substituted into `{placeholders}` in a string. */
export type TParams = Record<string, string | number>;

type I18nState = {
  lang: string;
  ready: boolean;
  init: () => Promise<void>;
  setLang: (code: string) => Promise<void>;
  t: (key: Path, params?: TParams) => string;
};

/**
 * `{name}`-style interpolation. Deliberately minimal — the alternative is concatenating strings
 * at call sites, which produces sentences no translator can reorder for their own grammar.
 */
function interpolate(text: string, params?: TParams): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (whole, key) => (key in params ? String(params[key]) : whole));
}

export const useI18n = create<I18nState>((set, get) => ({
  lang: 'hi',
  ready: false,
  init: async () => {
    let lang = await store.getJSON<string>(KEYS.language, '');
    if (!lang) {
      const device = Localization.getLocales()?.[0]?.languageCode ?? 'hi';
      lang = packs[device] ? device : 'hi';
    }
    // Best-effort OTA string refresh (cached version gate) — never blocks first paint.
    const cachedVer = await store.getJSON<number>('sg.i18nVer', 0);
    api
      .i18nCatalogue()
      .then((r) => {
        if (r?.packs && (r.version ?? 0) >= cachedVer) {
          mergeCatalogue(r.packs);
          store.setJSON('sg.i18nVer', r.version ?? 0);
          set({ lang: get().lang }); // trigger re-render with merged strings
        }
      })
      .catch(() => {});
    set({ lang, ready: true });
  },
  setLang: async (code) => {
    await store.setJSON(KEYS.language, code);
    set({ lang: code });
  },
  t: (key, params) => {
    const { lang } = get();
    const pack: Dict = packs[lang] ?? en;
    let value = deepGet(pack, key);

    if (typeof value !== 'string') {
      // Missing in the chosen language — fall back to English and report it, so a gap in a
      // translation pack shows up as telemetry rather than as a guard staring at a key name
      // (PRD 18.2 §10).
      value = deepGet(en, key);
      if (typeof value === 'string' && lang !== 'en') reportMissingKey(key, lang);
    }

    return typeof value === 'string' ? interpolate(value, params) : key;
  },
}));

/** Convenience hook returning just the translate function, re-rendering on language change. */
export function useT() {
  // `t` is one stable function, so selecting it alone never re-renders anything: a guard who
  // changed language from Profile kept seeing the old one until each screen was reopened.
  // Subscribing to `lang` makes every screen that translates re-render on a switch.
  useI18n((s) => s.lang);
  return useI18n((s) => s.t);
}
