import cmuRegular from '../assets/fonts/cmu-serif-regular.woff2?url';
import cmuItalic from '../assets/fonts/cmu-serif-italic.woff2?url';
import cmuBold from '../assets/fonts/cmu-serif-bold.woff2?url';
import cmuBoldItalic from '../assets/fonts/cmu-serif-bold-italic.woff2?url';
import firaLatin from '../assets/fonts/fira-code-latin-400.woff2?url';
import firaLatinBold from '../assets/fonts/fira-code-latin-700.woff2?url';
import firaLatinExt from '../assets/fonts/fira-code-latin-ext-400.woff2?url';
import firaLatinExtBold from '../assets/fonts/fira-code-latin-ext-700.woff2?url';
import { FONT_FAMILIES, fontStack } from './domain.ts';
import type { Design, MapFont } from './domain.ts';

/**
 * Self-hosted map typefaces, licensed under the SIL Open Font License (public/fonts):
 * CMU Serif (Computer Modern Unicode) and Fira Code. Same-origin files need no third-party
 * requests and can be embedded in SVG exports.
 */
export interface FontFile { family: string; weight: 400 | 700; style: 'normal' | 'italic'; url: string; unicodeRange?: string }
// Fira Code's Latin subsets, as published; other scripts use the stack's fallbacks.
const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';
const serif = FONT_FAMILIES.serif!, mono = FONT_FAMILIES.mono!;
export const FONT_FILES: readonly FontFile[] = [
  { family: serif, weight: 400, style: 'normal', url: cmuRegular },
  { family: serif, weight: 400, style: 'italic', url: cmuItalic },
  { family: serif, weight: 700, style: 'normal', url: cmuBold },
  { family: serif, weight: 700, style: 'italic', url: cmuBoldItalic },
  // Fira Code has no italic design: italic text slants the upright face.
  { family: mono, weight: 400, style: 'normal', url: firaLatin, unicodeRange: LATIN },
  { family: mono, weight: 400, style: 'normal', url: firaLatinExt, unicodeRange: LATIN_EXT },
  { family: mono, weight: 700, style: 'normal', url: firaLatinBold, unicodeRange: LATIN },
  { family: mono, weight: 700, style: 'normal', url: firaLatinExtBold, unicodeRange: LATIN_EXT },
];

const rule = (file: FontFile, src: string) => `@font-face{font-family:'${file.family}';font-style:${file.style};font-weight:${file.weight};font-display:swap;src:url(${src}) format('woff2')${file.unicodeRange ? `;unicode-range:${file.unicodeRange}` : ''}}`;
/** Rules for the page; browsers download each file only when text first needs it. */
export const fontFaceCss = () => FONT_FILES.map(file => rule(file, file.url)).join('');
/** A rule whose font travels inside an exported file. */
export const embeddedFontFace = (file: Omit<FontFile, 'url'>, base64: string) => rule({ ...file, url: '' }, `data:font/woff2;base64,${base64}`);

/** One weight and style of map text, with sample text for loading only the needed subsets. */
export interface TextFace { weight: 400 | 700; italic: boolean; text: string }
/** Faces an export draws: the label as styled, regular scale bar and grid text, and the bold compass letter. */
export function exportFaces(design: Design, gridLabels: boolean): TextFace[] {
  const faces: TextFace[] = [];
  if (design.label.text) faces.push({ weight: design.label.bold ? 700 : 400, italic: !!design.label.italic, text: design.label.text });
  if (design.scaleBar || gridLabels) faces.push({ weight: 400, italic: false, text: '0123456789 kmift°′.NSEW' });
  if (design.north) faces.push({ weight: 700, italic: false, text: 'N' });
  return faces;
}
/** Shipped files for a face, or none for system typefaces. Faces without an italic file use the upright one. */
export function fontFiles(font: MapFont, face: TextFace): FontFile[] {
  const family = FONT_FAMILIES[font];
  const files = FONT_FILES.filter(file => file.family === family && file.weight === face.weight);
  const styled = files.filter(file => file.style === (face.italic ? 'italic' : 'normal'));
  return styled.length ? styled : files.filter(file => file.style === 'normal');
}
/** CSS font shorthand for canvas text. */
export const canvasFont = (font: MapFont, face: Omit<TextFace, 'text'>, size: number) => `${face.italic ? 'italic ' : ''}${face.weight === 700 ? 'bold ' : ''}${size}px ${fontStack(font)}`;

/**
 * Loads the faces a canvas export draws; canvas text never waits for a font by itself.
 * An unavailable font leaves its fallback in place rather than failing the export.
 */
export async function loadFonts(font: MapFont, faces: TextFace[]) {
  if (!FONT_FAMILIES[font] || typeof document === 'undefined') return;
  await Promise.all(faces.map(face => document.fonts.load(canvasFont(font, face, 16), face.text).catch(() => [])));
}

/**
 * Font files an SVG export embeds, deduplicated, with their bytes. Like canvas loading, an
 * unavailable file is left out and viewers use the stack's fallback.
 */
export async function embeddedFonts(font: MapFont, faces: TextFace[], signal?: AbortSignal): Promise<{ file: Omit<FontFile, 'url'>; bytes: ArrayBuffer }[]> {
  const files = [...new Map(faces.flatMap(face => fontFiles(font, face)).map(file => [file.url, file])).values()];
  const loaded = await Promise.all(files.map(async ({ url, ...file }) => {
    try {
      const response = await fetch(url, { signal });
      return response.ok ? { file, bytes: await response.arrayBuffer() } : undefined;
    } catch { signal?.throwIfAborted(); return undefined; }
  }));
  return loaded.filter(entry => entry !== undefined);
}
