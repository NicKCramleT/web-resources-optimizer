# web-resources-optimizer

CLI que toma una carpeta con imágenes y videos (incluidas las fotos **HEIC** y los videos **HDR** del iPhone) y genera en `export/` versiones listas para la web: el menor peso posible sin pérdida visible, sin metadatos privados y con dimensiones razonables.

## Interfaz web (lo más fácil)

```bash
pnpm install
pnpm web
```

Se abre el navegador en `http://localhost:4747`. Arrastra tus fotos y videos (o usa **Elegir archivos**), elige la calidad y pulsa **Optimizar**. Cada archivo muestra su avance y, al terminar, el porcentaje que bajó de peso. Si haces clic en una foto, se abre una comparación antes/después. **Descargar todo (.zip)** baja el resultado completo con su `manifest.json`.

En macOS también puedes hacer doble clic en **`Abrir optimizador.command`**: instala las dependencias la primera vez y abre la interfaz. Para cerrarla, cierra esa ventana de Terminal o pulsa Ctrl+C.

- Todo se procesa en tu computador; el servidor solo escucha en `localhost`.
- Los trabajos se guardan en la carpeta temporal del sistema. Se borran al cerrar el optimizador o tras 2 horas sin uso, así que descarga el ZIP antes. Si lo abres dos veces, la segunda vez solo se abre el navegador en la instancia que ya está corriendo.
- Opcional: `PORT=5000 pnpm web` cambia el puerto, y `NO_OPEN=1` evita que se abra el navegador.

## Línea de comandos

```bash
pnpm install
# 1. Copia tus archivos en ./input (se respetan las subcarpetas)
# 2. Ejecuta:
pnpm optimize
# 3. Los archivos optimizados quedan en ./export, junto a export/manifest.json
```

Con otras carpetas:

```bash
pnpm optimize ~/Desktop/fotos-viaje -o ~/Desktop/fotos-web
```

Ejemplo de salida:

```
✔ foto.jpg → foto.avif 2560×1920  1.4 MB → 95.2 KB (-93.4%)
✔ sub/IMG_0001.HEIC → sub/IMG_0001.avif 2560×1920  568.2 KB → 92.3 KB (-83.8%)
✔ anim.gif → anim.webp 320×240  105.8 KB → 14.7 KB (-86.1%)
✔ video4k.mov → video4k.mp4 1920×1080  33.6 MB → 460.9 KB (-98.7%) + poster 28.6 KB
· notas.txt  (omitido: formato no soportado)

9 listos, 1 omitidos, 0 con error · 37.0 MB → 1.3 MB (-96.4%) · 5.2 s
```

Requisitos: Node.js ≥ 22.12 y pnpm. No hace falta instalar ffmpeg ni libvips: los binarios vienen como dependencias de npm.

## Qué hace con cada tipo de archivo

| Entrada | Salida (por defecto) | Proceso |
|---|---|---|
| JPG, PNG, TIFF, BMP, WebP, AVIF | **AVIF o WebP, el que pese menos** | Corrige la orientación EXIF, convierte a sRGB, elimina metadatos (GPS, modelo de cámara), redimensiona a un máximo de 2560 px por lado y quita el canal alfa si no se usa. En PNG/GIF/TIFF/BMP también prueba WebP sin pérdida, que suele ganar en logos y capturas de pantalla. |
| HEIC / HEIF (iPhone) | AVIF o WebP | Igual que arriba, y además lee el perfil de color **Display P3** del iPhone y lo convierte bien a sRGB. Sin ese paso, las fotos se ven desaturadas en el navegador. |
| GIF animado | WebP animado | Mantiene todos los cuadros y suele pesar entre 5 y 10 veces menos. |
| SVG | SVG minificado | SVGO multipass; conserva `viewBox` y `<title>` y elimina `<script>`. |
| MOV, MP4, MKV, AVI, WebM… | **MP4 H.264** + poster `.webp` | Resolución máxima de 1920 px, máximo 30 fps, HDR (HLG/Dolby Vision del iPhone) convertido a SDR, audio AAC 128k, `faststart` para que empiece a reproducirse antes de descargarse completo, sin metadatos de ubicación. |
| Otros (`.txt`, fuentes, `.json`) | Se omiten | Con `--copy-unsupported` se copian sin cambios. |

Protecciones:

- En modo `auto`, si el original ya es apto para web (JPG, PNG, GIF, WebP, AVIF), no hubo que redimensionarlo y ninguna conversión lo mejora, **se conserva** pero sin EXIF/GPS (se quitan sin recodificar). Así el resultado nunca pesa más que el original. Con un MP4/WebM que ya cumple todo (mismo códec, SDR, ≤ 30 fps) pasa lo mismo: solo se re-empaqueta sin metadatos.
- Un PNG animado (APNG) se conserva tal cual, porque convertirlo lo dejaría en un solo cuadro. Si pides `-f jpeg` o `-f png` para un GIF animado, el GIF también se conserva.
- Si dos archivos terminarían con el mismo nombre (`foto.jpg` y `foto.png` → `foto.avif`), el segundo pasa a llamarse `foto-png.avif`.
- Un archivo dañado no detiene el proceso: queda marcado con `✖` en el reporte y el comando termina con código 1.

### ¿Por qué AVIF/WebP y H.264?

- **AVIF** suele pesar entre 20 % y 50 % menos que WebP en fotos, y **WebP** gana en gráficos simples. Ambos funcionan en todos los navegadores actuales (Chrome, Safari 16+, Firefox, Edge). Por eso el modo `auto` codifica los dos y conserva el más liviano.
- **H.264 en MP4** se reproduce en cualquier dispositivo. Si solo te interesan navegadores modernos, `--video-codec av1` pesa entre 30 % y 50 % menos, pero tarda más en codificar.

## Opciones

| Opción | Valor por defecto | Descripción |
|---|---|---|
| `[input]` | `input` | Carpeta con los originales |
| `-o, --output <dir>` | `export` | Carpeta de salida |
| `-f, --format` | `auto` | `auto`, `avif`, `webp`, `jpeg` o `png`. Para máxima compatibilidad (por ejemplo, emails) usa `jpeg` |
| `-p, --preset` | `balanced` | `small` (prioriza peso), `balanced` o `high` (prioriza calidad) |
| `-q, --quality <1-100>` | — | Calidad manual de imagen; reemplaza la del preset |
| `--max-size <px>` | `2560` | Lado mayor máximo de las imágenes. Nunca se agranda una imagen |
| `--video-codec` | `h264` | `h264` (.mp4), `vp9` (.webm) o `av1` (.mp4) |
| `--max-video-size <px>` | `1920` | Lado mayor máximo de los videos |
| `--mute` | — | Elimina el audio (útil para videos de fondo con `autoplay muted`) |
| `--no-poster` | — | No genera la imagen de portada de los videos |
| `--copy-unsupported` | — | Copia los archivos no multimedia |
| `--clean` | — | Vacía la carpeta de salida antes de empezar. Por seguridad, solo lo hace si está vacía o es un export anterior (tiene `manifest.json`) |
| `-c, --concurrency <n>` | núcleos / 2 | Imágenes procesadas en paralelo. Los videos se procesan de a uno |
| `--dry-run` | — | Muestra qué haría, sin escribir nada |

Variables de entorno: `FFMPEG_PATH` y `FFPROBE_PATH` permiten usar binarios propios en lugar de los incluidos.

## El manifest

`export/manifest.json` registra cada archivo con rutas relativas: ruta de salida, formato, peso antes y después, y **ancho y alto**. Conviene usar esas dimensiones en el HTML para evitar saltos de layout (CLS):

```html
<img src="/img/foto.avif" width="2560" height="1920" loading="lazy" decoding="async" alt="…">

<video src="/video/video4k.mp4" poster="/video/video4k.poster.webp"
       width="1920" height="1080" controls playsinline preload="metadata"></video>
```

## Desarrollo

```bash
pnpm test            # Vitest: unitarios + integración con imágenes y videos reales
pnpm typecheck
pnpm build       # Compila a dist/ (binario `web-optimize`)
```

```
src/
├── cli.ts              # Interfaz de línea de comandos (commander)
├── optimizer.ts        # Recorre la carpeta, planifica salidas, concurrencia, manifest
├── config.ts           # Presets de calidad y opciones por defecto
├── formats.ts          # Clasificación de archivos por extensión
├── server/
│   ├── index.ts        # Arranca el servidor local y abre el navegador
│   ├── app.ts          # Rutas HTTP: subida, SSE de progreso, ZIP, vistas previas
│   └── jobs.ts         # Trabajos en memoria, cola y limpieza
├── processors/
│   ├── image.ts        # sharp/libvips: AVIF, WebP, mozjpeg, PNG con paleta
│   ├── heic.ts         # Decodificación HEIC (libheif WASM) + perfil de color
│   ├── svg.ts          # SVGO
│   └── video.ts        # ffmpeg: H.264/VP9/AV1, tone-mapping HDR, poster
└── utils/
web/                    # Interfaz (HTML/CSS/JS sin build)
```

### Notas

- El proyecto usa **pnpm**. pnpm bloquea los scripts de instalación hasta que se aprueban. Los que hacen falta (`ffmpeg-static` descarga el binario de ffmpeg, `@ffprobe-installer/*` marca su binario como ejecutable y `esbuild` lo usa `tsx`) ya están aprobados en `pnpm-workspace.yaml` (`allowBuilds`). Si `pnpm install` muestra `ERR_PNPM_IGNORED_BUILDS` con otro paquete, agrégalo ahí.
- La carpeta de salida no puede ser la de entrada ni contenerla. Al revés sí se permite: `web-optimize . -o export` ignora la propia carpeta `export`.
- De un HEIC con varias imágenes (ráfagas) solo se procesa la principal. El video de una Live Photo es un `.MOV` aparte y se procesa como video.
