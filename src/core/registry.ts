import { Telegraf } from 'telegraf';
import type { Tenant } from '../generated/platform';
import { prisma, tenantDb } from './db';
import { decrypt } from './crypto';
import { env } from './env';
import { log } from './logger';
import { tgError } from './telegram';
import { buildTenantBot } from '../bots/tenant';

/// Ishga tushirilgan tenant botlar reyestri: botId -> instance.
/// Bitta Node jarayoni N ta Telegraf instansiyasini webhook rejimida boshqaradi —
/// polling ishlatilmaydi, shuning uchun 10+ bot bemalol sig'adi.
interface Entry {
    tenantId: string;
    botId: string;
    secret: string;
    bot: Telegraf;
}

const registry = new Map<string, Entry>();

export function getEntry(botId: string): Entry | undefined {
    return registry.get(botId);
}

export function getBot(botId: string): Telegraf | undefined {
    return registry.get(botId)?.bot;
}

/// tenantId orqali botni topish (scheduler va AI tool'lari uchun)
export function getBotByTenant(tenantId: string): Telegraf | undefined {
    for (const e of registry.values()) {
        if (e.tenantId === tenantId) return e.bot;
    }
    return undefined;
}

export function activeTenantIds(): string[] {
    return [...new Set([...registry.values()].map(e => e.tenantId))];
}

export function webhookPath(tenant: { botId: string; webhookSecret: string }): string {
    return `/tg/${tenant.botId}/${tenant.webhookSecret}`;
}

export function webhookUrl(tenant: { botId: string; webhookSecret: string }): string {
    return `${env.PUBLIC_URL}${webhookPath(tenant)}`;
}

/// Tenant botini xotiraga yuklash va Telegram'da webhook o'rnatish.
export async function registerTenant(tenant: Tenant, setWebhook = true): Promise<void> {
    unregisterTenant(tenant.botId);

    // Bot uchun alohida ma'lumot fayli tayyor turishi kerak
    await tenantDb(tenant.botId);

    const token = decrypt(tenant.botTokenEnc);
    const bot = new Telegraf(token, { handlerTimeout: 90_000 });

    bot.catch((err, ctx) => {
        log.error('tenant-bot', `xato (tenant=${tenant.id}, update=${ctx?.update?.update_id ?? '?'})`, err);
    });

    buildTenantBot(bot, tenant.id);

    registry.set(tenant.botId, {
        tenantId: tenant.id,
        botId: tenant.botId,
        secret: tenant.webhookSecret,
        bot,
    });

    if (setWebhook && env.PUBLIC_URL) {
        try {
            await bot.telegram.setWebhook(webhookUrl(tenant), {
                secret_token: tenant.webhookSecret,
                drop_pending_updates: false,
                // Business update turlari Telegraf 4.16 tiplarida yo'q — xom ro'yxat
                allowed_updates: [
                    'message', 'edited_message', 'callback_query', 'my_chat_member',
                    'chat_member', 'business_connection', 'business_message',
                    'edited_business_message', 'deleted_business_messages',
                ] as any,
            });
            log.info('registry', `webhook o'rnatildi: @${tenant.botUsername} (${tenant.botId})`);
        } catch (e) {
            log.error('registry', `webhook o'rnatishda xato @${tenant.botUsername}: ${tgError(e)}`);
        }
    }
}

export function unregisterTenant(botId: string): void {
    const entry = registry.get(botId);
    if (!entry) return;
    registry.delete(botId);
}

/// Botni to'liq o'chirish — webhook ham olib tashlanadi.
export async function detachTenant(botId: string): Promise<void> {
    const entry = registry.get(botId);
    if (entry) {
        try {
            await entry.bot.telegram.deleteWebhook({ drop_pending_updates: true });
        } catch (e) {
            log.warn('registry', `webhook o'chirilmadi (${botId}): ${tgError(e)}`);
        }
    }
    unregisterTenant(botId);
}

/// Startda barcha faol tenantlarni yuklash.
export async function loadAllTenants(): Promise<void> {
    const tenants = await prisma.tenant.findMany({ where: { status: 'active' } });
    log.info('registry', `${tenants.length} ta faol tenant yuklanmoqda...`);
    for (const t of tenants) {
        try {
            await registerTenant(t);
        } catch (e) {
            log.error('registry', `tenant yuklanmadi ${t.botUsername}`, e);
        }
    }
    log.info('registry', `${registry.size} ta bot faol`);
}
