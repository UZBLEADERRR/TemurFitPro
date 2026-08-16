import { Telegraf } from 'telegraf';
import type { Tenant } from '../generated/platform';
import { prisma, tenantDb } from './db';
import { decrypt } from './crypto';
import { env } from './env';
import { log } from './logger';
import { tgError } from './telegram';
import { setWebhook, reconcile, getState, TENANT_UPDATES, type WebhookSpec } from './webhooks';
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
export async function registerTenant(tenant: Tenant, withWebhook = true): Promise<void> {
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

    if (withWebhook && env.PUBLIC_URL) {
        await setWebhook(bot, tenantSpec(tenant));
    }
}

/// Tenant boti uchun webhook tavsifi
export function tenantSpec(tenant: { botId: string; botUsername: string; webhookSecret: string }): WebhookSpec {
    return {
        label: `@${tenant.botUsername}`,
        url: webhookUrl(tenant),
        secret: tenant.webhookSecret,
        allowedUpdates: TENANT_UPDATES,
    };
}

/// Barcha tenant botlarining webhookini tekshirib, kerak bo'lsa tiklaydi.
/// Telegram bir marta javob bermay qolsa, bot butunlay kar bo'lib qolmasin.
export async function reconcileTenantWebhooks(): Promise<{ checked: number; fixed: number }> {
    if (!env.PUBLIC_URL) return { checked: 0, fixed: 0 };
    let checked = 0;
    let fixed = 0;

    for (const entry of registry.values()) {
        const tenant = await prisma.tenant.findUnique({ where: { id: entry.tenantId } });
        if (!tenant || tenant.status !== 'active') continue;
        checked++;
        const spec = tenantSpec(tenant);
        if ((await getState(entry.bot, spec.url))?.ok) continue;
        if (await reconcile(entry.bot, spec)) fixed++;
    }

    return { checked, fixed };
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
