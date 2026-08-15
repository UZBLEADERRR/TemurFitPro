import dotenv from 'dotenv';
dotenv.config();

function required(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`${name} env o'zgaruvchisi majburiy`);
    return v;
}

export const env = {
    /// Faqat ona (control) bot tokeni Railway'da turadi. Qolgan botlar DB'da.
    CONTROL_BOT_TOKEN: required('CONTROL_BOT_TOKEN'),
    /// Vergul bilan ajratilgan super admin telegram id'lari (startda DB'ga seed bo'ladi)
    SUPER_ADMIN_IDS: (process.env.SUPER_ADMIN_IDS || '')
        .split(',').map(s => s.trim()).filter(Boolean),
    /// Bot tokenlarini shifrlash uchun kalit (32 baytga hash qilinadi)
    ENCRYPTION_KEY: required('ENCRYPTION_KEY'),
    /// Railway public URL, masalan https://temurfitpro.up.railway.app (oxirida / bo'lmasin)
    PUBLIC_URL: (process.env.PUBLIC_URL || process.env.RAILWAY_PUBLIC_DOMAIN
        ? (process.env.PUBLIC_URL || `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`)
        : '').replace(/\/+$/, ''),
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    GEMINI_MODEL: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
    PORT: Number(process.env.PORT || 3000),
    NODE_ENV: process.env.NODE_ENV || 'production',
};

export function webappUrl(tenantId: string): string {
    if (!env.PUBLIC_URL) return '';
    return `${env.PUBLIC_URL}/app?t=${tenantId}`;
}
