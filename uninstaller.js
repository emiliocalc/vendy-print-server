/**
 * Vendy Print Server — Uninstaller
 * Detiene el servidor y elimina accesos directos.
 */
const { execSync } = require('child_process');
const path = require('path');
const fs   = require('fs');

const startupLink = path.join(
    process.env.APPDATA,
    'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup',
    'VendyPrintServer.lnk'
);
const desktopLink = path.join(process.env.USERPROFILE, 'Desktop', 'Vendy Print Server.lnk');
const vbsLauncher = path.join(path.dirname(process.execPath), 'VendyPrintServer-Launch.vbs');

function runPs(lines, tmpName) {
    const ps = '\uFEFF' + lines.join('\r\n');
    const tmp = path.join(process.env.TEMP || __dirname, tmpName);
    fs.writeFileSync(tmp, ps, 'utf8');
    try {
        return execSync(`powershell -ExecutionPolicy Bypass -File "${tmp}"`, { windowsHide: true }).toString().trim();
    } catch (_) {
        return '';
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
    }
}

// Confirmación antes de desinstalar
const confirmed = runPs([
    `Add-Type -AssemblyName PresentationFramework`,
    `$r = [System.Windows.MessageBox]::Show("Estas seguro que deseas desinstalar Vendy Print Server?\`n\`nSe eliminaran los accesos directos de inicio y escritorio.", 'Vendy Print Server', 'YesNo', 'Warning')`,
    `Write-Output $r`,
], 'vendy_uninstall_confirm.ps1');

if (confirmed !== 'Yes') process.exit(0);

// Matar proceso si está corriendo
try { execSync('taskkill /F /IM vendy-print-server.exe /T', { windowsHide: true }); } catch (_) {}

// Borrar accesos directos
function removeIfExists(p) { if (fs.existsSync(p)) try { fs.unlinkSync(p); } catch (_) {} }
removeIfExists(startupLink);
removeIfExists(desktopLink);
removeIfExists(vbsLauncher);

// Mensaje de éxito
runPs([
    `Add-Type -AssemblyName PresentationFramework`,
    `[System.Windows.MessageBox]::Show("Vendy Print Server desinstalado correctamente.\`n\`nSe eliminaron los accesos directos de inicio y escritorio.", 'Vendy Print Server', 'OK', 'Information')`,
], 'vendy_uninstall_msg.ps1');
