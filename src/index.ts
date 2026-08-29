import express from 'express';
import cors from 'cors';
import path from 'path';
import { env } from './core/env';
import { prisma, disconnectAll } from './core/db';
import { log } from './core/logger';
import { api } from './api/routes';
import { controlBot, seedSuperAdmins } from './bots/control';
import { getEntry, loadAllTenants, webhookPath } from './core/registry';
import { setWebhook, reconcile, CONTROL_UPDATES, type WebhookSpec } from './core/webhooks';
import { startScheduler } from './scheduler';
import { tgError } from './core/telegram';
import { DATA_DIR } from './core/paths';
import { encryptionKeyIsNew, secretsFilePath } from './core/secrets';
import { loadSettings, publicUrl } from './core/settings';

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ====== SOG'LIQ TEKSHIRUVI (Railway) ======
app.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

// ====== ONA BOT WEBHOOK ======
// Sir Volume ichidagi secrets.json da o'zi yaratiladi — env'da yozish shart emas.
const CONTROL_SECRET = env.CONTROL_WEBHOOK_SECRET;
const CONTROL_PATH = `/tg/control/${CONTROL_SECRET}`;
app.use(controlBot.webhookCallback(CONTROL_PATH, { secretToken: CONTROL_SECRET }));

// ====== TENANT BOTLAR WEBHOOK ======
// Bitta dinamik yo'l N ta botga xizmat qiladi: /tg/<botId>/<secret>
app.post('/tg/:botId/:secret', express.json(), async (req, res) => {
    const { botId, secret } = req.params;
    const entry = getEntry(botId);

    if (!entry || entry.secret !== secret) {
        res.sendStatus(404);
        return;
    }
    // Telegram sarlavhadagi sirni ham tekshiramiz — URL sizib ketsa ham himoya
    const headerSecret = req.header('x-telegram-bot-api-secret-token');
    if (headerSecret && headerSecret !== entry.secret) {
        res.sendStatus(403);
        return;
    }

    // Telegram 200 ni tez kutadi — update'ni fonda qayta ishlaymiz
    res.sendStatus(200);
    entry.bot
        .handleUpdate(req.body)
        .catch(e => log.error('webhook', `update xatosi (bot=${botId}): ${tgError(e)}`));
});

/// Ona bot webhookining tavsifi
export function controlSpec(): WebhookSpec {
    return {
        label: 'ona bot',
        url: `${publicUrl()}${CONTROL_PATH}`,
        secret: CONTROL_SECRET,
        allowedUpdates: CONTROL_UPDATES,
    };
}

/// Ona bot webhookini tekshirib, kerak bo'lsa tiklash (scheduler chaqiradi)
export async function reconcileControlWebhook(): Promise<boolean> {
    if (!publicUrl()) return false;
    return reconcile(controlBot, controlSpec());
}

// ====== API ======
app.use('/api', api);

// ====== MINI APP (statik) ======
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist, { maxAge: '1h', index: false }));
app.get(/^\/(?!api|tg|health).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, 'index.html'), err => {
        if (err) res.status(404).send('Mini ilova hali yig\'ilmagan (npm run build).');
    });
});

// ====== BOOTSTRAP ======
async function bootstrap(): Promise<void> {
    // Server DARHOL ko'tariladi — Railway health check kutib qolmasin
    app.listen(env.PORT, '0.0.0.0', () => {
        log.info('server', `${env.PORT} portda ishlamoqda`);
    });

    try {
        await prisma.$connect();
        log.info('db', `platforma bazasi ulandi (${DATA_DIR})`);
    } catch (e) {
        log.error('db', 'baza ochilmadi — Railway Volume ulanganini tekshiring', e);
        process.exit(1);
    }

    // Bot ichidan qo'yilgan sozlamalar (Gemini kaliti, model, PUBLIC_URL)
    await loadSettings();
    await seedSuperAdmins();
    await warnIfVolumeMissing();

    if (!publicUrl()) {
        log.warn(
            'server',
            "PUBLIC_URL topilmadi — webhooklar o'rnatilmaydi. Railway domenini yoqing yoki ona bot → 🔑 Kalitlar → 🌐 dan qo'ying.",
        );
    } else {
        // Webhook o'rnatishni KUTMAYMIZ: Telegram sekin javob bersa (504 odatiy hol)
        // butun startni 2 daqiqaga to'xtatib qo'yardi. Fonda qayta urinadi, va
        // baribir yiqilsa scheduler har 10 daqiqada tiklashga harakat qiladi.
        void setWebhook(controlBot, controlSpec()).then(ok => {
            if (!ok) log.warn('control-bot', "webhook hozircha o'rnatilmadi — scheduler qayta urinadi");
        });
    }

    await loadAllTenants();
    startScheduler();

    log.info('server', '🚀 TemurFitPro tayyor');
}

/// Volume ulanmagan bo'lsa shifrlash kaliti har deployda yangidan yaratiladi va
/// saqlangan bot tokenlari ochilmay qoladi. Sukut saqlab yiqilgandan ko'ra
/// sababini aniq aytgan ma'qul.
async function warnIfVolumeMissing(): Promise<void> {
    if (!encryptionKeyIsNew()) return;

    const tenants = await prisma.tenant.count().catch(() => 0);
    if (tenants === 0) {
        log.info('secrets', `shifrlash kaliti yaratildi: ${secretsFilePath()}`);
        return;
    }

    log.error(
        'secrets',
        [
            `DIQQAT: shifrlash kaliti YANGIDAN yaratildi, lekin bazada ${tenants} ta bot bor.`,
            `Bu odatda Volume ulanmaganini bildiradi (${DATA_DIR} har deployda tozalanmoqda).`,
            'Railway → Service → Settings → Volumes → mount path /data qiling.',
            "Aks holda mijoz bot tokenlari ochilmaydi va ularni qaytadan qo'shishga to'g'ri keladi.",
        ].join(' '),
    );
}

// ====== GRACEFUL SHUTDOWN ======
async function shutdown(signal: string): Promise<void> {
    log.info('server', `${signal} — yopilmoqda`);
    try {
        await disconnectAll();
    } catch {
        /* ignore */
    }
    process.exit(0);
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', reason => {
    log.error('process', 'ushlanmagan rejection', reason);
});
process.on('uncaughtException', err => {
    log.error('process', 'ushlanmagan exception', err);
});

void bootstrap();
