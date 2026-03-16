# Watch Match Server

Standalone WebSocket backend for the Watch Match feature.

## Features
- Create and join 2-player sessions
- Each player submits 5 picks
- Random shared voting flow
- Match on `yes + yes`
- Built-in chat (`send_chat_message`, `chat_message`, `chat_history`)
- Health endpoint: `GET /health`

## Local Run
```bash
cd watch-match-server
npm install
npm start
```

Default port: `3001`

## Render Deployment (Free)
1. Push this folder as a separate GitHub repo.
2. Create a Render **Web Service**.
3. Build command: `npm install`
4. Start command: `npm start`
5. Health check path: `/health`

After deploy, use in app:

`VITE_WATCH_MATCH_SOCKET_URL=wss://<your-service>.onrender.com`
