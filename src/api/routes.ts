import { Router } from 'express';
import type { Request, Response } from 'express';
import { prisma } from '../core/db';
import { authenticate, requireCoach, AuthedRequest } from './auth';
import { MEAL_TYPES } from '../core/meals';
import { todayIn, safeTz, lastNDates } from '../core/time';
import { findInactive, getStats, listMembers, memberReport, listGroups, findMissingToday } from '../features/filters';
import { activeConnection } from '../features/business';

export const api = Router();

const wrap =
    (fn: (req: AuthedRequest, res: Response) => Promise<unknown>) => async (req: Request, res: Response) => {
        try {
            await fn(req as AuthedRequest, res);
        } catch (e) {
            console.error('API xatosi:', e);
            if (!res.headersSent) res.status(500).json({ error: 'Server xatosi' });
        }
    };

api.use(authenticate);

api.get('/me', wrap(async (req, res) => {
    res.json({
        role: req.role,
        telegramId: req.telegramId,
        member: req.member
            ? { id: req.member.id, name: req.member.name, timezone: req.member.timezone, role: req.member.role }
            : null,
        tenant: {
            id: req.tenant.id,
            botUsername: req.tenant.botUsername,
            timezone: req.tenant.timezone,
            meals: {
                nonushta: req.tenant.breakfastTime,
                tushlik: req.tenant.lunchTime,
                kechki: req.tenant.dinnerTime,
            },
        },
    });
}));

/// Kunlik jadval — sana bo'yicha. Guruh berilmasa BARCHA guruhlar.
api.get('/board', wrap(async (req, res) => {
    const { tenant, db } = req;
    const date = String(req.query.date || todayIn(safeTz(tenant.timezone)));
    const groupId = req.query.group ? String(req.query.group) : null;
    const scopeToSelf = req.role === 'member';

    const members = await db.member.findMany({
        where: {
            status: 'active',
            ...(scopeToSelf && req.member ? { id: req.member.id } : {}),
            ...(groupId ? { groups: { some: { groupId } } } : {}),
        },
        include: { groups: { include: { group: true } } },
        orderBy: { joinedAt: 'asc' },
    });

    const records = await db.mealRecord.findMany({
        where: { date, memberId: { in: members.map(m => m.id) } },
    });

    // Murabbiyga telegramId/username ham beriladi — ilovada odamning
    // Telegram profiliga o'tish uchun kerak. A'zoga boshqalarniki berilmaydi.
    const canSeeContacts = req.role !== 'member';

    res.json({
        date,
        members: members.map(m => ({
            id: m.id,
            name: m.name,
            role: m.role,
            timezone: m.timezone,
            ...(canSeeContacts ? { telegramId: m.telegramId, username: m.username } : {}),
            groups: m.groups.map(g => ({ id: g.groupId, title: g.group.title || g.group.chatId })),
            meals: Object.fromEntries(
                MEAL_TYPES.map(t => {
                    const r = records.find(x => x.memberId === m.id && x.mealType === t);
                    return [t, r ? r.status : 'missing'];
                }),
            ),
        })),
    });
}));

api.get('/groups', wrap(async (req, res) => {
    const groups = await listGroups(req.db);
    res.json(
        await Promise.all(
            groups.map(async g => ({
                id: g.id,
                title: g.title || g.chatId,
                members: await req.db.groupMember.count({ where: { groupId: g.id } }),
            })),
        ),
    );
}));

api.get('/stats', requireCoach, wrap(async (req, res) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const groupId = req.query.group ? String(req.query.group) : null;
    res.json(await getStats(req.db, req.tenant, { days, groupId }));
}));

/// Yubormaganlar — standart holatda BARCHA guruhlar bo'ylab
api.get('/inactive', requireCoach, wrap(async (req, res) => {
    const days = Math.min(60, Math.max(1, Number(req.query.days) || 2));
    const groupId = req.query.group ? String(req.query.group) : null;
    res.json(await findInactive(req.db, req.tenant, { days, groupId }));
}));

/// Bugun to'liq yubormaganlar — barcha guruhlar
api.get('/missing-today', requireCoach, wrap(async (req, res) => {
    const groupId = req.query.group ? String(req.query.group) : null;
    res.json(await findMissingToday(req.db, { groupId }));
}));

api.get('/members', requireCoach, wrap(async (req, res) => {
    const groupId = req.query.group ? String(req.query.group) : null;
    res.json(await listMembers(req.db, { groupId }));
}));

api.get('/member/:id', wrap(async (req, res) => {
    const days = Math.min(60, Math.max(1, Number(req.query.days) || 14));
    const id = req.params.id === 'me' ? req.member?.id : req.params.id;
    if (!id) return res.status(404).json({ error: "A'zo topilmadi" });
    if (req.role === 'member' && id !== req.member?.id) return res.status(403).json({ error: 'Ruxsat yoʻq' });

    const rep = await memberReport(req.db, id, days);
    if (!rep) return res.status(404).json({ error: "A'zo topilmadi" });

    // Eslatma holati — murabbiy ilovadan o'chirib/yoqib qo'yishi uchun
    const overrides = await req.db.reminderOverride.findMany({ where: { memberId: id } });
    const reminders = Object.fromEntries(
        MEAL_TYPES.map(t => [t, !overrides.some(o => o.mealType === t && o.muted)]),
    );

    res.json({
        reminders,
        member: {
            id: rep.member.id,
            name: rep.member.name,
            timezone: rep.member.timezone,
            role: rep.member.role,
            ...(req.role !== 'member'
                ? { telegramId: rep.member.telegramId, username: rep.member.username }
                : {}),
        },
        days: rep.byDate,
        total: rep.total,
        expected: rep.expected,
    });
}));

api.get('/streak', wrap(async (req, res) => {
    const memberId = req.query.member ? String(req.query.member) : req.member?.id;
    if (!memberId) return res.json({ streak: 0, days: [] });
    if (req.role === 'member' && memberId !== req.member?.id) return res.status(403).json({ error: 'Ruxsat yoʻq' });

    const member = await req.db.member.findUnique({ where: { id: memberId } });
    if (!member) return res.status(404).json({ error: "A'zo topilmadi" });

    const window = lastNDates(safeTz(member.timezone), 30);
    const records = await req.db.mealRecord.findMany({
        where: { memberId, date: { in: window } },
        select: { date: true, status: true },
    });

    const days = window.map(date => {
        const forDate = records.filter(r => r.date === date);
        return { date, done: forDate.length, late: forDate.filter(r => r.status === 'late').length };
    });

    // Bugun hali tugamagan — seriyani kechagi kundan sanaymiz
    let streak = 0;
    for (let i = days.length - 2; i >= 0; i--) {
        if (days[i].done >= MEAL_TYPES.length) streak++;
        else break;
    }

    res.json({ streak, days });
}));

api.get('/settings', requireCoach, wrap(async (req, res) => {
    const t = req.tenant;
    res.json({
        timezone: t.timezone,
        breakfastTime: t.breakfastTime,
        lunchTime: t.lunchTime,
        dinnerTime: t.dinnerTime,
        graceMinutes: t.graceMinutes,
        reminderInterval: t.reminderInterval,
        maxReminders: t.maxReminders,
        dailyTableHour: t.dailyTableHour,
        requirePhoto: t.requirePhoto,
        autoDeleteReminders: t.autoDeleteReminders,
        breakfastWords: t.breakfastWords,
        lunchWords: t.lunchWords,
        dinnerWords: t.dinnerWords,
    });
}));

api.post('/settings', requireCoach, wrap(async (req, res) => {
    const b = req.body ?? {};
    const timeRe = /^([01]\d|2[0-3]):[0-5]\d$/;
    const data: Record<string, unknown> = {};

    for (const key of ['breakfastTime', 'lunchTime', 'dinnerTime'] as const) {
        if (b[key] !== undefined) {
            if (!timeRe.test(String(b[key]))) return res.status(400).json({ error: `${key} formati notoʻgʻri` });
            data[key] = String(b[key]);
        }
    }

    const nums: Array<[string, number, number]> = [
        ['graceMinutes', 0, 720],
        ['reminderInterval', 5, 1440],
        ['maxReminders', 0, 20],
        ['dailyTableHour', 0, 23],
    ];
    for (const [key, min, max] of nums) {
        if (b[key] !== undefined) {
            const v = Math.round(Number(b[key]));
            if (!Number.isFinite(v) || v < min || v > max) {
                return res.status(400).json({ error: `${key} ${min}..${max} oraligʻida boʻlsin` });
            }
            data[key] = v;
        }
    }

    if (b.requirePhoto !== undefined) data.requirePhoto = !!b.requirePhoto;
    if (b.autoDeleteReminders !== undefined) data.autoDeleteReminders = !!b.autoDeleteReminders;
    for (const key of ['breakfastWords', 'lunchWords', 'dinnerWords'] as const) {
        if (b[key]) data[key] = String(b[key]).slice(0, 500);
    }

    if (Object.keys(data).length === 0) return res.status(400).json({ error: 'Oʻzgarish yoʻq' });

    await prisma.tenant.update({ where: { id: req.tenant.id }, data });
    res.json({ ok: true, settings: data });
}));

api.post('/reminder-override', requireCoach, wrap(async (req, res) => {
    const { memberId, mealType, muted } = req.body ?? {};
    if (!memberId || !mealType) return res.status(400).json({ error: 'memberId va mealType kerak' });
    const member = await req.db.member.findUnique({ where: { id: String(memberId) } });
    if (!member) return res.status(404).json({ error: "A'zo topilmadi" });

    if (muted) {
        await req.db.reminderOverride.upsert({
            where: { memberId_mealType: { memberId: member.id, mealType: String(mealType) } },
            create: { memberId: member.id, mealType: String(mealType), muted: true },
            update: { muted: true },
        });
    } else {
        await req.db.reminderOverride.deleteMany({ where: { memberId: member.id, mealType: String(mealType) } });
    }
    res.json({ ok: true });
}));

api.get('/business', requireCoach, wrap(async (req, res) => {
    const conn = await activeConnection(req.db, req.telegramId);
    res.json({
        ready: !!conn,
        connection: conn ? { user: conn.userName, canReply: conn.canReply, enabled: conn.isEnabled } : null,
    });
}));
