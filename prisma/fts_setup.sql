-- Knowledge base full-text search setup.
-- İlk migration-dan sonra bu SQL-i DB-yə tətbiq edin:
-- psql $DATABASE_URL -f prisma/fts_setup.sql
-- Və ya Prisma Studio-dan işlədin.

-- tsvector sütunu əlavə edirik (title + content birləşdirilib)
ALTER TABLE "KnowledgeEntry"
  ADD COLUMN IF NOT EXISTS search_vector tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(content, '')), 'B')
  ) STORED;

-- GIN index sürətli axtarış üçün
CREATE INDEX IF NOT EXISTS knowledge_search_idx
  ON "KnowledgeEntry" USING GIN(search_vector);
