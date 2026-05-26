/**
 * Módulo de autenticación Supabase para print-server
 *
 * Usa un Auth user con app_metadata generado por la Edge Function
 * pair-print-device. Supabase firma los tokens (ES256) con su clave privada.
 *
 * Credentials format: { supabaseUrl, anonKey, access_token, refresh_token, organizationId, deviceId }
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Polyfill WebSocket para Node.js (Supabase Realtime lo requiere en globalThis)
if (!globalThis.WebSocket) {
    globalThis.WebSocket = require('ws');
}

// NSSM configura AppDirectory = directorio de instalación, por lo que process.cwd()
// apunta al directorio real del exe en disco (ej. C:\Program Files\Vendy Print Server\).
// NO usar __dirname: pkg compila con filesystem virtual C:\snapshot\ (solo lectura).
const CREDENTIALS_FILE = path.join(process.cwd(), '.vendy-credentials.json');

let supabase = null;
let organizationId = null;
let deviceId = null;
let credentials = null;
let lastInitError = null;

function loadCredentials() {
    try {
        if (!fs.existsSync(CREDENTIALS_FILE)) return null;
        const raw = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
        return JSON.parse(raw);
    } catch (err) {
        console.error('[supabaseClient] Error loading credentials:', err.message);
        return null;
    }
}

function saveCredentials(creds) {
    try {
        fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), 'utf8');
    } catch (err) {
        console.error('[supabaseClient] Error saving credentials:', err.message);
    }
}

function clearCredentials() {
    try {
        if (fs.existsSync(CREDENTIALS_FILE)) fs.unlinkSync(CREDENTIALS_FILE);
    } catch (err) {
        console.error('[supabaseClient] Error clearing credentials:', err.message);
    }
    supabase = null;
    organizationId = null;
    deviceId = null;
    credentials = null;
}

async function init() {
    lastInitError = null;
    credentials = loadCredentials();
    if (!credentials) {
        lastInitError = 'No credentials file found';
        return false;
    }

    const { supabaseUrl, anonKey, access_token, refresh_token, organizationId: orgId, deviceId: devId } = credentials;

    if (!supabaseUrl || !anonKey || !access_token || !refresh_token || !orgId || !devId) {
        const fields = { supabaseUrl, anonKey, access_token, refresh_token, organizationId: orgId, deviceId: devId };
        const missing = Object.entries(fields).filter(([, v]) => !v).map(([k]) => k);
        lastInitError = `Incomplete credentials — missing: ${missing.join(', ')}`;
        console.error('[supabaseClient]', lastInitError);
        return false;
    }

    supabase = createClient(supabaseUrl, anonKey, {
        auth: {
            persistSession:       false,
            autoRefreshToken:     true,
            detectSessionFromUrl: false,
        }
    });

    // Establecer sesión con los tokens guardados
    const { error: sessionError } = await supabase.auth.setSession({ access_token, refresh_token });
    if (sessionError) {
        lastInitError = `Session error: ${sessionError.message}`;
        console.error('[supabaseClient]', lastInitError);
        supabase = null;
        return false;
    }

    // Cuando el token se refresca automáticamente, guardar los nuevos tokens en disco
    supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'TOKEN_REFRESHED' && session) {
            const current = loadCredentials();
            if (current) {
                saveCredentials({ ...current, access_token: session.access_token, refresh_token: session.refresh_token });
                console.log('[supabaseClient] Tokens refreshed and saved');
            }
            // Actualizar auth de Realtime con el nuevo token
            supabase.realtime.setAuth(session.access_token);
        }
    });

    // Inyectar token en Realtime
    supabase.realtime.setAuth(access_token);

    organizationId = orgId;
    deviceId = devId;

    // Validar que la sesión funcione con una query real
    try {
        const { error } = await supabase
            .from('print_devices')
            .select('id')
            .eq('id', deviceId)
            .single();

        if (error) {
            lastInitError = `Session validation failed: ${error.message} (code: ${error.code})`;
            console.error('[supabaseClient]', lastInitError);
            supabase = null;
            organizationId = null;
            deviceId = null;
            return false;
        }
    } catch (networkErr) {
        console.error('[supabaseClient] Network error during validation:', networkErr.message);
        supabase = null;
        throw networkErr;
    }

    console.log(`[supabaseClient] Authenticated via Auth session. Org: ${organizationId}, Device: ${deviceId}`);
    return true;
}

function getClient() { return supabase; }
function getOrgId() { return organizationId; }
function getDeviceId() { return deviceId; }
function isAuthenticated() { return !!supabase && !!organizationId; }
function getLastInitError() { return lastInitError; }

module.exports = {
    init,
    getClient,
    getOrgId,
    getDeviceId,
    isAuthenticated,
    getLastInitError,
    loadCredentials,
    saveCredentials,
    clearCredentials,
    CREDENTIALS_FILE
};
