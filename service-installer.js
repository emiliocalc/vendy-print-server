/**
 * Instalador de servicio de Windows para Vendy Print Server
 *
 * - Si ya existe una versión anterior → la desinstala primero
 * - Instala la nueva versión como servicio de Windows
 * - El servicio arranca automáticamente en cada reinicio
 */

const Service = require('node-windows').Service;
const path = require('path');

console.log('');
console.log('╔════════════════════════════════════════════╗');
console.log('║     VENDY PRINT SERVER — INSTALADOR        ║');
console.log('╚════════════════════════════════════════════╝');
console.log('');

const svc = new Service({
    name: 'Vendy Print Server',
    description: 'Servidor de impresión térmica ESC/POS para Vendy',
    script: path.join(__dirname, 'server.js'),
    nodeOptions: [],
    env: [{ name: 'NODE_ENV', value: 'production' }]
});

// ─── Eventos ─────────────────────────────────────────────────────────────────

svc.on('install', function () {
    console.log('✅ Servicio instalado correctamente');
    console.log('⏳ Esperando 3 segundos para iniciar...');
    // El SCM necesita un momento para registrar el servicio antes del start
    setTimeout(() => svc.start(), 3000);
});

svc.on('start', function () {
    console.log('✅ Servicio iniciado correctamente');
    console.log('');
    console.log('╔════════════════════════════════════════════╗');
    console.log('║  ✅ INSTALACIÓN COMPLETADA                 ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log('');
    console.log('El servidor de impresión está corriendo.');
    console.log('Se iniciará automáticamente con cada encendido.');
    console.log('');
    console.log('Puerto:  http://localhost:9123');
    console.log('Estado:  http://localhost:9123/status');
    console.log('');
});

svc.on('uninstall', function () {
    console.log('✅ Versión anterior desinstalada');
    console.log('📦 Instalando versión nueva...');
    console.log('');
    // Esperar que Windows libere los recursos antes de reinstalar
    setTimeout(() => svc.install(), 2000);
});

svc.on('error', function (err) {
    console.error('❌ Error:', err);
});

// ─── Flujo principal ──────────────────────────────────────────────────────────

if (svc.exists) {
    console.log('🔄 Se encontró una versión anterior instalada.');
    console.log('   Desinstalando antes de continuar...');
    console.log('');
    svc.uninstall();
} else {
    console.log('📦 Instalando servicio de Windows...');
    console.log('');
    svc.install();
}
