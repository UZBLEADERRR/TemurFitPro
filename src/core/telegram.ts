import { Telegraf } from 'telegraf';

/// Telegram xatosining matnli tavsifi
export function tgError(e: any): string {
    return e?.response?.description || e?.description || e?.message || String(e);
}

export function tgErrorCode(e: any): number | undefined {
    return e?.response?.error_code;
}

/// Tarmoq uzilishlari va shlyuz xatolari — Telegram javobida error_code
/// bo'lmasligi mumkin (masalan 504 HTML sahifa qaytarsa). Shuning uchun
/// xato matnini ham tekshiramiz.
const TRANSIENT_PATTERNS = [
    'gateway time-out',
    'gateway timeout',
    'bad gateway',
    'service unavailable',
    'timeout',
    'timedout',
    'etimedout',
    'econnreset',
    'econnrefused',
    'enotfound',
    'eai_again',
    'socket hang up',
    'network',
    'fetch failed',
    // Shlyuz JSON o'rniga HTML xato sahifasini qaytarganda Telegraf shunday deydi
    'invalid json response',
];

export function isTransient(e: any): boolean {
    const code = tgErrorCode(e);
    if (code === 429) return true;
    if (typeof code === 'number' && code >= 500 && code < 600) return true;
    const text = String(tgError(e)).toLowerCase();
    return TRANSIENT_PATTERNS.some(p => text.includes(p));
}

/// Vaqtinchalik xatolarda exponential backoff bilan qayta urinamiz.
/// Doimiy xatolar (400 "chat not found", 403 "bot was blocked") darhol uloqtiriladi.
export async function withRetry<T>(fn: () => Promise<T>, retries = 3, baseDelayMs = 1000): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (e: any) {
            if (!isTransient(e) || attempt > retries) throw e;
            const retryAfter = e?.response?.parameters?.retry_after;
            const delay = retryAfter ? retryAfter * 1000 : baseDelayMs * 2 ** (attempt - 1);
            await sleep(delay);
        }
    }
}

export function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

/// Telegram HTML parse_mode uchun xavfsizlash
export function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/// Foydalanuvchini HTML mention qilish
export function mention(telegramId: string, name: string): string {
    return `<a href="tg://user?id=${telegramId}">${esc(name)}</a>`;
}

/// Telegram xabar chegarasi (4096) bo'yicha bo'lish
export function chunkText(text: string, limit = 3800): string[] {
    if (text.length <= limit) return [text];
    const out: string[] = [];
    let buf = '';
    for (const line of text.split('\n')) {
        if (buf.length + line.length + 1 > limit) {
            out.push(buf);
            buf = '';
        }
        buf += (buf ? '\n' : '') + line;
    }
    if (buf) out.push(buf);
    return out;
}

/// Fayl id orqali Telegram'dan faylni yuklab olish (ovozli xabarlar uchun)
export async function downloadFile(bot: Telegraf, fileId: string): Promise<Buffer> {
    const link = await bot.telegram.getFileLink(fileId);
    const res = await fetch(link.toString());
    if (!res.ok) throw new Error(`Fayl yuklab olinmadi: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}
