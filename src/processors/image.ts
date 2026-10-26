import { readFile, writeFile } from 'node:fs/promises';
import sharp, { type Metadata, type Sharp } from 'sharp';
import type { ImageFormat, ImageFormatOption, QualitySettings } from '../config.js';
import { extensionOf, FORMAT_EXTENSION, isWebReady } from '../formats.js';
import { isApng, stripJpegMetadata, stripPngMetadata } from '../utils/strip-metadata.js';
import { decodeHeicToPng } from './heic.js';
import type { ProcessedAsset } from './types.js';

export interface ImageJob {
  inputPath: string;
  /** Ruta de salida sin extensión; la extensión depende del formato elegido. */
  outputBase: string;
  isHeic: boolean;
  format: ImageFormatOption;
  quality: QualitySettings;
  maxSize: number;
}

interface Candidate {
  format: ImageFormat;
  buffer: Buffer;
}

/** Formatos que pueden traer animación y que sharp sabe leer como tal. */
const ANIMATABLE = new Set(['.gif', '.webp']);
/** Fuentes sin pérdida: suelen ser gráficos/capturas donde WebP lossless puede ganar. */
const LOSSLESS_SOURCES = new Set(['.png', '.gif', '.bmp', '.tif', '.tiff']);

// Evita que sharp acumule caché de archivos entre cientos de imágenes.
sharp.cache({ files: 0 });

function encode(pipeline: Sharp, format: ImageFormat, quality: QualitySettings, animated: boolean, lossless = false): Promise<Buffer> {
  switch (format) {
    case 'avif':
      return pipeline.avif({ quality: quality.avif, effort: 5, chromaSubsampling: '4:2:0' }).toBuffer();
    case 'webp':
      return lossless
        ? pipeline.webp({ lossless: true, effort: 6 }).toBuffer()
        : pipeline.webp({ quality: quality.webp, effort: 6, smartSubsample: true, ...(animated && { minSize: true, mixed: true }) }).toBuffer();
    case 'jpeg':
      return pipeline.flatten({ background: '#ffffff' }).jpeg({ quality: quality.jpeg, mozjpeg: true, progressive: true }).toBuffer();
    case 'png':
      return pipeline.png({ palette: true, quality: quality.webp, compressionLevel: 9, effort: 10 }).toBuffer();
  }
}

interface KeptOriginal {
  buffer: Buffer;
  note: string;
}

/**
 * Devuelve el original sin metadatos privados, sin recodificarlo, o `undefined`
 * si no se puede conservar (necesita rotación o trae metadatos que no sabemos quitar).
 */
function stripOriginal(original: Buffer, ext: string, meta: Metadata): Buffer | undefined {
  if ((meta.orientation ?? 1) !== 1) return undefined;
  if (ext === '.jpg' || ext === '.jpeg') return stripJpegMetadata(original);
  if (ext === '.png') return stripPngMetadata(original);
  return meta.exif || meta.xmp || meta.iptc ? undefined : original;
}

async function writeKept(job: ImageJob, ext: string, kept: KeptOriginal, width?: number, height?: number): Promise<ProcessedAsset> {
  const outputPath = job.outputBase + (ext === '.jpeg' ? '.jpg' : ext);
  await writeFile(outputPath, kept.buffer);
  return { outputPath, format: ext === '.jpeg' ? 'jpg' : ext.slice(1), bytes: kept.buffer.length, width, height, copied: true, note: kept.note };
}

/**
 * Optimiza una imagen: corrige orientación EXIF, elimina metadatos (GPS, cámara),
 * convierte a sRGB, limita el tamaño y codifica en el formato más liviano.
 */
export async function optimizeImage(job: ImageJob): Promise<ProcessedAsset> {
  const ext = extensionOf(job.inputPath);
  const original = job.isHeic ? undefined : await readFile(job.inputPath);

  // sharp no lee la animación de un APNG: se conserva tal cual (sin metadatos).
  if (original && ext === '.png' && isApng(original)) {
    const meta = await sharp(original).metadata();
    const buffer = stripPngMetadata(original) ?? original;
    return writeKept(job, ext, { buffer, note: 'PNG animado (APNG): se conservó el original' }, meta.width, meta.height);
  }

  const source = original
    ? sharp(original, { animated: ANIMATABLE.has(ext) })
    : sharp(await decodeHeicToPng(job.inputPath));
  const meta = await source.metadata();
  // Un TIFF multipágina también reporta `pages`, pero no es una animación.
  const animated = ANIMATABLE.has(ext) && (meta.pages ?? 1) > 1;
  let note: string | undefined;

  if (animated && job.format !== 'auto' && job.format !== 'webp') {
    if (original && ext === '.gif') {
      return writeKept(job, ext, { buffer: original, note: `${job.format.toUpperCase()} no admite animación: se conservó el GIF` }, meta.width, meta.pageHeight ?? meta.height);
    }
    note = `${job.format.toUpperCase()} no admite animación: se usó WebP animado`;
  }

  // Muchas imágenes traen canal alfa sin usar; quitarlo ahorra bytes.
  let hasAlpha = meta.hasAlpha ?? false;
  if (hasAlpha && !animated) hasAlpha = !(await source.clone().stats()).isOpaque;

  const pipeline = source.clone();
  if (!animated) pipeline.autoOrient();
  pipeline.resize({ width: job.maxSize, height: job.maxSize, fit: 'inside', withoutEnlargement: true });
  if (meta.hasAlpha && !hasAlpha) pipeline.removeAlpha();

  // Solo WebP conserva animación con sharp; AVIF/JPEG/PNG perderían los cuadros.
  const formats: ImageFormat[] = animated ? ['webp'] : job.format === 'auto' ? ['avif', 'webp'] : [job.format];

  const candidates: Candidate[] = await Promise.all(
    formats.map(async (format) => ({ format, buffer: await encode(pipeline.clone(), format, job.quality, animated) })),
  );
  if (job.format === 'auto' && !animated && LOSSLESS_SOURCES.has(ext)) {
    candidates.push({ format: 'webp', buffer: await encode(pipeline.clone(), 'webp', job.quality, false, true) });
  }

  const best = candidates.reduce((a, b) => (b.buffer.length < a.buffer.length ? b : a));
  const out = await sharp(best.buffer).metadata();
  const width = out.width;
  const height = out.pageHeight ?? out.height;

  // Si el original ya era apto para web, no se redimensionó y pesa menos, se conserva (sin metadatos).
  const oriented = meta.autoOrient ?? meta;
  const resized = width !== oriented.width || height !== (meta.pageHeight ?? oriented.height);
  if (job.format === 'auto' && original && isWebReady(job.inputPath) && !resized && best.buffer.length >= original.length) {
    const stripped = stripOriginal(original, ext, meta);
    if (stripped) {
      return writeKept(job, ext, { buffer: stripped, note: 'el original ya estaba optimizado; se conservó sin metadatos' }, width, height);
    }
  }

  const outputPath = job.outputBase + FORMAT_EXTENSION[best.format];
  await writeFile(outputPath, best.buffer);
  return { outputPath, format: best.format, bytes: best.buffer.length, width, height, note };
}
