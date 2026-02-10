# Render PostgreSQL Setup (DAY/MON records)

This project now supports PostgreSQL-backed persistence for DAY/MON scoreboard records.

## 1) Set environment variables on your Render **web service**

In Render dashboard:

1. Open your web service.
2. Go to **Environment**.
3. Add:
   - `DATABASE_URL` = your Render Postgres **External Database URL**
   - `PGSSLMODE` = `require`
4. Save and redeploy.

> Important: keep credentials in Render Environment Variables only. Do not hardcode DB URLs in git.

## 2) Point client relay URL to your Render server

In browser console (once):

```js
localStorage.setItem('ninePokerRelayUrl', 'https://<your-render-service>.onrender.com');
location.reload();
```

## 3) How persistence works now

- Preferred read: `GET /records/DAY` and `GET /records/MON` on Render relay server.
- Preferred write: `POST /save` on Render relay server.
- Fallback: existing GitHub/Worker flow if API or DB is unavailable.

## 4) Verify quickly

Use your Render URL:

```bash
curl -i https://<your-render-service>.onrender.com/records/MON
```

Expected:
- `200` with JSON when record exists.
- `404` if no record yet.
- `503` if `DATABASE_URL` is not configured.
