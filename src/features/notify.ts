import { prisma } from '../core/db';
import { log } from '../core/logger';
import { chunkText, tgError } from '../core/telegram';

/// Ona bot orqali barcha super adminlarga xabar yuborish.
/// controlBot dinamik import qilinadi — aks holda modullar aylanma bog'lanib qoladi
/// (control.ts → tenants.ts → notify.ts → control.ts).
export async function notifySuperAdmins(text: string, keyboard?: any): Promise<number> {
    const { controlBot } = await import('../bots/control');
    const admins = await prisma.superAdmin.findMany();

    let sent = 0;
    for (const admin of admins) {
        const chunks = chunkText(text);
        try {
            for (let i = 0; i < chunks.length; i++) {
                const isLast = i === chunks.length - 1;
                await controlBot.telegram.sendMessage(admin.telegramId, chunks[i], {
                    parse_mode: 'HTML',
                    link_preview_options: { is_disabled: true },
                    ...(isLast && keyboard ? keyboard : {}),
                } as any);
            }
            sent++;
        } catch (e) {
            // Admin botni bloklagan yoki hali /start bosmagan bo'lishi mumkin
            log.warn('notify', `super adminga yuborilmadi (${admin.telegramId}): ${tgError(e)}`);
        }
    }
    return sent;
}
