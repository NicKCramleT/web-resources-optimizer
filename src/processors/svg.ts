import { readFile, writeFile } from 'node:fs/promises';
import { optimize } from 'svgo';
import type { ProcessedAsset } from './types.js';

/**
 * Minifica un SVG con SVGO y elimina scripts. El preset por defecto de SVGO 4 conserva
 * viewBox y title, necesarios para escalar bien y para accesibilidad.
 */
export async function optimizeSvg(inputPath: string, outputBase: string): Promise<ProcessedAsset> {
  const { data } = optimize(await readFile(inputPath, 'utf8'), { path: inputPath, multipass: true, plugins: ['preset-default', 'removeScripts'] });

  // Siempre se usa la versión de SVGO (aunque casi nunca crece): es la que no trae scripts.
  const outputPath = `${outputBase}.svg`;
  await writeFile(outputPath, data);
  return { outputPath, format: 'svg', bytes: Buffer.byteLength(data) };
}
