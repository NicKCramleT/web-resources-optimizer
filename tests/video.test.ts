import { spawnSync } from 'node:child_process';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import ffprobeInstaller from '@ffprobe-installer/ffprobe';
import { describe, expect, it } from 'vitest';
import { optimizeVideo, type VideoJob } from '../src/processors/video.js';
import { ffmpeg, QUALITY, tempDir } from './helpers.js';

function probeVideo(file: string): Record<string, string> {
  const result = spawnSync(ffprobeInstaller.path, [
    '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height,avg_frame_rate,pix_fmt,color_transfer',
    '-of', 'default=noprint_wrappers=1', file,
  ]);
  return Object.fromEntries(result.stdout.toString().trim().split('\n').map((line) => line.split('=') as [string, string]));
}

function job(inputPath: string, outputBase: string, overrides: Partial<VideoJob> = {}): VideoJob {
  return { inputPath, outputBase, codec: 'h264', quality: QUALITY, maxSize: 1920, mute: false, poster: true, ...overrides };
}

describe('optimizeVideo', () => {
  it('recodifica a H.264 MP4, limita resolución y fps, y genera poster', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'clip.mov');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=2560x1440:r=60:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-c:v', 'libx264', '-crf', '10', '-c:a', 'aac', '-shortest', input]);

    const result = await optimizeVideo(job(input, path.join(dir, 'clip')));
    const info = probeVideo(result.outputPath);

    expect(result.outputPath).toBe(path.join(dir, 'clip.mp4'));
    expect(info).toMatchObject({ codec_name: 'h264', width: '1920', height: '1080', avg_frame_rate: '30/1', pix_fmt: 'yuv420p' });
    expect(result.bytes).toBeLessThan((await stat(input)).size);
    expect(result.duration).toBeCloseTo(1, 0);
    expect(result.poster).toMatchObject({ format: 'webp', width: 1920, height: 1080 });
  });

  it('convierte video HDR (HLG, como graba el iPhone) a SDR bt709', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'IMG_0001.MOV');
    ffmpeg([
      '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=1', '-c:v', 'libx265', '-pix_fmt', 'yuv420p10le',
      '-color_trc', 'arib-std-b67', '-color_primaries', 'bt2020', '-colorspace', 'bt2020nc', '-tag:v', 'hvc1', input,
    ]);

    const result = await optimizeVideo(job(input, path.join(dir, 'out'), { poster: false }));
    const info = probeVideo(result.outputPath);

    expect(info).toMatchObject({ codec_name: 'h264', pix_fmt: 'yuv420p', color_transfer: 'bt709' });
    expect(result.poster).toBeUndefined();
  });

  it('un MP4 H.264 ya liviano se re-empaqueta sin metadatos en vez de crecer', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'liviano.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=24:d=1', '-c:v', 'libx264', '-crf', '45', '-metadata', 'location=+40.4+003.7/', input]);

    const result = await optimizeVideo(job(input, path.join(dir, 'out'), { poster: false }));
    const tags = spawnSync(ffprobeInstaller.path, ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', result.outputPath]);

    expect(result.copied).toBe(true);
    expect(result.bytes).toBeLessThanOrEqual((await stat(input)).size);
    expect(tags.stdout.toString()).not.toContain('location');
  });

  it('un MP4 en HEVC siempre se recodifica a H.264 aunque pese poco', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'hevc.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=24:d=1', '-c:v', 'libx265', '-crf', '45', '-tag:v', 'hvc1', input]);

    const result = await optimizeVideo(job(input, path.join(dir, 'out'), { poster: false }));

    expect(result.copied).toBe(false);
    expect(probeVideo(result.outputPath).codec_name).toBe('h264');
  });

  it('genera WebM VP9 sin audio cuando se pide', async () => {
    const dir = await tempDir();
    const input = path.join(dir, 'clip.mp4');
    ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=24:d=1', '-f', 'lavfi', '-i', 'sine=d=1', '-shortest', input]);

    const result = await optimizeVideo(job(input, path.join(dir, 'out'), { codec: 'vp9', mute: true, poster: false }));

    expect(result.outputPath.endsWith('.webm')).toBe(true);
    expect(probeVideo(result.outputPath).codec_name).toBe('vp9');
    const audio = spawnSync(ffprobeInstaller.path, ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv', result.outputPath]);
    expect(audio.stdout.toString().trim()).toBe('');
  });
});
