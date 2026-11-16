# Contributing

Thanks for taking a look. This is a proof of concept, so keep changes small and focused.

## Setup

```bash
npm install
npx playwright install chromium   # once, for the browser tests
npm run dev                       # API :4570 + Vite :5173
```

No Google account is needed for development: with no credentials the app runs on the in-memory backend.

## Before opening a PR

```bash
npm run typecheck
npm run test:drive
npm run test:e2e
```

- Add or adjust tests for behaviour changes. Backend logic → `scripts/drive-mock-test.mjs` or a Playwright
  API test; UI behaviour → `e2e/app.spec.ts`.
- Keep the `ObjectStore` interface the single seam between backends and the HTTP layer.
- Never commit `credentials.json`, `token.json`, `.env`, or anything under `node_modules`, `dist`,
  `web/dist`, `test-results`.

## Style

- TypeScript, strict, no `any` unless it is at an API boundary.
- Backend code has no framework and no runtime dependencies beyond `googleapis`.
- React: server state in TanStack Query, local state only for UI concerns.
- Commit messages: `feat(api): …`, `fix(web): …`, `docs: …`, `test: …` — one logical change per commit.
