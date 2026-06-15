# World Cup — Production Deployment Reference

This documents how the live World Cup API and site are deployed, so future fixes
are not made blindly on the server. **No secret values appear in this file.**

## Topology

- **Frontend (static SEO site):** rsync'd to `ubuntu@<prod-host>:/var/www/worldcup`
  and served by nginx at `https://renrenrenai.cn/worldcup/`. Not a git clone.
- **API (this `backend/`):** runs on the prod host under PM2 and is reached at
  `https://renrenrenai.cn/api/*` via an nginx reverse proxy.

## Deployed API

| Item | Value |
|---|---|
| Deployed path | `/home/ubuntu/worldcup-app` (this `backend/` directory) |
| PM2 process | `worldcup-api` (fork mode, `NODE_ENV=production`) |
| Entry script | `backend/server.js` |
| Listen port | `3001` |
| Bind address | should be `127.0.0.1` (loopback-only, behind nginx) |
| Env file | `/home/ubuntu/worldcup-app/.env` (server-only, **never committed**) |
| Local DB | JSON store at `.data/worldcup-db.json` (gitignored) |

The deployed source is historically edited directly on the server and has at
times run ahead of this repo. Keep this branch/`backend/` in sync after any
server-side change.

## nginx / proxy expectations

- `location ^~ /api/` → `proxy_pass http://127.0.0.1:3001/api/` (GET/HEAD/POST/OPTIONS only).
- `location ^~ /api/admin/` → `return 404` **except** `/api/admin/worldcup-growth/summary`,
  which is proxied (and must be protected by `ADMIN_TOKEN` in the app).
- `location = /api/predict` → `return 405`.
- `location ^~ /worldcup/` → static from `/var/www/worldcup` with security headers + CSP
  (CSP must allowlist AdSense + GA4 domains).
- Root `renrenrenai.cn/` redirects to `/worldcup/`; `/ads.txt` stays served at the root.
- The `/api` → `/worldcup-api` path migration is **deferred** (not active yet).

## Environment variables (names only — set real values in server `.env`)

See `.env.example`. Names:

- `NODE_ENV`, `PORT`, `HOST`
- `ADMIN_TOKEN` — bearer/basic credential for `/api/admin/*`; if unset, admin fails closed (403)
- `ALLOWED_ORIGIN` — CORS allowlist origin (prod: `https://renrenrenai.cn`)
- `DATABASE_URL` — reserved (JSON store used by default)
- `FOOTBALL_API_PROVIDER`, `API_FOOTBALL_KEY`, `SPORTMONKS_KEY` — provider config (keys are secret)
- `SYNC_INTERVAL_MINUTES`, `DATA_STORE`, `JSON_DB_PATH`, `ENABLE_CRON`

The app does not load `.env` itself (no dotenv). Env vars are injected via PM2:
source `.env`, then `pm2 restart worldcup-api --update-env && pm2 save`.

## Security controls (in `backend/`)

`backend/security.js` provides: security headers, CORS allowlist (`corsGuard`),
per-IP rate limiting (`createRateLimiter`: public 120 / analytics 30 / admin 10
per minute → 429), `requireAdminToken` (bearer/`X-Admin-Token`) and
`requireAdminBasicAuth` for `/admin` pages, `rejectPublicWrites`, and an analytics
handler that allowlists `event_name` (400 on unknown) and caps metadata size.

## Deploy / restart

```bash
# from /home/ubuntu/worldcup-app on the server
set -a; . ./.env; set +a
pm2 restart worldcup-api --update-env && pm2 save
```

## Rollback

Timestamped backups of server-side edits live in
`/home/ubuntu/worldcup-app/backups/<timestamp>/`. To roll back, restore the files
and `pm2 restart worldcup-api`.
