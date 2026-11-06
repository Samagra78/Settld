# client/

Settld web app: Vite + React + TypeScript, with Circle user-controlled wallets (email code + PIN).

```bash
npm install
npm run dev      # http://localhost:5173 (proxies /api to the server on :3000)
npm run build
```

Needs `client/.env` with `VITE_CIRCLE_APP_ID` (never commit it).
