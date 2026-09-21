# Mara House dashboard — TillFlow UI

This is the public browser app. It talks **only** to the API Gateway.
`/internal/*`, `/payments/callback`, `/payments/b2c/callback` are never called.

## Live endpoints the till uses

| Action | Call | Auth |
|---|---|---|
| Create sale | `POST /sales` | `X-Tenant-Id`, `X-User-Id`, `X-Role: attendant`, `Idempotency-Key` |
| Read sale | `GET /sales/:id` | same headers |
| Cancel (only from `created`) | `POST /sales/:id/cancel` | same headers |
| Start pay | `POST /sales/:id/pay` `{ msisdn }` | + `Idempotency-Key` |
| Poll until paid | `GET /sales/:id` | same headers |
| Ops strip | `GET /health` `/ready` `/version` | none |

Default identity is the seeded Mara House till:

- tenant `11111111-1111-1111-1111-111111111111`
- attendant `22222222-2222-2222-2222-222222222222`
- payer `254700000000`

A timeout is **not** a decline. Fake STK still needs the signed callback
before the sale becomes `paid`. This UI will not post that callback.

## Local

```sh
cd MaraHouseDashboard
bun install
bun run dev
```

Vite proxies `/sales`, `/health`, `/ready`, `/version` to the live Gateway.
Turn **Simulate** off in Settings to hit real POS.

## Ship with web

Release builds this folder with Bun and copies it into `services/web/public`.
`GET /` and `GET /demo` become HTML. `/health` `/ready` `/version` stay JSON.
`/sales*` still routes to POS.

Laptop copy (optional): `./services/web/scripts/sync-ui.sh` then `cd services/web && npm start`.

---

# Welcome to your Lovable project

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Open your project in the [Lovable editor](https://lovable.dev) and keep building.

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: connect the project to GitHub and every change made in Lovable is committed straight to your repository.
- **Full ownership**: this code is yours. Push to your repository and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```

## Built with

- TanStack Start
- TypeScript
- React
- Tailwind CSS
