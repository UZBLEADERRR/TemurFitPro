import dotenv from 'dotenv';
import { encryptionKey, controlWebhookSecret } from './secrets';
dotenv.config();

// Railway'da FAQAT ikkita o'zgaruvchi kerak:
//
//   CONTROL_BOT_TOKEN   — ona bot tokeni (@BotFather)
//   GEMINI_API_KEY      — AI uchun (ixtiyoriy, bot ichidan ham qo'yish mumkin)
//
// Qolgan hamma narsa o'zi topiladi yoki ona bot ichidan sozlanadi:
//   ENCRYPTION_KEY          → secrets.ts, Volume ichidagi faylda o'zi yaratiladi
//   CONTROL_WEBHOOK_SECRET  → xuddi shunday
//   SUPER_ADMIN_IDS         → botga birinchi /start bosgan odam ega bo'ladi
//   PUBLIC_URL              → RAILWAY_PUBLIC_DOMAIN dan, yoki 🔑 Kalitlar panelidan
//   DATA_DIR                → RAILWAY_VOLUME_MOUNT_PATH dan

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`${name} env o'zgaruvchisi majburiy`);
    return v;
}

function bool(name: string, fallback = false): boolean {
    const v = process.env[name];
    if (v === undefined || v === '') return fallback;
    return ['1', 'true', 'yes', 'ha'].includes(v.toLowerCase());
}

export const env = {
    /// Yagona majburiy o'zgaruvchi. Mijoz botlari bazada shifrlangan holda yotadi.
    CONTROL_BOT_TOKEN: required('CONTROL_BOT_TOKEN'),

    /// Ixtiyoriy. Bo'sh bo'lsa — ona botga birinchi /start bosgan odam ega bo'ladi.
    SUPER_ADMIN_IDS: (process.env.SUPER_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean),

    /// Volume ichidagi fayldan; env'da bo'lsa o'sha ko'chiriladi.
    ENCRYPTION_KEY: encryptionKey(),
    CONTROL_WEBHOOK_SECRET: controlWebhookSecret(),

    /// Railway domenidan avtomatik. Bot ichidan ham o'zgartirsa bo'ladi —
    /// joriy qiymat uchun settings().publicUrl ga qarang.
    PUBLIC_URL: (
        process.env.PUBLIC_URL ||
        (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
    ).replace(/\/+$/, ''),

    /// AI uchun standart qiymatlar. Bot ichidan o'zgartirilgani ustun turadi —
    /// har doim settings() orqali o'qing, to'g'ridan-to'g'ri emas.
    AI_ENABLED: bool('AI_ENABLED', true),
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',

    PORT: Number(process.env.PORT || 3000),
    NODE_ENV: process.env.NODE_ENV || 'production',
};
