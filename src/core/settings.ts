import { prisma } from './db';
import { env } from './env';
import { encrypt, decrypt } from './crypto';
import { log } from './logger';

// Ona bot ichidan o'zgartiriladigan sozlamalar. Bazada (platform.db) yotadi,
// xotirada keshlanadi — chunki env.AI_ENABLED kabi qiymatlar kod bo'ylab
// sinxron o'qiladi.
//
// Ustunlik tartibi: bazadagi qiymat → env → standart.
// Ya'ni Railway'ga GEMINI_API_KEY qo'ysangiz ham ishlaydi, bot ichidan
// qo'ysangiz ham; bot ichidagisi ustun turadi.

export interface RuntimeSettings {
    geminiApiKey: string;
    /// Kalit qayerdan: bot ichidan qo'yilganmi yoki env'danmi
    geminiKeyFromBot: boolean;
    geminiModel: string;
    aiEnabled: boolean;
    publicUrl: string;
    /// PUBLIC_URL bot ichidan qo'lda qo'yilganmi
    publicUrlFromBot: boolean;

    /// Kunlik zaxira fayli super adminlarga yuborilsinmi
    backupEnabled: boolean;
    /// Qaysi soatda (UTC, 0-23)
    backupHour: number;
}

const KEYS = {
    geminiApiKey: 'geminiApiKey',
    geminiModel: 'geminiModel',
    aiEnabled: 'aiEnabled',
    publicUrl: 'publicUrl',
    backupEnabled: 'backupEnabled',
    backupHour: 'backupHour',
} as const;

let cache: RuntimeSettings = {
    geminiApiKey: env.GEMINI_API_KEY,
    geminiKeyFromBot: false,
    geminiModel: env.GEMINI_MODEL,
    aiEnabled: env.AI_ENABLED,
    publicUrl: env.PUBLIC_URL,
    publicUrlFromBot: false,
    backupEnabled: true,
    backupHour: 2,
};

/// Joriy sozlamalar. Sinxron — bootstrap'da loadSettings() bir marta chaqiriladi,
/// keyin har o'zgartirishda kesh yangilanadi.
export function settings(): RuntimeSettings {
    return cache;
}

export async function loadSettings(): Promise<void> {
    let rows: Array<{ key: string; value: string }> = [];
    try {
        rows = await prisma.platformSetting.findMany();
    } catch (e) {
        // Jadval hali yaratilmagan bo'lsa (juda eski baza) — env qiymatlari bilan ishlaymiz
        log.warn('settings', `bazadan o'qilmadi, env qiymatlari ishlatiladi: ${String(e).slice(0, 120)}`);
        return;
    }

    const map = new Map(rows.map(r => [r.key, r.value]));

    let geminiApiKey = env.GEMINI_API_KEY;
    let geminiKeyFromBot = false;
    const stored = map.get(KEYS.geminiApiKey);
    if (stored) {
        try {
            geminiApiKey = decrypt(stored);
            geminiKeyFromBot = true;
        } catch {
            // Shifrlash kaliti o'zgargan — env'ga tushamiz, foydalanuvchi qayta qo'yadi
            log.warn('settings', "saqlangan Gemini kaliti ochilmadi — qaytadan qo'ying");
        }
    }

    const storedUrl = (map.get(KEYS.publicUrl) || '').replace(/\/+$/, '');

    cache = {
        geminiApiKey,
        geminiKeyFromBot,
        geminiModel: map.get(KEYS.geminiModel) || env.GEMINI_MODEL,
        aiEnabled: map.has(KEYS.aiEnabled) ? map.get(KEYS.aiEnabled) === '1' : env.AI_ENABLED,
        publicUrl: storedUrl || env.PUBLIC_URL,
        publicUrlFromBot: !!storedUrl,
        backupEnabled: map.get(KEYS.backupEnabled) !== '0',
        backupHour: clampHour(map.get(KEYS.backupHour)),
    };
}

function clampHour(v: string | undefined): number {
    const n = Number(v);
    return Number.isInteger(n) && n >= 0 && n <= 23 ? n : 2;
}

async function put(key: string, value: string): Promise<void> {
    await prisma.platformSetting.upsert({
        where: { key },
        create: { key, value },
        update: { value },
    });
    await loadSettings();
}

async function drop(key: string): Promise<void> {
    await prisma.platformSetting.deleteMany({ where: { key } });
    await loadSettings();
}

/// Gemini kalitini bot ichidan o'rnatish (bazada shifrlangan holda yotadi).
export async function setGeminiKey(raw: string): Promise<void> {
    await put(KEYS.geminiApiKey, encrypt(raw.trim()));
}

/// Bot ichidagi kalitni olib tashlash — env'dagisiga qaytadi.
export async function clearGeminiKey(): Promise<void> {
    await drop(KEYS.geminiApiKey);
}

export async function setGeminiModel(model: string): Promise<void> {
    await put(KEYS.geminiModel, model.trim());
}

export async function setAiEnabled(on: boolean): Promise<void> {
    await put(KEYS.aiEnabled, on ? '1' : '0');
}

export async function setPublicUrl(url: string): Promise<void> {
    const clean = url.trim().replace(/\/+$/, '');
    if (clean) await put(KEYS.publicUrl, clean);
    else await drop(KEYS.publicUrl);
}

export async function setBackupEnabled(on: boolean): Promise<void> {
    await put(KEYS.backupEnabled, on ? '1' : '0');
}

export async function setBackupHour(hour: number): Promise<void> {
    await put(KEYS.backupHour, String(clampHour(String(hour))));
}

/// Joriy public URL — webhook va mini ilova havolalari shundan quriladi.
export function publicUrl(): string {
    return cache.publicUrl;
}

/// Mini ilova havolasi. PUBLIC_URL bo'lmasa bo'sh satr (tugma ko'rsatilmaydi).
export function webappUrl(tenantId: string): string {
    if (!cache.publicUrl) return '';
    return `${cache.publicUrl}/app?t=${tenantId}`;
}

/// Kalitni to'liq ko'rsatmaslik uchun: "AIza…7f2c"
export function maskKey(key: string): string {
    if (!key) return '';
    if (key.length <= 10) return `${key.slice(0, 2)}…`;
    return `${key.slice(0, 4)}…${key.slice(-4)}`;
}
