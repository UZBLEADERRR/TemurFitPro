import dotenv from 'dotenv';
dotenv.config();

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
    /// Faqat ona (control) bot tokeni env'da. Qolgan botlar bazada.
    CONTROL_BOT_TOKEN: required('CONTROL_BOT_TOKEN'),
    SUPER_ADMIN_IDS: (process.env.SUPER_ADMIN_IDS || '').split(',').map(s => s.trim()).filter(Boolean),
    /// Bot tokenlarini shifrlash kaliti
    ENCRYPTION_KEY: required('ENCRYPTION_KEY'),
    /// Railway public URL (oxirida / bo'lmasin)
    PUBLIC_URL: (
        process.env.PUBLIC_URL ||
        (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : '')
    ).replace(/\/+$/, ''),

    /// AI hozircha O'CHIRILGAN. Yoqish uchun AI_ENABLED=true va GEMINI_API_KEY kerak.
    AI_ENABLED: bool('AI_ENABLED', false),
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',

    PORT: Number(process.env.PORT || 3000),
    NODE_ENV: process.env.NODE_ENV || 'production',
};

export function webappUrl(tenantId: string): string {
    if (!env.PUBLIC_URL) return '';
    return `${env.PUBLIC_URL}/app?t=${tenantId}`;
}
