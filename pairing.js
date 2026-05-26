/**
 * Módulo de pairing para print-server
 *
 * Recibe un código de 6 dígitos, lo valida contra la Edge Function,
 * guarda credenciales localmente y arranca el procesador autónomo.
 */

const supabaseClient = require('./supabaseClient');
const orgConfig = require('./orgConfig');
const printJobProcessor = require('./printJobProcessor');

// URL de la Edge Function (se configura por env o se deduce de supabaseUrl)
function getEdgeFunctionUrl() {
    const creds = supabaseClient.loadCredentials();
    const baseUrl = process.env.SUPABASE_URL || (creds && creds.supabaseUrl) || '';

    // Edge Functions URL: https://<project>.supabase.co/functions/v1/<fn-name>
    if (baseUrl) {
        return `${baseUrl}/functions/v1/pair-print-device`;
    }
    return null;
}

/**
 * Ejecutar pairing con código de 6 dígitos
 * @param {string} code - Código de pairing
 * @param {string} supabaseUrl - URL de Supabase (para primer pairing, viene del frontend)
 * @param {Function} printFn - Función print() del server
 * @param {Function} logFn - Función logEvent() del server
 * @returns {object} { success, error? }
 */
async function pair(code, supabaseUrl, anonKey, printFn, logFn) {
    if (!code || code.length !== 6) {
        return { success: false, error: 'Codigo debe tener 6 digitos' };
    }

    const edgeUrl = supabaseUrl
        ? `${supabaseUrl}/functions/v1/pair-print-device`
        : getEdgeFunctionUrl();

    if (!edgeUrl) {
        return { success: false, error: 'No se pudo determinar URL de Supabase' };
    }

    try {
        logFn('INFO', `[pairing] Attempting pairing with code: ${code}`);

        const headers = { 'Content-Type': 'application/json' };
        if (anonKey) {
            headers['Authorization'] = `Bearer ${anonKey}`;
            headers['apikey'] = anonKey;
        }

        const response = await fetch(edgeUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify({ pairing_code: code })
        });

        const result = await response.json();

        if (!result.success || !result.credentials) {
            return { success: false, error: result.error || 'Pairing failed' };
        }

        // Guardar credenciales (access_token + refresh_token de Supabase Auth)
        const finalCredentials = {
            ...result.credentials,
            anonKey: result.credentials.anonKey || anonKey  // fallback por si acaso
        };
        supabaseClient.saveCredentials(finalCredentials);

        // Inicializar conexión Supabase
        const authOk = await supabaseClient.init();
        if (!authOk) {
            const reason = supabaseClient.getLastInitError() || 'unknown';
            logFn('ERROR', `[pairing] Auth failed: ${reason}`);
            supabaseClient.clearCredentials();
            return { success: false, error: `Auth failed: ${reason}` };
        }

        // Cargar config de la org
        await orgConfig.fetch();
        orgConfig.subscribe();

        // Arrancar procesador
        printJobProcessor.start(printFn, logFn, null);

        logFn('INFO', `[pairing] Success! Org: ${supabaseClient.getOrgId()}`);
        return { success: true, organizationId: supabaseClient.getOrgId() };

    } catch (err) {
        logFn('ERROR', `[pairing] Error: ${err.message}`);
        return { success: false, error: err.message };
    }
}

/**
 * Desvincular: detener procesador, limpiar credenciales
 */
function unpair(logFn) {
    printJobProcessor.stop();
    orgConfig.stop();
    supabaseClient.clearCredentials();
    if (logFn) logFn('INFO', '[pairing] Device unpaired');
    return { success: true };
}

/**
 * Intentar iniciar modo autónomo con credenciales guardadas.
 * Se llama al arrancar el server.
 * Reintenta con backoff si la red no está lista (EAI_AGAIN, fetch failed, etc.)
 */
async function tryAutoStart(printFn, logFn, { maxRetries = 5, initialDelay = 3000 } = {}) {
    const creds = supabaseClient.loadCredentials();
    if (!creds) {
        logFn('INFO', '[pairing] No credentials found - waiting for pairing');
        return false;
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        logFn('INFO', `[pairing] Auto-start attempt ${attempt}/${maxRetries}...`);

        try {
            const authOk = await supabaseClient.init();
            if (authOk) {
                await orgConfig.fetch();
                orgConfig.subscribe();
                printJobProcessor.start(printFn, logFn, null);
                logFn('INFO', '[pairing] Auto-start successful');
                return true;
            }
        } catch (err) {
            logFn('WARN', `[pairing] Auto-start attempt ${attempt} error: ${err.message}`);
        }

        if (attempt < maxRetries) {
            const delay = initialDelay * attempt;
            logFn('INFO', `[pairing] Retrying in ${delay / 1000}s...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }

    logFn('WARN', '[pairing] Auto-start failed after all retries - credentials may be expired or network unavailable');
    return false;
}

module.exports = { pair, unpair, tryAutoStart };
