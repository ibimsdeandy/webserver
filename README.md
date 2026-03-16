# WSE Watch Match Server

Standalone WebSocket backend for the Watch Match feature.

## Features
- Creates and joins 2-player sessions
- Each player submits 5 picks
- Random synchronized movie voting
- Match on `yes + yes`
- Next movie on non-match
- In-memory session state (MVP)

## Local Run
```bash
cd watch-match-server
npm install
npm start
```

Server runs on `PORT` (default `3001`).

## Health Check
- `GET /health` returns `{ "ok": true }`

## WebSocket URL
- Local: `ws://localhost:3001`
- Render: `wss://<your-service>.onrender.com`

## Render Deploy
1. Push `watch-match-server` as a separate GitHub repo.
2. Create a new **Web Service** on Render.
3. Use:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Node: `>=18`
4. After deploy, copy your public URL and set in app:
   - `VITE_WATCH_MATCH_SOCKET_URL=wss://<your-service>.onrender.com`

## Notes
- This MVP stores everything in memory.
- For production, move sessions to Redis/Postgres and add auth.
