# 2026-10-24 — Migrate the runtime image to Node.js 24 and document screenshots

**Status:** implemented
**Scope:** `Dockerfile`, `.nvmrc`, `.dockerignore`, `README.md`, `docs/screenshots/`, `plans/`
**Related issues:** container image vulnerability report against `node:20-alpine`

---

## 1. Context

The production image was built from `node:20-alpine`. Node.js 20 reached
end-of-life on **2026-04-30**, so that tag no longer receives Node security
patches, and the Alpine release pinned by the retired tag lags behind the
`openssl`/`musl`/`zlib` fixes shipped in current Alpine images. The result is a
growing list of CVEs reported by image scanners even though the application
itself has no known vulnerable npm dependencies (`npm audit --omit=dev` reports
**0 vulnerabilities**).

The repository also had no visual documentation: the README describes the map
picker, the graph, the themes and the admin panel in text only, and there was no
`docs/` folder at all.

## 2. Goals

1. Replace the runtime base image with `node:24-alpine` (active LTS, supported
   until April 2028) without changing application behaviour or the container
   contract (port, health check, unprivileged user, volume permissions).
2. Record the migration as a dated plan under `plans/`.
3. Publish real screenshots under `docs/screenshots/` and document them in
   `README.md`.

### Non-goals

- Editing `.github/workflows/*` (the README states the release pipeline must not
  be changed as part of application work). `semantic-release.yml` still uses
  `actions/setup-node` with Node 20 on the runner; that is CI tooling, not the
  shipped runtime — see the follow-ups.
- Changing `npm install --omit=dev` to `npm ci` (see follow-ups).
- Any change to `server.js`, `src/`, `views/`, `public/` or `db/`.

---

## 3. Why `node:24-alpine` reduces the reported vulnerabilities

| Aspect | `node:20-alpine` (before) | `node:24-alpine` (after) |
| --- | --- | --- |
| Node.js support | EOL since 2026-04-30, no security releases | Active LTS, supported until April 2028 |
| Alpine base | Alpine 3.23.4, 4 HIGH OS findings | Alpine 3.24.3, 0 OS findings (patched `openssl`, `musl`, `zlib`, `busybox`) |
| npm bundled | npm 10, 23 findings (22 HIGH, 1 CRITICAL) in the Node.js/npm layer | npm 12.2.1 installed over the bundled npm 11, 1 HIGH left (`undici` vendored inside npm) |
| Platform support | amd64/arm64 | amd64/arm64 (same multi-arch build matrix) |

The application is compatible without code changes: its dependencies are
`express@5.3.0` (`node >= 18`), `mysql2@3.24.6` (`node >= 8`) and
`dotenv@18.0.9` (`node >= 12`), and the code only uses stable `node:` built-ins
(`crypto`, `zlib`, `fs`, `path`, `http`).

---

## 4. Changes

| File | Change |
| --- | --- |
| `Dockerfile` | `FROM node:24-alpine`; documented the LTS/EOL rationale in the header comment, and added `RUN npm install -g npm@12.2.1 && npm cache clean --force` after the dependency install so the npm that ships in the runtime image is the patched one. Every other instruction is untouched: `NODE_ENV=production`, `npm install --omit=dev`, runtime file copies, `WEBIMAGES_DIR=/app/webimages` + `chown node:node`, `USER node`, `EXPOSE 8080`, health check and `CMD ["node", "server.js"]`. |
| `.nvmrc` (new) | `24` so local development matches the image. |
| `.dockerignore` | Added `docs` and `plans`: the screenshots and plan documents are documentation, not runtime files, and must not inflate the build context. |
| `README.md` | Screenshots section (after Overview) + table of contents entry; Tech stack and prerequisites now state Node.js 24 LTS; project structure lists `docs/screenshots/` and `plans/`; Docker section notes the `node:24-alpine` base image. |
| `docs/screenshots/` (new) | Seven PNGs captured from a local instance running the seeded demo map. |
| `plans/2026-10-24-node-24-alpine-migration-and-screenshots.md` (new) | This document. |

---

## 5. Screenshots

All images live in `docs/screenshots/` and are embedded in the README
"Screenshots" section.

| File | Page | Viewport |
| --- | --- | --- |
| `home-dark.png` | `/` — map picker with the selected map preview | 1440×900, dark |
| `map-dark.png` | `/m/{shortId}` — saved map in full screen | 1440×900, dark |
| `evidence-modal.png` | Edge ("Conexão") card with topic + sources | 1440×900, dark |
| `map-light.png` | Same map with the light/parchment theme | 1440×900, light |
| `map-editor.png` | Map page as a signed-in administrator (details + relations editor) | 1440×900, light |
| `admin-settings.png` | `/admin/settings` — appearance tab | 1440×900, light |
| `mobile-map.png` | Map page on a phone viewport (compact graph profile) | 390×844 @2x, dark |

### How they were captured

1. Throwaway MariaDB with a published port:

   ```bash
   docker run -d --rm --name criminalmap-shots \
     -e MARIADB_ROOT_PASSWORD=shots -e MARIADB_DATABASE=criminalmap_shots \
     -p 127.0.0.1:3307:3306 mariadb:11.4
   ```

2. The application on Node.js 24, pointed at that database (the embedded
   bootstrap seeds the demo map automatically):

   ```bash
   PORT=8099 DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=root DB_PASSWORD=shots \
   DB_NAME=criminalmap_shots WEBIMAGES_DIR=/tmp/criminalmap-webimages \
   ADMIN_LOGIN=admin@example.com ADMIN_PASSWORD=shots-password \
   SESSION_SECRET=shots-secret DOMAIN=localhost:8099 node server.js
   ```

3. Headless Chromium through Playwright (already available in the local npm
   cache — no dependency was added to `package.json`). The capture script wraps
   the `vis.Network` constructor so it can call `fit()` and emit the
   application's own `click` event, which opens the real evidence card
   deterministically instead of guessing canvas coordinates. Both desktop and
   mobile contexts use `reducedMotion: 'reduce'`, wait for the force solver to
   settle and take the screenshot with `animations: 'disabled'`.

4. The temporary container, app process and `/tmp` artifacts were removed
   afterwards; only the PNGs were committed.

### Content notes

- The demo data comes from `src/seed.js` (Portuguese labels, default `pt_BR`
  locale). No credentials, cookies or local paths appear in the images.
- The administrator screenshots use a throwaway `ADMIN_LOGIN`/`ADMIN_PASSWORD`
  pair that only existed for the capture run.
- Images are PNG, 1440×900 (desktop) and 780×1688 (mobile @2x), roughly
  95 KB–460 KB each.

### Regenerating them

Repeat the three steps above and reuse the same Playwright flow: open `/`,
`/m/{shortId}`, click `#theme-toggle`, sign in via `/auth/login`, open
`/admin/settings`, then repeat the map page with a 390×844 mobile context.
Keep the file names stable so the README links keep working.

---

## 6. Validation

Performed on 2026-10-24 with Docker 29.9.2, Compose v5.6.1 and Node.js 24.21.0
on the host.

| Check | Command | Result |
| --- | --- | --- |
| Image builds | `docker build -t criminalmap:node24 .` | success |
| Node version in the image | `docker run --rm --entrypoint node criminalmap:node24 --version` | `v24.22.1` |
| npm version in the image | `docker run --rm --entrypoint npm criminalmap:node24 --version` | `12.2.1` |
| Runtime user | `docker exec … id` | `uid=1000(node) gid=1000(node)` |
| Image boots against MariaDB 11.4 | container + seeded DB | `Database connected`, `Tables ready`, `listening on http://localhost:8080` |
| Health check | `docker inspect --format '{{json .State.Health.Status}}'` | `"healthy"` |
| Public pages | `GET /api/settings`, `GET /`, `GET /m/wnblbk` | `200`, `200`, `200` |
| Runtime dependencies | `npm audit --omit=dev` | 0 vulnerabilities |
| Image scan (final image) | `trivy image criminalmap:node24` (HIGH, CRITICAL) | **1 HIGH, 0 CRITICAL**: Alpine 3.24.3 = 0, `app/package.json` = 0, only `undici@6.29.0` vendored inside npm |
| Baseline scan | `trivy image node:20-alpine` (HIGH, CRITICAL) | **27 findings (26 HIGH, 1 CRITICAL)**: 4 HIGH in Alpine 3.23.4 + 23 in the Node.js/npm layer |

The single remaining advisory is npm's own `undici@6.29.0`
(CVE-2026-109869, fixed in `undici@6.29.1`). It is not part of the application
dependency tree (`app/package.json` scans clean) and npm is never executed by
the running server; it will disappear with the next npm release. See
follow-ups.

### Volume / Compose contract

`node:24-alpine` still ships the `node` user with **uid/gid 1000**, and the image
creates `/app/webimages/maps` as `node:node` before switching users, so the
existing `docker/.env` contract (bind mount owned by 1000:1000, or named volume)
keeps working. `PORT`, `WEBIMAGES_DIR`, the health check command and the
`EXPOSE 8080` instruction were not modified.

---

## 7. Rollback

Revert the `FROM` line (and the npm upgrade step) and rebuild:

```bash
git revert <commit>
docker compose build   # or the build workflow
```

No database migration, schema change or volume layout changed, so a rollback is
a pure image swap — the same data volumes remain valid in both directions.

---

## 8. Follow-ups

1. **CI Node version.** `.github/workflows/semantic-release.yml` still sets
   `node-version: '20'` for `actions/setup-node`. It is CI tooling, not the
   shipped runtime, and the workflows are outside the scope of this change, but
   it should be moved to `24` (or read from `.nvmrc`) when the pipeline is next
   updated.
2. **Pin installs.** `Dockerfile` uses `npm install --omit=dev` because the
   project intentionally has no lockfile. Adding `package-lock.json` and
   switching to `npm ci` would make builds reproducible and remove the last
   layer of drift.
3. **Remaining npm advisory.** Bump the `npm@12.2.1` pin when a release bundles
   `undici >= 6.29.1`, or drop npm from the runtime image entirely once no
   workflow needs it inside the container.
4. **Screenshot freshness.** The images show the seeded demo map; when the demo
   data or the visual design changes, regenerate them with the procedure in
   section 5 so the README stays accurate.

