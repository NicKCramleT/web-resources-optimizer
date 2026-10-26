#!/usr/bin/env node
import os from 'node:os';
import path from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { DEFAULT_OPTIONS, type OptimizerOptions } from './config.js';
import { optimizeDirectory, type FileReport } from './optimizer.js';
import { formatBytes } from './utils/bytes.js';

function positiveInt(value: string): number {
  const parsed = Number(value);
  if (!/^\d+$/.test(value) || parsed <= 0) throw new InvalidArgumentError('debe ser un entero positivo.');
  return parsed;
}

const signed = (savings: number) => (savings >= 0 ? `-${savings}%` : `+${-savings}%`);

function quality(value: string): number {
  const parsed = positiveInt(value);
  if (parsed > 100) throw new InvalidArgumentError('debe estar entre 1 y 100.');
  return parsed;
}

const STATUS_ICON: Record<FileReport['status'], string> = {
  optimized: '✔',
  copied: '=',
  skipped: '·',
  failed: '✖',
  planned: '→',
};

function describe(file: FileReport): string {
  const icon = STATUS_ICON[file.status];
  if (file.status === 'failed') return `${icon} ${file.source}  ERROR: ${file.error}`;
  if (file.status === 'skipped') return `${icon} ${file.source}  (omitido: ${file.note ?? 'formato no soportado'})`;
  if (file.status === 'planned') return `${icon} ${file.source}  [${file.kind}] ${formatBytes(file.bytesIn)}`;
  const dims = file.width && file.height ? ` ${file.width}×${file.height}` : '';
  const poster = file.poster ? ` + poster ${formatBytes(file.poster.bytes)}` : '';
  const note = file.note ? `  (${file.note})` : '';
  return `${icon} ${file.source} → ${file.output}${dims}  ${formatBytes(file.bytesIn)} → ${formatBytes(file.bytesOut ?? 0)} (${signed(file.savings ?? 0)})${poster}${note}`;
}

const program = new Command()
  .name('web-optimize')
  .description('Optimiza imágenes (JPG, PNG, GIF, HEIC de iPhone, TIFF, BMP, WebP, AVIF), SVG y videos para la web.')
  .argument('[input]', 'directorio con los archivos originales', 'input')
  .option('-o, --output <dir>', 'directorio donde se escriben los archivos optimizados', 'export')
  .addOption(
    new Option('-f, --format <format>', 'formato de imagen; "auto" elige el más liviano entre AVIF y WebP')
      .choices(['auto', 'avif', 'webp', 'jpeg', 'png'])
      .default(DEFAULT_OPTIONS.imageFormat),
  )
  .addOption(new Option('-p, --preset <preset>', 'equilibrio calidad/peso').choices(['small', 'balanced', 'high']).default(DEFAULT_OPTIONS.preset))
  .option('-q, --quality <1-100>', 'calidad de imagen manual (sobrescribe el preset)', quality)
  .option('--max-size <px>', 'lado mayor máximo de las imágenes', positiveInt, DEFAULT_OPTIONS.maxImageSize)
  .addOption(new Option('--video-codec <codec>', 'códec de video').choices(['h264', 'vp9', 'av1']).default(DEFAULT_OPTIONS.videoCodec))
  .option('--max-video-size <px>', 'lado mayor máximo de los videos', positiveInt, DEFAULT_OPTIONS.maxVideoSize)
  .option('--mute', 'elimina el audio de los videos', DEFAULT_OPTIONS.muteVideo)
  .option('--no-poster', 'no generar imagen de portada para los videos')
  .option('--copy-unsupported', 'copia al export los archivos que no son multimedia', DEFAULT_OPTIONS.copyUnsupported)
  .option('--clean', 'vacía el directorio de salida antes de empezar', false)
  .option('-c, --concurrency <n>', 'imágenes procesadas en paralelo', positiveInt, Math.max(1, Math.floor(os.availableParallelism() / 2)))
  .option('--dry-run', 'muestra qué se procesaría sin escribir nada', DEFAULT_OPTIONS.dryRun)
  .action(async (input: string, opts) => {
    const options: OptimizerOptions & { clean: boolean } = {
      inputDir: input,
      outputDir: opts.output,
      imageFormat: opts.format,
      videoCodec: opts.videoCodec,
      preset: opts.preset,
      quality: opts.quality,
      maxImageSize: opts.maxSize,
      maxVideoSize: opts.maxVideoSize,
      muteVideo: opts.mute,
      videoPoster: opts.poster,
      copyUnsupported: opts.copyUnsupported,
      concurrency: opts.concurrency,
      dryRun: opts.dryRun,
      clean: opts.clean,
    };

    console.log(`Entrada: ${path.resolve(input)}\nSalida:  ${path.resolve(opts.output)}\n`);
    const report = await optimizeDirectory(options, { onFileDone: (file) => console.log(describe(file)) });
    const { totals } = report;

    if (totals.files === 0) {
      console.log(`No hay archivos en ${report.inputDir}. Coloca ahí tus imágenes o videos y vuelve a ejecutar.`);
      return;
    }
    if (options.dryRun) {
      const planned = report.files.filter((f) => f.status === 'planned');
      const bytes = planned.reduce((sum, f) => sum + f.bytesIn, 0);
      console.log(`\nSe procesarían ${planned.length} archivos (${formatBytes(bytes)}); ${totals.skipped} se omitirían. No se escribió nada.`);
      return;
    }
    console.log(
      `\n${totals.optimized} listos, ${totals.skipped} omitidos, ${totals.failed} con error · ` +
        `${formatBytes(totals.bytesIn)} → ${formatBytes(totals.bytesOut)} (${signed(totals.savings)}) · ` +
        `${(report.elapsedMs / 1000).toFixed(1)} s`,
    );
    if (!options.dryRun) console.log(`Manifest: ${path.join(report.outputDir, 'manifest.json')}`);
    if (totals.failed > 0) process.exitCode = 1;
  });

program.parseAsync().catch((error: unknown) => {
  console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
