/**
 * Módulo de autenticación Supabase para print-server
 *
 * Maneja credenciales del device, auto-refresh de tokens,
 * y persistencia local en .vendy-credentials.json
 */

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

// Polyfill WebSocket para Node.js (Supabase Realtime lo requiere en globalThis)
if (!globalThis.WebSocket) {
    globalThis.WebSocket = require('ws');
}

// __dirname = directorio del archivo .js, siempre correcto independiente de cómo
// se inicie el servicio (NSSM, node-windows, línea de comandos, pkg).
// process.cwd() puede apuntar a C:\Windows\System32 en el primer inicio como servicio.
const CREDENTIALS_FILE = path.join(__dirname, '.vendy-credentials.json');

let supabase = null;
let organizationId = null;
let deviceId = null;
let credentials = null;

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
    credentials = loadCredentials();
    if (!credentials) return false;

    const { supabaseUrl, anonKey, email, password } = credentials;
    if (!supabaseUrl || !anonKey || !email || !password) {
        console.error('[supabaseClient] Incomplete credentials');
        return false;
    }

    supabase = createClient(supabaseUrl, anonKey, {
        auth: { persistSession: false }
    });

    // Autenticar con email/password del device
    let data, error;
    try {
        ({ data, error } = await supabase.auth.signInWithPassword({ email, password }));
    } catch (networkErr) {
        console.error('[supabaseClient] Network error during auth:', networkErr.message);
        supabase = null;
        throw networkErr; // Re-throw so tryAutoStart can retry
    }

    if (error) {
        console.error('[supabaseClient] Auth failed:', error.message);
        supabase = null;
        return false;
    }

    // Setear token JWT en Realtime (necesario con persistSession: false en Node.js)
    if (data.session?.access_token) {
        supabase.realtime.setAuth(data.session.access_token);
        console.log('[supabaseClient] Realtime auth token set');
    }

    // Persistir tokens actualizados en cada refresh
    supabase.auth.onAuthStateChange((event, session) => {
        if (event === 'TOKEN_REFRESHED' && session) {
            console.log('[supabaseClient] Token refreshed');
            // Actualizar token de Realtime también
            supabase.realtime.setAuth(session.access_token);
        }
        if (event === 'SIGNED_OUT') {
            console.warn('[supabaseClient] Session ended - device may have been revoked');
        }
    });

    organizationId = credentials.organizationId || null;
    deviceId = credentials.deviceId || null;

    // Si no tenemos orgId en las credenciales, buscarlo en profiles
    if (!organizationId && data.user) {
        const { data: profile } = await supabase
            .from('profiles')
            .select('organization_id')
            .eq('id', data.user.id)
            .single();
        if (profile) {
            organizationId = profile.organization_id;
            credentials.organizationId = organizationId;
            saveCredentials(credentials);
        }
    }

    console.log(`[supabaseClient] Authenticated. Org: ${organizationId}, Device: ${deviceId}`);
    return true;
}

function getClient() { return supabase; }
function getOrgId() { return organizationId; }
function getDeviceId() { return deviceId; }
function isAuthenticated() { return !!supabase && !!organizationId; }

module.exports = {
    init,
    getClient,
    getOrgId,
    getDeviceId,
    isAuthenticated,
    loadCredentials,
    saveCredentials,
    clearCredentials,
    CREDENTIALS_FILE
};
