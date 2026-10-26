const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Chunks PNG de texto/EXIF que pueden contener datos privados. iCCP se conserva. */
const PNG_METADATA_CHUNKS = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);

/**
 * Elimina EXIF/XMP (APP1), IPTC (APP13) y comentarios de un JPEG sin
 * recodificarlo. Conserva APP0 (JFIF), APP2 (perfil ICC) y APP14 (Adobe).
 * Devuelve `undefined` si la estructura no es la esperada.
 */
export function stripJpegMetadata(jpeg: Buffer): Buffer | undefined {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return undefined;
  const parts: Buffer[] = [jpeg.subarray(0, 2)];
  let offset = 2;
  while (offset + 4 <= jpeg.length) {
    if (jpeg[offset] !== 0xff) return undefined;
    const marker = jpeg[offset + 1]!;
    // SOS: a partir de aquí son datos de imagen.
    if (marker === 0xda) {
      parts.push(jpeg.subarray(offset));
      return Buffer.concat(parts);
    }
    const length = jpeg.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > jpeg.length) return undefined;
    const isMetadata = marker === 0xe1 || marker === 0xed || marker === 0xfe;
    if (!isMetadata) parts.push(jpeg.subarray(offset, end));
    offset = end;
  }
  return undefined;
}

/** Elimina chunks de texto y EXIF de un PNG sin recodificarlo. */
export function stripPngMetadata(png: Buffer): Buffer | undefined {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) return undefined;
  const parts: Buffer[] = [png.subarray(0, 8)];
  let offset = 8;
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > png.length) return undefined;
    if (!PNG_METADATA_CHUNKS.has(type)) parts.push(png.subarray(offset, end));
    offset = end;
    if (type === 'IEND') return Buffer.concat(parts);
  }
  return undefined;
}

/** true si el PNG es animado (APNG): tiene un chunk acTL antes de IDAT. */
export function isApng(png: Buffer): boolean {
  if (!png.subarray(0, 8).equals(PNG_SIGNATURE)) return false;
  let offset = 8;
  while (offset + 12 <= png.length) {
    const type = png.toString('latin1', offset + 4, offset + 8);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    offset += 12 + png.readUInt32BE(offset);
  }
  return false;
}
