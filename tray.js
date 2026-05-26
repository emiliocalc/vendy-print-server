/**
 * Vendy Print Server — System Tray
 * Envuelve server.js con ícono en bandeja y selector de impresora.
 */

const { fork, exec, execSync } = require('child_process');
const path  = require('path');
const http  = require('http');
const fs    = require('fs');
const SysTray = require('systray').default;

// ── Paths ──────────────────────────────────────────────────────
const ICON_PATH = path.join(__dirname, 'assets', 'icon.ico');
const ENV_PATH  = path.join(process.cwd(), '.env');

// ── Estado global ──────────────────────────────────────────────
let serverProcess = null;
let tray          = null;
let isConnected   = false;
let printers      = [];
let selectedPrinter = '';

// ── .env helpers ───────────────────────────────────────────────
function readEnv() {
    try {
        return fs.readFileSync(ENV_PATH, 'utf8');
    } catch (_) { return ''; }
}

function getEnvVar(key) {
    const match = readEnv().match(new RegExp(`^${key}=(.*)$`, 'm'));
    return match ? match[1].trim() : '';
}

function setEnvVar(key, value) {
    let content = readEnv();
    const regex = new RegExp(`^${key}=.*$`, 'm');
    if (regex.test(content)) {
        content = content.replace(regex, `${key}=${value}`);
    } else {
        content += `\n${key}=${value}`;
    }
    fs.writeFileSync(ENV_PATH, content, 'utf8');
    process.env[key] = value;
}

// ── Obtener impresoras vía PowerShell ─────────────────────────
function getPrinters() {
    return new Promise((resolve) => {
        exec(
            'powershell -command "Get-Printer | Select-Object -ExpandProperty Name"',
            { windowsHide: true },
            (err, stdout) => {
                if (err) return resolve([]);
                const list = stdout
                    .split('\n')
                    .map(l => l.trim())
                    .filter(l => l.length > 0);
                resolve(list);
            }
        );
    });
}

// ── Servidor ───────────────────────────────────────────────────
function startServer() {
    const serverPath = path.join(__dirname, 'server.js');
    serverProcess = fork(serverPath, [], { stdio: 'inherit', detached: false });
    serverProcess.on('exit', () => { isConnected = false; });
    serverProcess.on('error', (err) => console.error('[tray] Error servidor:', err.message));
    console.log('[tray] Servidor iniciado (PID:', serverProcess.pid, ')');
}

function stopServer() {
    if (serverProcess) { serverProcess.kill('SIGTERM'); serverProcess = null; }
}

function restartServer() {
    stopServer();
    setTimeout(startServer, 1000);
}

// ── Polling de estado ─────────────────────────────────────────
function checkStatus() {
    const req = http.get({
        hostname: 'localhost',
        port: process.env.PRINT_SERVER_PORT || 9123,
        path: '/status',
        timeout: 2000,
    }, (res) => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
            try { JSON.parse(data); isConnected = true; } catch (_) { isConnected = false; }
        });
    });
    req.on('error', () => { isConnected = false; });
    req.on('timeout', () => { req.destroy(); isConnected = false; });
}

// ── Abrir URL ─────────────────────────────────────────────────
function openUrl(url) {
    exec(`start "" "${url}"`, { windowsHide: true });
}

// ── Construir items del menú ───────────────────────────────────
function buildMenuItems() {
    const items = [
        {
            title: isConnected ? '✅ Conectado a Vendy' : '⚪ Sin conexión',
            tooltip: 'Estado del servidor',
            enabled: false,
            checked: false,
        },
        { title: '───────────────────', tooltip: '', enabled: false, checked: false },
        {
            title: selectedPrinter
                ? `🖨️ Impresora: ${selectedPrinter}`
                : '⚠️ Sin impresora — selecciona una:',
            tooltip: 'Impresora activa',
            enabled: false,
            checked: false,
        },
    ];

    // Una fila por impresora
    printers.forEach(name => {
        items.push({
            title: `   ${name}`,
            tooltip: `Usar ${name}`,
            enabled: true,
            checked: name === selectedPrinter,
        });
    });

    items.push({ title: '───────────────────', tooltip: '', enabled: false, checked: false });
    items.push({ title: '🌐 Abrir panel web',   tooltip: 'Abrir app.somosvendy.cl', enabled: true, checked: false });
    items.push({ title: '🔄 Reiniciar servidor', tooltip: '',                        enabled: true, checked: false });
    items.push({ title: '───────────────────', tooltip: '', enabled: false, checked: false });
    items.push({ title: '❌ Salir',              tooltip: 'Cerrar el servidor',       enabled: true, checked: false });

    return items;
}

// ── Reiniciar tray con menú actualizado ───────────────────────
function rebuildTray() {
    if (tray) { try { tray.kill(); } catch (_) {} tray = null; }
    setTimeout(startTray, 500);
}

// ── Iniciar tray ──────────────────────────────────────────────
function startTray() {
    const iconBase64 = fs.readFileSync(ICON_PATH).toString('base64');

    tray = new SysTray({
        menu: {
            icon: iconBase64,
            title: 'Vendy Print',
            tooltip: 'Vendy Print Server',
            items: buildMenuItems(),
        },
        debug: false,
        copyDir: true,
    });

    tray.onClick((action) => {
        if (!action.item.enabled) return;
        const title = action.item.title.trim();

        // ¿Es una impresora?
        const matchedPrinter = printers.find(p => title === p);
        if (matchedPrinter) {
            if (matchedPrinter === selectedPrinter) return; // ya está seleccionada
            selectedPrinter = matchedPrinter;
            setEnvVar('PRINTER_NAME', selectedPrinter);
            console.log('[tray] Impresora seleccionada:', selectedPrinter);
            restartServer();
            rebuildTray();
            return;
        }

        if (title.includes('Abrir panel web')) {
            openUrl('https://app.somosvendy.cl');
        } else if (title.includes('Reiniciar')) {
            restartServer();
        } else if (title.includes('Salir')) {
            stopServer();
            tray.kill();
            process.exit(0);
        }
    });

    tray.onError((err) => console.error('[tray] Error:', err));
    console.log('[tray] Ícono en bandeja activo');
}

// ── Crear acceso directo apuntando al .exe ────────────────────
function createShortcut(lnkPath, description) {
    const exePath = process.execPath;
    const exeDir  = path.dirname(exePath);
    const ps = [
        `$WshShell = New-Object -ComObject WScript.Shell`,
        `$Shortcut = $WshShell.CreateShortcut("${lnkPath.replace(/\\/g, '\\\\')}")`,
        `$Shortcut.TargetPath = "${exePath.replace(/\\/g, '\\\\')}"`,
        `$Shortcut.WorkingDirectory = "${exeDir.replace(/\\/g, '\\\\')}"`,
        `$Shortcut.Description = "${description}"`,
        `$Shortcut.Save()`,
    ].join('\r\n');

    const tmpScript = path.join(process.env.TEMP || process.env.TMP || __dirname, 'vendy_shortcut.ps1');
    fs.writeFileSync(tmpScript, ps, 'utf8');
    exec(`powershell -ExecutionPolicy Bypass -File "${tmpScript}"`, { windowsHide: true }, (err) => {
        try { fs.unlinkSync(tmpScript); } catch (_) {}
        if (err) console.error('[tray] Error al crear acceso directo:', err.message);
        else      console.log('[tray] Acceso directo creado:', lnkPath);
    });
}

// ── Helper: escribir y ejecutar PS1 con BOM (fix encoding UTF-8) ──
function runPs(lines, tmpName) {
    const ps = '\uFEFF' + lines.join('\r\n');
    const tmpScript = path.join(process.env.TEMP || process.env.TMP || __dirname, tmpName);
    fs.writeFileSync(tmpScript, ps, 'utf8');
    try {
        return execSync(`powershell -ExecutionPolicy Bypass -File "${tmpScript}"`, { windowsHide: true }).toString().trim();
    } catch (_) {
        return '';
    } finally {
        try { fs.unlinkSync(tmpScript); } catch (_) {}
    }
}

// ── Instancia única ───────────────────────────────────────────
function isAlreadyRunning() {
    try {
        const out = execSync('tasklist /FI "IMAGENAME eq vendy-print-server.exe" /NH', { windowsHide: true }).toString();
        const matches = (out.match(/vendy-print-server\.exe/gi) || []).length;
        return matches > 1;
    } catch (_) { return false; }
}

// ── Confirmación antes de instalar ────────────────────────────
function askInstallConfirm() {
    const result = runPs([
        `Add-Type -AssemblyName PresentationFramework`,
        `$msg = "Deseas instalar Vendy Print Server?\`n\`n" +`,
        `       "Se creara un acceso directo en el Escritorio y el servidor\`n" +`,
        `       "se iniciara automaticamente al encender el computador.\`n\`n" +`,
        `       "Una vez instalado, vincula tu cuenta desde la aplicacion en app.somosvendy.cl."`,
        `$r = [System.Windows.MessageBox]::Show($msg, 'Vendy Print Server', 'YesNo', 'Question')`,
        `Write-Output $r`,
    ], 'vendy_confirm.ps1');
    return result === 'Yes';
}

// ── Mensaje de instalación exitosa ────────────────────────────
function showInstallMessage() {
    runPs([
        `Add-Type -AssemblyName PresentationFramework`,
        `$msg = "Vendy Print Server instalado correctamente.\`n\`n" +`,
        `       "Se creo un acceso directo en el Escritorio para abrir el servidor.\`n" +`,
        `       "El servidor se iniciara automaticamente cada vez que enciendas el computador.\`n\`n" +`,
        `       "Selecciona tu impresora desde el icono en la bandeja del sistema (abajo a la derecha)."`,
        `[System.Windows.MessageBox]::Show($msg, 'Vendy Print Server', 'OK', 'Information')`,
    ], 'vendy_install_msg.ps1');
}

// ── Mensaje "ya instalado" ─────────────────────────────────────
function showAlreadyInstalledMessage() {
    runPs([
        `Add-Type -AssemblyName PresentationFramework`,
        `[System.Windows.MessageBox]::Show("Vendy Print Server ya esta instalado y corriendo.\`n\`nPuedes controlarlo desde el icono en la bandeja del sistema (abajo a la derecha).", 'Vendy Print Server', 'OK', 'Information')`,
    ], 'vendy_already_msg.ps1');
}

// ── Acceso directo en Startup + Escritorio ────────────────────
function ensureShortcuts() {
    const startupDir  = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
    const desktopDir  = path.join(process.env.USERPROFILE, 'Desktop');
    const startupLink = path.join(startupDir, 'VendyPrintServer.lnk');
    const desktopLink = path.join(desktopDir, 'Vendy Print Server.lnk');

    const firstInstall = !fs.existsSync(startupLink) && !fs.existsSync(desktopLink);

    if (!firstInstall) {
        showAlreadyInstalledMessage();
        return;
    }

    if (!askInstallConfirm()) return;

    if (!fs.existsSync(startupLink)) createShortcut(startupLink, 'Vendy Print Server');
    if (!fs.existsSync(desktopLink)) createShortcut(desktopLink, 'Vendy Print Server');

    setTimeout(showInstallMessage, 2000);
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
    // Instancia única: salir si ya hay una corriendo
    if (isAlreadyRunning()) process.exit(0);

    // Leer impresora guardada
    selectedPrinter = getEnvVar('PRINTER_NAME') || '';

    // Obtener lista de impresoras
    printers = await getPrinters();
    console.log('[tray] Impresoras detectadas:', printers);

    if (!selectedPrinter) {
        console.log('[tray] Sin impresora configurada — el usuario debe seleccionar una desde el menú');
    }

    startServer();
    startTray();
    ensureShortcuts();

    setTimeout(checkStatus, 3000);
    setInterval(checkStatus, 5000);
}

main();

process.on('SIGINT', () => {
    stopServer();
    if (tray) tray.kill();
    process.exit(0);
});
