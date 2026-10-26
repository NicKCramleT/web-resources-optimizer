import { readFile } from 'node:fs/promises';
import { deflateSync, crc32 } from 'node:zlib';
import decodeHeic from 'heic-decode';
import sharp from 'sharp';

/** colour_primaries de ISO/IEC 23091-2 que nos interesan. */
const PRIMARIES_DISPLAY_P3 = 12;

let p3ProfileCache: Buffer | undefined;

/** Perfil ICC Display P3 que trae libvips, para HEIC que solo declaran `nclx`. */
async function displayP3Profile(): Promise<Buffer | undefined> {
  if (!p3ProfileCache) {
    const sample = await sharp({ create: { width: 1, height: 1, channels: 3, background: '#000' } })
      .withIccProfile('p3')
      .png()
      .toBuffer();
    p3ProfileCache = (await sharp(sample).metadata()).icc;
  }
  return p3ProfileCache;
}

/**
 * Busca la caja `colr` del contenedor HEIF y devuelve el perfil ICC embebido
 * (`prof`) o, si solo declara primarias `nclx` Display P3 (típico de iPhone),
 * el perfil P3 equivalente.
 */
export async function extractHeicIccProfile(file: Buffer): Promise<Buffer | undefined> {
  let offset = file.indexOf('colr');
  while (offset !== -1) {
    if (offset < 4) {
      offset = file.indexOf('colr', offset + 4);
      continue;
    }
    const boxSize = file.readUInt32BE(offset - 4);
    const colourType = file.toString('latin1', offset + 4, offset + 8);
    const boxEnd = offset - 4 + boxSize;
    if (boxSize > 12 && boxEnd <= file.length) {
      if (colourType === 'prof') return file.subarray(offset + 8, boxEnd);
      if (colourType === 'nclx' && offset + 10 <= boxEnd) {
        const primaries = file.readUInt16BE(offset + 8);
        return primaries === PRIMARIES_DISPLAY_P3 ? displayP3Profile() : undefined;
      }
    }
    offset = file.indexOf('colr', offset + 4);
  }
  return undefined;
}

/** Inserta un chunk iCCP justo después del IHDR de un PNG. */
function embedIccInPng(png: Buffer, icc: Buffer): Buffer {
  const IHDR_END = 8 + 4 + 4 + 13 + 4; // firma + (longitud, tipo, datos, crc)
  const data = Buffer.concat([Buffer.from('icc\0\0', 'latin1'), deflateSync(icc)]);
  const type = Buffer.from('iCCP', 'latin1');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([png.subarray(0, IHDR_END), length, type, data, crc, png.subarray(IHDR_END)]);
}

/**
 * Decodifica un HEIC/HEIF (fotos de iPhone) y devuelve un buffer PNG sin pérdida
 * con su perfil de color, listo para que sharp lo convierta a sRGB.
 * La orientación ya viene aplicada por libheif (transformaciones irot/imir).
 */
export async function decodeHeicToPng(filePath: string): Promise<Buffer> {
  const file = await readFile(filePath);
  const { width, height, data } = await decodeHeic({ buffer: new Uint8Array(file) });
  const raw = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  const png = await sharp(raw, { raw: { width, height, channels: 4 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
  const icc = await extractHeicIccProfile(file);
  return icc ? embedIccInPng(png, icc) : png;
}
