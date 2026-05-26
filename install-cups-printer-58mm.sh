#!/usr/bin/env bash
set -euo pipefail

# ============================================
# Instalador CUPS + Impresora Térmica 58mm
# Vendy Print System - Instalación Automática
# ============================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOG_FILE="/tmp/vendy-cups-install.log"

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
    echo -e "${GREEN}[INFO]${NC} $*" | tee -a "$LOG_FILE"
}

warn() {
    echo -e "${YELLOW}[WARN]${NC} $*" | tee -a "$LOG_FILE"
}

error() {
    echo -e "${RED}[ERROR]${NC} $*" | tee -a "$LOG_FILE"
}

success() {
    echo -e "${BLUE}✓${NC} $*" | tee -a "$LOG_FILE"
}

print_header() {
    clear
    cat << "EOF"
╔══════════════════════════════════════════════╗
║   INSTALADOR DE IMPRESORA TÉRMICA 58MM      ║
║   Vendy Print System - CUPS Setup           ║
║   v1.0                                       ║
╚══════════════════════════════════════════════╝
EOF
    echo ""
}

ensure_terminal() {
    if [[ ! -t 1 ]]; then
        if command -v x-terminal-emulator >/dev/null 2>&1; then
            x-terminal-emulator -e "$0"
            exit 0
        elif command -v gnome-terminal >/dev/null 2>&1; then
            gnome-terminal -- "$0"
            exit 0
        elif command -v konsole >/dev/null 2>&1; then
            konsole -e "$0"
            exit 0
        elif command -v xfce4-terminal >/dev/null 2>&1; then
            xfce4-terminal -e "$0"
            exit 0
        else
            error "Necesitas abrir este instalador desde una terminal."
            exit 1
        fi
    fi
}

check_sudo() {
    if [[ $EUID -eq 0 ]]; then
        error "No ejecutes este script como root directamente."
        error "El script pedirá permisos sudo cuando sea necesario."
        exit 1
    fi

    log "Verificando permisos sudo..."
    if ! sudo -v; then
        error "Se requieren permisos sudo para continuar."
        exit 1
    fi
    success "Permisos verificados"
}

install_cups() {
    log "Verificando instalación de CUPS..."

    if command -v cupsd >/dev/null 2>&1; then
        success "CUPS ya está instalado"
        return 0
    fi

    log "Instalando CUPS y herramientas necesarias..."
    sudo apt update
    sudo apt install -y cups cups-client cups-bsd printer-driver-all \
        system-config-printer hplip ghostscript

    # Habilitar y arrancar servicio CUPS
    sudo systemctl enable cups
    sudo systemctl start cups

    # Agregar usuario actual al grupo lpadmin
    sudo usermod -a -G lpadmin "$USER"

    success "CUPS instalado correctamente"
}

detect_thermal_printer() {
    log "Buscando impresora térmica USB conectada..."

    # Buscar dispositivos USB que puedan ser impresoras térmicas
    local usb_devices
    usb_devices=$(lsusb 2>/dev/null || echo "")

    if [[ -z "$usb_devices" ]]; then
        warn "No se pudo ejecutar lsusb. Instalando usbutils..."
        sudo apt install -y usbutils
        usb_devices=$(lsusb)
    fi

    echo ""
    log "Dispositivos USB detectados:"
    echo "$usb_devices" | grep -iE 'printer|thermal|pos|receipt|58mm|80mm' || true
    echo ""

    # Buscar dispositivos en /dev/usb/
    if [[ -d /dev/usb ]]; then
        local usb_printers
        usb_printers=$(ls -la /dev/usb/lp* 2>/dev/null || echo "")
        if [[ -n "$usb_printers" ]]; then
            success "Dispositivos de impresora encontrados:"
            echo "$usb_printers"
        fi
    fi

    # Verificar si hay impresora conectada
    if ! echo "$usb_devices" | grep -iE 'printer|thermal|pos|receipt' >/dev/null; then
        warn "No se detectó una impresora térmica USB."
        echo ""
        read -r -p "¿Deseas continuar de todos modos? (s/N): " continue_anyway
        if [[ "${continue_anyway,,}" != "s" ]]; then
            log "Por favor, conecta la impresora térmica USB y vuelve a ejecutar el instalador."
            exit 0
        fi
    else
        success "Impresora térmica detectada"
    fi
}

get_usb_device() {
    # Buscar el primer dispositivo lp disponible
    if [[ -e /dev/usb/lp0 ]]; then
        echo "/dev/usb/lp0"
    elif [[ -e /dev/lp0 ]]; then
        echo "/dev/lp0"
    else
        # Buscar cualquier dispositivo lp
        local device
        device=$(find /dev -name 'lp*' 2>/dev/null | head -1)
        if [[ -n "$device" ]]; then
            echo "$device"
        else
            echo ""
        fi
    fi
}

setup_printer_permissions() {
    log "Configurando permisos de impresora..."

    local device
    device=$(get_usb_device)

    if [[ -n "$device" ]]; then
        sudo usermod -a -G lp "$USER"
        sudo chmod 666 "$device" 2>/dev/null || true
        success "Permisos configurados para $device"
    else
        warn "No se encontró dispositivo USB, los permisos se configurarán cuando conectes la impresora"
    fi
}

install_printer_in_cups() {
    log "Configurando impresora térmica de 58mm en CUPS..."

    local printer_name="${1:-MHT58}"

    # Verificar si la impresora ya existe
    if lpstat -p "$printer_name" >/dev/null 2>&1; then
        warn "La impresora '$printer_name' ya existe en CUPS"
        read -r -p "¿Deseas reemplazarla? (s/N): " replace
        if [[ "${replace,,}" == "s" ]]; then
            log "Eliminando impresora existente..."
            sudo lpadmin -x "$printer_name"
        else
            success "Usando impresora existente"
            return 0
        fi
    fi

    # Obtener dispositivo USB
    local device
    device=$(get_usb_device)

    if [[ -z "$device" ]]; then
        warn "No se encontró dispositivo USB automáticamente"
        read -r -p "Ingresa el dispositivo manualmente (ej: /dev/usb/lp0) o Enter para usar USB por defecto: " manual_device
        device="${manual_device:-usb://Unknown/Unknown}"
    fi

    # Crear impresora en CUPS
    # Driver: raw (para impresoras térmicas ESC/POS)
    log "Creando impresora '$printer_name'..."

    sudo lpadmin -p "$printer_name" \
        -v "$device" \
        -E \
        -m raw \
        -o printer-is-shared=false \
        -D "Impresora Térmica 58mm - Vendy" \
        -L "Local USB" 2>&1 | tee -a "$LOG_FILE"

    # Habilitar la impresora
    sudo cupsenable "$printer_name"
    sudo cupsaccept "$printer_name"

    # Configurar como impresora por defecto (opcional)
    read -r -p "¿Deseas establecer esta impresora como predeterminada? (S/n): " set_default
    if [[ "${set_default,,}" != "n" ]]; then
        sudo lpadmin -d "$printer_name"
        success "Impresora establecida como predeterminada"
    fi

    success "Impresora '$printer_name' instalada correctamente en CUPS"
}

test_printer() {
    local printer_name="${1:-MHT58}"

    echo ""
    read -r -p "¿Deseas imprimir una página de prueba? (S/n): " do_test
    if [[ "${do_test,,}" == "n" ]]; then
        return 0
    fi

    log "Imprimiendo página de prueba..."

    # Crear archivo de prueba simple
    cat > /tmp/vendy-test.txt << 'EOF'
================================
   VENDY PRINT SYSTEM
   Prueba de Impresora 58mm
================================

Fecha: $(date '+%Y-%m-%d %H:%M:%S')

Caracteres especiales:
  - Tildes: á é í ó ú ñ
  - Símbolos: $ € £ ¥ °

================================
  PRUEBA EXITOSA
================================
EOF

    # Imprimir archivo de prueba
    lpr -P "$printer_name" /tmp/vendy-test.txt 2>&1 | tee -a "$LOG_FILE" || {
        warn "Error al imprimir. Verifica que la impresora esté encendida y conectada."
    }

    rm -f /tmp/vendy-test.txt
}

install_vendy_print_server() {
    echo ""
    log "El servidor de impresión Vendy aún no está instalado."
    read -r -p "¿Deseas instalar el servidor de impresión Vendy ahora? (S/n): " install_server

    if [[ "${install_server,,}" == "n" ]]; then
        log "Puedes instalar el servidor más tarde ejecutando:"
        log "  cd $SCRIPT_DIR && ./install-linux-service.sh"
        return 0
    fi

    if [[ -f "$SCRIPT_DIR/install-linux-service.sh" ]]; then
        log "Ejecutando instalador del servidor Vendy..."
        bash "$SCRIPT_DIR/install-linux-service.sh"
    else
        warn "No se encontró install-linux-service.sh"
        log "Puedes instalarlo manualmente más tarde."
    fi
}

show_summary() {
    echo ""
    echo "╔══════════════════════════════════════════════╗"
    echo "║        INSTALACIÓN COMPLETADA               ║"
    echo "╚══════════════════════════════════════════════╝"
    echo ""
    success "CUPS instalado y configurado"
    success "Impresora térmica 58mm agregada"
    echo ""
    log "Información de la impresora:"
    lpstat -p 2>/dev/null || true
    echo ""
    log "Comandos útiles:"
    echo "  - Ver impresoras: lpstat -p"
    echo "  - Estado CUPS: sudo systemctl status cups"
    echo "  - Panel de impresoras: system-config-printer"
    echo "  - Configuración web CUPS: http://localhost:631"
    echo ""
    warn "IMPORTANTE: Reinicia tu sesión para aplicar los permisos de grupo"
    echo ""

    read -r -p "Presiona Enter para cerrar..."
}

# ============================================
# MAIN
# ============================================

main() {
    ensure_terminal
    print_header

    log "Iniciando instalación..."
    echo "Log guardado en: $LOG_FILE"
    echo ""

    check_sudo
    install_cups
    detect_thermal_printer
    setup_printer_permissions

    # Solicitar nombre de impresora
    echo ""
    read -r -p "Nombre para la impresora (default: MHT58): " printer_name
    printer_name="${printer_name:-MHT58}"

    install_printer_in_cups "$printer_name"
    test_printer "$printer_name"
    install_vendy_print_server
    show_summary
}

# Ejecutar main
main "$@"
