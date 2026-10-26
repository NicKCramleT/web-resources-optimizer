import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { optimizeImage, type ImageJob } from '../src/processors/image.js';
import { extractHeicIccProfile } from '../src/processors/heic.js';
import { createPhoto, ffmpeg, FIXTURES, meanColor, QUALITY, tempDir } from './helpers.js';

function job(inputPath: string, outputBase: string, overrides: Partial<ImageJob> = {}): ImageJob {
  return { inputPath, outputBase, isHeic: false, format: 'auto', quality: QUALITY, maxSize: 2560, ...overrides };
}

describe('optimizeImage', () => {
  it('convierte una foto JPG a un formato moderno mucho más liviano y limita el tamaño', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'foto.jpg');
    await createPhoto(input, 3000, 2000);

    const result = await optimizeImage(job(input, path.join(dir, 'out')));

    expect(['avif', 'webp']).toContain(result.format);
    expect(result.bytes).toBeLessThan((await stat(input)).size / 2);
    expect(result.width).toBe(2560);
    expect(result.height).toBe(1707);
  });

  it('aplica la orientación EXIF y elimina los metadatos (GPS, cámara)', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'vertical.jpg');
    await createPhoto(input, 400, 200, { orientation: 6 });

    const result = await optimizeImage(job(input, path.join(dir, 'out')));
    const meta = await sharp(result.outputPath).metadata();

    expect([result.width, result.height]).toEqual([200, 400]);
    expect(meta.exif).toBeUndefined();
    expect(meta.orientation ?? 1).toBe(1);
  });

  it('conserva la transparencia de un PNG', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'logo.png');
    await sharp({ create: { width: 300, height: 300, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: Buffer.from('<svg width="300" height="300"><circle cx="150" cy="150" r="100" fill="#0a7"/></svg>') }])
      .png()
      .toFile(input);

    const result = await optimizeImage(job(input, path.join(dir, 'out')));

    expect((await sharp(result.outputPath).metadata()).hasAlpha).toBe(true);
  });

  it('elimina un canal alfa que no se usa', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'opaco.png');
    const photo = path.join(dir, 'base.jpg');
    await createPhoto(photo, 300, 300);
    await sharp(photo).ensureAlpha().png().toFile(input);

    const result = await optimizeImage(job(input, path.join(dir, 'out')));

    expect((await sharp(result.outputPath).metadata()).hasAlpha).toBe(false);
  });

  it('convierte un GIF animado en WebP animado', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'anim.gif');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=s=160x120:r=10:d=1', input]);

    const result = await optimizeImage(job(input, path.join(dir, 'out')));
    const meta = await sharp(result.outputPath, { animated: true }).metadata();

    expect(result.format).toBe('webp');
    expect(meta.pages).toBe(10);
    expect([result.width, result.height]).toEqual([160, 120]);
    expect(result.bytes).toBeLessThan((await stat(input)).size);
  });

  it('respeta un formato explícito (JPEG con mozjpeg)', async () => {
    const dir = await tempDir();
    const photo = path.join(dir, 'base.jpg');
    const input = path.join(dir, 'foto.png');
    await createPhoto(photo, 800, 600);
    await sharp(photo).png().toFile(input);

    const result = await optimizeImage(job(input, path.join(dir, 'out'), { format: 'jpeg' }));

    expect(result.outputPath.endsWith('.jpg')).toBe(true);
    expect((await sharp(result.outputPath).metadata()).format).toBe('jpeg');
  });

  it('conserva el original si ya es apto para web y más liviano, pero sin metadatos privados', async () => {
    const dir = await tempDir();
    const photo = path.join(dir, 'base.jpg');
    const input = path.join(dir, 'comprimida.jpg');
    await createPhoto(photo, 400, 400);
    // Un JPEG ya muy comprimido: recodificarlo a AVIF/WebP solo lo haría crecer.
    await sharp(photo)
      .withExif({ IFD0: { Model: 'iPhone 15' } })
      .jpeg({ quality: 20, mozjpeg: true })
      .toFile(input);

    const result = await optimizeImage(job(input, path.join(dir, 'out')));
    const output = await readFile(result.outputPath);

    expect(result.outputPath).toBe(path.join(dir, 'out.jpg'));
    expect(result.copied).toBe(true);
    expect(result.bytes).toBeLessThan((await stat(input)).size);
    expect((await sharp(output).metadata()).exif).toBeUndefined();
    expect(output.includes('iPhone 15')).toBe(false);
  });

  it('trata un TIFF multipágina como imagen fija y respeta el formato pedido', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'scan.tif');
    const page = await sharp({ create: { width: 100, height: 300, channels: 3, background: '#357' } }).png().toBuffer();
    await sharp([page, page, page], { join: { animated: true } }).tiff().toFile(input);
    expect((await sharp(input).metadata()).pages).toBe(3);

    const result = await optimizeImage(job(input, path.join(dir, 'out'), { format: 'jpeg' }));

    expect(result.outputPath.endsWith('.jpg')).toBe(true);
    expect([result.width, result.height]).toEqual([100, 300]);
  });

  it('conserva un APNG (PNG animado) en vez de aplanarlo', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'anim.png');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=s=64x64:r=5:d=1', '-plays', '0', '-f', 'apng', input]);

    const result = await optimizeImage(job(input, path.join(dir, 'out')));

    expect(result.outputPath).toBe(path.join(dir, 'out.png'));
    expect(result.copied).toBe(true);
    expect(result.note).toMatch(/APNG/);
  });

  it('con un formato sin animación pedido explícitamente, conserva el GIF animado', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'anim.gif');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc=s=64x64:r=5:d=1', input]);

    const result = await optimizeImage(job(input, path.join(dir, 'out'), { format: 'jpeg' }));

    expect(result.outputPath).toBe(path.join(dir, 'out.gif'));
    expect(result.note).toMatch(/animación/);
  });

  it('convierte una foto HEIC de iPhone (Display P3) a sRGB sin perder color', async () => {
    const dir = await tempDir();
    const input = path.join(FIXTURES, 'iphone-p3.heic');

    expect(await extractHeicIccProfile(await readFile(input))).toBeDefined();
    const result = await optimizeImage(job(input, path.join(dir, 'out'), { isHeic: true, format: 'webp' }));

    expect(result.format).toBe('webp');
    expect([result.width, result.height]).toEqual([480, 320]);
    const reference = await meanColor(path.join(FIXTURES, 'reference-srgb.jpg'));
    const converted = await meanColor(result.outputPath);
    converted.forEach((value, i) => expect(Math.abs(value - reference[i]!)).toBeLessThan(2));
  });

  it('reporta un error claro si el archivo está corrupto', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'roto.jpg');
    await writeFile(input, 'esto no es una imagen');

    await expect(optimizeImage(job(input, path.join(dir, 'out')))).rejects.toThrow();
  });
});
