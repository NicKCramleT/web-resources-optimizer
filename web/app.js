// Mesa de luz: sube archivos al servidor local, sigue el avance por SSE y descarga el resultado.

const $ = (selector) => document.querySelector(selector);

const table = $('#table');
const slidesEl = $('#slides');
const picker = $('#picker');
const settingsForm = $('#settings');
const tray = $('#tray');
const trayHeadline = $('#trayHeadline');
const trayDetail = $('#trayDetail');
const trayActions = $('#trayActions');
const meter = $('#meter');
const loupe = $('#loupe');
const slideTemplate = $('#slideTemplate');

const UPLOAD_CONCURRENCY = 3;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|mpe?g|3gp|ogv|mts|m2ts)$/i;
const SVG_EXT = /\.svg$/i;

/** @type {'idle' | 'uploading' | 'processing' | 'done' | 'failed'} */
let phase = 'idle';
let job = null;
let events = null;
let nextId = 1;
let reconnecting = false;
/** @type {Map<number, Entry>} */
const entries = new Map();

/**
 * @typedef {{ id: number, file: File, kind: 'image' | 'video', status: string, el: HTMLElement,
 *   source?: string, upload: number, progress?: number, report?: any, previewUrl?: string }} Entry
 */

// ── Formato ────────────────────────────────────────────────

const number = new Intl.NumberFormat('es', { maximumFractionDigits: 1 });

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${number.format(value)} ${units[unit]}`;
}

function savingLabel(percent) {
  if (percent > 0) return `−${Math.round(percent)} %`;
  return percent < 0 ? `+${Math.round(-percent)} %` : '= 0 %';
}

const FORMAT_NAMES = { avif: 'AVIF', webp: 'WebP', jpeg: 'JPG', jpg: 'JPG', png: 'PNG', gif: 'GIF', svg: 'SVG', h264: 'MP4', vp9: 'WebM', av1: 'AV1' };

function outputUrl(path, download = false) {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `/api/jobs/${job.id}/output/${encoded}${download ? '?download' : ''}`;
}

// ── Diapositivas ───────────────────────────────────────────

function extensionLabel(name) {
  const match = /\.([a-z0-9]+)$/i.exec(name);
  return match ? match[1].toUpperCase() : '?';
}

/** Vista previa local inmediata (antes de subir). HEIC/TIFF solo se ven en algunos navegadores. */
function attachPreview(entry) {
  const win = entry.el.querySelector('.slide__window');
  const placeholder = win.querySelector('.slide__placeholder');
  placeholder.textContent = extensionLabel(entry.file.name);
  entry.previewUrl = URL.createObjectURL(entry.file);

  if (entry.kind === 'video') {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.src = `${entry.previewUrl}#t=0.1`;
    video.addEventListener('loadeddata', () => (placeholder.hidden = true), { once: true });
    win.prepend(video);
    return;
  }
  const img = new Image();
  img.alt = '';
  img.decoding = 'async';
  img.addEventListener('load', () => (placeholder.hidden = true), { once: true });
  img.addEventListener('error', () => img.remove(), { once: true });
  img.src = entry.previewUrl;
  win.prepend(img);
}

/** Reemplaza la vista previa por el archivo ya optimizado servido por el servidor. */
function revealOutput(entry) {
  const report = entry.report;
  const src = entry.kind === 'video' ? report.poster && outputUrl(report.poster.output) : report.output && outputUrl(report.output);
  if (!src) return;
  const win = entry.el.querySelector('.slide__window');
  const img = new Image();
  img.alt = '';
  img.decoding = 'async';
  img.style.opacity = '0';
  img.addEventListener('load', () => {
    win.querySelectorAll('img, video').forEach((old) => old !== img && old.remove());
    win.querySelector('.slide__placeholder').hidden = true;
    requestAnimationFrame(() => (img.style.opacity = '1'));
  }, { once: true });
  img.addEventListener('error', () => img.remove(), { once: true });
  img.src = src;
  win.prepend(img);
}

function addFiles(fileList) {
  if (phase === 'done' || phase === 'failed') reset();
  if (phase !== 'idle') return;
  for (const file of fileList) {
    if (file.size === 0) continue;
    const el = slideTemplate.content.firstElementChild.cloneNode(true);
    const entry = {
      id: nextId++,
      file,
      kind: VIDEO_EXT.test(file.name) || file.type.startsWith('video/') ? 'video' : 'image',
      status: 'selected',
      el,
      upload: 0,
    };
    el.style.setProperty('--tilt', `${(Math.random() * 3 - 1.5).toFixed(2)}deg`);
    el.querySelector('.slide__name').textContent = file.name;
    el.querySelector('.slide__name').title = file.name;
    el.querySelector('.slide__remove').setAttribute('aria-label', `Quitar ${file.name}`);
    el.querySelector('.slide__remove').addEventListener('click', () => removeEntry(entry));
    el.querySelector('.slide__mount').addEventListener('click', () => openLoupe(entry));
    entries.set(entry.id, entry);
    slidesEl.append(el);
    attachPreview(entry);
    renderSlide(entry);
  }
  renderTray();
}

function removeEntry(entry) {
  // El foco pasa a la diapositiva vecina para no perderlo al quitar una.
  const neighbor = entry.el.nextElementSibling ?? entry.el.previousElementSibling;
  if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  entry.el.remove();
  entries.delete(entry.id);
  renderTray();
  (neighbor?.querySelector('.slide__remove') ?? table.querySelector('[data-action="pick"]'))?.focus();
}

const STATUS_TEXT = {
  selected: (e) => formatBytes(e.file.size),
  uploading: (e) => `Subiendo ${Math.round(e.upload * 100)} %`,
  uploaded: () => 'En espera',
  processing: (e) => (e.kind === 'video' && e.progress ? `Procesando ${Math.round(e.progress * 100)} %` : 'Procesando…'),
  optimized: (e) => `${formatBytes(e.report.bytesIn)} → ${formatBytes(totalOut(e.report))} · ${FORMAT_NAMES[e.report.format] ?? e.report.format}`,
  copied: (e) => `${formatBytes(e.report.bytesOut)} · ya estaba optimizado`,
  skipped: () => 'No es una foto ni un video',
  failed: (e) => shorten(e.report?.error ?? e.uploadError ?? 'No se pudo subir'),
};

function shorten(text, max = 90) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function totalOut(report) {
  return (report.bytesOut ?? 0) + (report.poster?.bytes ?? 0);
}

function renderSlide(entry) {
  const { el, status } = entry;
  const previous = el.dataset.status;
  el.dataset.status = status;
  el.querySelector('.slide__meta').textContent = STATUS_TEXT[status]?.(entry) ?? '';

  const progress = status === 'uploading' ? entry.upload : entry.progress;
  el.style.setProperty('--progress', String(progress ?? 0));
  el.classList.toggle('has-progress', status === 'processing' && entry.kind === 'video' && entry.progress > 0);

  const mount = el.querySelector('.slide__mount');
  const finished = status === 'optimized' || status === 'copied';
  mount.disabled = !finished;
  mount.setAttribute('aria-label', finished ? `Ver detalle de ${entry.file.name}` : entry.file.name);

  // La marca de lápiz graso se escribe una sola vez, al terminar.
  if (status !== previous && (finished || status === 'failed')) {
    const mark = el.querySelector('.slide__mark-text');
    mark.textContent = finished
      ? savingLabel(entry.report.bytesIn ? (1 - totalOut(entry.report) / entry.report.bytesIn) * 100 : 0)
      : '✗';
    el.classList.add('is-marked');
    if (finished) revealOutput(entry);
    const reason = entry.report?.error ?? entry.uploadError;
    if (status === 'failed' && reason) el.querySelector('.slide__meta').title = reason;
  }
}

// ── Bandeja inferior ───────────────────────────────────────

function button(label, className, onClick, attrs = {}) {
  const el = document.createElement(attrs.href ? 'a' : 'button');
  el.className = `button ${className}`;
  el.textContent = label;
  if (!attrs.href) el.type = 'button';
  Object.assign(el, attrs);
  if (onClick) el.addEventListener('click', onClick);
  return el;
}

let trayKey = '';
let announcedPhase = '';

function announce(text) {
  $('#announcer').textContent = text;
}

/** Reconstruye los botones solo cuando cambian (si no, el foco del teclado se pierde). */
function setActions(key, build) {
  if (key === trayKey) return;
  trayKey = key;
  trayActions.replaceChildren(...build());
}

function setMeter(fraction) {
  const percent = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  meter.style.setProperty('--progress', String(percent / 100));
  meter.setAttribute('aria-valuenow', String(percent));
}

function renderTray() {
  const list = [...entries.values()];
  table.classList.toggle('has-files', list.length > 0);
  tray.hidden = list.length === 0;
  tray.classList.toggle('is-done', phase === 'done' || phase === 'failed');
  if (list.length === 0) {
    trayKey = '';
    return;
  }

  const totalSize = list.reduce((sum, e) => sum + e.file.size, 0);
  const finished = list.filter((e) => ['optimized', 'copied', 'skipped', 'failed'].includes(e.status));

  if (phase === 'idle') {
    trayHeadline.textContent = `${list.length} ${list.length === 1 ? 'archivo' : 'archivos'} · ${formatBytes(totalSize)}`;
    trayDetail.textContent = 'Puedes seguir agregando archivos o quitar los que no quieras.';
    meter.hidden = true;
    setActions(`idle:${list.length}`, () => [
      button('Agregar más', 'button--ghost', () => picker.click()),
      button(`Optimizar ${list.length === 1 ? 'archivo' : `${list.length} archivos`}`, 'button--primary', start),
    ]);
    return;
  }

  meter.hidden = phase === 'done' || phase === 'failed';
  if (phase === 'uploading') {
    const uploaded = list.reduce((sum, e) => sum + e.file.size * e.upload, 0);
    setMeter(uploaded / totalSize);
    trayHeadline.textContent = `Subiendo ${formatBytes(uploaded)} de ${formatBytes(totalSize)}`;
    trayDetail.textContent = 'Los archivos no salen de este computador.';
    setActions('uploading', () => []);
    if (announcedPhase !== phase) announce('Subiendo archivos.');
    announcedPhase = phase;
    return;
  }

  if (phase === 'processing') {
    const partial = list.reduce((sum, e) => sum + (finished.includes(e) ? 1 : e.status === 'processing' ? (e.progress ?? 0) : 0), 0);
    setMeter(partial / list.length);
    trayHeadline.textContent = `${finished.length} de ${list.length} listos`;
    trayDetail.textContent = reconnecting
      ? 'Reconectando con el servidor…'
      : list.some((e) => e.kind === 'video' && !finished.includes(e))
        ? 'Los videos son lo que más tarda. Puedes dejar esta pestaña abierta.'
        : 'Optimizando…';
    setActions('processing', () => []);
    if (announcedPhase !== phase) announce('Procesando archivos.');
    announcedPhase = phase;
    return;
  }

  // Terminado
  const done = list.filter((e) => e.status === 'optimized' || e.status === 'copied');
  const failed = list.filter((e) => e.status === 'failed');
  const before = done.reduce((sum, e) => sum + e.report.bytesIn, 0);
  const after = done.reduce((sum, e) => sum + totalOut(e.report), 0);
  const saved = before ? Math.round((1 - after / before) * 100) : 0;

  if (phase === 'failed') {
    trayHeadline.textContent = 'No se pudo completar';
    trayDetail.textContent = job?.error ?? 'Revisa que el servidor siga abierto e inténtalo de nuevo.';
  } else {
    trayHeadline.textContent = `${formatBytes(before)} → ${formatBytes(after)}, ${saved} % menos`;
    trayDetail.textContent = [
      `${done.length} ${done.length === 1 ? 'archivo listo' : 'archivos listos'}`,
      failed.length ? `${failed.length} con error (el motivo aparece en cada uno)` : '',
    ].filter(Boolean).join(', ');
  }
  if (announcedPhase !== phase) announce(`${trayHeadline.textContent}. ${trayDetail.textContent}`);
  announcedPhase = phase;

  setActions(`${phase}:${done.length > 0}`, () => {
    if (done.length === 0) return [button('Empezar de nuevo', 'button--ghost', reset)];
    const downloadUrl = `/api/jobs/${job.id}/download`;
    const copy = button('Copiar enlace', 'button--ghost copy-link', async (event) => {
      const target = event.currentTarget;
      try {
        await navigator.clipboard.writeText(new URL(downloadUrl, location.href).href);
        target.dataset.copied = '';
        setTimeout(() => delete target.dataset.copied, 1600);
      } catch {
        prompt('Copia este enlace:', new URL(downloadUrl, location.href).href);
      }
    });
    copy.title = 'Funciona en este computador mientras el optimizador esté abierto';
    return [
      button('Empezar de nuevo', 'button--ghost', reset),
      copy,
      button('Descargar todo (.zip)', 'button--primary', null, { href: downloadUrl, download: '' }),
    ];
  });
}

// ── Flujo: crear trabajo → subir → procesar ────────────────

function readSettings() {
  const data = new FormData(settingsForm);
  return {
    preset: data.get('preset'),
    imageFormat: data.get('imageFormat'),
    videoCodec: data.get('videoCodec'),
    muteVideo: data.get('muteVideo') === 'on',
  };
}

async function api(method, url, body) {
  const response = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? `Error ${response.status}`);
  return data;
}

function uploadFile(entry) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `/api/jobs/${job.id}/files?name=${encodeURIComponent(entry.file.name)}`);
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      entry.upload = event.loaded / event.total;
      renderSlide(entry);
      renderTray();
    });
    xhr.addEventListener('load', () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // Respuesta no JSON: se trata como error genérico abajo.
      }
      if (xhr.status >= 300 || !body.source) return reject(new Error(body.error ?? `Error ${xhr.status} al subir`));
      entry.source = body.source;
      resolve();
    });
    xhr.addEventListener('error', () => reject(new Error('Se perdió la conexión con el servidor.')));
    xhr.send(entry.file);
  });
}

async function start() {
  const list = [...entries.values()];
  if (list.length === 0) return;
  // Se leen antes de deshabilitar el formulario: FormData ignora los campos deshabilitados.
  const settings = readSettings();
  phase = 'uploading';
  settingsForm.setAttribute('aria-disabled', 'true');
  settingsForm.querySelectorAll('input').forEach((input) => (input.disabled = true));
  renderTray();

  try {
    job = await api('POST', '/api/jobs', settings);
    const queue = [...list];
    const worker = async () => {
      for (let entry = queue.shift(); entry; entry = queue.shift()) {
        entry.status = 'uploading';
        renderSlide(entry);
        try {
          await uploadFile(entry);
          entry.upload = 1;
          entry.status = 'uploaded';
        } catch (error) {
          entry.status = 'failed';
          entry.uploadError = error.message;
        }
        renderSlide(entry);
      }
    };
    await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));
    if (!list.some((e) => e.source)) throw new Error('No se pudo subir ningún archivo.');

    phase = 'processing';
    renderTray();
    listen();
    await api('POST', `/api/jobs/${job.id}/start`);
  } catch (error) {
    phase = 'failed';
    job = { ...job, error: error.message };
    renderTray();
  }
}

function listen() {
  events = new EventSource(`/api/jobs/${job.id}/events`);
  const bySource = () => new Map([...entries.values()].filter((e) => e.source).map((e) => [e.source, e]));

  const applyFile = (file, index) => {
    const entry = index.get(file.source);
    if (!entry) return;
    if (file.status === 'uploaded' && entry.status !== 'uploaded') return;
    entry.status = file.status;
    entry.progress = file.progress;
    entry.report = file.report;
    renderSlide(entry);
  };

  events.addEventListener('open', () => {
    reconnecting = false;
    renderTray();
  });
  events.addEventListener('error', () => {
    if (phase !== 'processing') return;
    // CLOSED: el servidor respondió con error (p. ej. se reinició y el trabajo ya no existe).
    if (events.readyState === EventSource.CLOSED) finish('failed', 'Se perdió la conexión con el optimizador. Vuelve a abrirlo y repite el proceso.');
    else reconnecting = true;
    renderTray();
  });

  events.addEventListener('message', (message) => {
    const event = JSON.parse(message.data);
    const index = bySource();
    if (event.type === 'snapshot') {
      event.job.files.forEach((file) => applyFile(file, index));
      if (event.job.status === 'done' || event.job.status === 'failed') finish(event.job.status, event.job.error);
    } else if (event.type === 'file') {
      applyFile(event.file, index);
    } else if (event.type === 'status' && (event.status === 'done' || event.status === 'failed')) {
      finish(event.status, event.error);
    }
    renderTray();
  });
}

function finish(status, error) {
  events?.close();
  reconnecting = false;
  phase = status === 'done' ? 'done' : 'failed';
  if (error) job.error = error;
  renderTray();
}

function reset() {
  events?.close();
  for (const entry of entries.values()) if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
  entries.clear();
  slidesEl.replaceChildren();
  job = null;
  phase = 'idle';
  settingsForm.removeAttribute('aria-disabled');
  settingsForm.querySelectorAll('input').forEach((input) => (input.disabled = false));
  picker.value = '';
  renderTray();
}

// ── Lupa: detalle con comparación antes/después ────────────

function fact(dl, label, value) {
  if (value === undefined || value === null || value === '') return;
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = label;
  dd.textContent = value;
  dl.append(dt, dd);
}

function compareView(beforeUrl, afterUrl) {
  const wrap = document.createElement('div');
  wrap.className = 'compare';
  wrap.style.setProperty('--split', '50%');
  wrap.innerHTML = `
    <img class="compare__after" alt="Optimizada">
    <div class="compare__before"><img alt="Original"></div>
    <div class="compare__handle" role="slider" tabindex="0" aria-label="Comparar original y optimizada" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"></div>
    <span class="compare__tag compare__tag--before">Original</span>
    <span class="compare__tag compare__tag--after">Optimizada</span>`;
  wrap.querySelector('.compare__after').src = afterUrl;
  wrap.querySelector('.compare__before img').src = beforeUrl;

  const handle = wrap.querySelector('.compare__handle');
  const set = (percent) => {
    const clamped = Math.min(100, Math.max(0, percent));
    wrap.style.setProperty('--split', `${clamped}%`);
    handle.setAttribute('aria-valuenow', String(Math.round(clamped)));
  };
  const fromPointer = (event) => {
    const rect = wrap.getBoundingClientRect();
    set(((event.clientX - rect.left) / rect.width) * 100);
  };
  wrap.addEventListener('pointerdown', (event) => {
    wrap.setPointerCapture(event.pointerId);
    fromPointer(event);
    wrap.addEventListener('pointermove', fromPointer);
    wrap.addEventListener('pointerup', () => wrap.removeEventListener('pointermove', fromPointer), { once: true });
  });
  handle.addEventListener('keydown', (event) => {
    const current = Number(handle.getAttribute('aria-valuenow'));
    if (event.key === 'ArrowLeft') set(current - 5);
    if (event.key === 'ArrowRight') set(current + 5);
  });
  return wrap;
}

/** true si el navegador puede mostrar el archivo original (HEIC/TIFF suelen no poder). */
function canRender(url) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
}

async function openLoupe(entry) {
  const report = entry.report;
  if (!report?.output) return;
  const frame = $('#loupeFrame');
  const info = $('#loupeInfo');
  frame.replaceChildren();
  info.replaceChildren();

  const afterUrl = outputUrl(report.output);
  if (entry.kind === 'video') {
    const video = document.createElement('video');
    video.src = afterUrl;
    video.controls = true;
    video.playsInline = true;
    if (report.poster) video.poster = outputUrl(report.poster.output);
    frame.append(video);
  } else if (!SVG_EXT.test(entry.file.name) && (await canRender(entry.previewUrl))) {
    frame.append(compareView(entry.previewUrl, afterUrl));
  } else {
    const img = new Image();
    img.src = afterUrl;
    img.alt = entry.file.name;
    frame.append(img);
  }

  const title = document.createElement('h2');
  title.id = 'loupeTitle';
  title.textContent = entry.file.name;
  const saving = document.createElement('p');
  saving.className = 'loupe__saving';
  saving.textContent = savingLabel(report.savings ?? 0);
  const facts = document.createElement('dl');
  facts.className = 'facts';
  fact(facts, 'Original', formatBytes(report.bytesIn));
  fact(facts, 'Optimizado', formatBytes(report.bytesOut));
  fact(facts, 'Formato', FORMAT_NAMES[report.format] ?? report.format);
  if (report.width) fact(facts, 'Tamaño', `${report.width} × ${report.height} px`);
  if (report.duration) fact(facts, 'Duración', `${number.format(report.duration)} s`);
  if (report.poster) fact(facts, 'Portada', `${formatBytes(report.poster.bytes)} (WebP)`);

  info.append(title, saving, facts);
  if (report.note) {
    const note = document.createElement('p');
    note.className = 'loupe__note';
    note.textContent = report.note.charAt(0).toUpperCase() + report.note.slice(1) + '.';
    info.append(note);
  }
  const fileName = report.output.split('/').pop();
  info.append(button(`Descargar ${FORMAT_NAMES[report.format] ?? 'archivo'}`, 'button--primary', null, { href: outputUrl(report.output, true), download: fileName }));
  if (report.poster) {
    info.append(button('Descargar portada', 'button--ghost', null, { href: outputUrl(report.poster.output, true), download: '' }));
  }
  loupe.showModal();
}

loupe.addEventListener('click', (event) => {
  if (event.target === loupe || event.target.closest('[data-action="close-loupe"]')) loupe.close();
});
loupe.addEventListener('close', () => loupe.querySelector('video')?.pause());

// ── Entrada de archivos ────────────────────────────────────

document.addEventListener('click', (event) => {
  if (event.target.closest('[data-action="pick"]')) picker.click();
});
picker.addEventListener('change', () => {
  addFiles(picker.files);
  picker.value = '';
});

let dragDepth = 0;
window.addEventListener('dragenter', (event) => {
  if (!event.dataTransfer?.types.includes('Files') || phase !== 'idle') return;
  dragDepth++;
  table.classList.add('is-dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) table.classList.remove('is-dragging');
});
window.addEventListener('dragover', (event) => event.preventDefault());
window.addEventListener('drop', (event) => {
  event.preventDefault();
  dragDepth = 0;
  table.classList.remove('is-dragging');
  if (event.dataTransfer?.files.length) addFiles(event.dataTransfer.files);
});

// Evita cerrar la pestaña por accidente en medio del trabajo.
window.addEventListener('beforeunload', (event) => {
  if (phase === 'uploading' || phase === 'processing') event.preventDefault();
});

renderTray();
