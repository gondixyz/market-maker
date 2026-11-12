import { useEffect, useState } from 'react';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'market-maker:theme';

/** The saved theme's text, `null` when none is saved or storage cannot be read. */
const savedTheme = () => {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
};

/**
 * The theme picked in the header; before anything is picked, the operating system's.
 *
 * IMPLEMENTATION NOTE: the window's `localStorage` is Chromium's, which Electron keeps under the
 * app's `userData` directory, so the choice survives restarts
 * (https://www.electronjs.org/docs/latest/api/app#appgetpathname, `userData`).
 */
export const readTheme = (): Theme => {
  const saved = savedTheme();
  if (saved === 'light' || saved === 'dark') return saved;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};

/** Sets `data-theme` on the document, which the stylesheet's dark tokens key on. */
export const applyTheme = (theme: Theme) => {
  document.documentElement.dataset.theme = theme;
};

/** The window's theme and its setter, which applies the new theme and saves it. */
export const useTheme = () => {
  const [theme, setTheme] = useState(readTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const pick = (picked: Theme) => {
    setTheme(picked);
    try {
      localStorage.setItem(STORAGE_KEY, picked);
    } catch {
      return;
    }
  };
  return [theme, pick] as const;
};
