import type { Telegraf } from 'telegraf';
import type { Tenant } from '../generated/platform';
import type { TenantClient } from '../core/db';
import { getBotByTenant } from '../core/registry';
import { tgError, withRetry } from '../core/telegram';
import { log } from '../core/logger';

/// Telegram Business ulanishi:
/// Murabbiy Telegram → Sozlamalar → Business → Chatbots bo'limida botni ulaydi.
/// Shundan keyin bot xabarlarni AYNAN murabbiyning shaxsiy akkaunti nomidan
/// yubora oladi (business_connection_id parametri orqali).

interface BusinessConnectionUpdate {
    id: string;
    user: { id: number; first_name?: string; last_name?: string; username?: string };
    user_chat_id: number;
    date: number;
    rights?: { can_reply?: boolean };
    can_reply?: boolean;
    is_enabled: boolean;
}

export async function saveBusinessConnection(db: TenantClient, conn: BusinessConnectionUpdate): Promise<void> {
    const canReply = conn.rights?.can_reply ?? conn.can_reply ?? false;
    const userName = [conn.user?.first_name, conn.user?.last_name].filter(Boolean).join(' ') || '';

    await db.businessConnection.upsert({
        where: { connectionId: conn.id },
        create: {
            connectionId: conn.id,
            userTgId: String(conn.user.id),
            userChatId: String(conn.user_chat_id),
            userName,
            canReply,
            isEnabled: conn.is_enabled,
        },
        update: { canReply, isEnabled: conn.is_enabled, userName },
    });

    log.info('business', `ulanish ${conn.is_enabled ? 'yoqildi' : "o'chirildi"}: ${userName} (reply=${canReply})`);
}

export async function activeConnection(db: TenantClient, coachTgId?: string) {
    if (coachTgId) {
        const own = await db.businessConnection.findFirst({
            where: { userTgId: coachTgId, isEnabled: true, canReply: true },
        });
        if (own) return own;
    }
    return db.businessConnection.findFirst({
        where: { isEnabled: true, canReply: true },
        orderBy: { updatedAt: 'desc' },
    });
}

export interface SendResult {
    ok: boolean;
    channel: 'business' | 'bot';
    error?: string;
}

export async function sendDirect(
    db: TenantClient,
    tenant: Tenant,
    chatId: string,
    text: string,
    opts: { channel?: 'business' | 'bot'; connectionId?: string | null; coachTgId?: string } = {},
): Promise<SendResult> {
    const bot = getBotByTenant(tenant.id);
    const channel = opts.channel ?? 'business';
    if (!bot) return { ok: false, channel, error: 'Bot faol emas' };

    if (channel === 'business') {
        const conn = opts.connectionId
            ? await db.businessConnection.findUnique({ where: { connectionId: opts.connectionId } })
            : await activeConnection(db, opts.coachTgId);

        if (!conn || !conn.isEnabled || !conn.canReply) {
            return {
                ok: false,
                channel: 'business',
                error:
                    "Business ulanish yo'q yoki javob berish huquqi berilmagan. " +
                    'Telegram → Sozlamalar → Business → Chatbots orqali botni ulang va "Reply to messages" ni yoqing.',
            };
        }

        try {
            await withRetry(() => callSendMessage(bot, chatId, text, conn.connectionId));
            return { ok: true, channel: 'business' };
        } catch (e) {
            return { ok: false, channel: 'business', error: tgError(e) };
        }
    }

    try {
        await withRetry(() => bot.telegram.sendMessage(chatId, text, { parse_mode: 'HTML' }));
        return { ok: true, channel: 'bot' };
    } catch (e) {
        return { ok: false, channel: 'bot', error: tgError(e) };
    }
}

/// business_connection_id Telegraf tiplarida yo'q — xom API chaqiruvi.
function callSendMessage(bot: Telegraf, chatId: string, text: string, connectionId: string) {
    return (bot.telegram as any).callApi('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        business_connection_id: connectionId,
        link_preview_options: { is_disabled: true },
    });
}

export async function connectionSummary(db: TenantClient): Promise<string> {
    const conns = await db.businessConnection.findMany();
    if (conns.length === 0) {
        return [
            "🔌 <b>Business ulanish yo'q</b>",
            '',
            'Murabbiy nomidan xabar yuborish uchun:',
            '1. Telegram → <b>Sozlamalar</b> → <b>Telegram Business</b>',
            "2. <b>Chatbots</b> bo'limini oching",
            "3. Shu botning username'ini kiriting",
            '4. <b>"Reply to messages"</b> ruxsatini yoqing',
            '',
            '<i>Eslatma: Telegram Business faqat Premium obunachilarga ochiq.</i>',
        ].join('\n');
    }
    const lines = conns.map(c => {
        const state = !c.isEnabled ? "⛔️ o'chiq" : c.canReply ? '✅ tayyor' : "⚠️ javob huquqi yo'q";
        return `• ${c.userName || c.userTgId} — ${state}`;
    });
    return ['🔌 <b>Business ulanishlar</b>', '', ...lines].join('\n');
}
