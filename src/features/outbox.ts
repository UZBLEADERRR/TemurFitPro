import type { Tenant } from '../generated/platform';
import type { TenantClient } from '../core/db';
import { prisma, tenantDb } from '../core/db';
import { sendDirect } from './business';
import { log } from '../core/logger';
import { formatIn, safeTz } from '../core/time';
import { esc } from '../core/telegram';

const MAX_ATTEMPTS = 3;

export interface EnqueueInput {
    memberId?: string | null;
    chatId: string;
    text: string;
    channel?: 'business' | 'bot';
    scheduledFor?: Date;
    createdByTgId?: string;
    batchId?: string;
    connectionId?: string | null;
}

export async function enqueue(db: TenantClient, input: EnqueueInput) {
    return db.outboundMessage.create({
        data: {
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

/// Barcha faol botlarning navbatini qayta ishlash — scheduler har daqiqada chaqiradi.
export async function processOutbox(perTenant = 25): Promise<{ sent: number; failed: number }> {
    const tenants = await prisma.tenant.findMany({ where: { status: 'active' } });
    let sent = 0;
    let failed = 0;

    for (const tenant of tenants) {
        const db = await tenantDb(tenant.botId);
        const due = await db.outboundMessage.findMany({
            where: { status: 'pending', scheduledFor: { lte: new Date() } },
            orderBy: { scheduledFor: 'asc' },
            take: perTenant,
        });
        if (due.length === 0) continue;

        for (const msg of due) {
            const res = await sendDirect(db, tenant, msg.chatId, msg.text, {
                channel: msg.channel === 'bot' ? 'bot' : 'business',
                connectionId: msg.connectionId,
            });

            if (res.ok) {
                await db.outboundMessage.update({
                    where: { id: msg.id },
                    data: { status: 'sent', sentAt: new Date(), attempts: { increment: 1 }, error: null },
                });
                sent++;
            } else {
                const attempts = msg.attempts + 1;
                await db.outboundMessage.update({
                    where: { id: msg.id },
                    data: {
                        attempts,
                        error: res.error?.slice(0, 400),
                        status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
                        scheduledFor:
                            attempts >= MAX_ATTEMPTS ? msg.scheduledFor : new Date(Date.now() + 5 * 60_000),
                    },
                });
                failed++;
                log.warn('outbox', `yuborilmadi (${msg.chatId}): ${res.error}`);
            }

            // Telegram rate limit — ehtiyot uchun sekinlashtiramiz
            await new Promise(r => setTimeout(r, 120));
        }
    }

    return { sent, failed };
}

export async function pendingSummary(db: TenantClient, tenant: Tenant): Promise<string> {
    const rows = await db.outboundMessage.findMany({
        where: { status: 'pending' },
        orderBy: { scheduledFor: 'asc' },
        take: 15,
        include: { member: true },
    });
    if (rows.length === 0) return "📭 Rejalashtirilgan xabarlar yo'q.";
    const tz = safeTz(tenant.timezone);
    const lines = rows.map(
        r => `• ${formatIn(r.scheduledFor, tz, 'dd.MM HH:mm')} → ${esc(r.member?.name ?? r.chatId)}`,
    );
    return ['📭 <b>Navbatdagi xabarlar</b>', '', ...lines].join('\n');
}

export async function cancelPending(db: TenantClient, batchId?: string): Promise<number> {
    const res = await db.outboundMessage.updateMany({
        where: { status: 'pending', ...(batchId ? { batchId } : {}) },
        data: { status: 'cancelled' },
    });
    return res.count;
}
