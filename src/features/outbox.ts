import type { Tenant } from '../generated/platform';
import type { TenantClient } from '../core/db';
import { prisma, tenantDb } from '../core/db';
import { sendDirect, explainSendError } from './business';
import { deliverToMember, describeAttempts, isChannel, CHANNEL_LABEL, type Channel } from './delivery';
import { getBotByTenant } from '../core/registry';
import { log } from '../core/logger';
import { formatIn, safeTz } from '../core/time';
import { esc, chunkText } from '../core/telegram';

const MAX_ATTEMPTS = 3;

/// `failed` — endigina uzil-kesil xato bo'ldi, murabbiyga hali aytilmagan.
/// `failed_seen` — murabbiyga aytib bo'lindi. Ikkalasi ham "yuborilmagan".
export const FAILED_STATES = ['failed', 'failed_seen'];

export interface EnqueueInput {
    memberId?: string | null;
    chatId: string;
    text: string;
    channel?: Channel;
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

/// Darhol yuborilgan xabarni tarixga yozamiz (navbatdan o'tmasdan).
/// Shunda "nima yuborildi / nima yuborilmadi" tarixi bir joyda qoladi.
export async function recordSend(
    db: TenantClient,
    input: EnqueueInput & { ok: boolean; via?: Channel | null; error?: string },
) {
    return db.outboundMessage.create({
        data: {
            memberId: input.memberId ?? null,
            chatId: input.chatId,
            text: input.text,
            channel: input.via ?? input.channel ?? 'business',
            scheduledFor: input.scheduledFor ?? new Date(),
            createdByTgId: input.createdByTgId,
            batchId: input.batchId,
            attempts: 1,
            status: input.ok ? 'sent' : 'failed_seen',
            sentAt: input.ok ? new Date() : null,
            error: input.ok ? null : input.error?.slice(0, 400),
        },
    });
}

interface Failure {
    coachTgId: string;
    name: string;
    error: string;
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
            include: { member: true },
        });
        if (due.length === 0) continue;

        const failures: Failure[] = [];

        for (const msg of due) {
            const preferred = isChannel(msg.channel) ? msg.channel : 'business';

            // A'zo ma'lum bo'lsa — to'liq zanjir (business → bot → guruh).
            // A'zo bog'lanmagan bo'lsa faqat to'g'ridan-to'g'ri yuborish qoladi.
            const res = msg.member
                ? await deliverToMember(
                      db,
                      tenant,
                      { id: msg.member.id, telegramId: msg.member.telegramId, name: msg.member.name },
                      msg.text,
                      { preferred, connectionId: msg.connectionId, coachTgId: msg.createdByTgId ?? undefined },
                  )
                : await toDelivery(
                      await sendDirect(db, tenant, msg.chatId, msg.text, {
                          channel: preferred === 'group' ? 'bot' : preferred,
                          connectionId: msg.connectionId,
                          coachTgId: msg.createdByTgId ?? undefined,
                      }),
                  );

            if (res.ok) {
                await db.outboundMessage.update({
                    where: { id: msg.id },
                    data: {
                        status: 'sent',
                        sentAt: new Date(),
                        attempts: { increment: 1 },
                        error: null,
                        // Haqiqatan qaysi kanal ishlaganini saqlaymiz
                        channel: res.via ?? preferred,
                    },
                });
                sent++;
                await pace();
                continue;
            }

            const attempts = msg.attempts + 1;
            const done = attempts >= MAX_ATTEMPTS;
            await db.outboundMessage.update({
                where: { id: msg.id },
                data: {
                    attempts,
                    error: (res.error ?? describeAttempts(res.attempts)).slice(0, 400),
                    status: done ? 'failed' : 'pending',
                    scheduledFor: done ? msg.scheduledFor : new Date(Date.now() + 5 * 60_000),
                },
            });
            failed++;
            log.warn('outbox', `yuborilmadi (${msg.chatId}): ${describeAttempts(res.attempts)}`);

            if (done && msg.createdByTgId) {
                failures.push({
                    coachTgId: msg.createdByTgId,
                    name: msg.member?.name ?? msg.chatId,
                    error: res.error ?? "Noma'lum sabab",
                });
            }

            await pace();
        }

        if (failures.length) await notifyFailures(tenant, db, failures);
    }

    return { sent, failed };
}

/// Telegram rate limit — ehtiyot uchun har xabar orasida biroz kutamiz
function pace() {
    return new Promise(r => setTimeout(r, 120));
}

async function toDelivery(res: { ok: boolean; channel: 'business' | 'bot'; error?: string }) {
    return {
        ok: res.ok,
        via: res.ok ? (res.channel as Channel) : null,
        attempts: [{ channel: res.channel as Channel, ok: res.ok, error: res.error }],
        error: res.ok ? undefined : explainSendError(res.error),
    };
}

/// Xabar yetib bormasa murabbiy BUNI BILISHI SHART — aks holda bot
/// "yubordim" deb qo'yadi, odam esa hech narsa olmaydi.
async function notifyFailures(tenant: Tenant, db: TenantClient, failures: Failure[]): Promise<void> {
    const bot = getBotByTenant(tenant.id);
    if (!bot) return;

    const byCoach = new Map<string, Failure[]>();
    for (const f of failures) {
        if (!byCoach.has(f.coachTgId)) byCoach.set(f.coachTgId, []);
        byCoach.get(f.coachTgId)!.push(f);
    }

    for (const [coachTgId, rows] of byCoach) {
        const lines = [
            `❌ <b>${rows.length} ta xabar yetib bormadi</b>`,
            '',
            ...rows.map(r => `• <b>${esc(r.name)}</b>\n  <i>${esc(r.error)}</i>`),
            '',
            "Qayta urinish uchun xabarni bot orqali yoki guruhda teglab yuboring — men ularni o'zim sinab ko'rdim, lekin ular ham o'tmadi.",
        ].join('\n');

        for (const part of chunkText(lines)) {
            await bot.telegram
                .sendMessage(coachTgId, part, { parse_mode: 'HTML' })
                .catch(e => log.warn('outbox', `murabbiyga xabar bermadik: ${e?.message}`));
        }
    }

    await db.outboundMessage.updateMany({ where: { status: 'failed' }, data: { status: 'failed_seen' } });
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

/// Yetib bormagan xabarlar — sababi bilan.
export async function failedSummary(db: TenantClient, tenant: Tenant, take = 15): Promise<string> {
    const rows = await db.outboundMessage.findMany({
        where: { status: { in: FAILED_STATES } },
        orderBy: { createdAt: 'desc' },
        take,
        include: { member: true },
    });
    if (rows.length === 0) return '✅ Yetib bormagan xabar yo\'q — hammasi joyida.';

    const tz = safeTz(tenant.timezone);
    const lines = rows.map(r => {
        const who = esc(r.member?.name ?? r.chatId);
        const when = formatIn(r.createdAt, tz, 'dd.MM HH:mm');
        return `• <b>${who}</b> <i>(${when})</i>\n  ${esc(explainSendError(r.error))}`;
    });
    return [`❌ <b>Yetib bormagan xabarlar — ${rows.length}</b>`, '', ...lines].join('\n');
}

export async function listFailed(db: TenantClient, take = 20) {
    const rows = await db.outboundMessage.findMany({
        where: { status: { in: FAILED_STATES } },
        orderBy: { createdAt: 'desc' },
        take,
        include: { member: true },
    });
    return rows.map(r => ({
        id: r.id,
        member: r.member?.name ?? r.chatId,
        channel: isChannel(r.channel) ? CHANNEL_LABEL[r.channel] : r.channel,
        text: r.text.slice(0, 120),
        reason: explainSendError(r.error),
        created_at: r.createdAt.toISOString(),
    }));
}

export async function cancelPending(db: TenantClient, batchId?: string): Promise<number> {
    const res = await db.outboundMessage.updateMany({
        where: { status: 'pending', ...(batchId ? { batchId } : {}) },
        data: { status: 'cancelled' },
    });
    return res.count;
}
