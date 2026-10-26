import path from 'node:path';

export type AssetKind = 'image' | 'heic' | 'svg' | 'video' | 'other';

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.jfif', '.pjpeg', '.png', '.apng', '.webp', '.avif',
  '.gif', '.tif', '.tiff', '.bmp',
]);
const HEIC_EXTENSIONS = new Set(['.heic', '.heif', '.hif']);
const SVG_EXTENSIONS = new Set(['.svg']);
const VIDEO_EXTENSIONS = new Set([
  '.mp4', '.m4v', '.mov', '.webm', '.mkv', '.avi', '.wmv', '.flv', '.mpg',
  '.mpeg', '.3gp', '.ogv', '.mts', '.m2ts',
]);

/** Formatos que cualquier navegador moderno muestra sin conversión. */
const WEB_READY_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.webp', '.avif', '.gif', '.svg', '.mp4', '.webm',
]);

export function extensionOf(filePath: string): string {
  return path.extname(filePath).toLowerCase();
}

export function classify(filePath: string): AssetKind {
  const ext = extensionOf(filePath);
  if (HEIC_EXTENSIONS.has(ext)) return 'heic';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  if (SVG_EXTENSIONS.has(ext)) return 'svg';
  if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  return 'other';
}

export function isWebReady(filePath: string): boolean {
  return WEB_READY_EXTENSIONS.has(extensionOf(filePath));
}

export const FORMAT_EXTENSION: Record<string, string> = {
  avif: '.avif',
  webp: '.webp',
  jpeg: '.jpg',
  png: '.png',
  gif: '.gif',
  svg: '.svg',
  mp4: '.mp4',
  webm: '.webm',
};
