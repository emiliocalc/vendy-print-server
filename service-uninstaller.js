/**
 * Desinstalador de servicio de Windows para Vendy Print Server
 */

const Service = require('node-windows').Service;
const path = require('path');

// Crear referencia al servicio
const svc = new Service({
    name: 'Vendy Print Server',
    script: path.join(__dirname, 'server.js')
});

// Escuchar eventos
svc.on('uninstall', function() {
    console.log('✅ Servicio desinstalado correctamente');
    console.log('');
    console.log('El servidor ya no se iniciará automáticamente.');
    console.log('');
    console.log('Para volver a instalarlo, ejecute:');
    console.log('   INSTALAR_SERVICIO.bat');
    console.log('');
});

svc.on('error', function(err) {
    console.error('❌ Error:', err);
});

svc.on('doesnotexist', function() {
    console.log('⚠️  El servicio no está instalado');
    console.log('');
});

// Desinstalar servicio
console.log('');
console.log('╔════════════════════════════════════════════╗');
console.log('║  VENDY PRINT - DESINSTALAR SERVICIO        ║');
console.log('╚════════════════════════════════════════════╝');
console.log('');
console.log('🗑️  Deteniendo y desinstalando servicio...');
console.log('');

svc.uninstall();
