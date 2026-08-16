-- Mavjud bot bazalarini yangi sxemaga moslash.
--
-- tenant-init.sql faqat YANGI bazalarni yaratadi (CREATE TABLE IF NOT EXISTS),
-- eski jadvalga ustun qo'sha olmaydi. Shu fayldagi buyruqlar har bir baza
-- ochilganda bajariladi; ustun allaqachon bo'lsa SQLite "duplicate column"
-- xatosini qaytaradi va u e'tiborsiz qoldiriladi.
--
-- QOIDA: faqat idempotent buyruqlar. Har bir yangi ustun DEFAULT bilan.
-- Bir marta qo'shilgan qatorni O'CHIRMANG — eski bazalar unga muhtoj.

-- 2026-08: guruhlarni super admin tasdiqlaydigan bo'ldi
ALTER TABLE "Group" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "Group" ADD COLUMN "approvedAt" DATETIME;
ALTER TABLE "Group" ADD COLUMN "approvedBy" TEXT;

-- ESLATMA: bu yerga faqat ALTER TABLE yozing.
-- Ma'lumotni to'ldirish (backfill) kerak bo'lsa src/core/db.ts dagi
-- AFTER_COLUMN_ADDED ga qo'shing — u ustun HAQIQATAN qo'shilgandagina
-- ishlaydi, ya'ni faqat eski bazalarda.
