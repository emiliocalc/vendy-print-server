#!/usr/bin/env bash
set -euo pipefail

SERVICE_NAME="vendy-print"
ENV_FILE="/etc/vendy-print.env"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

sudo -v

echo "Deteniendo servicio ${SERVICE_NAME}..."
sudo systemctl stop ${SERVICE_NAME} || true
sudo systemctl disable ${SERVICE_NAME} || true

if [[ -f "${SERVICE_FILE}" ]]; then
  echo "Eliminando ${SERVICE_FILE}"
  sudo rm -f "${SERVICE_FILE}"
fi

sudo systemctl daemon-reload

if [[ -f "${ENV_FILE}" ]]; then
  read -r -p "¿Eliminar ${ENV_FILE}? (s/N): " remove_env
  if [[ "${remove_env,,}" == "s" || "${remove_env,,}" == "si" || "${remove_env,,}" == "sí" ]]; then
    sudo rm -f "${ENV_FILE}"
    echo "${ENV_FILE} eliminado"
  else
    echo "${ENV_FILE} conservado"
  fi
fi

echo "Desinstalación completada."
