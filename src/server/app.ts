import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import { JobStore, parseSettings, type JobEvent } from './jobs.js';

export const APP_ID = 'mesa-de-luz';
const WEB_DIR = path.resolve(import.meta.dirname, '../../web');
/** Límite por archivo subido (videos 4K largos incluidos). */
const MAX_UPLOAD_BYTES = 8 * 1024 ** 3;

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.avif': 'image/avif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': CONTENT_TYPES['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 10_000) throw new HttpError(413, 'Cuerpo demasiado grande.');
  }
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new HttpError(400, 'JSON inválido.');
  }
}

/** Resuelve `relative` dentro de `root` o lanza 404 (evita salir del directorio con ../). */
function resolveInside(root: string, relative: string): string {
  const full = path.resolve(root, relative);
  if (!full.startsWith(root + path.sep)) throw new HttpError(404, 'No encontrado.');
  return full;
}

async function sendFile(req: IncomingMessage, res: ServerResponse, file: string, extraHeaders: Record<string, string> = {}): Promise<void> {
  const info = await stat(file).catch(() => undefined);
  if (!info?.isFile()) throw new HttpError(404, 'No encontrado.');
  const type = CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Accept-Ranges': 'bytes', ...extraHeaders };

  // Rangos: necesarios para que <video> pueda adelantar la reproducción.
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
  if (range && (range[1] || range[2])) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start > end || start >= info.size) {
      res.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
      return;
    }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
    await pipeline(createReadStream(file, { start, end }), res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': info.size });
  await pipeline(createReadStream(file), res);
}

function attachment(name: string): string {
  return `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_').replaceAll('"', '')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function zipName(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `optimizado-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.zip`;
}

/** Corta la subida si supera el límite aunque no venga Content-Length (chunked). */
function byteLimit(max: number): Transform {
  let total = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      total += chunk.length;
      callback(total > max ? new HttpError(413, 'El archivo supera los 8 GB.') : null, chunk);
    },
  });
}

/** Una vista previa nunca debe ejecutar scripts (p. ej. un SVG con <script>). */
const OUTPUT_HEADERS = {
  'Cache-Control': 'private, max-age=3600',
  'Content-Security-Policy': "default-src 'none'; img-src data:; style-src 'unsafe-inline'; media-src 'self'; sandbox",
  'X-Content-Type-Options': 'nosniff',
};

export function createApp(store: JobStore, allowedHosts: Set<string>) {
  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Solo responde a localhost: evita que otra web use el servidor vía DNS rebinding.
    if (!allowedHosts.has(req.headers.host ?? '')) throw new HttpError(403, 'Host no permitido.');

    const method = req.method ?? 'GET';
    // Otra web no puede crear trabajos ni subir archivos: las escrituras exigen origen propio.
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = req.headers.origin;
      const originHost = origin ? URL.parse(origin)?.host : undefined;
      if ((origin && !allowedHosts.has(originHost ?? '')) || req.headers['sec-fetch-site'] === 'cross-site') {
        throw new HttpError(403, 'Origen no permitido.');
      }
    }

    const url = new URL(req.url ?? '/', 'http://localhost');
    let parts: string[];
    try {
      parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    } catch {
      throw new HttpError(400, 'Ruta inválida.');
    }

    if (parts[0] !== 'api') {
      const file = parts.length === 0 ? 'index.html' : parts.join('/');
      await sendFile(req, res, resolveInside(WEB_DIR, file), { 'Cache-Control': 'no-cache' });
      return;
    }

    // GET /api/health → permite detectar si la app ya está abierta en este puerto
    if (method === 'GET' && parts[1] === 'health' && parts.length === 2) {
      sendJson(res, 200, { app: APP_ID });
      return;
    }

    // POST /api/jobs → crea un trabajo con su configuración
    if (method === 'POST' && parts.length === 2 && parts[1] === 'jobs') {
      if (!req.headers['content-type']?.startsWith('application/json')) throw new HttpError(415, 'Se espera JSON.');
      const job = await store.create(parseSettings(await readJson(req)));
      sendJson(res, 201, store.snapshot(job));
      return;
    }

    if (parts[1] !== 'jobs' || !parts[2]) throw new HttpError(404, 'No encontrado.');
    const job = store.get(parts[2]);
    if (!job) throw new HttpError(404, 'Este trabajo ya no existe (se borran tras 2 horas sin uso o al cerrar el servidor).');
    store.touch(job);
    const action = parts[3];

    // PUT /api/jobs/:id/files?name=foto.heic  (cuerpo = bytes del archivo)
    if (method === 'PUT' && action === 'files') {
      if (job.status !== 'uploading') throw new HttpError(409, 'El trabajo ya se está procesando.');
      if (Number(req.headers['content-length'] ?? 0) > MAX_UPLOAD_BYTES) throw new HttpError(413, 'El archivo supera los 8 GB.');
      const source = store.reserveName(job, url.searchParams.get('name') ?? 'archivo');
      const target = resolveInside(job.inputDir, source);
      // Se escribe a un .part oculto (listFiles ignora los ocultos) y se renombra al completar.
      const partial = path.join(job.inputDir, `.${randomUUID()}.part`);
      job.activeUploads++;
      try {
        await pipeline(req, byteLimit(MAX_UPLOAD_BYTES), createWriteStream(partial));
        await rename(partial, target);
      } catch (error) {
        job.files.delete(source);
        await rm(partial, { force: true });
        throw error;
      } finally {
        job.activeUploads--;
        store.touch(job);
      }
      sendJson(res, 201, job.files.get(source));
      return;
    }

    // POST /api/jobs/:id/start
    if (method === 'POST' && action === 'start') {
      if (job.files.size === 0) throw new HttpError(400, 'Sube al menos un archivo.');
      if (job.activeUploads > 0) throw new HttpError(409, 'Todavía hay archivos subiéndose.');
      store.start(job);
      sendJson(res, 202, store.snapshot(job));
      return;
    }

    // GET /api/jobs/:id/events  (Server-Sent Events con el avance)
    if (method === 'GET' && action === 'events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      const isFinal = (status: string) => status === 'done' || status === 'failed';
      let keepAlive: NodeJS.Timeout | undefined;
      const stop = () => {
        clearInterval(keepAlive);
        job.events.off('event', send);
        res.end();
      };
      // Al terminar el trabajo se cierra el stream: ya no habrá más eventos.
      const send = (event: JobEvent) => {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
        if (event.type === 'status' && isFinal(event.status)) stop();
      };
      res.write(`data: ${JSON.stringify({ type: 'snapshot', job: store.snapshot(job) })}\n\n`);
      if (isFinal(job.status)) return void res.end();
      keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);
      job.events.on('event', send);
      req.on('close', stop);
      return;
    }

    // GET /api/jobs/:id/download  → ZIP con todo el export
    if (method === 'GET' && action === 'download') {
      if (job.status !== 'done') throw new HttpError(409, 'El trabajo todavía no termina.');
      res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': attachment(zipName()) });
      // Las imágenes y videos ya están comprimidos: guardarlos sin recomprimir es instantáneo.
      const zip = new ZipArchive({ store: true });
      zip.directory(job.outputDir, false);
      zip.finalize().catch((error: unknown) => zip.destroy(error instanceof Error ? error : undefined));
      await pipeline(zip, res);
      return;
    }

    // GET /api/jobs/:id/output/<ruta>  → archivo optimizado (vista previa o descarga individual)
    if (method === 'GET' && action === 'output' && parts.length > 4) {
      const relative = parts.slice(4).join('/');
      const headers: Record<string, string> = { ...OUTPUT_HEADERS };
      if (url.searchParams.has('download')) headers['Content-Disposition'] = attachment(path.basename(relative));
      await sendFile(req, res, resolveInside(job.outputDir, relative), headers);
      return;
    }

    throw new HttpError(404, 'No encontrado.');
  }

  return async (req: IncomingMessage, res: ServerResponse) => {
    try {
      await route(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      // Si se rechaza una subida, no seguir recibiendo gigas que se descartarán.
      if (req.method === 'PUT' && !req.readableEnded) res.setHeader('Connection', 'close');
      sendJson(res, status, { error: error instanceof Error ? error.message : 'Error inesperado.' });
    }
  };
}
