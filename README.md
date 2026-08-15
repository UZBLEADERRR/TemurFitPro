# TemurFitPro

Ko'p ijarali (multi-tenant) Telegram platformasi — **bitta Railway servisida o'nlab
ratsion nazorat botlari**. Har bir mijoz o'z boti, o'z guruhlari va o'z murabbiysi
bilan ishlaydi; ma'lumotlar butunlay ajratilgan.

`temur-fit` botining davomchisi: u bitta guruh uchun qattiq sozlangan edi, bu esa
platformaga aylandi.

---

## Nima o'zgardi

| | temur-fit (eski) | TemurFitPro (yangi) |
|---|---|---|
| Botlar | 1 ta, token env'da | Cheksiz, ona bot orqali qo'shiladi |
| Guruhlar | 1 ta (`ALLOWED_GROUP_ID`) | Har bir botda cheksiz guruh |
| Ulanish | Long polling | Webhook (bitta port, N ta bot) |
| Sozlamalar | Global `Settings` qatori | Har bir bot uchun alohida |
| Murabbiy | Faqat rol belgisi | To'liq panel + bir buyruqli saralash |
| AI | Yo'q | Gemini 3 Flash: matn, ovoz, tool-calling |
| Xabar yuborish | Faqat guruhga | Murabbiy nomidan shaxsiy DM (Telegram Business) |
| Mini ilova | Bitta ekran | 4 ekranli mobil ilova, initData imzosi bilan |

---

## Arxitektura

```
                    ┌──────────────────────────────┐
   Telegram ───────▶│  Express (bitta Railway port)│
                    ├──────────────────────────────┤
  /tg/control/<sirl>│  Ona bot (super admin)       │
  /tg/<botId>/<sir> │  Tenant botlar reyestri      │──▶ Telegraf × N
  /api/*            │  Mini ilova API (HMAC auth)  │
  /app              │  React mini ilova            │
                    ├──────────────────────────────┤
                    │  Scheduler (node-cron)       │
                    │   · eslatmalar (1 daq)       │
                    │   · chiquvchi navbat (1 daq) │
                    │   · kunlik jadval (1 soat)   │
                    └──────────────┬───────────────┘
                                   ▼
                        Supabase Postgres (Prisma)
```

Barcha botlar **webhook** rejimida — long polling ishlatilmaydi, shuning uchun
o'nlab bot bitta jarayonda bemalol sig'adi. Har bir bot o'z URL yo'li va o'z
sirli tokeni bilan ajratilgan.

Bot tokenlari bazada **AES-256-GCM** bilan shifrlangan holda yotadi.

---

## Ishga tushirish

### 1. Supabase

Yangi loyiha yarating → **Project Settings → Database → Connection string →
Session pooler** (5432-port) satrini nusxalang.

> Transaction pooler (6543) ishlatmang — Prisma prepared statement'lari buziladi.

### 2. Ona bot

@BotFather da bot yarating (masalan `@TemurFitProAdminBot`). Bu **faqat sizniki** —
mijozlar unga kirmaydi.

### 3. Railway

Repozitoriyni ulang va env o'zgaruvchilarini kiriting (`.env.example` ga qarang):

```
CONTROL_BOT_TOKEN=...
SUPER_ADMIN_IDS=<sizning telegram id>
ENCRYPTION_KEY=<openssl rand -base64 32>
DATABASE_URL=<supabase session pooler>
PUBLIC_URL=https://<loyiha>.up.railway.app
GEMINI_API_KEY=<aistudio.google.com/apikey>
```

Deploy'dan keyin sxema avtomatik qo'llanadi (`prisma db push`).

### 4. Birinchi mijoz boti

1. @BotFather da mijoz uchun bot yarating, tokenini oling
2. Ona botga `/start` → **➕ Yangi bot qo'shish** → tokenni tashlang
3. Yangi botni mijoz guruhlariga qo'shing — ular **avtomatik** ro'yxatga olinadi
4. Botni guruhda **admin** qiling (jadvalni pinlash va eslatmalarni tozalash uchun)
5. Murabbiy o'sha botga `/start` bossin
6. Ona botda → bot → **🎯 Murabbiylar** → murabbiyni tayinlang

Botni birinchi bo'lib `/start` bosgan odam avtomatik **ega** (owner) bo'ladi.

---

## Rollar

| Rol | Qayerda | Nima qila oladi |
|---|---|---|
| **Super admin** | Ona bot | Bot qo'shish/o'chirish, guruhlar, murabbiylar, ma'lumot tozalash, istalgan botni AI orqali boshqarish |
| **Murabbiy** (owner/coach) | O'z boti | Saralash, statistika, sozlamalar, a'zolarga xabar, AI yordamchi |
| **A'zo** | O'z boti | Ovqat yuborish, o'z natijasi, mini ilova |

---

## Murabbiy uchun

### Bir buyruq bilan saralash

Barcha guruhlar bo'ylab ishlaydi:

- **⚠️ Yubormaganlar** tugmasi → 1 / 2 / 3 / 7 kunlik oyna
- `/saralash 3` — oxirgi 3 kunda yubormaganlar
- `/stat 14` — 14 kunlik intizom reytingi
- `/bugun` — barcha guruhlarning bugungi holati

> Bugun ovqat yuborgan odam "N kundan beri yubormaganlar" ro'yxatiga tushmaydi.

### AI yordamchi (Feruza)

Botga oddiy tilda yozing yoki **ovozli xabar** yuboring:

```
"oxirgi 2 kunda ovqat jo'natmaganlarni top"
"ularga ogohlantirish yubor"
"ertaga soat 9 da yubor"
"nonushta vaqtini 07:30 ga o'zgartir"
"eng intizomsiz 5 kishini ayt"
"Dilnozaning eslatmalarini o'chir, u kasal"
```

AI shunchaki gaplashmaydi — **botni haqiqatan boshqaradi**: sozlamalarni
o'zgartiradi, guruh qo'shadi, xabar yuboradi, jadvalni yangilaydi. Har bir
funksiya rol bo'yicha cheklangan: a'zoga hech qanday tool berilmaydi, murabbiy
platforma darajasidagi amallarni bajara olmaydi.

Yordamchining ismini o'zgartirish mumkin (**Sozlamalar → AI ismi**).

### Murabbiy nomidan xabar yuborish

Bot xabarni **sizning shaxsiy akkauntingiz nomidan** yuboradi — a'zo uchun bu
oddiy shaxsiy xabar bo'lib ko'rinadi.

Ulash (Telegram Premium talab qilinadi):

1. Telegram → **Sozlamalar → Telegram Business → Chatbots**
2. Bot username'ini kiriting
3. **"Reply to messages"** ruxsatini yoqing

Ulanish holatini botdagi **🔌 Business** bo'limida ko'rasiz.

### Yozish uslubi

**Sozlamalar → ✍️ Yozish uslubim** da o'z uslubingizni tasvirlab bering:

> "Qisqa yozaman, hurmat bilan lekin qat'iy. Doim ismini aytaman va oxirida bitta
> motivatsion jumla qo'shaman. Emoji kam ishlataman."

AI a'zolarga yozadigan har bir xabarni aynan shu uslubda tayyorlaydi.

---

## A'zolar uchun

Guruhga ovqat rasmini hashtag bilan yuborish:

`#nonushta` · `#tushlik` · `#kechki`

Kalit so'zlarni murabbiy o'zgartirishi mumkin. Bot javob beradi, pinlangan
jadvalni yangilaydi va o'sha ovqat uchun yuborilgan eslatmani guruhdan o'chiradi.

**Vaqt mintaqasi.** Har bir a'zo o'z mahalliy vaqtida hisoblanadi — Koreyadagi
va O'zbekistondagi a'zolar bitta guruhda to'g'ri ko'rinadi. Botga lokatsiya
yuborsangiz mintaqa avtomatik aniqlanadi.

Yarim tundan keyin yuborilgan kechki ovqat kechagi kunga yoziladi.

---

## Mini ilova

Bot tugmasi orqali ochiladi. Telegram mavzusiga moslashadi (yorug'/qorong'i).

- **Bugun** — kunlik jadval, sana bo'yicha o'tish, a'zoga bosib 14 kunlik tarix
- **Reyting** — intizom foizi va yubormaganlar (murabbiy)
- **A'zolar** — qidiruv, guruhlar (murabbiy)
- **Sozlash** — vaqtlar, eslatmalar, kalit so'zlar, AI uslubi (murabbiy)

A'zoga faqat **Bugun** ekrani ochiladi va u faqat o'z natijasini ko'radi.

Har bir so'rov Telegram `initData` HMAC imzosi bilan tekshiriladi — imzo o'sha
tenantning bot tokeni bilan solishtiriladi, shuning uchun bir mijoz boshqasining
ma'lumotiga o'ta olmaydi.

---

## Lokal ishlab chiqish

```bash
npm install
cp .env.example .env      # to'ldiring
npx prisma db push
npm run dev               # backend
cd client && npm run dev  # mini ilova (5173-port, /api proxy bilan)
```

Lokalda `PUBLIC_URL` bo'lmasa webhooklar o'rnatilmaydi — botlar yuklanadi,
lekin Telegram'dan update kelmaydi. Sinash uchun ngrok/cloudflared ishlating.

```bash
npm run typecheck   # backend
npm run build       # typecheck + mini ilova
```

---

## Loyiha tuzilishi

```
prisma/schema.prisma      Multi-tenant sxema
src/
  index.ts                Express, webhook marshrutlash, bootstrap
  scheduler.ts            Eslatmalar, kunlik jadval, navbat
  core/
    registry.ts           Tenant bot reyestri (Telegraf × N)
    tenants.ts            Bot qo'shish/o'chirish/tozalash
    crypto.ts             AES-256-GCM token shifrlash
    time.ts               Per-user timezone hisoblari
    meals.ts              Ovqat turlari va aniqlash
  bots/
    control.ts            Ona bot — super admin paneli
    tenant.ts             Mijoz boti handlerlari
    ui.ts, session.ts     Inline klaviaturalar, dialog holati
  features/
    recording.ts          Rasm → ovqat qaydi
    table.ts              Pinlangan jadval
    filters.ts            Saralash va statistika
    business.ts           Telegram Business orqali yuborish
    outbox.ts             Rejalashtirilgan xabarlar navbati
  ai/
    gemini.ts             Gemini REST klienti (matn + audio)
    tools.ts              Function-calling tool'lari + rol nazorati
    agent.ts              Agent sikli, xotira, ovoz
    prompt.ts             Tizim ko'rsatmasi
  api/
    auth.ts               initData HMAC tekshiruvi
    routes.ts             Mini ilova API
client/                   React + Vite mini ilova
```

---

## Xavfsizlik

- Bot tokenlari bazada AES-256-GCM bilan shifrlangan
- Har bir webhook o'z tasodifiy siri bilan (URL + `X-Telegram-Bot-Api-Secret-Token`)
- Mini ilova so'rovlari HMAC imzo bilan, doimiy vaqtli taqqoslash orqali
- Barcha so'rovlar `tenantId` bo'yicha cheklangan
- AI tool'lari rol bo'yicha filtrlangan; o'chirish amallari tasdiq talab qiladi
- Muhim amallar `AuditLog` ga yoziladi
