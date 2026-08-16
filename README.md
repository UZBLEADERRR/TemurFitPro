# TemurFitPro

Ko'p ijarali (multi-tenant) Telegram platformasi — **bitta Railway servisida o'nlab
ratsion nazorat botlari**. Har bir mijoz o'z boti, o'z guruhlari va o'z murabbiysi
bilan ishlaydi; ma'lumotlari **alohida faylda**.

`temur-fit` botining davomchisi: u bitta guruh uchun qattiq sozlangan edi, bu esa
platformaga aylandi.

---

## Nima o'zgardi

| | temur-fit (eski) | TemurFitPro (yangi) |
|---|---|---|
| Botlar | 1 ta, token env'da | Cheksiz, ona bot orqali qo'shiladi |
| Guruhlar | 1 ta (`ALLOWED_GROUP_ID`) | Har bir botda cheksiz guruh |
| Ulanish | Long polling | Webhook — bitta port, N ta bot |
| Baza | Postgres xizmati (oylik to'lov) | Volume ichidagi SQLite fayllar (bepul) |
| Ma'lumot ajratilishi | Yo'q | Har bot uchun alohida fayl |
| O'chirish | Qo'lda SQL | Tugma: guruh / tur / eski sana / butun bot |
| Murabbiy | Faqat rol belgisi | To'liq panel, barcha guruhlar bo'ylab saralash |
| Mini ilova | Bitta ekran, auth yo'q | 4 ekran, initData HMAC imzosi |

---

## Ma'lumotlar qayerda yotadi

Alohida baza xizmati **kerak emas**. Hamma narsa Railway Volume ichidagi
SQLite fayllarda:

```
/data
├── platform.db            botlar ro'yxati + super adminlar (kichik)
└── tenants/
    ├── 7891234567.db      1-bot: guruhlari, a'zolari, butun tarixi
    ├── 8123456789.db      2-bot: …
    └── 8234567890.db      3-bot: …
```

**Nega har bot alohida faylda:**

- Mijoz ketsa — **bitta fayl o'chadi**, hech qanday qoldiq qolmaydi
- Bir mijozning ma'lumoti boshqasinikiga jismonan aralashmaydi
- Zaxira nusxa ham, ko'chirish ham fayl darajasida
- Yozuv qulflari botlar orasida bo'linadi

**Guruhlar fayl ichida `groupId` bilan ajratilgan** — shuning uchun bitta so'rov
bilan barcha guruhlar bo'ylab hisobot olish mumkin, va istalgan bitta guruhni
alohida tozalash ham bir tugma.

**Xarajat:** Railway Volume ~5 GB dan boshlanadi. 100 kishilik guruh yiliga
taxminan 10 MB to'playdi — ya'ni yuzlab botga yetadi. Ona botdagi
**💾 Disk hisoboti** har bir botning hajmini ko'rsatib turadi.

---

## Arxitektura

```
                    ┌──────────────────────────────┐
   Telegram ───────▶│  Express (bitta Railway port)│
                    ├──────────────────────────────┤
  /tg/control/<sir> │  Ona bot (super admin)       │
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
                       SQLite fayllar (Railway Volume)
```

Barcha botlar **webhook** rejimida — polling yo'q, shuning uchun o'nlab bot bitta
jarayonda bemalol sig'adi. Har bir bot o'z URL yo'li va o'z tasodifiy siri bilan
ajratilgan. Bot tokenlari bazada **AES-256-GCM** bilan shifrlangan.

---

## Ishga tushirish

### 1. Ona bot

@BotFather da bot yarating (masalan `@TemurFitProAdminBot`). Bu **faqat sizniki** —
mijozlar unga kirmaydi.

### 2. Railway

Repozitoriyni ulang, so'ng:

**Volume qo'shing** — Service → Settings → Volumes → Add Volume, mount path `/data`.
Busiz ma'lumotlar har deploy'da yo'qoladi.

Env o'zgaruvchilari (`.env.example` ga qarang):

```
CONTROL_BOT_TOKEN=...
SUPER_ADMIN_IDS=<sizning telegram id>
ENCRYPTION_KEY=<openssl rand -base64 32>
PUBLIC_URL=https://<loyiha>.up.railway.app
```

Platforma bazasi startda avtomatik yaratiladi; har bir bot fayli esa bot
qo'shilgan payt paydo bo'ladi.

### 3. Birinchi mijoz boti

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
| **Super admin** | Ona bot | Bot qo'shish/o'chirish, guruhlar, murabbiylar, tozalash, disk hisoboti |
| **Murabbiy** (owner/coach) | O'z boti | Saralash, statistika, sozlamalar, guruhlarni tozalash, a'zolarga xabar |
| **A'zo** | O'z boti | Ovqat yuborish, o'z natijasi, mini ilova |

---

## Murabbiy uchun

### Yubormaganlar — barcha guruhlar bo'ylab

Asosiy ekran. Standart holatda **barcha guruhlar** ko'rsatiladi va natija
guruhlar bo'yicha bo'linadi:

```
⚠️ Oxirgi 2 kunda yubormaganlar
Jami 5 kishi · 2/3 guruhda

Ertalabki guruh — 3 kishi
  • Dilnoza (hech qachon)
  • Jasur (4 kun)
  • Aziz (2 kun)

Kechki guruh — 2 kishi
  • Kamola (3 kun)
  • Bek (2 kun)
```

Tugmalar: **1 / 2 / 3 / 7 kun** oynasi, kerak bo'lsa **bitta guruh** bilan
cheklash, va **✉️ Ularga ogohlantirish yuborish**.

> Bugun ovqat yuborgan odam bu ro'yxatga tushmaydi — ertalab nonushta
> yuborganni "2 kundan beri jim" deb ayblamaslik uchun.

Buyruqlar ham bor: `/saralash 3`, `/stat 14`, `/bugun`.

### Guruhlarni boshqarish

**🏠 Guruhlar** → guruhni tanlang:
- **📊 Shu guruh jadvali** — faqat o'sha guruhning bugungi holati
- **🧹 Ma'lumotlarini tozalash** — o'sha guruhning ovqat tarixi, eslatmalari va
  **faqat shu guruhdagi** a'zolari o'chadi (boshqa guruhda ham turganlar qoladi)

### Murabbiy nomidan xabar yuborish

Bot xabarni **sizning shaxsiy akkauntingiz nomidan** yuboradi — a'zo uchun bu
oddiy shaxsiy xabar bo'lib ko'rinadi.

Ulash (Telegram Premium talab qilinadi):

1. Telegram → **Sozlamalar → Telegram Business → Chatbots**
2. Bot username'ini kiriting
3. **"Reply to messages"** ruxsatini yoqing

Matnda `{name}` yozsangiz — har bir a'zoning ismiga almashadi.

#### ⚠️ Telegram cheklovi: 24 soat qoidasi

Telegram **sizning nomingizdan suhbat boshlashga ruxsat bermaydi** — faqat
javob berishga. Ya'ni xabar sizning akkauntingizdan **faqat oxirgi 24 soat
ichida sizga yozgan** odamga ketadi. Aks holda Telegram
`BUSINESS_PEER_USAGE_MISSING` xatosini qaytaradi. Buni aylanib o'tishning iloji
yo'q — bu Telegram tomonidagi spamga qarshi qoida.

Shuning uchun bot xabarni **bosqichma-bosqich** yetkazadi:

| # | Kanal | Qachon ishlaydi |
|---|-------|-----------------|
| 1 | 👤 Sizning nomingizdan | Odam oxirgi 24 soatda sizga yozgan bo'lsa |
| 2 | 🤖 Bot nomidan shaxsiy | Odam botni `/start` qilgan bo'lsa |
| 3 | 👥 Guruhda teglab | Deyarli har doim |

Natijada bot **kimga qaysi yo'l bilan yetganini aniq aytadi** va hech qachon
"yuborildi" deb yolg'on gapirmaydi. Yetib bormasa — sababi bilan sizga xabar
keladi. Barcha holatni **📮 Xabarlar holati** tugmasidan ko'rasiz.

> Hamma xabar sizning nomingizdan ketishini xohlasangiz: a'zolarga bir marta
> o'zingiz yozing yoki ulardan sizga yozishni so'rang — shundan keyin 24 soat
> oynasi ochiladi.

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

## Ma'lumotlarni o'chirish

Har bir daraja uchun alohida tugma — SQL yozish shart emas:

| Nima | Qayerda | Natija |
|---|---|---|
| Bitta guruh | Bot → 🏠 Guruhlar → guruh → 🧹 | O'sha guruh tarixi va faqat undagi a'zolar |
| Ovqat tarixi | Ona bot → bot → 🧹 Tozalash | Butun bot bo'yicha ovqat qaydlari |
| A'zolar | Ona bot → bot → 🧹 Tozalash | Oddiy a'zolar (murabbiylar qoladi) |
| 30/90 kundan eskisi | Ona bot → bot → 🧹 Tozalash | Faqat eski yozuvlar |
| Butun bot | Ona bot → bot → ❌ | **Fayl o'chadi**, qoldiq yo'q |

Har bir tozalashdan keyin `VACUUM` ishlaydi — bo'shagan joy diskka qaytadi.

---

## Mini ilova

Bot tugmasi orqali ochiladi. Telegram mavzusiga moslashadi (yorug'/qorong'i).

- **Bugun** — kunlik jadval, sana bo'yicha o'tish, a'zoga bosib 14 kunlik tarix
- **Reyting** — intizom foizi va yubormaganlar (guruhlar bo'yicha bo'lingan)
- **A'zolar** — qidiruv, guruhlar
- **Sozlash** — vaqtlar, eslatmalar, kalit so'zlar

A'zoga faqat **Bugun** ekrani ochiladi va u faqat o'z natijasini ko'radi.

Har bir so'rov Telegram `initData` HMAC imzosi bilan tekshiriladi — imzo o'sha
botning tokeni bilan solishtiriladi, shuning uchun bir mijoz boshqasining
ma'lumotiga o'ta olmaydi.

---

## AI (hozircha o'chirilgan)

AI yordamchi **ishlatilmayapti** (`AI_ENABLED=false`). Bot to'liq tugmalar va
buyruqlar bilan boshqariladi.

Kelajakda qaytarish uchun asos qoldirilgan: `src/ai/gemini.ts` — Gemini REST
klienti (matn + audio, function calling'ni qo'llaydi). Tool qatlami olib
tashlangan, chunki u eski Postgres sxemasiga bog'langan edi; yangidan yozilganda
`tenantDb(botId)` orqali ishlashi kerak.

---

## Lokal ishlab chiqish

```bash
npm install
cp .env.example .env      # to'ldiring
npm run dev               # backend (./data papkasida SQLite yaratadi)
cd client && npm run dev  # mini ilova (5173-port, /api proxy bilan)
```

Lokalda `PUBLIC_URL` bo'lmasa webhooklar o'rnatilmaydi — botlar yuklanadi,
lekin Telegram'dan update kelmaydi. Sinash uchun ngrok/cloudflared ishlating.

```bash
npm run typecheck    # backend
npm run build        # generate + typecheck + mini ilova
npm run sql:tenant   # sxema o'zgarsa tenant DDL faylini yangilash
```

**Sxemani o'zgartirsangiz:** `prisma/tenant.prisma` ni tahrirlab, `npm run sql:tenant`
ni ishga tushiring. Yangi bazalar yangi DDL bilan yaratiladi; mavjud fayllarga
qo'shimcha ustun kerak bo'lsa, migratsiyani qo'lda yozish lozim.

---

## Loyiha tuzilishi

```
prisma/
  platform.prisma         Botlar ro'yxati + super adminlar sxemasi
  tenant.prisma           Har bir bot fayli uchun sxema
  tenant-init.sql         Undan avtomatik yaratilgan DDL (runtime'da ishlatiladi)
scripts/prestart.js       Volume papkasi + platforma bazasini tayyorlash
src/
  index.ts                Express, webhook marshrutlash, bootstrap
  scheduler.ts            Eslatmalar, kunlik jadval, navbat
  core/
    db.ts                 Platforma klienti + tenant klient fabrikasi
    paths.ts              Fayl yo'llari, hajm hisoblash
    registry.ts           Tenant bot reyestri (Telegraf × N)
    tenants.ts            Bot qo'shish/o'chirish, guruh va tozalash amallari
    crypto.ts             AES-256-GCM token shifrlash
    time.ts               Per-user timezone hisoblari
    meals.ts              Ovqat turlari va aniqlash
    roles.ts              Rol yordamchilari
  bots/
    control.ts            Ona bot — super admin paneli
    tenant.ts             Mijoz boti handlerlari
    ui.ts, session.ts     Inline klaviaturalar, dialog holati
  features/
    recording.ts          Rasm → ovqat qaydi
    table.ts              Pinlangan jadval
    filters.ts            Saralash va statistika (guruhlar bo'yicha)
    business.ts           Telegram Business orqali yuborish
    delivery.ts           Yetkazish zanjiri: business → bot → guruh teg
    outbox.ts             Rejalashtirilgan xabarlar navbati
  ai/gemini.ts            Gemini klienti (hozircha ishlatilmaydi)
  api/                    Mini ilova API + initData tekshiruvi
client/                   React + Vite mini ilova
```

---

## Xavfsizlik

- Bot tokenlari bazada AES-256-GCM bilan shifrlangan
- Har bir webhook o'z tasodifiy siri bilan (URL + `X-Telegram-Bot-Api-Secret-Token`)
- Mini ilova so'rovlari HMAC imzo bilan, doimiy vaqtli taqqoslash orqali
- Har bir bot o'z faylida — so'rov boshqa botning ma'lumotiga yeta olmaydi
- Muhim amallar `AuditLog` ga yoziladi
