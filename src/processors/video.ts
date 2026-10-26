import { spawn } from 'node:child_process';
import { rename, rm, stat, writeFile } from 'node:fs/promises';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import ffmpegStatic from 'ffmpeg-static';
import sharp from 'sharp';
import type { QualitySettings, VideoCodec } from '../config.js';
import { extensionOf } from '../formats.js';
import type { ProcessedAsset } from './types.js';

export interface VideoJob {
  inputPath: string;
  outputBase: string;
  codec: VideoCodec;
  quality: QualitySettings;
  maxSize: number;
  mute: boolean;
  poster: boolean;
  /** Avance de la codificación entre 0 y 1. */
  onProgress?: (fraction: number) => void;
}

interface ProbeStream {
  index: number;
  codec_type: string;
  codec_name?: string;
  disposition?: { attached_pic?: number };
  width?: number;
  height?: number;
  color_transfer?: string;
  avg_frame_rate?: string;
}

interface ProbeResult {
  streams: ProbeStream[];
  format: { duration?: string };
}

/** Más de 30 fps rara vez aporta en web y casi duplica el peso. */
const MAX_FPS = 30;
/** Transferencias HDR (HLG de iPhone, PQ/HDR10) que hay que llevar a SDR. */
const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084']);

const CODEC_ARGS: Record<VideoCodec, { ext: string; codecName: string; video: (crf: number) => string[]; audio: string[] }> = {
  h264: {
    ext: '.mp4',
    codecName: 'h264',
    video: (crf) => ['-c:v', 'libx264', '-preset', 'slow', '-crf', `${crf}`, '-profile:v', 'high', '-movflags', '+faststart'],
    audio: ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'],
  },
  vp9: {
    ext: '.webm',
    codecName: 'vp9',
    video: (crf) => ['-c:v', 'libvpx-vp9', '-crf', `${crf}`, '-b:v', '0', '-row-mt', '1', '-deadline', 'good', '-cpu-used', '2'],
    audio: ['-c:a', 'libopus', '-b:a', '96k', '-ac', '2'],
  },
  av1: {
    ext: '.mp4',
    codecName: 'av1',
    video: (crf) => ['-c:v', 'libsvtav1', '-crf', `${crf}`, '-preset', '6', '-movflags', '+faststart'],
    audio: ['-c:a', 'aac', '-b:a', '128k', '-ac', '2'],
  },
};

function run(binary: string, args: string[], onStdout?: (chunk: string) => void): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (onStdout ? onStdout(chunk.toString()) : stdout.push(chunk)));
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(stdout));
      else reject(new Error(`${binary.split('/').pop()} terminó con código ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

/** Binarios incluidos vía npm; se pueden reemplazar con FFMPEG_PATH / FFPROBE_PATH. */
function ffmpegBinary(): string {
  const binary = process.env.FFMPEG_PATH ?? (ffmpegStatic as unknown as string | null);
  if (!binary) throw new Error('No se encontró ffmpeg para esta plataforma; define FFMPEG_PATH.');
  return binary;
}

function ffprobeBinary(): string {
  return process.env.FFPROBE_PATH ?? ffprobeInstaller.path;
}

async function probe(file: string): Promise<ProbeResult> {
  const output = await run(ffprobeBinary(), ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  return JSON.parse(output.toString()) as ProbeResult;
}

function parseFrameRate(rate?: string): number {
  const [num, den] = (rate ?? '0/1').split('/').map(Number);
  return num && den ? num / den : 0;
}

function buildFilters(stream: ProbeStream, maxSize: number): string {
  const filters = [
    `scale=w='min(iw,${maxSize})':h='min(ih,${maxSize})':force_original_aspect_ratio=decrease:force_divisible_by=2`,
  ];
  if (parseFrameRate(stream.avg_frame_rate) > MAX_FPS + 1) filters.push(`fps=${MAX_FPS}`);
  if (isHdr(stream)) {
    filters.push(
      'zscale=t=linear:npl=100',
      'format=gbrpf32le',
      'zscale=p=bt709',
      'tonemap=tonemap=hable:desat=0',
      'zscale=t=bt709:m=bt709:r=tv',
    );
  }
  filters.push('format=yuv420p');
  return filters.join(',');
}

async function createPoster(videoPath: string, outputBase: string, quality: QualitySettings): Promise<NonNullable<ProcessedAsset['poster']>> {
  const frame = await run(ffmpegBinary(), [
    '-v', 'error', '-i', videoPath, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-',
  ]);
  const { data, info } = await sharp(frame).webp({ quality: quality.webp, effort: 6 }).toBuffer({ resolveWithObject: true });
  const outputPath = `${outputBase}.poster.webp`;
  await writeFile(outputPath, data);
  return { outputPath, format: 'webp', bytes: data.length, width: info.width, height: info.height };
}

/** Convierte la salida de `-progress pipe:1` de ffmpeg en una fracción 0-1. */
function progressParser(durationSec: number, onProgress: (fraction: number) => void): (chunk: string) => void {
  let pending = '';
  let last = 0;
  return (chunk) => {
    // Un chunk puede cortar una línea a la mitad: la última se guarda para el siguiente.
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      const match = /^out_time_us=(\d+)/.exec(line);
      if (!match || durationSec <= 0) continue;
      const fraction = Math.min(1, Number(match[1]) / 1e6 / durationSec);
      if (fraction > last) onProgress((last = fraction));
    }
  };
}

function isHdr(stream: ProbeStream): boolean {
  return stream.color_transfer !== undefined && HDR_TRANSFERS.has(stream.color_transfer);
}

/** Pista de video principal (ignora carátulas embebidas en .m4v/.mkv). */
function mainVideoStream(streams: ProbeStream[]): ProbeStream | undefined {
  return streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
}

/**
 * Recodifica un video para web: códec universal, sin metadatos (ubicación),
 * HDR convertido a SDR, resolución y fps limitados, y `faststart` para que
 * empiece a reproducirse antes de descargarse completo.
 */
export async function optimizeVideo(job: VideoJob): Promise<ProcessedAsset> {
  const info = await probe(job.inputPath);
  const video = mainVideoStream(info.streams);
  if (!video) throw new Error('El archivo no contiene una pista de video.');
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  const codec = CODEC_ARGS[job.codec];
  const outputPath = job.outputBase + codec.ext;
  // Se escribe a un temporal para no dejar archivos a medias si ffmpeg falla.
  const tempPath = `${job.outputBase}.tmp${codec.ext}`;
  const audioArgs = audio && !job.mute ? ['-map', `0:${audio.index}`] : ['-an'];

  try {
    await run(ffmpegBinary(), [
      '-y', '-v', 'error', '-i', job.inputPath,
      '-map', `0:${video.index}`, ...audioArgs, '-map_metadata', '-1', '-map_chapters', '-1', '-sn', '-dn',
      '-vf', buildFilters(video, job.maxSize),
      ...codec.video(job.quality.crf[job.codec]),
      ...(audio && !job.mute ? codec.audio : []),
      ...(job.onProgress ? ['-progress', 'pipe:1', '-nostats'] : []),
      tempPath,
    ], job.onProgress && progressParser(Number(info.format.duration), job.onProgress));

    const out = await probe(tempPath);
    const outVideo = mainVideoStream(out.streams);
    let bytes = (await stat(tempPath)).size;
    let note: string | undefined;

    // Un video que ya cumple todo (mismo códec y contenedor, SDR, ≤30 fps, mismo tamaño)
    // puede crecer al recodificar: en ese caso solo se re-empaqueta sin metadatos.
    const alreadyCompliant =
      extensionOf(job.inputPath) === codec.ext &&
      video.codec_name === codec.codecName &&
      !isHdr(video) &&
      parseFrameRate(video.avg_frame_rate) <= MAX_FPS + 1 &&
      !(job.mute && audio) &&
      outVideo?.width === video.width &&
      outVideo?.height === video.height;
    if (alreadyCompliant && bytes >= (await stat(job.inputPath)).size) {
      await run(ffmpegBinary(), [
        '-y', '-v', 'error', '-i', job.inputPath,
        '-map', `0:${video.index}`, ...audioArgs, '-c', 'copy', '-map_metadata', '-1', '-map_chapters', '-1',
        ...(codec.ext === '.mp4' ? ['-movflags', '+faststart'] : []),
        tempPath,
      ]);
      bytes = (await stat(tempPath)).size;
      note = 'el original ya estaba optimizado; se conservó sin metadatos';
    }
    await rename(tempPath, outputPath);

    const duration = Number(out.format.duration ?? info.format.duration);
    return {
      outputPath,
      format: job.codec,
      bytes,
      width: outVideo?.width,
      height: outVideo?.height,
      duration: Number.isFinite(duration) ? Math.round(duration * 100) / 100 : undefined,
      poster: job.poster ? await createPoster(outputPath, job.outputBase, job.quality) : undefined,
      copied: note !== undefined,
      note,
    };
  } finally {
    await rm(tempPath, { force: true });
  }
}
