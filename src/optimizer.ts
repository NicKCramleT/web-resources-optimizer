import { copyFile, mkdir, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import { resolveQuality, type OptimizerOptions } from './config.js';
import { classify, extensionOf, type AssetKind } from './formats.js';
import { optimizeImage } from './processors/image.js';
import { optimizeSvg } from './processors/svg.js';
import type { ProcessedAsset } from './processors/types.js';
import { optimizeVideo } from './processors/video.js';
import { savingsPercent } from './utils/bytes.js';
import { listFiles } from './utils/fs.js';

export type FileStatus = 'optimized' | 'copied' | 'skipped' | 'failed' | 'planned';

export interface FileReport {
  /** Ruta relativa al directorio de entrada. */
  source: string;
  kind: AssetKind;
  status: FileStatus;
  bytesIn: number;
  /** Ruta relativa al directorio de salida. */
  output?: string;
  bytesOut?: number;
  savings?: number;
  format?: string;
  width?: number;
  height?: number;
  duration?: number;
  poster?: { output: string; bytes: number; width: number; height: number };
  note?: string;
  error?: string;
}

export interface RunReport {
  inputDir: string;
  outputDir: string;
  files: FileReport[];
  totals: { files: number; optimized: number; skipped: number; failed: number; bytesIn: number; bytesOut: number; savings: number };
  elapsedMs: number;
}

export interface OptimizerHooks {
  onFileStart?: (source: string, kind: AssetKind) => void;
  /** Avance 0-1 de archivos largos (videos). */
  onFileProgress?: (source: string, fraction: number) => void;
  onFileDone?: (report: FileReport) => void;
}

interface PlannedFile {
  inputPath: string;
  source: string;
  kind: AssetKind;
  /** Ruta de salida sin extensión, única dentro del export. */
  outputBase: string;
}

/** Nombres reservados en la raíz del export. */
const MANIFEST = 'manifest.json';

/**
 * Asigna a cada archivo una ruta de salida única. `foto.jpg` y `foto.png`
 * terminarían ambos en `foto.webp`, así que el segundo pasa a `foto-png`.
 * Los videos se planifican primero porque también reservan `<nombre>.poster`.
 * La comparación ignora mayúsculas porque macOS/Windows también lo hacen.
 */
export function planOutputs(files: string[], inputDir: string, outputDir: string): PlannedFile[] {
  const used = new Set<string>(['manifest']);
  const byPriority = [...files].sort((a, b) => Number(classify(b) === 'video') - Number(classify(a) === 'video'));
  const planned = new Map<string, PlannedFile>();

  for (const inputPath of byPriority) {
    const source = path.relative(inputDir, inputPath);
    const ext = extensionOf(source);
    const stem = source.slice(0, source.length - ext.length);
    const kind = classify(inputPath);
    const isFree = (name: string) => !used.has(name.toLowerCase()) && (kind !== 'video' || !used.has(`${name}.poster`.toLowerCase()));
    let candidate = stem;
    for (let i = 2; !isFree(candidate); i++) {
      candidate = i === 2 ? `${stem}-${ext.slice(1)}` : `${stem}-${ext.slice(1)}-${i - 1}`;
    }
    used.add(candidate.toLowerCase());
    if (kind === 'video') used.add(`${candidate}.poster`.toLowerCase());
    planned.set(inputPath, { inputPath, source, kind, outputBase: path.join(outputDir, candidate) });
  }
  return files.map((file) => planned.get(file)!);
}

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

/** Ruta canónica (resuelve symlinks) aunque el último tramo todavía no exista. */
async function canonical(dir: string): Promise<string> {
  const resolved = await realpath(dir).catch(async () => path.join(await canonical(path.dirname(dir)), path.basename(dir)));
  return CASE_INSENSITIVE_FS ? resolved.toLowerCase() : resolved;
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function assertSafeDirectories(inputDir: string, outputDir: string, clean: boolean): Promise<void> {
  const [input, output] = await Promise.all([canonical(inputDir), canonical(outputDir)]);
  if (isInside(input, output)) {
    throw new Error('El directorio de salida no puede ser el de entrada ni contenerlo.');
  }
  if (clean) {
    // Solo se vacía una carpeta vacía o un export anterior (tiene manifest.json).
    const entries = await readdir(outputDir).catch(() => [] as string[]);
    if (entries.some((e) => !e.startsWith('.')) && !entries.includes(MANIFEST)) {
      throw new Error(`--clean solo vacía exports anteriores; ${outputDir} no tiene ${MANIFEST}.`);
    }
  }
}

async function processFile(plan: PlannedFile, options: OptimizerOptions, hooks: OptimizerHooks): Promise<ProcessedAsset | null> {
  const quality = resolveQuality(options);
  switch (plan.kind) {
    case 'image':
    case 'heic':
      return optimizeImage({
        inputPath: plan.inputPath,
        outputBase: plan.outputBase,
        isHeic: plan.kind === 'heic',
        format: options.imageFormat,
        quality,
        maxSize: options.maxImageSize,
      });
    case 'svg':
      return optimizeSvg(plan.inputPath, plan.outputBase);
    case 'video':
      return optimizeVideo({
        inputPath: plan.inputPath,
        outputBase: plan.outputBase,
        codec: options.videoCodec,
        quality,
        maxSize: options.maxVideoSize,
        mute: options.muteVideo,
        poster: options.videoPoster,
        onProgress: hooks.onFileProgress && ((fraction) => hooks.onFileProgress?.(plan.source, fraction)),
      });
    case 'other':
      if (!options.copyUnsupported) return null;
      {
        const outputPath = plan.outputBase + extensionOf(plan.inputPath);
        await copyFile(plan.inputPath, outputPath);
        return { outputPath, format: extensionOf(plan.inputPath).slice(1), bytes: (await stat(outputPath)).size, copied: true, note: 'copiado sin cambios' };
      }
  }
}

export async function optimizeDirectory(options: OptimizerOptions & { clean?: boolean }, hooks: OptimizerHooks = {}): Promise<RunReport> {
  const started = Date.now();
  const inputDir = path.resolve(options.inputDir);
  const outputDir = path.resolve(options.outputDir);

  const inputStat = await stat(inputDir).catch(() => undefined);
  if (!inputStat?.isDirectory()) throw new Error(`El directorio de entrada no existe: ${inputDir}`);
  await assertSafeDirectories(inputDir, outputDir, options.clean ?? false);

  if (!options.dryRun) {
    if (options.clean) await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
  }

  const plans = planOutputs(await listFiles(inputDir, outputDir), inputDir, outputDir);
  // Las imágenes paralelizan bien; ffmpeg ya usa todos los núcleos, así que los videos van de a uno.
  const imageLimit = pLimit(Math.max(1, options.concurrency));
  const videoLimit = pLimit(1);

  const files = await Promise.all(
    plans.map((plan) =>
      (plan.kind === 'video' ? videoLimit : imageLimit)(async (): Promise<FileReport> => {
        const base: FileReport = { source: plan.source, kind: plan.kind, status: 'planned', bytesIn: 0 };
        let report: FileReport;

        try {
          base.bytesIn = (await stat(plan.inputPath)).size;
          if (options.dryRun) {
            report = plan.kind === 'other' && !options.copyUnsupported ? { ...base, status: 'skipped' } : base;
          } else {
            await mkdir(path.dirname(plan.outputBase), { recursive: true });
            hooks.onFileStart?.(plan.source, plan.kind);
            const result = await processFile(plan, options, hooks);
            report = result ? toReport(base, result, outputDir) : { ...base, status: 'skipped', note: 'formato no soportado' };
          }
        } catch (error) {
          report = { ...base, status: 'failed', error: friendlyError(error) };
        }

        hooks.onFileDone?.(report);
        return report;
      }),
    ),
  );

  const done = files.filter((f) => f.status === 'optimized' || f.status === 'copied');
  const bytesIn = done.reduce((sum, f) => sum + f.bytesIn, 0);
  const bytesOut = done.reduce((sum, f) => sum + (f.bytesOut ?? 0) + (f.poster?.bytes ?? 0), 0);
  const report: RunReport = {
    inputDir,
    outputDir,
    files,
    totals: {
      files: files.length,
      optimized: done.length,
      skipped: files.filter((f) => f.status === 'skipped').length,
      failed: files.filter((f) => f.status === 'failed').length,
      bytesIn,
      bytesOut,
      savings: savingsPercent(bytesIn, bytesOut),
    },
    elapsedMs: Date.now() - started,
  };

  if (!options.dryRun) {
    // Sin rutas absolutas: el export se publica y no debe revelar la estructura local.
    const manifest = { generatedAt: new Date().toISOString(), totals: report.totals, files: report.files };
    await writeFile(path.join(outputDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return report;
}

/** Traduce los errores técnicos más comunes de libvips/ffmpeg a algo accionable. */
function friendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/unsupported image format|premature end|corrupt|bad (huffman|seek)|not a (jpeg|png)|invalid data found|moov atom not found/i.test(message)) {
    return 'El archivo está dañado o no es lo que dice su extensión.';
  }
  if (/pixel limit/i.test(message)) return 'La imagen es demasiado grande para procesarla.';
  return message;
}

function toReport(base: FileReport, result: ProcessedAsset, outputDir: string): FileReport {
  const relative = (p: string) => path.relative(outputDir, p).split(path.sep).join('/');
  return {
    ...base,
    status: result.copied ? 'copied' : 'optimized',
    output: relative(result.outputPath),
    bytesOut: result.bytes,
    savings: savingsPercent(base.bytesIn, result.bytes),
    format: result.format,
    width: result.width,
    height: result.height,
    duration: result.duration,
    poster: result.poster && {
      output: relative(result.poster.outputPath),
      bytes: result.poster.bytes,
      width: result.poster.width,
      height: result.poster.height,
    },
    note: result.note,
  };
}
