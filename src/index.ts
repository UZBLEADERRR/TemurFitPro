import express from 'express';
import cors from 'cors';
import path from 'path';
import { env } from './core/env';
import { prisma } from './core/db';
import { log } from './core/logger';
import { api } from './api/routes';
import { controlBot, seedSuperAdmins } from './bots/control';
import { getEntry, loadAllTenants, webhookPath } from './core/registry';
import { startScheduler } from './scheduler';
import { tgError } from './core/telegram';

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '1mb' }));

// ====== SOG'LIQ TEKSHIRUVI (Railway) ======
app.get('/health', (_req, res) => {
    res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

// ====== ONA BOT WEBHOOK ======
const CONTROL_SECRET = process.env.CONTROL_WEBHOOK_SECRET || 'control';
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
        log.info('db', 'ulandi');
    } catch (e) {
        log.error('db', 'ulanmadi — qayta urinish uchun restart kerak', e);
        process.exit(1);
    }

    await seedSuperAdmins();

    if (!env.PUBLIC_URL) {
        log.warn('server', "PUBLIC_URL sozlanmagan — webhooklar o'rnatilmaydi. Railway'da qo'shing.");
    } else {
        try {
            await controlBot.telegram.setWebhook(`${env.PUBLIC_URL}${CONTROL_PATH}`, {
                secret_token: CONTROL_SECRET,
                drop_pending_updates: true,
                allowed_updates: ['message', 'callback_query', 'my_chat_member'],
            });
            log.info('control-bot', 'webhook o\'rnatildi');
        } catch (e) {
            log.error('control-bot', `webhook o'rnatilmadi: ${tgError(e)}`);
        }
    }

    await loadAllTenants();
    startScheduler();

    log.info('server', '🚀 TemurFitPro tayyor');
}

// ====== GRACEFUL SHUTDOWN ======
async function shutdown(signal: string): Promise<void> {
    log.info('server', `${signal} — yopilmoqda`);
    try {
        await prisma.$disconnect();
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
