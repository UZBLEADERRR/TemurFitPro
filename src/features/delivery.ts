import type { Tenant } from '../generated/platform';
import type { TenantClient } from '../core/db';
import { getBotByTenant } from '../core/registry';
import { sendDirect, explainSendError, activeConnection } from './business';
import { withRetry, tgError, mention } from '../core/telegram';
import { LIVE_GROUP } from '../core/groups';

/// # Nega zanjir kerak?
///
/// Telegram Business murabbiyning shaxsiy akkaunti nomidan xabar yuborishga
/// ruxsat beradi, LEKIN faqat SUHBATGA JAVOB sifatida: odam oxirgi 24 soat
/// ichida murabbiyga yozgan bo'lishi shart. Aks holda Telegram
/// `BUSINESS_PEER_USAGE_MISSING` xatosini qaytaradi va xabar yo'qoladi.
///
/// Shuning uchun xabarni bosqichma-bosqich yetkazamiz:
///   1. business — murabbiyning o'z nomidan (eng yaxshisi),
///   2. bot      — bot nomidan shaxsiy xabar (odam botni ishga tushirgan bo'lsa),
///   3. group    — guruhda odamni teglab (bu deyarli har doim ishlaydi).
///
/// Har bir urinish natijasi saqlanadi — murabbiy qaysi kanal ishlaganini
/// aniq ko'radi va bot hech qachon "yuborildi" deb yolg'on gapirmaydi.

export type Channel = 'business' | 'bot' | 'group';

export const CHANNEL_LABEL: Record<Channel, string> = {
    business: 'sizning nomingizdan',
    bot: 'bot nomidan shaxsiy',
    group: 'guruhda teglab',
};

const LADDER: Record<Channel, Channel[]> = {
    business: ['business', 'bot', 'group'],
    bot: ['bot', 'group'],
    group: ['group'],
};

export function isChannel(v: unknown): v is Channel {
    return v === 'business' || v === 'bot' || v === 'group';
}

export interface DeliveryTarget {
    id?: string | null;
    telegramId: string;
    name: string;
}

export interface Attempt {
    channel: Channel;
    ok: boolean;
    error?: string;
}

export interface DeliveryResult {
    ok: boolean;
    /// Xabar HAQIQATAN qaysi kanal orqali ketdi. Yetib bormasa — null.
    via: Channel | null;
    attempts: Attempt[];
    /// Odam tushunadigan xato izohi (ok=false bo'lganda)
    error?: string;
}

export interface DeliverOptions {
    preferred?: Channel;
    /// false bo'lsa faqat preferred kanal sinaladi
    fallback?: boolean;
    connectionId?: string | null;
    coachTgId?: string;
}

/// Guruhda teglab yuborish — a'zo qaysi guruhda bo'lsa o'shanda.
async function sendViaGroup(
    db: TenantClient,
    tenant: Tenant,
    target: DeliveryTarget,
    text: string,
): Promise<{ ok: boolean; error?: string }> {
    const bot = getBotByTenant(tenant.id);
    if (!bot) return { ok: false, error: 'Bot faol emas' };

    let chatId: string | null = null;
    if (target.id) {
        const link = await db.groupMember.findFirst({
            where: { memberId: target.id, group: LIVE_GROUP },
            include: { group: true },
            orderBy: { joinedAt: 'desc' },
        });
        chatId = link?.group.chatId ?? null;
    }
    if (!chatId) return { ok: false, error: "A'zo hech qaysi faol guruhda emas" };

    try {
        await withRetry(() =>
            bot.telegram.sendMessage(chatId!, `${mention(target.telegramId, target.name)}, ${text}`, {
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
            }),
        );
        return { ok: true };
    } catch (e) {
        return { ok: false, error: tgError(e) };
    }
}

export async function deliverToMember(
    db: TenantClient,
    tenant: Tenant,
    target: DeliveryTarget,
    text: string,
    opts: DeliverOptions = {},
): Promise<DeliveryResult> {
    const preferred = opts.preferred && isChannel(opts.preferred) ? opts.preferred : 'business';
    const chain = opts.fallback === false ? [preferred] : LADDER[preferred];
    const attempts: Attempt[] = [];

    for (const channel of chain) {
        if (channel === 'group') {
            const res = await sendViaGroup(db, tenant, target, text);
            attempts.push({ channel, ok: res.ok, error: res.error });
            if (res.ok) return { ok: true, via: channel, attempts };
            continue;
        }

        const res = await sendDirect(db, tenant, target.telegramId, text, {
            channel,
            connectionId: channel === 'business' ? opts.connectionId : null,
            coachTgId: opts.coachTgId,
        });
        attempts.push({ channel, ok: res.ok, error: res.error });
        if (res.ok) return { ok: true, via: channel, attempts };
    }

    // Eng birinchi (eng muhim) urinishning sababini ko'rsatamiz — odatda shu
    // murabbiyga kerakli javob: "nega mening nomimdan ketmadi?"
    return { ok: false, via: null, attempts, error: explainSendError(attempts[0]?.error) };
}

/// Zanjir natijasini bitta qatorga siqamiz — log va hisobot uchun.
export function describeAttempts(attempts: Attempt[]): string {
    return attempts.map(a => `${a.channel}${a.ok ? ' ✅' : ` ❌ ${a.error ?? ''}`.trimEnd()}`).join(' → ');
}

/// Murabbiyning nomidan yuborish umuman mumkinmi? (ogohlantirish uchun)
export async function businessReady(db: TenantClient, coachTgId?: string): Promise<boolean> {
    return !!(await activeConnection(db, coachTgId));
}
