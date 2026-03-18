/**
 * Sistema de rotación de logs para print-server
 * Evita que los archivos de log crezcan indefinidamente
 */

const fs = require('fs');
const path = require('path');

// Configuración de rotación
const config = {
    maxSize: 10 * 1024 * 1024, // 10 MB
    maxFiles: 5, // Mantener últimos 5 archivos
    checkInterval: 60 * 1000 // Verificar cada 1 minuto
};

/**
 * Obtiene el tamaño de un archivo
 */
function getFileSize(filePath) {
    try {
        const stats = fs.statSync(filePath);
        return stats.size;
    } catch (err) {
        return 0;
    }
}

/**
 * Rota un archivo de log
 * Renombra: file.log -> file.1.log -> file.2.log -> ... -> elimina file.5.log
 */
function rotateLogFile(logPath) {
    const dir = path.dirname(logPath);
    const ext = path.extname(logPath);
    const basename = path.basename(logPath, ext);

    try {
        // Eliminar el archivo más antiguo si existe
        const oldestFile = path.join(dir, `${basename}.${config.maxFiles}${ext}`);
        if (fs.existsSync(oldestFile)) {
            fs.unlinkSync(oldestFile);
        }

        // Rotar archivos existentes
        for (let i = config.maxFiles - 1; i >= 1; i--) {
            const currentFile = path.join(dir, `${basename}.${i}${ext}`);
            const nextFile = path.join(dir, `${basename}.${i + 1}${ext}`);

            if (fs.existsSync(currentFile)) {
                fs.renameSync(currentFile, nextFile);
            }
        }

        // Rotar el archivo actual
        const rotatedFile = path.join(dir, `${basename}.1${ext}`);
        if (fs.existsSync(logPath)) {
            fs.renameSync(logPath, rotatedFile);
        }

        // Crear nuevo archivo vacío
        fs.writeFileSync(logPath, '');

        console.log(`[LOG ROTATION] ${path.basename(logPath)} rotado exitosamente`);
        return true;
    } catch (err) {
        console.error(`[LOG ROTATION] Error rotando ${logPath}:`, err.message);
        return false;
    }
}

/**
 * Verifica si un archivo necesita rotación
 */
function checkRotation(logPath) {
    if (!fs.existsSync(logPath)) return false;

    const size = getFileSize(logPath);
    if (size >= config.maxSize) {
        rotateLogFile(logPath);
        return true;
    }
    return false;
}

/**
 * Inicia el sistema de rotación automática para un archivo
 */
function startRotation(logPath) {
    // Verificación inicial
    checkRotation(logPath);

    // Verificar periódicamente
    const interval = setInterval(() => {
        checkRotation(logPath);
    }, config.checkInterval);

    return () => clearInterval(interval);
}

/**
 * Inicia rotación para múltiples archivos
 */
function startMultipleRotations(logPaths) {
    const stopCallbacks = logPaths.map(logPath => startRotation(logPath));

    return () => {
        stopCallbacks.forEach(stop => stop());
    };
}

/**
 * Limpia archivos de log antiguos manualmente
 */
function cleanOldLogs(logPath, daysToKeep = 7) {
    const dir = path.dirname(logPath);
    const ext = path.extname(logPath);
    const basename = path.basename(logPath, ext);

    const cutoffTime = Date.now() - (daysToKeep * 24 * 60 * 60 * 1000);

    try {
        const files = fs.readdirSync(dir);
        let deletedCount = 0;

        files.forEach(file => {
            if (file.startsWith(basename) && file.endsWith(ext) && file !== path.basename(logPath)) {
                const filePath = path.join(dir, file);
                const stats = fs.statSync(filePath);

                if (stats.mtimeMs < cutoffTime) {
                    fs.unlinkSync(filePath);
                    deletedCount++;
                }
            }
        });

        if (deletedCount > 0) {
            console.log(`[LOG CLEANUP] Eliminados ${deletedCount} archivos antiguos`);
        }
    } catch (err) {
        console.error('[LOG CLEANUP] Error limpiando logs antiguos:', err.message);
    }
}

module.exports = {
    startRotation,
    startMultipleRotations,
    checkRotation,
    rotateLogFile,
    cleanOldLogs,
    config
};
