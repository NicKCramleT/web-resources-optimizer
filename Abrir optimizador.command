#!/bin/bash
# Doble clic en Finder para abrir la interfaz web del optimizador.
cd "$(dirname "$0")" || exit 1

if ! command -v pnpm >/dev/null 2>&1; then
  echo "Necesitas Node.js 22.12+ y pnpm: https://pnpm.io/installation"
  read -r -p "Presiona Enter para cerrar…"
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "Instalando dependencias (solo la primera vez)…"
  pnpm install || { read -r -p "Falló la instalación. Presiona Enter para cerrar…"; exit 1; }
fi

pnpm --silent web
