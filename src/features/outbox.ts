import type { Tenant } from '@prisma/client';
import { prisma } from '../core/db';
import { sendDirect } from './business';
import { log } from '../core/logger';
import { formatIn, safeTz } from '../core/time';
import { esc } from '../core/telegram';

const MAX_ATTEMPTS = 3;

export interface EnqueueInput {
    tenantId: string;
    memberId?: string | null;
    chatId: string;
    text: string;
    channel?: 'business' | 'bot';
    scheduledFor?: Date;
    createdByTgId?: string;
    batchId?: string;
    connectionId?: string | null;
}

export async function enqueue(input: EnqueueInput) {
    return prisma.outboundMessage.create({
        data: {
            tenantId: input.tenantId,
            memberId: input.memberId ?? null,
            chatId: input.chatId,
            text: input.text,
            channel: input.channel ?? 'business',
            scheduledFor: input.scheduledFor ?? new Date(),
            createdByTgId: input.createdByTgId,
            batchId: input.batchId,
            connectionId: input.connectionId ?? null,
        },
    });
}

/// Navbatni qayta ishlash — scheduler har daqiqada chaqiradi.
export async function processOutbox(limit = 40): Promise<{ sent: number; failed: number }> {
    const due = await prisma.outboundMessage.findMany({
        where: { status: 'pending', scheduledFor: { lte: new Date() } },
        orderBy: { scheduledFor: 'asc' },
        take: limit,
        include: { tenant: true },
    });

    let sent = 0;
    let failed = 0;

    for (const msg of due) {
        if (msg.tenant.status !== 'active') continue;

        const res = await sendDirect(msg.tenant as Tenant, msg.chatId, msg.text, {
            channel: msg.channel === 'bot' ? 'bot' : 'business',
            connectionId: msg.connectionId,
        });

        if (res.ok) {
            await prisma.outboundMessage.update({
                where: { id: msg.id },
                data: { status: 'sent', sentAt: new Date(), attempts: { increment: 1 }, error: null },
            });
            sent++;
        } else {
            const attempts = msg.attempts + 1;
            await prisma.outboundMessage.update({
                where: { id: msg.id },
                data: {
                    attempts,
                    error: res.error?.slice(0, 400),
                    status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
                    // Qayta urinishni 5 daqiqaga suramiz
                    scheduledFor: attempts >= MAX_ATTEMPTS ? msg.scheduledFor : new Date(Date.now() + 5 * 60_000),
                },
            });
            failed++;
            log.warn('outbox', `yuborilmadi (${msg.chatId}): ${res.error}`);
        }

        // Telegram rate limit — sekundiga ~25 xabar; ehtiyot uchun sekinlashtiramiz
        await new Promise(r => setTimeout(r, 120));
    }

    return { sent, failed };
}

export async function batchStatus(tenantId: string, batchId: string): Promise<string> {
    const rows = await prisma.outboundMessage.findMany({
        where: { tenantId, batchId },
        include: { member: true },
    });
    if (rows.length === 0) return 'Bu partiya topilmadi.';

    const sent = rows.filter(r => r.status === 'sent').length;
    const pending = rows.filter(r => r.status === 'pending').length;
    const failed = rows.filter(r => r.status === 'failed');

    const lines = [
        `📬 <b>Yuborish holati</b>`,
        `✅ Yuborildi: ${sent} · ⏳ Navbatda: ${pending} · ❌ Xato: ${failed.length}`,
    ];
    if (failed.length) {
        lines.push('', '<b>Xatolar:</b>');
        for (const f of failed.slice(0, 10)) {
            lines.push(`• ${esc(f.member?.name ?? f.chatId)} — ${esc((f.error ?? '').slice(0, 120))}`);
        }
    }
    return lines.join('\n');
}

export async function pendingSummary(tenant: Tenant): Promise<string> {
    const rows = await prisma.outboundMessage.findMany({
        where: { tenantId: tenant.id, status: 'pending' },
        orderBy: { scheduledFor: 'asc' },
        take: 15,
        include: { member: true },
    });
    if (rows.length === 0) return '📭 Rejalashtirilgan xabarlar yo\'q.';
    const tz = safeTz(tenant.timezone);
    const lines = rows.map(
        r => `• ${formatIn(r.scheduledFor, tz, 'dd.MM HH:mm')} → ${esc(r.member?.name ?? r.chatId)}`,
    );
    return ['📭 <b>Navbatdagi xabarlar</b>', '', ...lines].join('\n');
}

export async function cancelPending(tenantId: string, batchId?: string): Promise<number> {
    const res = await prisma.outboundMessage.updateMany({
        where: { tenantId, status: 'pending', ...(batchId ? { batchId } : {}) },
        data: { status: 'cancelled' },
    });
    return res.count;
}
