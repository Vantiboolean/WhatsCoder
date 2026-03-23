import { createHighlighter, type Highlighter, type BundledLanguage } from 'shiki';

let highlighterPromise: Promise<Highlighter> | null = null;

const PRELOADED_LANGS: BundledLanguage[] = [
  'javascript', 'typescript', 'jsx', 'tsx', 'json',
  'html', 'css', 'python', 'rust', 'bash', 'markdown',
  'yaml', 'toml', 'sql', 'go', 'java', 'c', 'cpp',
];

const DARK_THEMES = ['github-dark', 'one-dark-pro', 'vitesse-dark'] as const;
const LIGHT_THEMES = ['github-light', 'vitesse-light'] as const;

export type ShikiDarkTheme = typeof DARK_THEMES[number];
export type ShikiLightTheme = typeof LIGHT_THEMES[number];
export type ShikiTheme = ShikiDarkTheme | ShikiLightTheme;

export function getHighlighter(): Promise<Highlighter> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighter({
      themes: [...DARK_THEMES, ...LIGHT_THEMES],
      langs: PRELOADED_LANGS,
    });
  }
  return highlighterPromise;
}

const loadedLanguages = new Set<string>(PRELOADED_LANGS);

export async function ensureLanguageLoaded(lang: string): Promise<string> {
  const highlighter = await getHighlighter();
  const normalizedLang = lang.toLowerCase().trim();

  if (loadedLanguages.has(normalizedLang)) return normalizedLang;

  try {
    await highlighter.loadLanguage(normalizedLang as BundledLanguage);
    loadedLanguages.add(normalizedLang);
    return normalizedLang;
  } catch {
    return 'text';
  }
}

export async function highlightCode(
  code: string,
  lang: string,
  theme: ShikiTheme = 'github-dark',
): Promise<string> {
  const highlighter = await getHighlighter();
  const resolvedLang = await ensureLanguageLoaded(lang);

  return highlighter.codeToHtml(code, {
    lang: resolvedLang,
    theme,
  });
}
