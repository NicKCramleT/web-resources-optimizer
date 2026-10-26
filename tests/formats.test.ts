import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveQuality } from '../src/config.js';
import { classify, isWebReady } from '../src/formats.js';
import { planOutputs } from '../src/optimizer.js';
import { formatBytes, savingsPercent } from '../src/utils/bytes.js';

describe('classify', () => {
  it.each([
    ['foto.JPG', 'image'],
    ['IMG_0001.HEIC', 'heic'],
    ['IMG_0002.heif', 'heic'],
    ['anim.gif', 'image'],
    ['scan.tiff', 'image'],
    ['logo.svg', 'svg'],
    ['IMG_0003.MOV', 'video'],
    ['clip.webm', 'video'],
    ['notas.txt', 'other'],
  ])('%s → %s', (file, kind) => {
    expect(classify(file)).toBe(kind);
  });

  it('detecta formatos que el navegador ya muestra', () => {
    expect(isWebReady('a.jpeg')).toBe(true);
    expect(isWebReady('a.heic')).toBe(false);
    expect(isWebReady('a.mov')).toBe(false);
  });
});

describe('planOutputs', () => {
  it('conserva subcarpetas y evita colisiones de nombre (sin distinguir mayúsculas)', () => {
    const input = '/in';
    const plans = planOutputs(
      ['/in/foto.jpg', '/in/foto.png', '/in/FOTO.heic', '/in/sub/foto.jpg'],
      input,
      '/out',
    );
    expect(plans.map((p) => path.relative('/out', p.outputBase))).toEqual([
      'foto',
      'foto-png',
      'FOTO-heic',
      path.join('sub', 'foto'),
    ]);
  });

  it('reserva el nombre del poster de cada video y el del manifest', () => {
    const plans = planOutputs(['/in/clip.mov', '/in/clip.poster.png', '/in/manifest.json'], '/in', '/out');
    expect(plans.map((p) => path.relative('/out', p.outputBase))).toEqual(['clip', 'clip.poster-png', 'manifest-json']);
  });
});

describe('utilidades', () => {
  it('formatea bytes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });

  it('calcula ahorro porcentual', () => {
    expect(savingsPercent(1000, 250)).toBe(75);
    expect(savingsPercent(0, 10)).toBe(0);
  });

  it('una calidad manual sobrescribe el preset y ajusta AVIF', () => {
    const q = resolveQuality({ preset: 'balanced', quality: 80 });
    expect(q.webp).toBe(80);
    expect(q.avif).toBeLessThan(80);
  });
});
