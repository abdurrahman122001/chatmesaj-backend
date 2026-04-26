-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "addedToKnowledge" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Site" ADD COLUMN     "settings" JSONB;
