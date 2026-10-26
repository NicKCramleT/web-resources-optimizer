export type ImageFormat = 'avif' | 'webp' | 'jpeg' | 'png';
export type ImageFormatOption = ImageFormat | 'auto';
export type VideoCodec = 'h264' | 'vp9' | 'av1';
export type Preset = 'small' | 'balanced' | 'high';

export interface QualitySettings {
  avif: number;
  webp: number;
  jpeg: number;
  /** CRF por códec de video: menor = más calidad y más peso. */
  crf: Record<VideoCodec, number>;
}

/**
 * Valores calibrados para que la diferencia visual sea imperceptible en web
 * con el menor peso posible. AVIF necesita un número de calidad menor que
 * WebP/JPEG para una calidad percibida equivalente.
 */
export const PRESETS: Record<Preset, QualitySettings> = {
  small: { avif: 42, webp: 65, jpeg: 70, crf: { h264: 30, vp9: 38, av1: 40 } },
  balanced: { avif: 52, webp: 76, jpeg: 80, crf: { h264: 26, vp9: 33, av1: 35 } },
  high: { avif: 64, webp: 86, jpeg: 88, crf: { h264: 22, vp9: 28, av1: 30 } },
};

export interface OptimizerOptions {
  inputDir: string;
  outputDir: string;
  /** `auto` prueba AVIF y WebP (y WebP sin pérdida para gráficos) y conserva el más liviano. */
  imageFormat: ImageFormatOption;
  videoCodec: VideoCodec;
  preset: Preset;
  /** Sobrescribe la calidad del preset para imágenes (0-100). */
  quality?: number;
  /** Lado mayor máximo de las imágenes en px (no agranda nunca). */
  maxImageSize: number;
  /** Lado mayor máximo de los videos en px (no agranda nunca). */
  maxVideoSize: number;
  /** Elimina la pista de audio de los videos. */
  muteVideo: boolean;
  /** Genera una imagen `poster` para cada video. */
  videoPoster: boolean;
  /** Copia al export los archivos que no son multimedia (fuentes, JSON, etc.). */
  copyUnsupported: boolean;
  concurrency: number;
  dryRun: boolean;
}

export const DEFAULT_OPTIONS: Omit<OptimizerOptions, 'inputDir' | 'outputDir' | 'concurrency'> = {
  imageFormat: 'auto',
  videoCodec: 'h264',
  preset: 'balanced',
  maxImageSize: 2560,
  maxVideoSize: 1920,
  muteVideo: false,
  videoPoster: true,
  copyUnsupported: false,
  dryRun: false,
};

export function resolveQuality(options: Pick<OptimizerOptions, 'preset' | 'quality'>): QualitySettings {
  const base = PRESETS[options.preset];
  if (options.quality === undefined) return base;
  const q = options.quality;
  // AVIF logra la misma calidad percibida con ~20 puntos menos de calidad nominal.
  return { ...base, webp: q, jpeg: q, avif: Math.max(1, q - 22) };
}
