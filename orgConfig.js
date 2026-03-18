/**
 * Módulo de configuración de organización para print-server
 *
 * Fetch inicial + suscripción Realtime a cambios de la org.
 * Cachea: printer_width, max_chars, header/footer text.
 */

const supabaseClient = require('./supabaseClient');

let orgConfig = null;
let subscription = null;

async function fetch() {
    const supabase = supabaseClient.getClient();
    const orgId = supabaseClient.getOrgId();
    if (!supabase || !orgId) return null;

    const { data, error } = await supabase
        .from('organizations')
        .select('printer_width, printer_58mm_max_chars, printer_80mm_max_chars, ticket_header_text, ticket_footer_text')
        .eq('id', orgId)
        .single();

    if (error) {
        console.error('[orgConfig] Error fetching config:', error.message);
        return null;
    }

    orgConfig = {
        printerWidth: data.printer_width || '80mm',
        maxChars58: data.printer_58mm_max_chars || 20,
        maxChars80: data.printer_80mm_max_chars || 42,
        headerText: data.ticket_header_text || 'CAFETERIA',
        footerText: data.ticket_footer_text || 'Gracias por su visita!'
    };

    console.log('[orgConfig] Loaded:', orgConfig.printerWidth, `header="${orgConfig.headerText}"`);
    return orgConfig;
}

function subscribe() {
    const supabase = supabaseClient.getClient();
    const orgId = supabaseClient.getOrgId();
    if (!supabase || !orgId) return;

    subscription = supabase
        .channel('org_config_print_server')
        .on('postgres_changes', {
            event: 'UPDATE',
            schema: 'public',
            table: 'organizations',
            filter: `id=eq.${orgId}`
        }, (payload) => {
            const d = payload.new;
            orgConfig = {
                printerWidth: d.printer_width || '80mm',
                maxChars58: d.printer_58mm_max_chars || 20,
                maxChars80: d.printer_80mm_max_chars || 42,
                headerText: d.ticket_header_text || 'CAFETERIA',
                footerText: d.ticket_footer_text || 'Gracias por su visita!'
            };
            console.log('[orgConfig] Updated:', orgConfig.printerWidth);
        })
        .subscribe();
}

function get() {
    return orgConfig || {
        printerWidth: '80mm',
        maxChars58: 20,
        maxChars80: 42,
        headerText: 'CAFETERIA',
        footerText: 'Gracias por su visita!'
    };
}

function getCustomMaxChars() {
    const config = get();
    return config.printerWidth === '58mm' ? config.maxChars58 : config.maxChars80;
}

function stop() {
    const supabase = supabaseClient.getClient();
    if (subscription && supabase) {
        supabase.removeChannel(subscription);
        subscription = null;
    }
    orgConfig = null;
}

module.exports = { fetch, subscribe, get, getCustomMaxChars, stop };
