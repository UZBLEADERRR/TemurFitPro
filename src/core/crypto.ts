import crypto from 'crypto';
import { env } from './env';

// Bot tokenlari bazada ochiq turmasligi kerak — baza sizib chiqsa, barcha
// mijoz botlari o'g'irlanadi. AES-256-GCM: shifr + autentifikatsiya tegi.

const KEY = crypto.createHash('sha256').update(env.ENCRYPTION_KEY).digest();

export function encrypt(plain: string): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
    const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64url')}.${tag.toString('base64url')}.${enc.toString('base64url')}`;
}

export function decrypt(payload: string): string {
    const [ivB64, tagB64, dataB64] = payload.split('.');
    if (!ivB64 || !tagB64 || !dataB64) throw new Error('Shifrlangan qiymat buzilgan');
    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(ivB64, 'base64url'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64url')), decipher.final()]).toString('utf8');
}

export function randomSecret(bytes = 24): string {
    return crypto.randomBytes(bytes).toString('base64url');
}

/// Bot token formatini tekshirish: "123456789:AA..."
export function parseBotToken(token: string): { botId: string } | null {
    const m = /^(\d{5,})[:][A-Za-z0-9_-]{30,}$/.exec(token.trim());
    return m ? { botId: m[1] } : null;
}
