-- CreateTable
CREATE TABLE "Group" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "approvedAt" DATETIME,
    "approvedBy" TEXT,
    "pinnedMessageId" INTEGER,
    "lastTableDate" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Member" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "telegramId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameLc" TEXT NOT NULL DEFAULT '',
    "username" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "status" TEXT NOT NULL DEFAULT 'active',
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Tashkent',
    "latitude" REAL,
    "longitude" REAL,
    "dmOpen" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT NOT NULL DEFAULT '',
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "GroupMember" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "joinedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "GroupMember_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "GroupMember_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MealRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "memberId" TEXT NOT NULL,
    "groupId" TEXT,
    "date" TEXT NOT NULL,
    "mealType" TEXT NOT NULL,
    "timeSent" DATETIME NOT NULL,
    "status" TEXT NOT NULL,
    "photoFileId" TEXT,
    "messageId" INTEGER,
    "caption" TEXT,
    CONSTRAINT "MealRecord_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MealRecord_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Mention" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "mealType" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "messageId" INTEGER NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Mention_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "Group" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Mention_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReminderOverride" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "memberId" TEXT NOT NULL,
    "mealType" TEXT NOT NULL,
    "muted" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ReminderOverride_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BusinessConnection" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "connectionId" TEXT NOT NULL,
    "userTgId" TEXT NOT NULL,
    "userChatId" TEXT NOT NULL,
    "userName" TEXT NOT NULL DEFAULT '',
    "canReply" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "OutboundMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "memberId" TEXT,
    "chatId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'business',
    "connectionId" TEXT,
    "scheduledFor" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "sentAt" DATETIME,
    "createdByTgId" TEXT,
    "batchId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OutboundMessage_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "Member" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BotSession" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'idle',
    "payload" TEXT NOT NULL DEFAULT '{}',
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "AiMessage" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatKey" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "Group_chatId_key" ON "Group"("chatId");

-- CreateIndex
CREATE INDEX "Group_isActive_status_idx" ON "Group"("isActive", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Member_telegramId_key" ON "Member"("telegramId");

-- CreateIndex
CREATE INDEX "Member_role_idx" ON "Member"("role");

-- CreateIndex
CREATE INDEX "Member_status_idx" ON "Member"("status");

-- CreateIndex
CREATE INDEX "GroupMember_memberId_idx" ON "GroupMember"("memberId");

-- CreateIndex
CREATE UNIQUE INDEX "GroupMember_groupId_memberId_key" ON "GroupMember"("groupId", "memberId");

-- CreateIndex
CREATE INDEX "MealRecord_date_idx" ON "MealRecord"("date");

-- CreateIndex
CREATE INDEX "MealRecord_groupId_date_idx" ON "MealRecord"("groupId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "MealRecord_memberId_date_mealType_key" ON "MealRecord"("memberId", "date", "mealType");

-- CreateIndex
CREATE INDEX "Mention_date_idx" ON "Mention"("date");

-- CreateIndex
CREATE UNIQUE INDEX "Mention_groupId_memberId_mealType_date_key" ON "Mention"("groupId", "memberId", "mealType", "date");

-- CreateIndex
CREATE UNIQUE INDEX "ReminderOverride_memberId_mealType_key" ON "ReminderOverride"("memberId", "mealType");

-- CreateIndex
CREATE UNIQUE INDEX "BusinessConnection_connectionId_key" ON "BusinessConnection"("connectionId");

-- CreateIndex
CREATE INDEX "BusinessConnection_isEnabled_idx" ON "BusinessConnection"("isEnabled");

-- CreateIndex
CREATE INDEX "OutboundMessage_status_scheduledFor_idx" ON "OutboundMessage"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "OutboundMessage_batchId_idx" ON "OutboundMessage"("batchId");

-- CreateIndex
CREATE UNIQUE INDEX "BotSession_chatId_key" ON "BotSession"("chatId");

-- CreateIndex
CREATE INDEX "AiMessage_chatKey_createdAt_idx" ON "AiMessage"("chatKey", "createdAt");

