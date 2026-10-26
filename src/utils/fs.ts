import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';

const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
const normalize = (p: string) => (CASE_INSENSITIVE_FS ? p.toLowerCase() : p);

/**
 * Lista recursivamente los archivos de `dir` (rutas absolutas, orden estable),
 * siguiendo enlaces simbólicos a archivos e ignorando ocultos (.DS_Store, ._foo)
 * y el directorio `exclude` si está dentro.
 */
export async function listFiles(dir: string, exclude?: string): Promise<string[]> {
  const excluded = exclude ? normalize(path.resolve(exclude)) : undefined;
  const results: string[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (normalize(full) === excluded) continue;
        await walk(full);
      } else if (entry.isFile() || (entry.isSymbolicLink() && (await stat(full).catch(() => undefined))?.isFile())) {
        results.push(full);
      }
    }
  }

  await walk(path.resolve(dir));
  return results.sort((a, b) => a.localeCompare(b));
}
