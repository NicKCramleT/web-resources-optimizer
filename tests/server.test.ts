import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import { createServer, get, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/server/app.js';
import { JobStore, parseSettings, safeFileName, type JobSnapshot } from '../src/server/jobs.js';
import { FIXTURES } from './helpers.js';

describe('safeFileName', () => {
  it.each([
    ['../../etc/passwd', 'passwd'],
    ['C:\\fotos\\IMG 1.HEIC', 'IMG 1.HEIC'],
    ['.oculto.jpg', 'oculto.jpg'],
    ['año<2024>.png', 'año_2024_.png'],
    ['', 'archivo'],
    // Al recortar un nombre largo no debe quedar un archivo oculto (empezando con ".").
    [`${'x'.repeat(50)}.${'y'.repeat(175)}.jpg`, `${'y'.repeat(175)}.jpg`],
  ])('%s → %s', (input, expected) => {
    expect(safeFileName(input)).toBe(expected);
  });
});

describe('JobStore', () => {
  it('cada instancia usa su propia carpeta: abrir la app dos veces no borra la otra', async () => {
    const first = new JobStore();
    await first.init();
    const job = await first.create(parseSettings({}));
    const second = new JobStore();
    await second.init();

    expect(await stat(job.inputDir).then((s) => s.isDirectory())).toBe(true);
    await Promise.all([first.dispose(), second.dispose()]);
    await expect(stat(job.inputDir)).rejects.toThrow();
  });
});

describe('parseSettings', () => {
  it('acepta valores válidos e ignora los desconocidos', () => {
    expect(parseSettings({ preset: 'high', imageFormat: 'webp', videoCodec: 'av1', muteVideo: true })).toEqual({
      preset: 'high', imageFormat: 'webp', videoCodec: 'av1', muteVideo: true,
    });
    expect(parseSettings({ preset: '../../x', muteVideo: 'yes' })).toMatchObject({ preset: 'balanced', muteVideo: false });
  });
});

describe('servidor web', () => {
  let server: Server;
  let base: string;
  let storeRoot: string;
  const tempRoot = async () => (storeRoot = await mkdtemp(path.join(os.tmpdir(), 'wro-server-')));

  beforeAll(async () => {
    const store = new JobStore(path.join(await tempRoot(), 'jobs'));
    await store.init();
    const hosts = new Set<string>();
    server = createServer(createApp(store, hosts));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    hosts.add(`127.0.0.1:${port}`);
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(storeRoot, { recursive: true, force: true });
  });

  /** Lee el stream SSE hasta que el trabajo termina y devuelve la foto final del estado. */
  async function waitUntilDone(id: string): Promise<JobSnapshot> {
    const response = await fetch(`${base}/api/jobs/${id}/events`);
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let finished = false;
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) throw new Error('El stream SSE se cerró antes de terminar.');
      buffer += value;
      const events = buffer.split('\n\n');
      buffer = events.pop()!;
      for (const raw of events) {
        if (!raw.startsWith('data: ')) continue;
        const event = JSON.parse(raw.slice(6)) as { type: string; status?: string; job?: JobSnapshot };
        const status = event.type === 'snapshot' ? event.job?.status : event.status;
        if (status === 'done' || status === 'failed') finished = true;
      }
    }
    await reader.cancel();
    // El snapshot inicial de una nueva conexión trae el estado completo.
    const snapshot = await fetch(`${base}/api/jobs/${id}/events`);
    const first = (await snapshot.body!.pipeThrough(new TextDecoderStream()).getReader().read()).value!;
    return (JSON.parse(first.slice(6).trim()) as { job: JobSnapshot }).job;
  }

  async function createJob(): Promise<JobSnapshot> {
    const response = await fetch(`${base}/api/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ imageFormat: 'webp' }),
    });
    return (await response.json()) as JobSnapshot;
  }

  it('sirve la interfaz', async () => {
    const response = await fetch(base);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Mesa de luz');
  });

  it('rechaza hosts ajenos y rutas fuera de la carpeta web', async () => {
    const status = await new Promise<number>((resolve) => {
      get(base, { headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode ?? 0)).end();
    });
    expect(status).toBe(403);
  });

  /** Petición HTTP cruda: fetch normaliza "..", así que no sirve para probar traversal. */
  function rawRequest(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const req = request(`${base}${path}`, { method, headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.end(body);
    });
  }

  it('no sale de la carpeta web ni con rutas codificadas', async () => {
    expect(await rawRequest('GET', '/..%2fpackage.json')).toBe(404);
    expect(await rawRequest('GET', '/../package.json')).toBe(404);
    expect(await rawRequest('GET', '/%E0%A4%A')).toBe(400);
  });

  it('rechaza que otra web cree trabajos', async () => {
    const json = { 'Content-Type': 'application/json' };
    expect(await rawRequest('POST', '/api/jobs', { ...json, Origin: 'https://evil.example' }, '{}')).toBe(403);
    expect(await rawRequest('POST', '/api/jobs', { ...json, 'Sec-Fetch-Site': 'cross-site' }, '{}')).toBe(403);
    expect(await rawRequest('POST', '/api/jobs', { 'Content-Type': 'text/plain' }, '{}')).toBe(415);
  });

  it('no empieza a procesar mientras un archivo se está subiendo', async () => {
    const job = await createJob();
    const heic = await readFile(path.join(FIXTURES, 'iphone-p3.heic'));
    const upload = request(`${base}/api/jobs/${job.id}/files?name=foto.heic`, { method: 'PUT', headers: { 'Content-Length': heic.length } });
    const uploaded = new Promise<number>((resolve) => upload.on('response', (res) => resolve(res.statusCode ?? 0)));
    upload.write(heic.subarray(0, 1000));
    await new Promise((r) => setTimeout(r, 100));

    expect((await fetch(`${base}/api/jobs/${job.id}/start`, { method: 'POST' })).status).toBe(409);
    upload.end(heic.subarray(1000));
    expect(await uploaded).toBe(201);
    expect((await fetch(`${base}/api/jobs/${job.id}/start`, { method: 'POST' })).status).toBe(202);
    expect((await waitUntilDone(job.id)).files[0]).toMatchObject({ status: 'optimized' });
  });

  it('sirve los archivos optimizados con una política que impide ejecutar scripts', async () => {
    const job = await createJob();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><script>alert(1)</script><rect width="10" height="10"/></svg>';
    await fetch(`${base}/api/jobs/${job.id}/files?name=logo.svg`, { method: 'PUT', body: svg });
    await fetch(`${base}/api/jobs/${job.id}/start`, { method: 'POST' });
    await waitUntilDone(job.id);

    const response = await fetch(`${base}/api/jobs/${job.id}/output/logo.svg`);
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await response.text()).not.toContain('<script');
  });

  it('sube, procesa y entrega un ZIP con los archivos optimizados', async () => {
    const job = await createJob();

    const heic = await readFile(path.join(FIXTURES, 'iphone-p3.heic'));
    const upload = await fetch(`${base}/api/jobs/${job.id}/files?name=${encodeURIComponent('../IMG_0001.HEIC')}`, { method: 'PUT', body: heic });
    expect(await upload.json()).toMatchObject({ source: 'IMG_0001.HEIC', kind: 'heic' });

    // La descarga no está disponible hasta terminar.
    expect((await fetch(`${base}/api/jobs/${job.id}/download`)).status).toBe(409);
    expect((await fetch(`${base}/api/jobs/${job.id}/start`, { method: 'POST' })).status).toBe(202);

    const done = await waitUntilDone(job.id);
    expect(done.status).toBe('done');
    expect(done.files[0]).toMatchObject({ status: 'optimized', report: { output: 'IMG_0001.webp', format: 'webp' } });

    const preview = await fetch(`${base}/api/jobs/${job.id}/output/IMG_0001.webp`);
    expect(preview.headers.get('content-type')).toBe('image/webp');

    const zip = await fetch(`${base}/api/jobs/${job.id}/download`);
    expect(zip.headers.get('content-type')).toBe('application/zip');
    const bytes = Buffer.from(await zip.arrayBuffer());
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(bytes.includes('IMG_0001.webp')).toBe(true);
    expect(bytes.includes('manifest.json')).toBe(true);
  });
});
