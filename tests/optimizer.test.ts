import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_OPTIONS, type OptimizerOptions } from '../src/config.js';
import { optimizeDirectory, type RunReport } from '../src/optimizer.js';
import { createPhoto, FIXTURES, tempDir } from './helpers.js';

async function setup(): Promise<{ input: string; output: string; options: OptimizerOptions }> {
  const root = await tempDir();
  const input = path.join(root, 'input');
  const output = path.join(root, 'export');
  await mkdir(path.join(input, 'galeria'), { recursive: true });
  await createPhoto(path.join(input, 'portada.jpg'), 1600, 900);
  await createPhoto(path.join(input, 'portada.png'), 200, 200);
  await copyFile(path.join(FIXTURES, 'iphone-p3.heic'), path.join(input, 'galeria', 'IMG_0001.HEIC'));
  await writeFile(path.join(input, 'icono.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">  <rect x="0.000" y="0.000" width="10" height="10"/>  </svg>');
  await writeFile(path.join(input, 'leeme.txt'), 'hola');
  await writeFile(path.join(input, '.DS_Store'), '');
  return { input, output, options: { ...DEFAULT_OPTIONS, inputDir: input, outputDir: output, concurrency: 2 } };
}

describe('optimizeDirectory', () => {
  it('procesa todo el directorio, conserva subcarpetas y escribe el manifest', async () => {
    const { output, options } = await setup();

    const report = await optimizeDirectory(options);

    const bySource = Object.fromEntries(report.files.map((f) => [f.source, f]));
    expect(Object.keys(bySource).sort()).toEqual(
      [path.join('galeria', 'IMG_0001.HEIC'), 'icono.svg', 'leeme.txt', 'portada.jpg', 'portada.png'].sort(),
    );
    expect(bySource['portada.jpg']?.output).toMatch(/^portada\.(avif|webp)$/);
    expect(bySource['portada.png']?.output).toMatch(/^portada-png\./);
    expect(bySource[path.join('galeria', 'IMG_0001.HEIC')]?.output).toMatch(/^galeria\/IMG_0001\.(avif|webp)$/);
    expect(bySource['leeme.txt']?.status).toBe('skipped');
    expect(report.totals).toMatchObject({ files: 5, optimized: 4, skipped: 1, failed: 0 });
    expect(report.totals.bytesOut).toBeLessThan(report.totals.bytesIn);

    const manifest = JSON.parse(await readFile(path.join(output, 'manifest.json'), 'utf8')) as Pick<RunReport, 'files'>;
    expect(manifest.files).toHaveLength(5);
    expect(await readdir(path.join(output, 'galeria'))).toHaveLength(1);
  });

  it('copia archivos no multimedia con --copy-unsupported', async () => {
    const { output, options } = await setup();

    await optimizeDirectory({ ...options, copyUnsupported: true });

    expect(await readFile(path.join(output, 'leeme.txt'), 'utf8')).toBe('hola');
  });

  it('en modo dry-run no escribe nada', async () => {
    const { output, options } = await setup();

    const report = await optimizeDirectory({ ...options, dryRun: true });

    expect(report.files.every((f) => f.status === 'planned' || f.status === 'skipped')).toBe(true);
    await expect(readdir(output)).rejects.toThrow();
  });

  it('registra los errores por archivo sin detener el resto', async () => {
    const { input, options } = await setup();
    await writeFile(path.join(input, 'corrupta.jpg'), 'no soy una imagen');

    const report = await optimizeDirectory(options);

    expect(report.files.find((f) => f.source === 'corrupta.jpg')).toMatchObject({ status: 'failed' });
    expect(report.totals.optimized).toBe(4);
  });

  it('rechaza directorios inválidos o peligrosos', async () => {
    const { input, options } = await setup();

    await expect(optimizeDirectory({ ...options, inputDir: path.join(input, 'no-existe') })).rejects.toThrow(/no existe/);
    await expect(optimizeDirectory({ ...options, outputDir: input })).rejects.toThrow(/entrada/);
    await expect(optimizeDirectory({ ...options, outputDir: path.dirname(input), clean: true })).rejects.toThrow(/entrada/);
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')(
    '--clean no borra la entrada si la salida solo difiere en mayúsculas',
    async () => {
      const { input, options } = await setup();

      await expect(optimizeDirectory({ ...options, outputDir: input.toUpperCase(), clean: true })).rejects.toThrow(/entrada/);
      expect(await readdir(input)).toContain('portada.jpg');
    },
  );

  it('--clean solo vacía una carpeta que sea un export anterior', async () => {
    const { output, options } = await setup();
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, 'importante.docx'), 'no borrar');

    await expect(optimizeDirectory({ ...options, clean: true })).rejects.toThrow(/exports anteriores/);
    expect(await readdir(output)).toContain('importante.docx');

    await rm(path.join(output, 'importante.docx'));
    await optimizeDirectory(options);
    await writeFile(path.join(output, 'viejo.webp'), '');
    await optimizeDirectory({ ...options, clean: true });
    expect(await readdir(output)).not.toContain('viejo.webp');
  });

  it('no trata una carpeta "..algo" como externa', async () => {
    const root = await tempDir();
    const input = path.join(root, '..fotos');
    await mkdir(input);
    await createPhoto(path.join(input, 'a.jpg'), 50, 50);

    await expect(
      optimizeDirectory({ ...DEFAULT_OPTIONS, inputDir: input, outputDir: root, concurrency: 1, clean: true }),
    ).rejects.toThrow(/entrada/);
    expect(await readdir(input)).toContain('a.jpg');
  });

  it('el manifest no expone rutas absolutas locales', async () => {
    const { input, output, options } = await setup();

    await optimizeDirectory(options);

    expect(await readFile(path.join(output, 'manifest.json'), 'utf8')).not.toContain(path.dirname(input));
  });
});
