import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import pLimit from 'p-limit';
import { DEFAULT_OPTIONS, type ImageFormatOption, type Preset, type VideoCodec } from '../config.js';
import { classify, type AssetKind } from '../formats.js';
import { optimizeDirectory, type FileReport, type RunReport } from '../optimizer.js';

export type JobFileStatus = 'uploaded' | 'processing' | FileReport['status'];

export interface JobFile {
  source: string;
  kind: AssetKind;
  status: JobFileStatus;
  /** Avance 0-1 mientras se procesa (solo videos). */
  progress?: number;
  report?: FileReport;
}

export interface JobSettings {
  preset: Preset;
  imageFormat: ImageFormatOption;
  videoCodec: VideoCodec;
  muteVideo: boolean;
}

export type JobStatus = 'uploading' | 'processing' | 'done' | 'failed';

export interface JobSnapshot {
  id: string;
  status: JobStatus;
  settings: JobSettings;
  files: JobFile[];
  totals?: RunReport['totals'];
  error?: string;
}

export type JobEvent =
  | { type: 'file'; file: JobFile }
  | { type: 'status'; status: JobStatus; totals?: RunReport['totals']; error?: string };

export interface Job {
  id: string;
  /** Última subida, avance o descarga: la limpieza cuenta desde aquí. */
  lastActivity: number;
  /** Subidas en curso; no se puede empezar a procesar mientras haya alguna. */
  activeUploads: number;
  inputDir: string;
  outputDir: string;
  settings: JobSettings;
  status: JobStatus;
  files: Map<string, JobFile>;
  totals?: RunReport['totals'];
  error?: string;
  events: EventEmitter;
}

const ROOT_PREFIX = 'web-resources-optimizer-';
/** Los trabajos (originales + optimizados) se borran tras este tiempo sin actividad. */
const JOB_TTL_MS = 2 * 60 * 60 * 1000;
/** Carpetas de instancias anteriores que se cerraron mal. */
const STALE_ROOT_MS = 24 * 60 * 60 * 1000;

const SETTING_CHOICES = {
  preset: ['small', 'balanced', 'high'],
  imageFormat: ['auto', 'avif', 'webp', 'jpeg', 'png'],
  videoCodec: ['h264', 'vp9', 'av1'],
} as const;

/** Valida la configuración enviada por el navegador; lo desconocido cae al valor por defecto. */
export function parseSettings(input: Record<string, unknown>): JobSettings {
  const pick = <K extends keyof typeof SETTING_CHOICES>(key: K, fallback: (typeof SETTING_CHOICES)[K][number]) => {
    const value = input[key];
    return (SETTING_CHOICES[key] as readonly unknown[]).includes(value) ? (value as typeof fallback) : fallback;
  };
  return {
    preset: pick('preset', DEFAULT_OPTIONS.preset),
    imageFormat: pick('imageFormat', DEFAULT_OPTIONS.imageFormat),
    videoCodec: pick('videoCodec', DEFAULT_OPTIONS.videoCodec),
    muteVideo: input.muteVideo === true,
  };
}

/** Nombre de archivo seguro: sin rutas, sin caracteres raros y sin ocultos. */
export function safeFileName(name: string): string {
  const base = path.basename(name.replaceAll('\\', '/')).normalize('NFC');
  const cleaned = base.replace(/[^\p{L}\p{N}._ ()-]/gu, '_');
  // Se recorta por caracteres (no unidades UTF-16) y después se quitan los puntos iniciales:
  // un nombre que empieza con "." quedaría oculto y no se procesaría.
  return [...cleaned].slice(-180).join('').replace(/^[.\s]+/, '').trim() || 'archivo';
}

export class JobStore {
  private readonly jobs = new Map<string, Job>();
  /** Un trabajo a la vez: cada uno ya aprovecha todos los núcleos. */
  private readonly queue = pLimit(1);

  private root: string;

  /**
   * Sin `root`, cada instancia usa su propia carpeta temporal: abrir la app dos
   * veces no borra los trabajos de la otra. Con `root` (tests) se usa esa carpeta.
   */
  constructor(private readonly fixedRoot?: string) {
    this.root = fixedRoot ?? '';
  }

  async init(): Promise<void> {
    if (this.fixedRoot) {
      await rm(this.fixedRoot, { recursive: true, force: true });
      await mkdir(this.fixedRoot, { recursive: true });
    } else {
      await this.removeStaleRoots();
      this.root = await mkdtemp(path.join(os.tmpdir(), ROOT_PREFIX));
    }
    setInterval(() => void this.cleanup(), 10 * 60 * 1000).unref();
  }

  /** Borra todos los trabajos de esta instancia (al cerrar el servidor). */
  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  private async removeStaleRoots(): Promise<void> {
    const tmp = os.tmpdir();
    const entries = await readdir(tmp).catch(() => [] as string[]);
    await Promise.all(
      entries
        .filter((name) => name.startsWith(ROOT_PREFIX))
        .map(async (name) => {
          const dir = path.join(tmp, name);
          const info = await stat(dir).catch(() => undefined);
          if (info && Date.now() - info.mtimeMs > STALE_ROOT_MS) await rm(dir, { recursive: true, force: true });
        }),
    );
  }

  async create(settings: JobSettings): Promise<Job> {
    const id = randomUUID();
    const dir = path.join(this.root, id);
    const job: Job = {
      id,
      lastActivity: Date.now(),
      activeUploads: 0,
      inputDir: path.join(dir, 'input'),
      outputDir: path.join(dir, 'export'),
      settings,
      status: 'uploading',
      files: new Map(),
      events: new EventEmitter(),
    };
    job.events.setMaxListeners(50);
    await mkdir(job.inputDir, { recursive: true });
    this.jobs.set(id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Reserva un nombre único (sin distinguir mayúsculas) para un archivo subido. */
  reserveName(job: Job, requested: string): string {
    const name = safeFileName(requested);
    const ext = path.extname(name);
    const stem = name.slice(0, name.length - ext.length);
    const taken = new Set([...job.files.keys()].map((k) => k.toLowerCase()));
    let candidate = name;
    for (let i = 2; taken.has(candidate.toLowerCase()); i++) candidate = `${stem} (${i})${ext}`;
    job.files.set(candidate, { source: candidate, kind: classify(candidate), status: 'uploaded' });
    return candidate;
  }

  snapshot(job: Job): JobSnapshot {
    return {
      id: job.id,
      status: job.status,
      settings: job.settings,
      files: [...job.files.values()],
      totals: job.totals,
      error: job.error,
    };
  }

  touch(job: Job): void {
    job.lastActivity = Date.now();
  }

  start(job: Job): void {
    if (job.status !== 'uploading') return;
    if (job.activeUploads > 0) throw new Error('Todavía hay archivos subiéndose.');
    this.setStatus(job, 'processing');
    void this.queue(() => this.process(job));
  }

  private async process(job: Job): Promise<void> {
    const update = (source: string, patch: Partial<JobFile>) => {
      const file = job.files.get(source);
      if (!file) return;
      Object.assign(file, patch);
      this.touch(job);
      job.events.emit('event', { type: 'file', file } satisfies JobEvent);
    };

    try {
      const report = await optimizeDirectory(
        {
          ...DEFAULT_OPTIONS,
          ...job.settings,
          inputDir: job.inputDir,
          outputDir: job.outputDir,
          concurrency: Math.max(1, Math.floor(os.availableParallelism() / 2)),
        },
        {
          onFileStart: (source) => update(source, { status: 'processing', progress: 0 }),
          onFileProgress: (source, progress) => update(source, { progress }),
          onFileDone: (report) => update(report.source, { status: report.status, progress: 1, report }),
        },
      );
      job.totals = report.totals;
      this.setStatus(job, 'done');
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error);
      this.setStatus(job, 'failed');
    }
  }

  private setStatus(job: Job, status: JobStatus): void {
    job.status = status;
    this.touch(job);
    job.events.emit('event', { type: 'status', status, totals: job.totals, error: job.error } satisfies JobEvent);
  }

  private async cleanup(): Promise<void> {
    const now = Date.now();
    for (const job of this.jobs.values()) {
      const busy = job.status === 'processing' || job.activeUploads > 0;
      if (!busy && now - job.lastActivity > JOB_TTL_MS) {
        this.jobs.delete(job.id);
        await rm(path.dirname(job.inputDir), { recursive: true, force: true });
      }
    }
  }
}
