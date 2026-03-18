/**
 * Generador de comandos ESC/POS para impresoras térmicas
 * Soporta 58mm (32 chars) y 80mm (48 chars)
 */

// Comandos ESC/POS básicos
const ESC = 0x1B;
const GS = 0x1D;
const FS = 0x1C;
const LF = 0x0A;

const COMMANDS = {
    // Inicialización
    INIT: [ESC, 0x40],                    // ESC @ - Reset impresora

    // Alineación
    ALIGN_LEFT: [ESC, 0x61, 0x00],        // ESC a 0
    ALIGN_CENTER: [ESC, 0x61, 0x01],      // ESC a 1
    ALIGN_RIGHT: [ESC, 0x61, 0x02],       // ESC a 2

    // Estilos de texto
    BOLD_ON: [ESC, 0x45, 0x01],           // ESC E 1
    BOLD_OFF: [ESC, 0x45, 0x00],          // ESC E 0
    DOUBLE_WIDTH_ON: [GS, 0x21, 0x10],    // GS ! 16
    DOUBLE_HEIGHT_ON: [GS, 0x21, 0x01],   // GS ! 1
    DOUBLE_ON: [GS, 0x21, 0x11],          // GS ! 17 (ancho y alto)
    NORMAL_SIZE: [GS, 0x21, 0x00],        // GS ! 0

    // Subrayado
    UNDERLINE_ON: [ESC, 0x2D, 0x01],      // ESC - 1
    UNDERLINE_OFF: [ESC, 0x2D, 0x00],     // ESC - 0

    // Línea y corte
    LINE_FEED: [LF],
    CUT_PARTIAL: [GS, 0x56, 0x01],        // GS V 1 - Corte parcial
    CUT_FULL: [GS, 0x56, 0x00],           // GS V 0 - Corte total

    // Espaciado
    LINE_SPACING_DEFAULT: [ESC, 0x32],    // ESC 2
    LINE_SPACING_SET: [ESC, 0x33],        // ESC 3 n (seguido de n)

    // Cajón de dinero
    CASH_DRAWER: [ESC, 0x70, 0x00, 0x19, 0xFA], // ESC p 0 25 250

    // Código de página (ESC t n)
    CODEPAGE: (n) => [ESC, 0x74, n],
    // Set de caracteres internacional (ESC R n)
    INTERNATIONAL: (n) => [ESC, 0x52, n],
    // Cancelar modo caracteres chinos (FS .)
    CHINESE_MODE_OFF: [FS, 0x2E]
};

/**
 * Configuración por tamaño de papel
 */
const PAPER_CONFIGS = {
    '58mm': { maxChars: 32, itemQtyWidth: 4, itemPriceWidth: 8 },
    '80mm': { maxChars: 48, itemQtyWidth: 4, itemPriceWidth: 10 }
};

// Código de página por defecto (0 = CP437)
const DEFAULT_CODEPAGE = (() => {
    const n = Number(process.env.PRINTER_CODEPAGE);
    return Number.isInteger(n) && n >= 0 && n <= 255 ? n : 0;
})();

// Set internacional por defecto (0 = USA)
const DEFAULT_INTERNATIONAL = (() => {
    const n = Number(process.env.PRINTER_INTERNATIONAL);
    return Number.isInteger(n) && n >= 0 && n <= 255 ? n : 0;
})();

const DISABLE_CHINESE_MODE = (() => {
    const v = (process.env.PRINTER_DISABLE_CHINESE_MODE || 'true').toLowerCase();
    return v !== 'false' && v !== '0' && v !== 'no';
})();

/**
 * Convierte string a bytes (Latin-1/CP437 compatible)
 */
const CHARSET_MAP = (process.env.PRINTER_CHARSET_MAP || 'cp858').toLowerCase();

const CHAR_MAPS = {
    // CP437
    cp437: {
        'á': 0xA0, 'é': 0x82, 'í': 0xA1, 'ó': 0xA2, 'ú': 0xA3,
        'Á': 0xB5, 'É': 0x90, 'Í': 0xD6, 'Ó': 0xE0, 'Ú': 0xE9,
        'ñ': 0xA4, 'Ñ': 0xA5, 'ü': 0x81, 'Ü': 0x9A,
        '¿': 0xA8, '¡': 0xAD, '°': 0xF8
    },
    // CP858 (muy similar a CP437, pero recomendado para Europa Occidental)
    cp858: {
        'á': 0xA0, 'é': 0x82, 'í': 0xA1, 'ó': 0xA2, 'ú': 0xA3,
        'Á': 0xB5, 'É': 0x90, 'Í': 0xD6, 'Ó': 0xE0, 'Ú': 0xE9,
        'ñ': 0xA4, 'Ñ': 0xA5, 'ü': 0x81, 'Ü': 0x9A,
        '¿': 0xA8, '¡': 0xAD, '°': 0xF8
    },
    // CP850 (alternativa común)
    cp850: {
        'á': 0xA0, 'é': 0x82, 'í': 0xA1, 'ó': 0xA2, 'ú': 0xA3,
        'Á': 0xB5, 'É': 0x90, 'Í': 0xD6, 'Ó': 0xE0, 'Ú': 0xE9,
        'ñ': 0xA4, 'Ñ': 0xA5, 'ü': 0x81, 'Ü': 0x9A,
        '¿': 0xA8, '¡': 0xAD, '°': 0xF8
    },
    // ISO-8859-1 / Latin-1 directo (byte = charCode)
    latin1: {}
};

function stringToBytes(str) {
    const bytes = [];
    for (let i = 0; i < str.length; i++) {
        let charCode = str.charCodeAt(i);
        // Mapeo básico de caracteres especiales españoles a CP437
        const charMap = CHAR_MAPS[CHARSET_MAP] || CHAR_MAPS.cp858;
        if (CHARSET_MAP === 'latin1') {
            if (charCode <= 255) {
                bytes.push(charCode);
            } else {
                bytes.push(0x3F);
            }
        } else if (charMap[str[i]]) {
            bytes.push(charMap[str[i]]);
        } else if (charCode > 127) {
            bytes.push(0x3F); // ? para caracteres no soportados
        } else {
            bytes.push(charCode);
        }
    }
    return bytes;
}

/**
 * Formatea precio en formato chileno
 */
function formatPrice(price) {
    if (!price && price !== 0) return '$0';
    const num = Math.round(Number(price));
    return '$' + num.toLocaleString('es-CL');
}

/**
 * Trunca texto respetando límite
 */
function truncate(text, maxLen) {
    if (!text) return '';
    if (text.length <= maxLen) return text;
    return text.substring(0, maxLen - 2) + '..';
}

/**
 * Rellena texto a ancho fijo
 */
function pad(text, width, align = 'left') {
    text = String(text || '');
    if (text.length > width) text = text.substring(0, width);
    const padding = width - text.length;
    if (align === 'right') return ' '.repeat(padding) + text;
    if (align === 'center') {
        const left = Math.floor(padding / 2);
        return ' '.repeat(left) + text + ' '.repeat(padding - left);
    }
    return text + ' '.repeat(padding);
}

/**
 * Genera línea separadora
 */
function separatorLine(char, width) {
    return char.repeat(width);
}

/**
 * Clase principal del generador ESC/POS
 */
class ESCPOSGenerator {
    constructor(printerWidth = '80mm', customMaxChars = null, codepage = null, international = null) {
        this.config = { ...PAPER_CONFIGS[printerWidth] || PAPER_CONFIGS['80mm'] };
        if (customMaxChars) {
            this.config.maxChars = customMaxChars;
        }
        this.codepage = (Number.isInteger(codepage) && codepage >= 0 && codepage <= 255)
            ? codepage
            : DEFAULT_CODEPAGE;
        this.international = (Number.isInteger(international) && international >= 0 && international <= 255)
            ? international
            : DEFAULT_INTERNATIONAL;
        this.buffer = [];
    }

    // Agregar bytes al buffer
    append(bytes) {
        if (Array.isArray(bytes)) {
            this.buffer.push(...bytes);
        } else {
            this.buffer.push(bytes);
        }
        return this;
    }

    // Agregar texto
    text(str) {
        this.append(stringToBytes(str));
        return this;
    }

    // Nueva línea
    newLine() {
        this.append(COMMANDS.LINE_FEED);
        return this;
    }

    // Inicializar impresora
    init() {
        this.append(COMMANDS.INIT);
        if (DISABLE_CHINESE_MODE) {
            this.append(COMMANDS.CHINESE_MODE_OFF);
        }
        if (this.international !== null && this.international !== undefined) {
            this.append(COMMANDS.INTERNATIONAL(this.international));
        }
        if (this.codepage !== null && this.codepage !== undefined) {
            this.append(COMMANDS.CODEPAGE(this.codepage));
        }
        return this;
    }

    // Alineación
    alignLeft() { this.append(COMMANDS.ALIGN_LEFT); return this; }
    alignCenter() { this.append(COMMANDS.ALIGN_CENTER); return this; }
    alignRight() { this.append(COMMANDS.ALIGN_RIGHT); return this; }

    // Estilos
    bold(on = true) {
        this.append(on ? COMMANDS.BOLD_ON : COMMANDS.BOLD_OFF);
        return this;
    }

    doubleSize(on = true) {
        this.append(on ? COMMANDS.DOUBLE_ON : COMMANDS.NORMAL_SIZE);
        return this;
    }

    doubleWidth(on = true) {
        this.append(on ? COMMANDS.DOUBLE_WIDTH_ON : COMMANDS.NORMAL_SIZE);
        return this;
    }

    // Línea de texto completa (con salto de línea)
    line(str) {
        this.text(str).newLine();
        return this;
    }

    // Línea centrada
    centerLine(str) {
        this.alignCenter().line(pad(str, this.config.maxChars, 'center')).alignLeft();
        return this;
    }

    // Separador
    separator(char = '-') {
        this.line(separatorLine(char, this.config.maxChars));
        return this;
    }

    // Separador doble
    doubleSeparator() {
        this.separator('=');
        return this;
    }

    // Línea de item con precio
    itemLine(qty, name, price) {
        const { maxChars, itemQtyWidth, itemPriceWidth } = this.config;
        const priceStr = pad(formatPrice(price), itemPriceWidth, 'right');

        if (qty === 1) {
            const nameWidth = maxChars - itemPriceWidth;
            const nameStr = pad(truncate(name, nameWidth), nameWidth);
            this.line(nameStr + priceStr);
        } else {
            const qtyStr = pad(`${qty}x`, itemQtyWidth);
            const nameWidth = maxChars - itemQtyWidth - itemPriceWidth;
            const nameStr = pad(truncate(name, nameWidth), nameWidth);
            this.line(qtyStr + nameStr + priceStr);
        }
        return this;
    }

    // Línea de item sin precio (comandas)
    // El comentario se imprime en negrita entre comillas
    itemLineNoPrice(qty, name, comment = '') {
        const { maxChars } = this.config;
        const hasComment = !!(comment && comment.trim());
        const commentStr = hasComment ? ` "${comment.trim()}"` : '';

        if (qty === 1) {
            const fullLen = name.length + commentStr.length;
            if (!hasComment) {
                // Sin comentario: wrapping normal
                if (name.length > maxChars) {
                    const words = name.split(' ');
                    let cur = '';
                    for (const word of words) {
                        if (cur.length + word.length + (cur ? 1 : 0) <= maxChars) {
                            cur += (cur ? ' ' : '') + word;
                        } else {
                            if (cur) this.line(cur);
                            cur = word.length > maxChars ? truncate(word, maxChars) : word;
                        }
                    }
                    if (cur) this.line(cur);
                } else {
                    this.line(name);
                }
            } else if (fullLen <= maxChars) {
                // Cabe en una línea: nombre normal + comentario en negrita
                this.text(name).bold(true).text(commentStr).bold(false).newLine();
            } else {
                // No cabe: nombre en su línea, comentario en negrita en la siguiente
                this.line(name);
                this.bold(true).line(truncate(commentStr.trim(), maxChars)).bold(false);
            }
        } else {
            const qtyWidth = 5;
            const qtyStr = pad(`${qty}x`, qtyWidth);
            const nameWidth = maxChars - qtyWidth;

            if (!hasComment) {
                if (name.length > nameWidth) {
                    const firstPart = truncate(name, nameWidth);
                    this.line(qtyStr + firstPart);
                    let remaining = name.substring(firstPart.length).trim();
                    while (remaining.length > 0) {
                        const linePart = truncate(remaining, maxChars);
                        this.line(pad('', qtyWidth) + linePart);
                        remaining = remaining.substring(linePart.length).trim();
                    }
                } else {
                    this.line(qtyStr + name);
                }
            } else if (name.length + commentStr.length <= nameWidth) {
                // Todo cabe en una línea junto a la cantidad
                this.text(qtyStr + name).bold(true).text(commentStr).bold(false).newLine();
            } else if (name.length <= nameWidth) {
                // Nombre cabe pero comentario no: nombre en primera línea, comentario en negrita abajo
                this.line(qtyStr + name);
                this.bold(true).line(truncate(commentStr.trim(), maxChars)).bold(false);
            } else {
                // Nombre tampoco cabe: wrapping normal + comentario en negrita al final
                const firstPart = truncate(name, nameWidth);
                this.line(qtyStr + firstPart);
                let remaining = name.substring(firstPart.length).trim();
                while (remaining.length > 0) {
                    const linePart = truncate(remaining, maxChars);
                    this.line(pad('', qtyWidth) + linePart);
                    remaining = remaining.substring(linePart.length).trim();
                }
                this.bold(true).line(truncate(commentStr.trim(), maxChars)).bold(false);
            }
        }
        return this;
    }

    // Línea de resumen (SUBTOTAL, TOTAL, etc.)
    summaryLine(label, amount) {
        const { maxChars } = this.config;
        const priceStr = formatPrice(amount);
        const spaces = maxChars - label.length - priceStr.length;
        this.line(label + ' '.repeat(Math.max(1, spaces)) + priceStr);
        return this;
    }

    // Total destacado
    totalLine(amount) {
        this.doubleSeparator();
        this.bold(true).doubleSize(true);
        this.line('TOTAL: ' + formatPrice(amount));
        this.bold(false).doubleSize(false);
        return this;
    }

    // Cortar papel
    cut(full = false) {
        this.newLine().newLine().newLine();
        this.append(full ? COMMANDS.CUT_FULL : COMMANDS.CUT_PARTIAL);
        return this;
    }

    // Abrir cajón
    openCashDrawer() {
        this.append(COMMANDS.CASH_DRAWER);
        return this;
    }

    // Obtener buffer como Uint8Array
    getBuffer() {
        return Buffer.from(this.buffer);
    }

    // Limpiar buffer
    clear() {
        this.buffer = [];
        return this;
    }
}

/**
 * Genera ticket de caja (con precios)
 */
function generateCashierTicket(data, printerWidth = '80mm', customMaxChars = null) {
    const gen = new ESCPOSGenerator(printerWidth, customMaxChars);
    const date = new Date().toLocaleString('es-CL', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
    });

    const items = Array.isArray(data.items) ? data.items : [];
    const subtotal = data.total || items.reduce((sum, item) =>
        sum + ((item.price || 0) * (item.quantity || 0)), 0);
    const propina = Math.round(subtotal * 0.1);
    const total = subtotal + propina;

    gen.init()
       .bold(true).doubleSize(true)
       .line(data.headerText || 'CAFETERIA')
       .bold(false).doubleSize(false)
       .line(`Mesa: ${data.table || 'N/A'}`)
       .line(date)
       .separator()
       .bold(true).line('DETALLE').bold(false)
       .separator('-');

    // Items expandidos (una línea por unidad) con precio unitario
    items.forEach(item => {
        const qty = item.quantity || 1;
        const unitPrice = item.price || 0;
        for (let i = 0; i < qty; i++) {
            gen.itemLine(1, item.name || 'Item', unitPrice);
        }
    });

    gen.separator()
       .summaryLine('SUBTOTAL:', subtotal)
       .summaryLine('Propina sugerida 10%:', propina)
       .totalLine(total)
       .newLine();

    // Footer
    const footerLines = (data.footerText || 'Gracias por su visita!\nVuelva pronto').split('\n');
    gen.separator('-');
    footerLines.forEach(line => gen.line(line));

    gen.cut();

    return gen.getBuffer();
}

/**
 * Genera comanda de cocina (sin precios)
 */
function generateKitchenCommand(data, printerWidth = '80mm', customMaxChars = null) {
    const gen = new ESCPOSGenerator(printerWidth, customMaxChars);
    const date = new Date().toLocaleString('es-CL', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
    });

    const items = Array.isArray(data.items) ? data.items : [];

    gen.init()
       .bold(true).doubleSize(true)
       .line('COMANDA COCINA')
       .bold(false).doubleSize(false)
       .line(`Mesa: ${data.table || 'N/A'}`)
       .line(`Solicitante: ${data.waiter || 'N/A'}`)
       .line(date)
       .separator()
       .bold(true).line('DETALLE').bold(false)
       .separator('-');

    // Items expandidos con comentarios
    items.forEach(item => {
        const qty = item.quantity || 1;
        for (let i = 0; i < qty; i++) {
            gen.itemLineNoPrice(1, item.name || 'Item', item.comment || '');
        }
    });

    gen.separator()
       .line(`Total items: ${items.reduce((sum, item) => sum + (item.quantity || 1), 0)}`)
       .cut();

    return gen.getBuffer();
}

/**
 * Genera comanda de barista (sin precios)
 */
function generateBaristaCommand(data, printerWidth = '80mm', customMaxChars = null) {
    const gen = new ESCPOSGenerator(printerWidth, customMaxChars);
    const date = new Date().toLocaleString('es-CL', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit'
    });

    const items = Array.isArray(data.items) ? data.items : [];

    gen.init()
       .bold(true).doubleSize(true)
       .line('COMANDA BARISTA')
       .bold(false).doubleSize(false)
       .line(`Mesa: ${data.table || 'N/A'}`)
       .line(`Solicitante: ${data.waiter || 'N/A'}`)
       .line(date)
       .separator()
       .bold(true).line('DETALLE').bold(false)
       .separator('-');

    // Items expandidos con comentarios
    items.forEach(item => {
        const qty = item.quantity || 1;
        for (let i = 0; i < qty; i++) {
            gen.itemLineNoPrice(1, item.name || 'Item', item.comment || '');
        }
    });

    gen.separator()
       .line(`Total items: ${items.reduce((sum, item) => sum + (item.quantity || 1), 0)}`)
       .cut();

    return gen.getBuffer();
}

/**
 * Imprime tabla de caracteres para diagnóstico
 */
function generateCharsetTest(printerWidth = '58mm', codepage = null, international = null) {
    const gen = new ESCPOSGenerator(printerWidth, null, codepage, international);
    gen.init()
       .bold(true)
       .line('CHARSET TEST')
       .bold(false)
       .line(`CP: ${gen.codepage} INT: ${gen.international}`)
       .separator();

    // Imprimir 0x20-0xFF en filas de 16
    for (let start = 0x20; start <= 0xF0; start += 0x10) {
        const bytes = [];
        for (let b = start; b < start + 0x10; b++) {
            bytes.push(b);
        }
        gen.append(bytes).newLine();
    }

    gen.separator()
       .line('Texto: ÁÉÍÓÚ áéíóú Ññ Üü ¿¡')
       .cut();

    return gen.getBuffer();
}

module.exports = {
    ESCPOSGenerator,
    generateCashierTicket,
    generateKitchenCommand,
    generateBaristaCommand,
    generateCharsetTest,
    COMMANDS,
    PAPER_CONFIGS
};
