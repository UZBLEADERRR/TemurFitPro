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

/// Bot bu chatga umuman yeta olmaydi — qayta urinishning ma'nosi yo'q.
/// Bunday guruhni "chiqarilgan" deb belgilab qo'yish kerak, aks holda
/// scheduler har kuni o'sha xatoni qayta-qayta yozaveradi.
const CHAT_GONE_PATTERNS = [
    'chat not found',
    'bot was kicked',
    'bot is not a member',
    'user is deactivated',
    'chat_write_forbidden',
    'not enough rights to send text messages',
    'the group chat was deleted',
    'group chat was upgraded to a supergroup',
    'peer_id_invalid',
    'forbidden: bot was blocked by the user',
];

export function isChatGone(e: any): boolean {
    const text = String(tgError(e)).toLowerCase();
    return CHAT_GONE_PATTERNS.some(p => text.includes(p));
}

export function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

// ============ MATNNI XAVFSIZLASH ============
//
// Telegram "Bad Request: text must be encoded in UTF-8" deb rad etadigan
// yagona amaliy sabab — matnda YOLG'IZ SURROGAT qolishi.
//
// JavaScript satrlari UTF-16 da. Emoji (😀, 🔥) ikkita kod birligidan iborat
// "surrogat juftlik". `name.slice(0, 14)` xuddi shu juftlikning o'rtasidan
// kessa, satrda yolg'iz yuqori surrogat (\uD83D) qoladi — bu yaroqsiz UTF-8
// va Telegram BUTUN xabarni rad etadi.
//
// Amalda bu shunday ko'rinadi: bitta a'zoning ismida emoji bo'lsa, o'sha
// guruhning jadvali BUTUNLAY ishlamay qoladi, boshqa guruhlar esa ishlayveradi.

/// Juftini yo'qotgan surrogatlarni olib tashlash.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/// Telegramga ketadigan har qanday matn shu yerdan o'tadi.
/// Yolg'iz surrogatlar va xabarni buzadigan boshqaruv belgilari olib tashlanadi.
export function safeText(s: string): string {
    return s
        .replace(LONE_SURROGATE, '')
        // Ko'rinmas boshqaruv belgilari (tab, LF, CR dan tashqari)
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/// Satrni surrogat juftlikni BUZMASDAN qisqartirish.
/// `Array.from` UTF-16 kod birliklari bo'yicha emas, kod nuqtalari bo'yicha
/// yuradi — shuning uchun emoji hech qachon o'rtasidan kesilmaydi.
export function truncate(s: string, maxChars: number): string {
    const chars = Array.from(s);
    if (chars.length <= maxChars) return s;
    return chars.slice(0, maxChars).join('');
}

/// Ko'rinadigan uzunlik bo'yicha to'ldirish. `padEnd` kod birliklarini
/// sanaydi, shuning uchun emojili ism ustunni buzardi.
export function padVisual(s: string, width: number): string {
    const len = Array.from(s).length;
    return len >= width ? s : s + ' '.repeat(width - len);
}

export function visualLength(s: string): number {
    return Array.from(s).length;
}

/// Telegram HTML parse_mode uchun xavfsizlash.
/// Foydalanuvchi kiritgan har bir satr shu yerdan o'tadi — shuning uchun
/// yolg'iz surrogatlarni ham shu yerda tozalaymiz.
export function esc(s: string): string {
    return safeText(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/// Foydalanuvchini HTML mention qilish
export function mention(telegramId: string, name: string): string {
    return `<a href="tg://user?id=${telegramId}">${esc(name)}</a>`;
}

/// Telegram xabar chegarasi (4096) bo'yicha bo'lish
export function chunkText(input: string, limit = 3800): string[] {
    // esc() dan o'tmagan yo'llar uchun oxirgi himoya
    const text = safeText(input);
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
