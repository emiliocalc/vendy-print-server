/**
 * Vendy Print Server - Micro-servicio ESC/POS
 *
 * Servidor HTTP que recibe datos de tickets y los imprime
 * usando comandos ESC/POS nativos en impresoras térmicas.
 *
 * Soporta:
 * - Linux: /dev/usb/lp0 o impresora configurada
 * - Windows: RAW spooler
 *
 * Puerto por defecto: 9123
 */

const http = require('http');
const fs = require('fs');
const { exec, execFile, spawn } = require('child_process');
const path = require('path');
const os = require('os');

const {
    generateCashierTicket,
    generateKitchenCommand,
    generateBaristaCommand,
    generateCharsetTest
} = require('./escpos');

// Módulos de modo autónomo (Camino A)
const supabaseClient = require('./supabaseClient');
const printJobProcessor = require('./printJobProcessor');
const orgConfig = require('./orgConfig');
const pairing = require('./pairing');

// ─── Seguridad: carga .env y auto-genera PRINT_API_KEY ──────────────────────

/** Lee .env desde process.cwd() y popula process.env (sin sobreescribir vars ya seteadas) */
function loadEnvFile() {
    try {
        const envPath = path.join(__dirname, '.env');
        const content = fs.readFileSync(envPath, 'utf8');
        for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) continue;
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx < 0) continue;
            const key = trimmed.slice(0, eqIdx).trim();
            const value = trimmed.slice(eqIdx + 1).trim();
            if (key && process.env[key] === undefined) {
                process.env[key] = value;
            }
        }
    } catch (_) {
        // .env no existe todavía — normal en primer arranque
    }
}

/** Persiste PRINT_API_KEY en .env para que sobreviva reinicios del servicio */
function saveApiKeyToEnv(key) {
    try {
        const envPath = path.join(__dirname, '.env');
        let content = '';
        try { content = fs.readFileSync(envPath, 'utf8'); } catch (_) {}
        if (/^PRINT_API_KEY=/m.test(content)) {
            content = content.replace(/^PRINT_API_KEY=.*$/m, `PRINT_API_KEY=${key}`);
        } else {
            content += (content && !content.endsWith('\n') ? '\n' : '') + `PRINT_API_KEY=${key}\n`;
        }
        fs.writeFileSync(envPath, content, 'utf8');
    } catch (err) {
        console.error('[Security] No se pudo guardar PRINT_API_KEY en .env:', err.message);
    }
}

// Cargar .env antes de leer cualquier variable de entorno
loadEnvFile();

// Configuración
const PORT = process.env.PRINT_SERVER_PORT || 9123;
const PRINTER_DEVICE = process.env.PRINTER_DEVICE || '/dev/usb/lp0';
const PRINTER_NAME = process.env.PRINTER_NAME || ''; // Windows o CUPS (Linux)

// Seguridad: cargar o auto-generar API key (zero-config — el usuario nunca la configura a mano)
let apiKey = process.env.PRINT_API_KEY || '';
if (!apiKey) {
    const { randomUUID } = require('crypto');
    apiKey = randomUUID();
    saveApiKeyToEnv(apiKey);
    console.log('[Security] PRINT_API_KEY auto-generada y guardada en .env');
}

// Regex para validar nombres de impresora (previene command injection H-003)
// Windows permite / ( ) , : en nombres de impresoras (ej. "Generic / Text Only", "HP (Red)")
// En Windows usamos WinAPI (no shell), así que / no es riesgo. CUPS sigue usando execFile con args array.
const SAFE_PRINTER_RE = /^[a-zA-Z0-9_\-\.\/ \(\),:#@]{1,200}$/;
// CORS: Por defecto acepta cualquier origen (*) para endpoints públicos (status, pair)
// Se puede restringir vía PRINT_ALLOWED_ORIGINS si se necesita
const ALLOWED_ORIGINS = process.env.PRINT_ALLOWED_ORIGINS
    ? process.env.PRINT_ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
    : ['*'];
const RATE_LIMIT_MAX = parseInt(process.env.PRINT_RATE_LIMIT || '30', 10); // req/min
const MAX_BODY_SIZE = 1024 * 1024; // 1MB

// Detectar sistema operativo
const IS_WINDOWS = os.platform() === 'win32';
const IS_LINUX = os.platform() === 'linux';
// __dirname = directorio del .js, correcto en dev, servicio y pkg
const LOG_FILE = path.join(__dirname, 'print-server.log');
const SERVER_LOG_FILE = path.join(__dirname, 'server.log');

// Sistema de log rotation
const { startRotation } = require('./logRotation');

// Métricas del servidor
const metrics = {
    startTime: Date.now(),
    requests: {
        total: 0,
        success: 0,
        error: 0,
        rateLimit: 0
    },
    printJobs: {
        total: 0,
        success: 0,
        failed: 0
    }
};

function incrementMetric(category, type) {
    if (metrics[category] && metrics[category][type] !== undefined) {
        metrics[category][type]++;
    }
}

function getUptime() {
    const uptimeMs = Date.now() - metrics.startTime;
    const seconds = Math.floor(uptimeMs / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

// Rate limiter: sliding window por IP
const rateLimitMap = new Map();

function isRateLimited(ip) {
    const now = Date.now();
    const windowMs = 60000;

    if (!rateLimitMap.has(ip)) {
        rateLimitMap.set(ip, []);
    }

    const timestamps = rateLimitMap.get(ip).filter(t => now - t < windowMs);
    rateLimitMap.set(ip, timestamps);

    if (timestamps.length >= RATE_LIMIT_MAX) {
        return true;
    }

    timestamps.push(now);
    return false;
}

// Limpiar entries viejos cada 5 minutos
setInterval(() => {
    const now = Date.now();
    for (const [ip, timestamps] of rateLimitMap) {
        const recent = timestamps.filter(t => now - t < 60000);
        if (recent.length === 0) {
            rateLimitMap.delete(ip);
        } else {
            rateLimitMap.set(ip, recent);
        }
    }
}, 300000);

function logEvent(level, message, meta = null) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}${meta ? ` | ${JSON.stringify(meta)}` : ''}\n`;
    fs.appendFile(LOG_FILE, line, (err) => {
        if (err) console.error('Error escribiendo log:', err.message);
    });
}

/**
 * Log de servidor: escribe en server.log Y en print_server_events (Supabase).
 * Usar para eventos del ciclo de vida del servidor: arranque, crash, watchdog, etc.
 */
function serverLog(level, message, meta = null) {
    const timestamp = new Date().toISOString();
    const line = `[${timestamp}] [${level}] ${message}${meta ? ` | ${JSON.stringify(meta)}` : ''}\n`;
    fs.appendFile(SERVER_LOG_FILE, line, (err) => {
        if (err) console.error('Error escribiendo server.log:', err.message);
    });
    // Insertar en Supabase de forma no-bloqueante (best-effort)
    try {
        const supabase = supabaseClient.getClient();
        const orgId    = supabaseClient.getOrgId();
        const deviceId = supabaseClient.getDeviceId();
        if (supabase && orgId) {
            supabase.from('print_server_events').insert({
                organization_id: orgId,
                device_id:       deviceId || null,
                level,
                message,
                meta:            meta || null
            }).then(({ error }) => {
                if (error) fs.appendFile(SERVER_LOG_FILE,
                    `[${new Date().toISOString()}] [WARN] serverLog insert failed: ${error.message}\n`,
                    () => {});
            });
        }
    } catch (_) { /* silencioso — no crashear por un error de log */ }
}

/**
 * Envía datos a la impresora en Linux
 */
function printLinuxCups(buffer, printerName) {
    return new Promise((resolve, reject) => {
        if (!printerName) {
            return reject(new Error('Nombre de impresora CUPS no especificado'));
        }
        // H-003: validar nombre antes de pasarlo al shell
        if (!SAFE_PRINTER_RE.test(printerName)) {
            return reject(new Error('Nombre de impresora contiene caracteres inválidos'));
        }

        const tempFile = path.join(os.tmpdir(), `vendy_print_${Date.now()}.bin`);
        fs.writeFileSync(tempFile, buffer);

        // Usar execFile para evitar interpolación de shell (H-003)
        execFile('lp', ['-d', printerName, '-o', 'raw', tempFile], (error) => {
            try { fs.unlinkSync(tempFile); } catch (_) {}
            if (error) {
                reject(new Error(`Error imprimiendo con CUPS: ${error.message}`));
            } else {
                resolve({ success: true, printer: printerName, type: 'cups' });
            }
        });
    });
}

function printLinuxRawDevice(buffer, device = PRINTER_DEVICE) {
    return new Promise((resolve, reject) => {
        // Verificar que el dispositivo existe
        if (!fs.existsSync(device)) {
            // Intentar dispositivos alternativos
            const alternatives = [
                '/dev/usb/lp0',
                '/dev/usb/lp1',
                '/dev/lp0',
                '/dev/lp1'
            ];

            let found = null;
            for (const alt of alternatives) {
                if (fs.existsSync(alt)) {
                    found = alt;
                    break;
                }
            }

            if (!found) {
                return reject(new Error(`Impresora no encontrada. Dispositivos buscados: ${device}, ${alternatives.join(', ')}`));
            }
            device = found;
        }

        // Escribir directamente al dispositivo
        fs.writeFile(device, buffer, (err) => {
            if (err) {
                reject(new Error(`Error escribiendo en dispositivo: ${err.message}`));
            } else {
                resolve({ success: true, device });
            }
        });
    });
}

/**
 * Envía datos a la impresora en Windows usando RAW spooler
 */
function printWindows(buffer, printerName = PRINTER_NAME) {
    return new Promise((resolve, reject) => {
        // Crear archivo temporal
        const tempFile = path.join(os.tmpdir(), `vendy_print_${Date.now()}.bin`);
        fs.writeFileSync(tempFile, buffer);

        // Determinar nombre de impresora
        let printer = printerName;
        if (!printer) {
            // Obtener impresora por defecto vía PowerShell (wmic está deprecado en Windows 11)
            const child = spawn('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                '-Command',
                'Get-Printer | Where-Object { $_.Default -eq $true } | Select-Object -ExpandProperty Name'
            ]);
            let stdout = '';
            child.stdout.on('data', d => { stdout += d; });
            child.on('close', (code) => {
                const name = stdout.trim().split('\n')[0]?.trim();
                if (code !== 0 || !name) {
                    try { fs.unlinkSync(tempFile); } catch (_) {}
                    return reject(new Error('No se pudo obtener la impresora por defecto'));
                }
                sendToWindowsPrinter(tempFile, name, resolve, reject);
            });
            child.on('error', () => {
                try { fs.unlinkSync(tempFile); } catch (_) {}
                reject(new Error('No se pudo lanzar PowerShell para detectar impresora'));
            });
        } else {
            sendToWindowsPrinter(tempFile, printer, resolve, reject);
        }
    });
}

/**
 * Envía datos RAW a impresora Windows usando WinAPI (WritePrinter via PowerShell).
 * No requiere que la impresora esté compartida — funciona con impresoras locales
 * instaladas y desde cuentas de servicio (LocalSystem/NSSM).
 * Usa tipo de dato RAW para que el spooler no procese los bytes ESC/POS.
 */
function sendToWindowsPrinter(tempFile, printerName, resolve, reject) {
    // H-003: validar nombre antes de pasarlo al shell
    if (!SAFE_PRINTER_RE.test(printerName)) {
        try { fs.unlinkSync(tempFile); } catch (_) {}
        return reject(new Error('Nombre de impresora contiene caracteres inválidos'));
    }

    // Escribir script PowerShell en archivo temporal para evitar problemas de escaping
    const psFile = path.join(os.tmpdir(), `vendy_ps_${Date.now()}.ps1`);

    // Rutas con barras forward funcionan en PowerShell y evitan escaping de backslash
    const safeTempFile = tempFile.replace(/\\/g, '/');
    const safePrinterName = printerName.replace(/'/g, "''"); // escape single quotes en PS

    const psScript = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class VendyPrint {
    [StructLayout(LayoutKind.Sequential)]
    public struct DOCINFOW {
        [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
        [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
        [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
    }
    [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool OpenPrinter(string n, out IntPtr h, IntPtr d);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool ClosePrinter(IntPtr h);
    [DllImport("winspool.drv", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern int StartDocPrinter(IntPtr h, int l, ref DOCINFOW d);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool EndDocPrinter(IntPtr h);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool StartPagePrinter(IntPtr h);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool EndPagePrinter(IntPtr h);
    [DllImport("winspool.drv", SetLastError=true)]
    public static extern bool WritePrinter(IntPtr h, IntPtr b, int c, out int w);
    public static bool SendRaw(string name, byte[] data) {
        IntPtr hp = IntPtr.Zero;
        if (!OpenPrinter(name, out hp, IntPtr.Zero)) return false;
        DOCINFOW di = new DOCINFOW(); di.pDocName = "VendyPrint"; di.pDataType = "RAW";
        if (StartDocPrinter(hp, 1, ref di) == 0) { ClosePrinter(hp); return false; }
        StartPagePrinter(hp);
        IntPtr ptr = Marshal.AllocCoTaskMem(data.Length);
        Marshal.Copy(data, 0, ptr, data.Length);
        int written; bool ok = WritePrinter(hp, ptr, data.Length, out written);
        Marshal.FreeCoTaskMem(ptr);
        EndPagePrinter(hp); EndDocPrinter(hp); ClosePrinter(hp);
        return ok;
    }
}
"@
$bytes = [System.IO.File]::ReadAllBytes('${safeTempFile}')
$ok = [VendyPrint]::SendRaw('${safePrinterName}', $bytes)
if (-not $ok) { throw "WritePrinter devolvio false - impresora no encontrada o sin acceso: ${safePrinterName}" }
`;

    try {
        fs.writeFileSync(psFile, psScript, 'utf8');
    } catch (err) {
        try { fs.unlinkSync(tempFile); } catch (_) {}
        return reject(new Error(`No se pudo crear script temporal: ${err.message}`));
    }

    const child = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile
    ]);

    let stdoutOutput = '';
    let stderrOutput = '';
    child.stdout.on('data', (data) => { stdoutOutput += data; });
    child.stderr.on('data', (data) => { stderrOutput += data; });

    // Timeout de 15s: si PowerShell no termina, matar el proceso y rechazar
    // Evita que un spooler bloqueado paralice el procesador indefinidamente
    const PRINT_TIMEOUT_MS = 15000;
    const killTimer = setTimeout(() => {
        child.kill();
        try { fs.unlinkSync(tempFile); } catch (_) {}
        try { fs.unlinkSync(psFile); } catch (_) {}
        reject(new Error('Timeout imprimiendo (15s) — spooler bloqueado o impresora sin respuesta'));
    }, PRINT_TIMEOUT_MS);

    child.on('error', (err) => {
        clearTimeout(killTimer);
        try { fs.unlinkSync(tempFile); } catch (_) {}
        try { fs.unlinkSync(psFile); } catch (_) {}
        reject(new Error(`No se pudo lanzar powershell.exe: ${err.message}`));
    });

    child.on('close', (code) => {
        clearTimeout(killTimer);
        try { fs.unlinkSync(tempFile); } catch (_) {}
        try { fs.unlinkSync(psFile); } catch (_) {}
        const diagnostics = [stdoutOutput, stderrOutput].filter(Boolean).join(' | ');
        if (code !== 0) {
            reject(new Error(`Error imprimiendo en Windows (WinAPI) código ${code}: ${diagnostics || 'sin detalles'}`));
        } else {
            resolve({ success: true, printer: printerName, diagnostics });
        }
    });
}

/**
 * Función principal de impresión
 */
async function print(buffer, options = {}) {
    if (IS_WINDOWS) {
        return printWindows(buffer, options.printerName);
    } else if (IS_LINUX) {
        const device = options.device || PRINTER_DEVICE;
        const printerName = options.printerName || PRINTER_NAME;

        // Si se especifica un nombre de impresora, usar CUPS
        if (printerName) {
            return await printLinuxCups(buffer, printerName);
        }

        // Sin nombre de impresora, usar dispositivo RAW
        return printLinuxRawDevice(buffer, device);
    } else {
        throw new Error(`Sistema operativo no soportado: ${os.platform()}`);
    }
}

/**
 * Lista impresoras disponibles
 */
function listPrinters() {
    return new Promise((resolve, reject) => {
        if (IS_WINDOWS) {
            // PowerShell reemplaza wmic (deprecado en Windows 11)
            const child = spawn('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                '-Command',
                'Get-Printer | Select-Object Name,Default | ConvertTo-Json'
            ]);
            let stdout = '';
            child.stdout.on('data', d => { stdout += d; });
            child.on('close', (code) => {
                if (code !== 0) return reject(new Error('PowerShell falló al listar impresoras'));
                try {
                    const raw = JSON.parse(stdout.trim() || '[]');
                    const arr = Array.isArray(raw) ? raw : [raw];
                    resolve(arr.map(p => ({ name: p.Name, isDefault: !!p.Default })).filter(p => p.name));
                } catch (_) {
                    resolve([]);
                }
            });
            child.on('error', (err) => reject(err));
        } else if (IS_LINUX) {
            // Buscar dispositivos USB
            const devices = [];

            // Dispositivos USB directos
            for (let i = 0; i < 4; i++) {
                const usbPath = `/dev/usb/lp${i}`;
                const lpPath = `/dev/lp${i}`;

                if (fs.existsSync(usbPath)) {
                    devices.push({ name: usbPath, type: 'usb' });
                }
                if (fs.existsSync(lpPath)) {
                    devices.push({ name: lpPath, type: 'parallel' });
                }
            }

            // También listar impresoras CUPS si está disponible
            exec('lpstat -p 2>/dev/null', (err, stdout) => {
                if (!err && stdout) {
                    const lines = stdout.trim().split('\n');
                    lines.forEach(line => {
                        const match = line.match(/printer (\S+)/);
                        if (match) {
                            devices.push({ name: match[1], type: 'cups' });
                        }
                    });
                }
                resolve(devices);
            });
        } else {
            resolve([]);
        }
    });
}

/**
 * Maneja las peticiones HTTP
 */
function handleRequest(req, res) {
    const clientIp = req.socket.remoteAddress || 'unknown';
    const origin = req.headers['origin'] || '';

    // CORS: permitir orígenes configurados o wildcard (*)
    if (ALLOWED_ORIGINS.includes('*')) {
        // Wildcard: permitir cualquier origen (útil para que funcione desde cualquier dominio)
        res.setHeader('Access-Control-Allow-Origin', origin || '*');
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else if (origin && ALLOWED_ORIGINS.includes(origin)) {
        // Origen específico en la lista
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    } else if (!origin) {
        // Requests sin origin (curl, mismo servidor)
        res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGINS[0] || '*');
    }
    // Si no cumple ninguna condición, no se setea header → browser bloquea

    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Print-Key');
    res.setHeader('Vary', 'Origin');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    // Rate limiting
    if (isRateLimited(clientIp)) {
        incrementMetric('requests', 'rateLimit');
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Demasiadas solicitudes. Intente en 1 minuto.' }));
        logEvent('WARN', 'Rate limited', { ip: clientIp });
        return;
    }

    // Incrementar contador de requests
    incrementMetric('requests', 'total');

    const url = new URL(req.url, `http://localhost:${PORT}`);

    // Autenticación por API key — obligatoria en todos los endpoints excepto los públicos
    // /status y /pair son públicos porque el frontend los llama antes de tener la clave
    const PUBLIC_PATHS = new Set(['/status', '/pair', '/device-status']);
    if (!PUBLIC_PATHS.has(url.pathname)) {
        const providedKey = req.headers['x-print-key'] || '';
        if (providedKey !== apiKey) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'API key inválida o faltante' }));
            logEvent('WARN', 'Auth failed', { ip: clientIp, path: req.url });
            return;
        }
    }

    // GET /status - Verificar que el servidor está corriendo
    if (req.method === 'GET' && url.pathname === '/status') {
        const memoryUsage = process.memoryUsage();

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'online',
            platform: os.platform(),
            version: '1.0.0',
            uptime: getUptime(),
            defaultDevice: IS_LINUX ? (PRINTER_NAME || PRINTER_DEVICE) : PRINTER_NAME,
            autonomous: {
                paired: supabaseClient.isAuthenticated(),
                processing: printJobProcessor.isRunning(),
                organizationId: supabaseClient.getOrgId() || null
            },
            metrics: {
                requests: metrics.requests,
                printJobs: metrics.printJobs
            },
            system: {
                memory: {
                    used: `${Math.round(memoryUsage.heapUsed / 1024 / 1024)}MB`,
                    total: `${Math.round(memoryUsage.heapTotal / 1024 / 1024)}MB`
                },
                nodeVersion: process.version,
                pid: process.pid
            }
        }));
        logEvent('INFO', 'GET /status');
        return;
    }

    // GET /printers - Listar impresoras disponibles
    if (req.method === 'GET' && url.pathname === '/printers') {
        listPrinters()
            .then(printers => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ printers }));
                logEvent('INFO', 'GET /printers', { count: printers.length });
            })
            .catch(err => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
                logEvent('ERROR', 'GET /printers', { error: err.message });
            });
        return;
    }

    // GET /test/charset - Imprimir tabla de caracteres (diagnóstico)
    if (req.method === 'GET' && url.pathname === '/test/charset') {
        const printerWidth = url.searchParams.get('width') || '58mm';
        const codepage = url.searchParams.get('codepage');
        const international = url.searchParams.get('international');
        const device = url.searchParams.get('device');
        const printerName = url.searchParams.get('printer');

        const buffer = generateCharsetTest(
            printerWidth,
            codepage !== null ? Number(codepage) : null,
            international !== null ? Number(international) : null
        );

        print(buffer, { device, printerName })
            .then(result => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, ...result }));
                logEvent('INFO', 'GET /test/charset', { printerWidth, codepage, international, device, printerName });
            })
            .catch(err => {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
                logEvent('ERROR', 'GET /test/charset', { error: err.message });
            });
        return;
    }

    // POST /print - Imprimir ticket
    if (req.method === 'POST' && url.pathname === '/print') {
        let body = '';
        let bodySize = 0;

        req.on('data', chunk => {
            bodySize += chunk.length;
            if (bodySize > MAX_BODY_SIZE) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Body demasiado grande (max 1MB)' }));
                req.destroy();
                return;
            }
            body += chunk.toString();
        });

        req.on('end', async () => {
            if (bodySize > MAX_BODY_SIZE) return;
            try {
                const data = JSON.parse(body);

                // Validar tipo de ticket
                const validTypes = ['cashier', 'kitchen', 'barista'];
                if (!data.type || !validTypes.includes(data.type)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        error: `Tipo de ticket inválido. Usar: ${validTypes.join(', ')}`
                    }));
                    return;
                }

                // Generar buffer ESC/POS según tipo
                let buffer;
                const printerWidth = data.printerWidth || '80mm';
                const customMaxChars = data.customMaxChars || null;

                switch (data.type) {
                    case 'cashier':
                        buffer = generateCashierTicket(data, printerWidth, customMaxChars);
                        break;
                    case 'kitchen':
                        buffer = generateKitchenCommand(data, printerWidth, customMaxChars);
                        break;
                    case 'barista':
                        buffer = generateBaristaCommand(data, printerWidth, customMaxChars);
                        break;
                }

                // Imprimir
                const result = await print(buffer, {
                    device: data.device,
                    printerName: data.printerName
                });

                console.log(`[${new Date().toISOString()}] Ticket ${data.type} impreso - Mesa: ${data.table || 'N/A'}`);
                logEvent('INFO', 'POST /print', {
                    type: data.type,
                    table: data.table || null,
                    printerWidth,
                    device: data.device || null,
                    printerName: data.printerName || null
                });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: true,
                    message: 'Ticket impreso correctamente',
                    ...result
                }));

            } catch (err) {
                console.error(`[${new Date().toISOString()}] Error:`, err.message);
                logEvent('ERROR', 'POST /print', { error: err.message });

                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    success: false,
                    error: err.message
                }));
            }
        });
        return;
    }

    // POST /print/raw - Imprimir buffer ESC/POS directo (para testing)
    if (req.method === 'POST' && url.pathname === '/print/raw') {
        const chunks = [];
        let bodySize = 0;

        req.on('data', chunk => {
            bodySize += chunk.length;
            if (bodySize > MAX_BODY_SIZE) {
                res.writeHead(413, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Body demasiado grande (max 1MB)' }));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', async () => {
            if (bodySize > MAX_BODY_SIZE) return;
            try {
                const buffer = Buffer.concat(chunks);
                const device = url.searchParams.get('device');
                const printerName = url.searchParams.get('printer');

                const result = await print(buffer, { device, printerName });

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, ...result }));
                logEvent('INFO', 'POST /print/raw', {
                    device: device || null,
                    printerName: printerName || null,
                    bytes: buffer.length
                });

            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
                logEvent('ERROR', 'POST /print/raw', { error: err.message });
            }
        });
        return;
    }

    // =====================================================
    // ENDPOINTS DE MODO AUTÓNOMO (Camino A)
    // =====================================================

    // POST /pair - Vincular print-server con organización
    if (req.method === 'POST' && url.pathname === '/pair') {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            try {
                const { code, supabaseUrl, anonKey } = JSON.parse(body);
                const result = await pairing.pair(code, supabaseUrl, anonKey, print, logEvent);

                // Incluir la API key en la respuesta de pairing exitoso para que el frontend la guarde
                if (result.success) {
                    result.printApiKey = apiKey;
                }

                const status = result.success ? 200 : 400;
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
                logEvent(result.success ? 'INFO' : 'WARN', 'POST /pair', result);
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: false, error: err.message }));
                logEvent('ERROR', 'POST /pair', { error: err.message });
            }
        });
        return;
    }

    // GET /device-status - Estado del device pareado
    if (req.method === 'GET' && url.pathname === '/device-status') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            paired: supabaseClient.isAuthenticated(),
            processing: printJobProcessor.isRunning(),
            organizationId: supabaseClient.getOrgId() || null,
            deviceId: supabaseClient.getDeviceId() || null
        }));
        return;
    }

    // POST /unpair - Desvincular device
    if (req.method === 'POST' && url.pathname === '/unpair') {
        const result = pairing.unpair(logEvent);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        logEvent('INFO', 'POST /unpair');
        return;
    }

    // Ruta no encontrada
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
        error: 'Ruta no encontrada',
        routes: {
            'GET /status': 'Estado del servidor',
            'GET /printers': 'Lista de impresoras',
            'POST /print': 'Imprimir ticket (JSON)',
            'POST /print/raw': 'Imprimir buffer ESC/POS directo',
            'POST /pair': 'Vincular con organizacion',
            'GET /device-status': 'Estado del dispositivo',
            'POST /unpair': 'Desvincular dispositivo'
        }
    }));
}

// ─── Global error handlers ────────────────────────────────────────────────────
// Sin estos, cualquier excepción no capturada mata el proceso en Node.js 15+.
// Aquí la registramos en ambos logs antes de dejar que el proceso termine.

process.on('uncaughtException', (err) => {
    const msg = `[CRASH] uncaughtException: ${err.message}`;
    console.error(msg, err.stack);
    serverLog('CRASH', msg, { stack: err.stack?.slice(0, 500) });
    // Dar 500ms para que serverLog termine de escribir antes del exit
    setTimeout(() => process.exit(1), 500);
});

process.on('unhandledRejection', (reason) => {
    const msg = `[CRASH] unhandledRejection: ${reason instanceof Error ? reason.message : String(reason)}`;
    console.error(msg);
    serverLog('CRASH', msg, {
        stack: reason instanceof Error ? reason.stack?.slice(0, 500) : null
    });
    // No exit — unhandledRejection no siempre es fatal; logueamos y seguimos
});

// Crear servidor
const server = http.createServer(handleRequest);

// Iniciar servidor
server.listen(PORT, () => {
    console.log('╔════════════════════════════════════════════╗');
    console.log('║     VENDY PRINT SERVER - ESC/POS v1.0      ║');
    console.log('╠════════════════════════════════════════════╣');
    console.log(`║  Puerto: ${PORT}                              ║`);
    console.log(`║  Sistema: ${os.platform().padEnd(31)}║`);
    if (IS_LINUX) {
        console.log(`║  Dispositivo: ${PRINTER_DEVICE.padEnd(27)}║`);
    }
    console.log('╠════════════════════════════════════════════╣');
    console.log('║  Endpoints:                                ║');
    console.log('║    GET  /status   - Estado del servidor    ║');
    console.log('║    GET  /printers - Lista impresoras       ║');
    console.log('║    POST /print    - Imprimir ticket        ║');
    console.log('╠════════════════════════════════════════════╣');
    console.log(`║  API Key: ACTIVA (auto-generada)              ║`);
    console.log(`║  CORS: ${ALLOWED_ORIGINS.length} origen(es) permitido(s)${' '.repeat(Math.max(0, 13 - String(ALLOWED_ORIGINS.length).length))}║`);
    console.log(`║  Rate limit: ${RATE_LIMIT_MAX} req/min${' '.repeat(Math.max(0, 21 - String(RATE_LIMIT_MAX).length))}║`);
    console.log('╚════════════════════════════════════════════╝');
    console.log('');
    console.log('Esperando trabajos de impresión...');
    logEvent('INFO', 'Server started', {
        port: PORT,
        platform: os.platform(),
        device: IS_LINUX ? PRINTER_DEVICE : null,
        printerName: PRINTER_NAME || null
    });

    // Iniciar log rotation automática para ambos logs
    startRotation(LOG_FILE);
    startRotation(SERVER_LOG_FILE);
    console.log('📋 Log rotation activada (max: 10MB por archivo, 5 archivos)');

    // Intentar auto-start del modo autónomo
    pairing.tryAutoStart(print, logEvent).then(started => {
        if (started) {
            console.log('✅ Modo autónomo activo - procesando cola de impresión');
            serverLog('INFO', 'Servidor iniciado — modo autónomo activo', { port: PORT, pid: process.pid });
        } else {
            console.log('ℹ️  Sin vinculación. Use POST /pair para vincular con una organización.');
            serverLog('INFO', 'Servidor iniciado — esperando vinculación', { port: PORT, pid: process.pid });
        }
    }).catch(err => {
        console.error('⚠️  Error en auto-start:', err.message);
        serverLog('ERROR', `Error en auto-start: ${err.message}`);
    });

    // Watchdog: cada 30s verifica que el procesador esté activo y lo reinicia si no lo está.
    // Protege contra: (1) tryAutoStart fallido por red, (2) token expirado, (3) crash silencioso.
    setInterval(async () => {
        if (!supabaseClient.isAuthenticated()) return; // sin credenciales, nada que hacer
        if (printJobProcessor.isRunning()) return;     // todo bien

        serverLog('WARN', '[watchdog] Procesador detenido inesperadamente — reiniciando');
        console.warn('[watchdog] Processor stopped unexpectedly — restarting...');
        try {
            const authOk = await supabaseClient.init();
            if (authOk) {
                await orgConfig.fetch();
                printJobProcessor.start(print, logEvent, serverLog);
                serverLog('INFO', '[watchdog] Procesador reiniciado correctamente');
                console.log('[watchdog] ✅ Processor restarted');
            } else {
                serverLog('ERROR', '[watchdog] Re-auth fallida — reintentando en próximo ciclo');
            }
        } catch (err) {
            serverLog('ERROR', `[watchdog] Error al reiniciar: ${err.message}`);
        }
    }, 30000);
});

// Manejar cierre graceful
process.on('SIGINT', () => {
    console.log('\nCerrando servidor...');
    printJobProcessor.stop();
    server.close(() => {
        console.log('Servidor cerrado.');
        logEvent('INFO', 'Server stopped');
        process.exit(0);
    });
});

module.exports = { server, print, listPrinters, serverLog };
