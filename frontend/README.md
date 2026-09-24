# Frontend

Next.js (App Router), TypeScript and Tailwind. It talks to the API only
through `lib/api.ts`. See the [root README](../README.md) for how the whole
project fits together.

```bash
npm install
cp .env.local.example .env.local   # NEXT_PUBLIC_API_URL=http://localhost:3000
npm run dev -- -p 3001             # http://localhost:3001
npm run build                      # type-check, lint and production build
```

## Layout

| Folder | Holds |
|---|---|
| `app/` | pages, kept thin: they load data and arrange components |
| `components/` | UI, grouped by area (`orders/`, `analytics/`, `team/`, `charts/`) |
| `lib/api.ts` | every API call and its types, the only HTTP client |
| `lib/` | formatting, CSV export, saved view state, session helpers |
