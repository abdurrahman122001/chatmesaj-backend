# Chatbot Backend

Node.js + Express + PostgreSQL + Prisma + Socket.IO.

## Tələblər

- Node.js 18+
- PostgreSQL 14+
- (opsional) Docker

## Sürətli start (local development)

### 1. PostgreSQL qaldır

Əgər local Postgres yoxdursa, Docker ilə:

```bash
docker run --name chatbot-pg -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=chatbot -p 5432:5432 -d postgres:16
```

### 2. Dependencies

```bash
cd server
npm install
```

### 3. Environment

```bash
cp .env.example .env
# .env faylını aç və DATABASE_URL, JWT_SECRET dəyərlərini yoxla
```

### 4. Migration + seed

```bash
npm run prisma:migrate   # ilk dəfə: migration yaradılır və tətbiq olunur
npm run seed             # admin@example.com / admin1234 istifadəçisi + nümunə knowledge entry-lər
```

### 4b. Full-text search setup (knowledge base üçün)

Migration-dan sonra **bir dəfə** bu SQL-i tətbiq edin (knowledge axtarışı üçün lazımdır):

```bash
# Windows (PowerShell):
Get-Content prisma/fts_setup.sql | psql $env:DATABASE_URL

# Linux/macOS:
psql $DATABASE_URL -f prisma/fts_setup.sql
```

Və ya Docker ilə:
```bash
docker exec -i chatbot-pg psql -U postgres -d chatbot < prisma/fts_setup.sql
```

### 5. Server-i başlat

```bash
npm run dev
```

Server `http://localhost:4000` ünvanında qalxır. Test:

```bash
curl http://localhost:4000/api/health
```

## API Endpoint-ləri

### Auth
- `POST /api/auth/register` — `{ email, password, name, siteName? }` → `{ token, user, sites }`
- `POST /api/auth/login` — `{ email, password }` → `{ token, user }`
- `GET  /api/auth/me` (auth) → `{ user, sites }`

### Admin (auth tələb edir — `Authorization: Bearer <token>`)
- `GET    /api/conversations?status=OPEN`
- `GET    /api/conversations/:id`
- `POST   /api/conversations/:id/messages` — `{ text, attachments? }`
- `PATCH  /api/conversations/:id` — `{ status?, assigneeId? }`
- `GET    /api/contacts?q=...`
- `PATCH  /api/contacts/:id`
- `PATCH  /api/sites/:id` — `{ quickActions?, appearance?, name? }`

### Knowledge base (auth tələb edir)
- `GET    /api/knowledge?siteId=...&status=ACTIVE`
- `POST   /api/knowledge` — `{ title, content, url?, tags?, status? }`
- `PATCH  /api/knowledge/:id`
- `DELETE /api/knowledge/:id`
- `GET    /api/knowledge/search?q=...` — axtarış testi

### Widget (public, auth yoxdur, `apiKey` query/body-də)
- `GET  /api/widget/config?apiKey=...`
- `POST /api/widget/session` — `{ apiKey, visitorToken?, metadata?, currentUrl?, referrer? }`
- `POST /api/widget/message` — `{ apiKey, visitorToken, text, attachments? }` → visitor mesajı + avtomatik bot cavabı (knowledge search-dən)
- `POST /api/widget/escalate` — `{ apiKey, visitorToken }` → "operator lazımdır"
- `GET  /api/widget/messages?apiKey=...&visitorToken=...&sinceId=...`

### Knowledge bot necə işləyir?

1. Visitor mesaj yazır.
2. Mesaj DB-yə VISITOR kimi yazılır.
3. Eyni anda backend knowledge base-də **full-text search** (PostgreSQL tsvector) edir.
4. Nəticə tapılsa:
   - BOT mesajı yaradılır (ən uyğun entry + əlaqəli mövzular)
   - Conversation statusu → `BOT`
5. Nəticə tapılmasa:
   - SYSTEM mesajı "Operator lazımdır" göndərilir
   - Status → `PENDING_HUMAN`
   - Admin inbox-a `conversation:needs-human` socket event-i göndərilir
6. Əgər agent söhbətə girsə (`assigneeId` təyin edilsə) — bot artıq cavab vermir.

### Upload
- `POST /api/uploads` — multipart form, field adı `files` (max 5, default 10MB hər biri)

### Socket.IO
- **Admin**: `io(URL, { auth: { token } })` → `join-site`, `join-conversation`, `typing`
- **Widget**: `io(URL, { auth: { apiKey, siteId, conversationId } })`
- **Events**: `conversation:message`, `conversation:updated`, `message`, `typing`

## Production Deploy (VPS)

### 1. PostgreSQL

```bash
# Ubuntu
sudo apt install postgresql postgresql-contrib
sudo -u postgres psql
# DB + user yarat
CREATE DATABASE chatbot;
CREATE USER chatbot WITH ENCRYPTED PASSWORD 'strong_password';
GRANT ALL PRIVILEGES ON DATABASE chatbot TO chatbot;
```

### 2. Node.js (pm2 ilə)

```bash
npm install -g pm2
cd /var/www/chatbot/server
npm ci
npm run prisma:deploy
pm2 start src/index.js --name chatbot-api
pm2 save
pm2 startup   # komandanı icra edib systemd-yə əlavə et
```

### 3. Nginx reverse proxy

```nginx
server {
    listen 443 ssl http2;
    server_name api.your-domain.com;

    ssl_certificate /etc/letsencrypt/live/api.your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/api.your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

### 4. Environment faylı

```
DATABASE_URL=postgresql://chatbot:strong_password@localhost:5432/chatbot?schema=public
JWT_SECRET=<uzun-təsadüfi-string>
FRONTEND_ORIGIN=https://admin.your-domain.com
WIDGET_ORIGINS=https://ripcrack.net,https://another-client.com
UPLOAD_DIR=/var/www/chatbot/uploads
PORT=4000
NODE_ENV=production
```

## Admin UI-nı API-yə bağlamaq

Frontend-də `VITE_API_URL=http://localhost:4000` və ya production URL-i `.env` faylına yazın. Növbəti mərhələdə edəcəyik.
"# chatmesaj-backend" 
