#!/usr/bin/env bash
# ============================================================
# Vendy Print - Reset Completo
# Desinstala TODO lo relacionado a impresión para partir de cero
# ============================================================
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
SERVICE_NAME="vendy-print"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_FILE="/etc/vendy-print.env"
CREDENTIALS_FILE="${APP_DIR}/.vendy-credentials.json"
LOG_FILE="${APP_DIR}/print-server.log"
CUPS_PRINTER="MHT58"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo ""
echo -e "${RED}╔════════════════════════════════════════════╗${NC}"
echo -e "${RED}║   VENDY PRINT - RESET COMPLETO             ║${NC}"
echo -e "${RED}╠════════════════════════════════════════════╣${NC}"
echo -e "${RED}║  Esto va a eliminar:                       ║${NC}"
echo -e "${RED}║   • Servicio systemd vendy-print           ║${NC}"
echo -e "${RED}║   • Configuración /etc/vendy-print.env     ║${NC}"
echo -e "${RED}║   • Credenciales de pairing                ║${NC}"
echo -e "${RED}║   • Impresora CUPS (${CUPS_PRINTER})                ║${NC}"
echo -e "${RED}║   • node_modules del print-server          ║${NC}"
echo -e "${RED}║   • Logs del print-server                  ║${NC}"
echo -e "${RED}╚════════════════════════════════════════════╝${NC}"
echo ""
read -r -p "¿Seguro que quieres borrar TODO? (escribe 'si' para confirmar): " confirm
if [[ "${confirm,,}" != "si" && "${confirm,,}" != "sí" ]]; then
    echo "Cancelado."
    exit 0
fi

echo ""

# ── 1. Servicio systemd ──────────────────────────────────────
echo -e "${YELLOW}[1/6]${NC} Servicio systemd..."
if systemctl is-active --quiet ${SERVICE_NAME} 2>/dev/null; then
    sudo systemctl stop ${SERVICE_NAME}
    echo "  ✓ Servicio detenido"
else
    echo "  - Servicio no estaba corriendo"
fi

if systemctl is-enabled --quiet ${SERVICE_NAME} 2>/dev/null; then
    sudo systemctl disable ${SERVICE_NAME} 2>/dev/null
    echo "  ✓ Servicio deshabilitado del arranque"
fi

if [[ -f "${SERVICE_FILE}" ]]; then
    sudo rm -f "${SERVICE_FILE}"
    sudo systemctl daemon-reload
    echo "  ✓ ${SERVICE_FILE} eliminado"
else
    echo "  - No existía archivo de servicio"
fi

# ── 2. Configuración ─────────────────────────────────────────
echo -e "${YELLOW}[2/6]${NC} Configuración..."
if [[ -f "${ENV_FILE}" ]]; then
    sudo rm -f "${ENV_FILE}"
    echo "  ✓ ${ENV_FILE} eliminado"
else
    echo "  - No existía archivo .env"
fi

# ── 3. Credenciales de pairing ────────────────────────────────
echo -e "${YELLOW}[3/6]${NC} Credenciales de pairing..."
if [[ -f "${CREDENTIALS_FILE}" ]]; then
    rm -f "${CREDENTIALS_FILE}"
    echo "  ✓ ${CREDENTIALS_FILE} eliminado"
else
    echo "  - No existían credenciales"
fi

# ── 4. Impresora CUPS ────────────────────────────────────────
echo -e "${YELLOW}[4/6]${NC} Impresora CUPS..."
if lpstat -p ${CUPS_PRINTER} 2>/dev/null | grep -q "${CUPS_PRINTER}"; then
    sudo lpadmin -x ${CUPS_PRINTER}
    echo "  ✓ Impresora ${CUPS_PRINTER} eliminada de CUPS"
else
    echo "  - Impresora ${CUPS_PRINTER} no existía en CUPS"
fi

# Mostrar si quedan otras impresoras
other_printers=$(lpstat -p 2>/dev/null | grep -v "^$" || true)
if [[ -n "${other_printers}" ]]; then
    echo "  ℹ Otras impresoras que siguen instaladas:"
    echo "    ${other_printers}"
fi

# ── 5. node_modules ──────────────────────────────────────────
echo -e "${YELLOW}[5/6]${NC} Dependencias (node_modules)..."
if [[ -d "${APP_DIR}/node_modules" ]]; then
    rm -rf "${APP_DIR}/node_modules"
    echo "  ✓ node_modules eliminado"
else
    echo "  - No existía node_modules"
fi

# ── 6. Logs ──────────────────────────────────────────────────
echo -e "${YELLOW}[6/6]${NC} Logs..."
if [[ -f "${LOG_FILE}" ]]; then
    rm -f "${LOG_FILE}"
    echo "  ✓ print-server.log eliminado"
else
    echo "  - No existía archivo de log"
fi

# Limpiar logs de systemd para este servicio
sudo journalctl --rotate 2>/dev/null || true
sudo journalctl --vacuum-time=1s -u ${SERVICE_NAME} 2>/dev/null || true
echo "  ✓ Logs de journalctl limpiados"

# ── Resumen ──────────────────────────────────────────────────
echo ""
echo -e "${GREEN}╔════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║   RESET COMPLETO ✓                         ║${NC}"
echo -e "${GREEN}╠════════════════════════════════════════════╣${NC}"
echo -e "${GREEN}║  Sistema de impresión limpio.              ║${NC}"
echo -e "${GREEN}║                                            ║${NC}"
echo -e "${GREEN}║  Para reinstalar desde cero:               ║${NC}"
echo -e "${GREEN}║  1. Conectar impresora USB                 ║${NC}"
echo -e "${GREEN}║  2. Doble clic: Instalar-Vendy-Print       ║${NC}"
echo -e "${GREEN}║  3. Vincular desde la app (Settings)       ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════╝${NC}"
echo ""
