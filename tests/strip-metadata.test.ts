import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { isApng, stripJpegMetadata, stripPngMetadata } from '../src/utils/strip-metadata.js';

const base = () => sharp({ create: { width: 32, height: 32, channels: 3, background: '#c33' } });

describe('stripJpegMetadata', () => {
  it('quita EXIF sin alterar los píxeles y conserva el perfil ICC', async () => {
    const jpeg = await base().withExif({ IFD0: { Model: 'iPhone 15' } }).withIccProfile('p3').jpeg().toBuffer();

    const stripped = stripJpegMetadata(jpeg)!;
    const meta = await sharp(stripped).metadata();

    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeDefined();
    expect(await sharp(stripped).raw().toBuffer()).toEqual(await sharp(jpeg).raw().toBuffer());
  });

  it('devuelve undefined si no es un JPEG', () => {
    expect(stripJpegMetadata(Buffer.from('hola'))).toBeUndefined();
  });
});

describe('stripPngMetadata', () => {
  it('quita chunks de texto/EXIF', async () => {
    const png = await base().withExif({ IFD0: { Model: 'iPhone 15' } }).png().toBuffer();

    const stripped = stripPngMetadata(png)!;

    expect(stripped.includes('iPhone 15')).toBe(false);
    expect((await sharp(stripped).metadata()).width).toBe(32);
  });

  it('detecta APNG solo cuando hay acTL', async () => {
    expect(isApng(await base().png().toBuffer())).toBe(false);
  });
});
