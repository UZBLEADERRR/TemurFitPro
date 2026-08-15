import { Telegraf } from 'telegraf';

/// Telegram xatosining matnli tavsifi
export function tgError(e: any): string {
    return e?.response?.description || e?.description || e?.message || String(e);
}

export function tgErrorCode(e: any): number | undefined {
    return e?.response?.error_code;
}

/// 429 va 5xx — vaqtinchalik xatolar, exponential backoff bilan qayta urinamiz.
/// 400/403 — doimiy, darhol uloqtiriladi.
export async function withRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await fn();
        } catch (e: any) {
            const code = tgErrorCode(e);
            const transient = code === 429 || (typeof code === 'number' && code >= 500 && code < 600);
            if (!transient || attempt > retries) throw e;
            const retryAfter = e?.response?.parameters?.retry_after;
            const delay = retryAfter ? retryAfter * 1000 : 1000 * 2 ** (attempt - 1);
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
