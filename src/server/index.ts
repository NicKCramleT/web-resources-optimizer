#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { APP_ID, createApp } from './app.js';
import { JobStore } from './jobs.js';

const HOST = '127.0.0.1';
const FIRST_PORT = Number(process.env.PORT ?? 4747);

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      // Si el puerto está ocupado por otro programa se prueba el siguiente.
      if (error.code === 'EADDRINUSE' && port < FIRST_PORT + 20) resolve(listen(server, port + 1));
      else reject(error);
    });
    server.listen(port, HOST, () => resolve(port));
  });
}

function openBrowser(url: string): void {
  if (process.env.NO_OPEN) return;
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(command, [url], { stdio: 'ignore', detached: true }).on('error', () => undefined).unref();
}

/** true si la app ya está corriendo en ese puerto (p. ej. se abrió dos veces). */
async function isAlreadyRunning(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    return ((await response.json()) as { app?: string }).app === APP_ID;
  } catch {
    return false;
  }
}

if (await isAlreadyRunning(FIRST_PORT)) {
  const url = `http://localhost:${FIRST_PORT}`;
  console.log(`\n  El optimizador ya estaba abierto en ${url}\n`);
  openBrowser(url);
  process.exit(0);
}

const store = new JobStore();
await store.init();

const hosts = new Set<string>();
const server = createServer(createApp(store, hosts));
// Sin timeout de petición: un video grande puede tardar en subir.
server.requestTimeout = 0;
const port = await listen(server, FIRST_PORT);
for (const host of ['localhost', '127.0.0.1']) hosts.add(`${host}:${port}`);

// Al cerrar (Ctrl+C o cerrar la Terminal) se borran los archivos temporales.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.once(signal, () => {
    server.closeAllConnections();
    void store.dispose().finally(() => process.exit(0));
  });
}

const url = `http://localhost:${port}`;
console.log(`\n  Optimizador listo en ${url}\n  (Ctrl+C para cerrar)\n`);
openBrowser(url);
