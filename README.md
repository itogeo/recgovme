# recgov.me

Cabin cancellation monitor for Recreation.gov. Users pick an Alaska USFS cabin, select dates, enter their email, and get notified when cancellation openings appear.

## Architecture

- **Frontend** (`site/`) — Static site on Cloudflare Pages. Cabin search, date picker, form that writes to Supabase.
- **Worker** (`worker/`) — Cloudflare Worker on a 5-min cron. Reads watches from Supabase, polls Recreation.gov, diffs state in KV, emails via Resend.
- **Database** — Supabase (watches + notifications tables).

## Setup

### 1. Supabase

Create a project and run `supabase/schema.sql` in the SQL editor.

### 2. Cabin list

```bash
python scripts/fetch-cabins.py
```

This writes `site/cabins.json` — the searchable cabin list for the frontend.

### 3. Frontend

Edit `site/app.js` and replace `SUPABASE_URL` and `SUPABASE_ANON_KEY` with your project values.

Deploy `site/` to Cloudflare Pages.

### 4. Worker

```bash
cd worker
npm install
wrangler kv namespace create STATE    # copy the ID into wrangler.toml
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put RESEND_API_KEY
wrangler secret put EMAIL_FROM
wrangler secret put WORKER_URL
wrangler deploy
```

### 5. Test

```bash
# Trigger a manual check
curl https://recgovme.YOUR_SUBDOMAIN.workers.dev/check

# Watch logs
cd worker && npx wrangler tail
```

## Cost

All services run within free tiers at small scale ($0/month).
