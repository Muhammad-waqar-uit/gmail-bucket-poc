# AGENTS.md

Repository notes for agents and new contributors. Read this before changing the auth or storage paths.

## What this repo is

A proof-of-concept **app** built on the `gmail-bucket` library, which lives in its own repository
(`Muhammad-waqar-uit/gmail-bucket`). The library owns storage backends, OAuth, the REST server and the
`serve()` entry; this repo owns the React UI (`web/`), `src/main.ts`, `src/auth-cli.ts`, `src/doctor.ts`,
`src/env.ts` and the Playwright suites.

## Commands

| Command | What it does |
| --- | --- |
| `npm run build` | `tsc` then Vite build — run before claiming a change works |
| `npm run typecheck` | Four tsconfigs: root, `web/`, `e2e/`, `examples/` |
| `npm run test:drive` | Library backends against a mock Drive — fast, no network, no account |
| `npm run test:e2e` | Builds, then Playwright API + browser tests |
| `npm test` | Typecheck + `test:drive` + `test:e2e` |
| `npm run dev` | API on `:4570`, Vite on `:5173` (proxies `/api`) |
| `npm run doctor` | Read-only diagnosis of the active config; exit 1 only when it cannot work |
| `npm run auth` | OAuth login; writes `token.json` next to `credentials.json` |

No credentials means **memory mode**, which is why the quick start needs no Google account. Point
`GMAIL_BUCKET_DIR` at a temp directory to exercise auth paths without touching `~/.gmail-bucket`.

## The library pin

`package.json` depends on a **tag**, not npm: `github:Muhammad-waqar-uit/gmail-bucket#v2.2.0`.
Never point it at a tag that does not exist — `npm install` fails with `ETARGET` and CI goes red.

`v2.2.0` exists but was never published to npm (`latest` there is `1.0.0`). The next release, **2.3.0**,
is prepared in the library repo: `drive.file` Drive scope by default, per-backend `login()`, a
`DRIVE_SCOPE=full` escape hatch, and `nosniff`/attachment hardening for object responses. Ship order:

1. Publish 2.3.0 (`NPM_TOKEN` repository secret, then push tag `v2.3.0`; the release workflow publishes).
2. Verify the tarball is what you expect.
3. Only then switch this repo to `github:Muhammad-waqar-uit/gmail-bucket#v2.3.0` (or `^2.3.0` once it is
   on npm).

Follow-ups that become due at that switch:

- `npm run auth` gains `--drive | --gmail | --all`; `src/auth-cli.ts` should pass them through and stop
  describing one shared token.
- `src/doctor.ts` compares the token against `SCOPES`; a token carrying the old broad `drive` scope must
  count as satisfying `drive.file`, or it reports a false "scope gap".
- Existing tokens stay broad until `npm run auth` is re-run.

## Behaviour worth not breaking

- **Object responses are hardened.** The library sends `X-Content-Type-Options: nosniff` and a sandbox
  CSP, serves `inline` only for plain image types, and everything else (HTML, SVG) as an attachment. Do
  not reintroduce passing an uploader's `Content-Type` straight through.
- **`doctor` never writes** and never uploads; it resolves the backend (which can create the Drive base
  folder) and lists buckets. Exit code 0 means "usable", including auto→memory fallbacks with warnings.
- **Errors should name the fix.** The library's auth errors already do; the UI shows them verbatim.

## Environment

Windows + Git Bash is the primary dev host, and the working tree is checked out with **CRLF**. Multi-line
text anchors in edits fail against CRLF; normalise the file to LF first (or anchor on single lines).

Do not publish, force-push, or run anything against a real Google account as part of a normal task. Tests
must not touch the network.

## Conventions

- Match the surrounding style; comments only where the reason is not obvious from the code.
- Keep diffs to the requested change — no formatting sweeps, no drive-by refactors.
- Prefer deriving a value from the library (`SCOPES`, `credFile()`) over hardcoding it; hardcoded copies of
  library behaviour are what went stale in `auth-cli`.
