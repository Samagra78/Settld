import 'dotenv/config';
import cors from 'cors';
import express from 'express';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'settld-server' });
});

// Routes added step by step (see docs/INTERFACES.md):
//   S4  POST /api/deals, GET /api/deals/:specHash
//   S5  POST /api/report/encode
//   S8  POST /api/certify
//   S10 POST /api/worldid

app.listen(PORT, () => {
  console.log(`Settld server running on http://localhost:${PORT}`);
});
