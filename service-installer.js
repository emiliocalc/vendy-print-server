/**
 * Instalador de servicio de Windows para Vendy Print Server
 * Instala el servidor como servicio que se ejecuta automáticamente
 */

const Service = require('node-windows').Service;
const path = require('path');

// Crear servicio
const svc = new Service({
    name: 'Vendy Print Server',
    description: 'Servidor de impresión térmica ESC/POS para Vendy',
    script: path.join(__dirname, 'server.js'),
    nodeOptions: [],
    env: [
        {
            name: "NODE_ENV",
            value: "production"
        }
    ]
});

// Escuchar eventos
svc.on('install', function() {
    console.log('✅ Servicio instalado correctamente');
    console.log('⏳ Esperando 3 segundos para que Windows registre el servicio...');
    // Esperar antes de start() — el SCM necesita un momento después del install
    // para registrar completamente el servicio, o el primer inicio falla.
    setTimeout(() => {
        console.log('🚀 Iniciando servicio...');
        svc.start();
    }, 3000);
});

svc.on('start', function() {
    console.log('✅ Servicio iniciado correctamente');
    console.log('');
    console.log('╔════════════════════════════════════════════╗');
    console.log('║  ✅ INSTALACIÓN COMPLETADA                 ║');
    console.log('╚════════════════════════════════════════════╝');
    console.log('');
    console.log('El servidor de impresión está corriendo y se');
    console.log('iniciará automáticamente cada vez que encienda');
    console.log('su computadora.');
    console.log('');
    console.log('📍 Puerto: 9123');
    console.log('🌐 Estado: http://localhost:9123/status');
    console.log('');
    console.log('Para desinstalar el servicio, ejecute:');
    console.log('   desinstalar-servicio.bat');
    console.log('');
});

svc.on('alreadyinstalled', function() {
    console.log('⚠️  El servicio ya está instalado');
    console.log('');
    console.log('Si desea reinstalarlo:');
    console.log('1. Ejecute: desinstalar-servicio.bat');
    console.log('2. Luego ejecute este instalador nuevamente');
});

svc.on('error', function(err) {
    console.error('❌ Error:', err);
});

// Instalar servicio
console.log('');
console.log('╔════════════════════════════════════════════╗');
console.log('║  VENDY PRINT - INSTALAR SERVICIO           ║');
console.log('╚════════════════════════════════════════════╝');
console.log('');
console.log('📦 Instalando servicio de Windows...');
console.log('');

svc.install();
