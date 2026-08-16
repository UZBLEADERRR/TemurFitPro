import type { Telegraf } from 'telegraf';
import { withRetry, tgError } from './telegram';
import { log } from './logger';

/// Webhook o'rnatish — Telegram vaqtinchalik javob bermasligi mumkin
/// (504 Gateway Time-out odatiy hol). Bir marta urinib taslim bo'lish
/// botni butunlay kar qoldiradi, shuning uchun qat'iy qayta urinamiz.

export const TENANT_UPDATES = [
    'message',
    'edited_message',
    'callback_query',
    'my_chat_member',
    'chat_member',
    'business_connection',
    'business_message',
    'edited_business_message',
    'deleted_business_messages',
];

export const CONTROL_UPDATES = ['message', 'callback_query', 'my_chat_member'];

export interface WebhookSpec {
    label: string;
    url: string;
    secret: string;
    allowedUpdates: string[];
}

export async function setWebhook(bot: Telegraf, spec: WebhookSpec): Promise<boolean> {
    try {
        // 5 urinish, 2s dan boshlab: 2 · 4 · 8 · 16 soniya
        await withRetry(
            () =>
                bot.telegram.setWebhook(spec.url, {
                    secret_token: spec.secret,
                    allowed_updates: spec.allowedUpdates as any,
                }),
            4,
            2000,
        );
        log.info('webhook', `o'rnatildi: ${spec.label}`);
        return true;
    } catch (e) {
        log.error('webhook', `o'rnatilmadi (${spec.label}): ${tgError(e)}`);
        return false;
    }
}

export interface WebhookState {
    url: string;
    ok: boolean;
    pending: number;
    lastError?: string;
    lastErrorAt?: Date;
}

export async function getState(bot: Telegraf, expectedUrl: string): Promise<WebhookState | null> {
    try {
        const info: any = await bot.telegram.getWebhookInfo();
        return {
            url: info.url || '',
            ok: !!info.url && info.url === expectedUrl,
            pending: info.pending_update_count ?? 0,
            lastError: info.last_error_message,
            lastErrorAt: info.last_error_date ? new Date(info.last_error_date * 1000) : undefined,
        };
    } catch (e) {
        log.warn('webhook', `holatni olishda xato: ${tgError(e)}`);
        return null;
    }
}

/// Webhook kutilgan manzilga mos emasligini tekshirib, kerak bo'lsa qayta o'rnatadi.
/// Scheduler har 10 daqiqada chaqiradi — bir marta yiqilgan webhook o'zi tiklanadi.
export async function reconcile(bot: Telegraf, spec: WebhookSpec): Promise<boolean> {
    const state = await getState(bot, spec.url);
    if (state?.ok) return true;

    log.warn(
        'webhook',
        `${spec.label} mos emas (hozirgi: "${state?.url ?? '?'}") — qayta o'rnatilmoqda`,
    );
    return setWebhook(bot, spec);
}
