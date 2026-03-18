/**
 * Procesador autónomo de print jobs
 *
 * Suscripción Realtime + polling de respaldo.
 * Claim atómico → generar ESC/POS → imprimir → marcar.
 *
 * Hardening:
 * - Recuperación de jobs huérfanos ('printing') al arrancar
 * - Reintentos con backoff (3 intentos: 10s, 30s, 60s)
 * - try/catch en heartbeat para evitar unhandled rejections
 * - processJob() con .catch() en el callback Realtime
 * - serverLog() para eventos críticos visibles en la app
 */

const supabaseClient = require('./supabaseClient');
const orgConfig = require('./orgConfig');
const {
    generateCashierTicket,
    generateKitchenCommand,
    generateBaristaCommand
} = require('./escpos');

// Importar print() del server principal (se inyecta en start)
let printFn = null;
let logFn = console.log;
let serverLogFn = null; // se inyecta en start() — opcional

let realtimeChannel = null;
let pollInterval = null;
let heartbeatInterval = null;
let processing = false;

// Mapeo de job_type a tipo de generador
const JOB_TYPE_MAP = {
    'ticket':          'cashier',
    'kitchen':         'kitchen',
    'kitchen_command': 'kitchen',
    'barista':         'barista',
    'barista_command': 'barista'
};

// Delays de reintento en segundos
const RETRY_DELAYS = [10, 30, 60];

/**
 * Claim atómico: solo uno gana
 */
async function claimJob(jobId) {
    const supabase = supabaseClient.getClient();
    const { data, error } = await supabase
        .from('print_jobs')
        .update({ status: 'printing' })
        .eq('id', jobId)
        .eq('status', 'pending')
        .select('id')
        .single();

    if (error || !data) return false;
    return true;
}

/**
 * Marcar job como impreso
 */
async function markPrinted(jobId) {
    const supabase = supabaseClient.getClient();
    await supabase
        .from('print_jobs')
        .update({
            status:     'printed',
            printed_at: new Date().toISOString()
        })
        .eq('id', jobId);
}

/**
 * Marcar job como fallido, o programar reintento si quedan intentos.
 * retryCount = valor actual del campo retry_count en el job (antes de este fallo).
 */
async function markFailedOrRetry(jobId, errorMessage, retryCount) {
    const supabase = supabaseClient.getClient();

    if (retryCount < 3) {
        const delaySec = RETRY_DELAYS[retryCount] ?? 60;
        const nextRetryAt = new Date(Date.now() + delaySec * 1000).toISOString();
        logFn('WARN', `[processor] Job ${jobId} falló (intento ${retryCount + 1}/3) — reintentando en ${delaySec}s: ${errorMessage}`);
        await supabase
            .from('print_jobs')
            .update({
                status:        'pending',
                retry_count:   retryCount + 1,
                next_retry_at: nextRetryAt,
                error_message: errorMessage
            })
            .eq('id', jobId);
    } else {
        logFn('ERROR', `[processor] Job ${jobId} fallido definitivo después de 3 intentos: ${errorMessage}`);
        if (serverLogFn) {
            serverLogFn('ERROR', `Job fallido definitivo: ${jobId}`, { error: errorMessage });
        }
        await supabase
            .from('print_jobs')
            .update({
                status:        'failed',
                error_message: errorMessage
            })
            .eq('id', jobId);
    }
}

/**
 * Recuperar jobs huérfanos: resetear 'printing' → 'pending' al arrancar.
 * Esto rescata jobs que quedaron a medias si el servidor crasheó.
 */
async function recoverOrphanJobs() {
    const supabase = supabaseClient.getClient();
    const orgId    = supabaseClient.getOrgId();
    if (!supabase || !orgId) return;

    const { data, error } = await supabase
        .from('print_jobs')
        .update({
            status:        'pending',
            next_retry_at: null,
            error_message: 'Recuperado al reiniciar servidor (job huérfano)'
        })
        .eq('organization_id', orgId)
        .eq('status', 'printing')
        .select('id');

    if (error) {
        logFn('WARN', `[processor] Error recuperando jobs huérfanos: ${error.message}`);
        return;
    }

    if (data && data.length > 0) {
        const msg = `[processor] Recuperados ${data.length} job(s) huérfanos → pending`;
        logFn('WARN', msg);
        if (serverLogFn) serverLogFn('WARN', msg, { count: data.length });
    }
}

/**
 * Procesar un job individual
 */
async function processJob(job) {
    const type = JOB_TYPE_MAP[job.job_type];
    if (!type) {
        logFn('WARN', `[processor] Unknown job_type: ${job.job_type}`, { jobId: job.id });
        await markFailedOrRetry(job.id, `Tipo desconocido: ${job.job_type}`, job.retry_count ?? 0);
        return;
    }

    // Respetar next_retry_at — no procesar antes de tiempo
    if (job.next_retry_at && new Date(job.next_retry_at) > new Date()) {
        return;
    }

    // Claim
    const claimed = await claimJob(job.id);
    if (!claimed) return; // Otro proceso lo tomó

    const retryCount = job.retry_count ?? 0;

    try {
        const config = orgConfig.get();
        const printerWidth   = config.printerWidth;
        const customMaxChars = orgConfig.getCustomMaxChars();
        const data = job.job_data || {};

        let buffer;
        if (type === 'cashier') {
            data.headerText = data.headerText || config.headerText;
            data.footerText = data.footerText || config.footerText;
            buffer = generateCashierTicket(data, printerWidth, customMaxChars);
        } else if (type === 'kitchen') {
            buffer = generateKitchenCommand(data, printerWidth, customMaxChars);
        } else if (type === 'barista') {
            buffer = generateBaristaCommand(data, printerWidth, customMaxChars);
        }

        if (!buffer) {
            // Error de datos — no tiene sentido reintentar
            const supabase = supabaseClient.getClient();
            await supabase.from('print_jobs').update({
                status:        'failed',
                error_message: 'No se pudo generar buffer ESC/POS'
            }).eq('id', job.id);
            return;
        }

        // Imprimir
        await printFn(buffer);

        // Marcar como impreso
        await markPrinted(job.id);
        const msg = `[processor] ✅ Printed job ${job.id} (${job.job_type})${retryCount > 0 ? ` (intento ${retryCount + 1})` : ''}`;
        console.log(msg);
        logFn('INFO', msg);

    } catch (err) {
        logFn('ERROR', `[processor] Failed job ${job.id}: ${err.message}`);
        await markFailedOrRetry(job.id, err.message, retryCount);
    }
}

/**
 * Polling: buscar jobs pendientes (fallback y catch-up)
 * Incluye jobs listos para reintentar (next_retry_at vencido)
 */
async function pollPendingJobs() {
    if (processing) return;
    processing = true;

    try {
        const supabase = supabaseClient.getClient();
        const orgId    = supabaseClient.getOrgId();
        if (!supabase || !orgId) return;

        const now = new Date().toISOString();

        const { data: pendingJobs } = await supabase
            .from('print_jobs')
            .select('id, job_type, job_data, retry_count, next_retry_at')
            .eq('organization_id', orgId)
            .eq('status', 'pending')
            .or(`next_retry_at.is.null,next_retry_at.lte.${now}`)
            .order('created_at', { ascending: true })
            .limit(20);

        if (pendingJobs && pendingJobs.length > 0) {
            console.log(`[processor] Processing ${pendingJobs.length} pending job(s) sequentially`);
            for (const job of pendingJobs) {
                await processJob(job);
            }
        }

    } catch (err) {
        logFn('ERROR', `[processor] Poll error: ${err.message}`);
    } finally {
        processing = false;
    }
}

/**
 * Iniciar procesamiento autónomo
 */
function start(printFunction, logFunction, serverLogFunction) {
    printFn     = printFunction;
    if (logFunction)       logFn       = logFunction;
    if (serverLogFunction) serverLogFn = serverLogFunction;

    const supabase = supabaseClient.getClient();
    const orgId    = supabaseClient.getOrgId();
    if (!supabase || !orgId) {
        logFn('ERROR', '[processor] Cannot start: not authenticated');
        return false;
    }

    // Recuperar jobs huérfanos antes de empezar a escuchar
    recoverOrphanJobs().catch(err =>
        logFn('WARN', `[processor] recoverOrphanJobs error: ${err.message}`)
    );

    // Suscripción Realtime
    realtimeChannel = supabase
        .channel('print_jobs_autonomous')
        .on('postgres_changes', {
            event:  'INSERT',
            schema: 'public',
            table:  'print_jobs',
            filter: `organization_id=eq.${orgId}`
        }, (payload) => {
            const msg = `[processor] Realtime INSERT received: ${payload.new?.id} (${payload.new?.job_type})`;
            console.log(msg);
            logFn('INFO', msg);
            const job = payload.new;
            if (job.status === 'pending') {
                // .catch() explícito para evitar unhandled rejection
                processJob({ ...job, retry_count: job.retry_count ?? 0 })
                    .catch(err => logFn('ERROR', `[processor] Realtime processJob error: ${err.message}`));
            }
        })
        .subscribe((status) => {
            const msg = `[processor] Realtime channel status: ${status}`;
            console.log(msg);
            logFn(status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' ? 'WARN' : 'INFO', msg);
        });

    // Heartbeat independiente cada 30s
    const updateHeartbeat = async () => {
        try {
            const deviceId = supabaseClient.getDeviceId();
            if (!deviceId) return;
            const supabase = supabaseClient.getClient();
            if (!supabase) return;
            const { error } = await supabase
                .from('print_devices')
                .update({ last_seen_at: new Date().toISOString() })
                .eq('id', deviceId);
            if (error) logFn('WARN', `[processor] Heartbeat error: ${error.message}`);
        } catch (err) {
            // No dejar que un error de red rompa el heartbeat interval
            logFn('WARN', `[processor] Heartbeat exception: ${err.message}`);
        }
    };
    updateHeartbeat();
    heartbeatInterval = setInterval(updateHeartbeat, 30000);

    // Polling de respaldo cada 2s
    pollPendingJobs(); // Catch-up inmediato al iniciar
    pollInterval = setInterval(pollPendingJobs, 2000);

    const msg = `[processor] Started. Org: ${orgId}. Realtime + polling every 2s, heartbeat every 30s`;
    console.log(msg);
    logFn('INFO', msg);
    return true;
}

/**
 * Detener procesamiento
 */
function stop() {
    const supabase = supabaseClient.getClient();
    if (realtimeChannel && supabase) {
        supabase.removeChannel(realtimeChannel);
        realtimeChannel = null;
    }
    if (pollInterval) {
        clearInterval(pollInterval);
        pollInterval = null;
    }
    if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
    }
    logFn('INFO', '[processor] Stopped');
}

function isRunning() {
    return !!realtimeChannel;
}

module.exports = { start, stop, isRunning, pollPendingJobs };
