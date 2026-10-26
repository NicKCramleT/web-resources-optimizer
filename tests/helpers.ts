import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import sharp from 'sharp';
import { afterEach } from 'vitest';
import { PRESETS } from '../src/config.js';

export const FIXTURES = path.join(import.meta.dirname, 'fixtures');
export const QUALITY = PRESETS.balanced;

const tempDirs: string[] = [];

export async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wro-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Imagen con ruido y degradado: se comporta como una foto para los encoders. */
export async function createPhoto(file: string, width: number, height: number, options: { orientation?: number } = {}): Promise<void> {
  const noise = await sharp({ create: { width, height, channels: 3, background: '#000', noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
    .blur(2)
    .png()
    .toBuffer();
  const image = sharp(noise).jpeg({ quality: 95 });
  if (options.orientation) image.withMetadata({ orientation: options.orientation, exif: { IFD0: { Make: 'Apple', Model: 'iPhone' } } });
  await image.toFile(file);
}

export function ffmpeg(args: string[]): void {
  const result = spawnSync(ffmpegStatic as unknown as string, ['-v', 'error', '-y', ...args]);
  if (result.status !== 0) throw new Error(result.stderr.toString());
}

export async function meanColor(input: Buffer | string): Promise<number[]> {
  // Se re-codifica para aplicar la conversión ICC → sRGB antes de medir.
  const srgb = await sharp(input).png().toBuffer();
  return (await sharp(srgb).stats()).channels.slice(0, 3).map((c) => c.mean);
}
