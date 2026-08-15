import crypto from 'crypto';
import type { Request, Response, NextFunction } from 'express';
import type { Tenant, Member } from '@prisma/client';
import { prisma } from '../core/db';
import { decrypt } from '../core/crypto';
import { isSuperAdmin } from '../core/tenants';
import type { Role } from '../ai/tools';

// Mini App so'rovlarini Telegram initData orqali tekshiramiz.
// Bu multi-tenant tizimda MUHIM: har bir tenantning o'z bot tokeni bilan
// imzo tekshiriladi, shuning uchun bir mijoz boshqasining ma'lumotini ko'ra olmaydi.

const MAX_AGE_SECONDS = 24 * 3600;

export interface AuthedRequest extends Request {
    tenant: Tenant;
    member: Member | null;
    telegramId: string;
    role: Role;
}

export function verifyInitData(initData: string, botToken: string): Record<string, string> | null {
    let params: URLSearchParams;
    try {
        params = new URLSearchParams(initData);
    } catch {
        return null;
    }

    const hash = params.get('hash');
    if (!hash) return null;
    params.delete('hash');

    const dataCheckString = [...params.entries()]
        .map(([k, v]) => `${k}=${v}`)
        .sort()
        .join('\n');

    const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    // Doimiy vaqtli taqqoslash — timing attack'ga qarshi
    const a = Buffer.from(computed, 'hex');
    const b = Buffer.from(hash, 'hex');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const authDate = Number(params.get('auth_date') || 0);
    if (!authDate || Date.now() / 1000 - authDate > MAX_AGE_SECONDS) return null;

    return Object.fromEntries(params.entries());
}

export async function authenticate(req: Request, res: Response, next: NextFunction): Promise<void> {
    const tenantId = String(req.query.t || req.header('x-tenant-id') || '');
    const initData = req.header('x-init-data') || String(req.query.initData || '');

    if (!tenantId) {
        res.status(400).json({ error: "Tenant ko'rsatilmagan" });
        return;
    }

    const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.status !== 'active') {
        res.status(404).json({ error: 'Bot topilmadi yoki faol emas' });
        return;
    }

    if (!initData) {
        res.status(401).json({ error: 'Avtorizatsiya yoʻq' });
        return;
    }

    let token: string;
    try {
        token = decrypt(tenant.botTokenEnc);
    } catch {
        res.status(500).json({ error: 'Server konfiguratsiyasi xato' });
        return;
    }

    const data = verifyInitData(initData, token);
    if (!data) {
        res.status(401).json({ error: "Imzo notoʻgʻri yoki muddati oʻtgan" });
        return;
    }

    let tgUser: { id: number; first_name?: string; last_name?: string; username?: string };
    try {
        tgUser = JSON.parse(data.user);
    } catch {
        res.status(401).json({ error: 'Foydalanuvchi maʼlumoti oʻqilmadi' });
        return;
    }

    const telegramId = String(tgUser.id);
    const member = await prisma.member.findUnique({
        where: { tenantId_telegramId: { tenantId: tenant.id, telegramId } },
    });

    const superAdmin = await isSuperAdmin(telegramId);
    const role: Role = superAdmin
        ? 'super'
        : member && (member.role === 'coach' || member.role === 'owner')
          ? 'coach'
          : 'member';

    const authed = req as AuthedRequest;
    authed.tenant = tenant;
    authed.member = member;
    authed.telegramId = telegramId;
    authed.role = role;
    next();
}

export function requireCoach(req: Request, res: Response, next: NextFunction): void {
    const r = req as AuthedRequest;
    if (r.role !== 'coach' && r.role !== 'super') {
        res.status(403).json({ error: 'Faqat murabbiy uchun' });
        return;
    }
    next();
}
