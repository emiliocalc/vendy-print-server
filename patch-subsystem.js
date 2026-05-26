/**
 * Cambia el subsistema del .exe de CONSOLE (3) a WINDOWS (2).
 * Esto elimina la ventana de consola sin afectar ninguna funcionalidad.
 * Uso: node patch-subsystem.js <ruta-al-exe>
 */
const fs = require('fs');
const exePath = process.argv[2];

if (!exePath) { console.error('Uso: node patch-subsystem.js <exe>'); process.exit(1); }

const buf = fs.readFileSync(exePath);

// e_lfanew: offset al PE header (en 0x3C)
const peOffset = buf.readUInt32LE(0x3C);
if (buf.readUInt32LE(peOffset) !== 0x00004550) {
    console.error('No es un archivo PE válido'); process.exit(1);
}

// Subsystem está en el Optional Header, offset 68 desde su inicio
// Optional Header empieza en peOffset + 4 (sig) + 20 (COFF) = peOffset + 24
const subsystemOffset = peOffset + 24 + 68;
const current = buf.readUInt16LE(subsystemOffset);

if (current === 3) {
    buf.writeUInt16LE(2, subsystemOffset);
    fs.writeFileSync(exePath, buf);
    console.log('[patch] Subsistema cambiado: CONSOLE → WINDOWS (sin consola)');
} else {
    console.log('[patch] Subsistema ya es WINDOWS, no se modifica');
}
