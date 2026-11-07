# client/

Settld website: React 19 + Vite + TypeScript, three.js scenes, Circle user-controlled wallets (email code + PIN),
World ID (IDKit) for arbitrators.

```bash
npm install
npm run dev      # http://localhost:5173 — /api is proxied to the Railway backend (set VITE_API_PROXY=http://localhost:3000 for a local server)
npm run build    # client/dist; in production the API server serves it (see ../Dockerfile)
```

Needs `client/.env` with `VITE_CIRCLE_APP_ID` (never commit it).

| Folder | Contents |
|---|---|
| `src/app/` | App shell, hash router, scroll and motion helpers |
| `src/pages/` | One file per screen (overview, new deal, deal, wallet, timeline, court, how it works) |
| `src/components/` | Shared UI, the confirmation flow modal, World ID widget |
| `src/data/` | Store, live API calls (`live.ts`, `liveDeals.ts`), Circle and World ID flows, demo fixtures |
| `src/lib/` | Formatting, address checks, deadlock checker bridge to `../shared` |
| `src/three/` | three.js scenes |
