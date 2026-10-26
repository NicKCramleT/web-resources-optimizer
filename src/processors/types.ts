export interface ProcessedAsset {
  /** Ruta absoluta del archivo generado. */
  outputPath: string;
  format: string;
  bytes: number;
  width?: number;
  height?: number;
  /** Duración en segundos (videos). */
  duration?: number;
  /** Imagen de portada generada para videos. */
  poster?: { outputPath: string; format: string; bytes: number; width: number; height: number };
  /** true si se conservó el original (sin recodificar). */
  copied?: boolean;
  /** Aclaraciones para el reporte (p. ej. se mantuvo el original). */
  note?: string;
}
