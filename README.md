# criminalmap

**Crime Board / Investigation Network Graph**

A web application that turns plain-text investigation notes into an interactive,
noir-styled network graph. Investigators paste relation lines such as
`[Person A] -> [Person B] : Topic | Fontes: url1, url2` and the system renders
an explorable graph where each entity is a node and each line becomes a directed
edge with a topic description and a list of sources.

---

## Table of contents

1. [Overview](#overview)
2. [Tech stack](#tech-stack)
3. [Plain-text relation syntax](#plain-text-relation-syntax)
4. [Project structure](#project-structure)
5. [Running locally](#running-locally)
6. [Running with Docker Compose](#running-with-docker-compose)
7. [Environment variables](#environment-variables)
8. [Authentication and the admin panel](#authentication-and-the-admin-panel)
9. [Saved maps and short URLs](#saved-maps-and-short-urls)
10. [Web standards (robots.txt, sitemap.xml, manifest)](#web-standards-robotstxt-sitemapxml-manifest)
11. [Themes (dark / light)](#themes-dark--light)
12. [Internationalization (i18n)](#internationalization-i18n)
13. [API endpoints](#api-endpoints)
14. [GitHub Actions](#github-actions)

---

## Overview

The system consists of:

- A **Node.js/Express** API that stores the graph in **MariaDB** and renders the
  HTML pages (the editor, the login form, the admin panel and public map pages).
- A **plain-text parser** that accepts one relation per line and extracts the
  `from` node, `to` node, topic description, and optional `Fontes:` (sources).
- A **Vanilla JS frontend** that renders the graph with
  [Vis.js](https://visjs.org/) (vis-network, loaded from CDN) and shows an
  evidence-card modal when a node or edge is clicked.
- An **embedded migration and seed**: on startup the API creates the database
  (if needed), applies [`db/schema.sql`](db/schema.sql:1), and inserts example
  data when the `nodes` table is empty.
- A **working graph** (the "scratch" canvas at `/`) that can be pasted into,
  processed and **cleared** by anybody by default, plus **saved maps**: frozen
  snapshots that only administrators can create, replace or delete and that
  anybody can read through a short URL such as `/m/abcxyz`.
- An **admin panel** behind an e-mail/password login where site identity,
  design, map URLs, web standards, custom HTML and maintenance actions are
  configured.
- A **three-language UI** (`pt_BR`, `en_US`, `es_MX`) with a **dark/light theme
  switch**; both the default language and the default theme are chosen in the
  admin panel.

---

## Tech stack

| Layer      | Technology                                              |
| ---------- | ------------------------------------------------------- |
| Frontend   | HTML5, CSS3, Vanilla JavaScript                         |
| Graph      | Vis.js (vis-network 9.1.9) via CDN                       |
| Backend    | Node.js, Express 4                                       |
| Templating | Tiny server-side renderer (`src/render.js`), no engine   |
| Auth       | Signed HttpOnly cookies + scrypt hashes (`node:crypto`)  |
| Database   | MariaDB (accessed through `mysql2`)                      |
| Parsing    | Node.js regular expressions                              |
| Packaging  | Docker, Docker Compose                                   |

Runtime dependencies stay limited to `express`, `mysql2` and `dotenv`.

---

## Plain-text relation syntax

Each non-empty line must follow this pattern:

```text
[Node A] -> [Node B] : Topic/Description | Fontes: url1, url2, url3
```

Rules:

- `[Node A]` and `[Node B]` are the entity labels. Anything inside the brackets
  is preserved verbatim (spaces and parentheses are fine).
- `Topic/Description` is the edge's topic text shown in the modal.
- The `| Fontes: ...` part is **optional**.
- `Fontes:` **may be empty** — a trailing `| Fontes:` with nothing after it is
  valid and produces an empty `sources` array.
- Sources are split on commas, trimmed, and empty entries are discarded.
- **Multiple lines between the same two nodes create multiple edges.** The
  database schema deliberately has no `UNIQUE` constraint on the from/to pair,
  so repeated relations are preserved as parallel edges.

Examples:

```text
[Victor (O Chefe)] -> [Marcos (O Capanga)] : Emprega e dá ordens para | Fontes: https://inquerito.gov/pag12
[Victor (O Chefe)] -> [Sr. Silva (Contador)] : Usa para lavar dinheiro | Fontes:
[Ana (Testemunha)] -> [Jornalista Investigativo] : Forneceu provas em segredo
```

The second line produces an edge with an empty `sources` array, and the third
line has no `Fontes:` section at all.

Lines that do not match the pattern are ignored by the parser. The
`POST /api/parse` endpoint reports them as `invalidLines` when **no** valid line
exists, so callers can debug malformed input.

---

## Project structure

```text
criminalmap/
├── server.js                     # Express app: routes, pages, admin panel, API
├── package.json                  # Node metadata, dependencies and scripts
├── Dockerfile                    # Production runtime image
├── .dockerignore                 # Files excluded from the Docker build context
├── src/
│   ├── db.js                     # MariaDB bootstrap (connect, migrate, seed)
│   ├── parser.js                 # Plain-text relation parser
│   ├── seed.js                   # Seed data and node/edge upsert helpers
│   ├── graph.js                  # Working graph read/clear helpers
│   ├── maps.js                   # Saved map snapshots (create/replace/load)
│   ├── shortid.js                # Random short-URL ID generator
│   ├── settings.js               # Cached key/value settings store
│   ├── locales.js                # Supported locale catalog
│   ├── auth.js                   # Login, signed session cookie and CSRF
│   ├── render.js                 # Minimal {{placeholder}} template renderer
│   └── cli/
│       └── hash-password.js      # `npm run hash-password` helper
├── views/                        # Server-rendered HTML templates (not public)
│   ├── layout.html               # Shared shell: meta, theme, language, nav
│   ├── index.html                # Editor / read-only working graph
│   ├── map.html                  # Public read-only saved map
│   ├── login.html                # Admin login form
│   └── admin/
│       ├── settings.html         # Tabbed admin settings
│       └── maps.html             # Saved map management
├── db/
│   └── schema.sql                # nodes, edges, settings, maps tables
├── public/                       # Statically served assets
│   ├── css/
│   │   └── style.css             # Noir dark theme + parchment light theme
│   ├── js/
│   │   ├── app.js                # Graph rendering, modals, clear, copy link
│   │   ├── i18n.js               # Locale loading and translation helpers
│   │   ├── theme.js              # Dark/light toggle and theme-color meta
│   │   └── admin.js              # Admin tabs and confirm dialogs
│   └── locales/
│       ├── pt_BR.json            # Brazilian Portuguese strings
│       ├── en_US.json            # American English strings
│       └── es_MX.json            # Mexican Spanish strings
├── docker/
│   ├── docker-compose.yml        # Compose service definition
│   └── .env.example              # Environment template for Docker
└── .github/
    └── workflows/                # CI/CD (see GitHub Actions section)
```

---

## Running locally

### Prerequisites

- Node.js 18 or newer
- A reachable MariaDB/MySQL server

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Create a `.env` file at the project root (the app loads it with `dotenv`):

```dotenv
PORT=8080
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=criminalmap

# Admin panel
AUTH_METHOD=account
ADMIN_LOGIN=admin@example.com
ADMIN_PASSWORD='scrypt$<saltHex>$<hashHex>'
SESSION_SECRET=replace_with_a_long_random_value
```

Most variables are optional and fall back to sensible defaults (`PORT=8080`,
`DB_HOST=127.0.0.1`, `DB_PORT=3306`, `DB_USER=root`, `DB_PASSWORD=` empty,
`DB_NAME=criminalmap`, `AUTH_METHOD=account`, `SESSION_LIFETIME=720`).

`ADMIN_LOGIN` and `ADMIN_PASSWORD` are **comma separated, index aligned lists**,
so several administrators can be defined:

```dotenv
ADMIN_LOGIN=admin@example.com,editor@example.com
ADMIN_PASSWORD=a-plain-password,'scrypt$<saltHex>$<hashHex>'
```

`ADMIN_PASSWORD[i]` is paired with `ADMIN_LOGIN[i]` and may be either plain text
or an `scrypt$…` hash. Generate a hash with:

```bash
npm run hash-password -- "your password"
```

`SESSION_SECRET` signs the admin session cookie. When it is omitted the app
still boots, but a temporary random secret is generated and every admin session
is dropped on restart:

```bash
openssl rand -hex 32
```

Without credentials the admin panel cannot be used (the login form reports that
authentication is not configured); the public editor keeps working.

### 3. Start the server

```bash
npm start
```

The server:

1. Connects to MariaDB (with retries).
2. Creates the database if it does not exist.
3. Applies [`db/schema.sql`](db/schema.sql:1) — the `CREATE TABLE IF NOT EXISTS`
   statements make the migration idempotent.
4. Checks the `nodes` table; if it is empty, it seeds the example graph from
   [`src/seed.js`](src/seed.js:12).
5. Loads the settings cache from the `settings` table (defaults are used for
   missing keys, so an existing database needs no manual migration).
6. Starts listening, serves the static assets from [`public/`](public/js/app.js:1)
   and renders the HTML pages from [`views/`](views/index.html:1).

### 4. Open the browser

Visit <http://localhost:8080>. The example graph loads automatically from
`GET /api/graph`.

---

## Running with Docker Compose

The Compose file runs the prebuilt application image and connects it to a
MariaDB server running **on the Docker host** via `host.docker.internal`.

### 1. Prepare the environment

From the `docker/` folder:

```bash
cd docker
cp .env.example .env
```

### 2. Edit the credentials

Open `docker/.env` and set at least the database credentials:

```dotenv
PORT=8080
DOMAIN=criminalmap.example.com
DB_HOST=host.docker.internal
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_real_password
DB_NAME=criminalmap
AUTH_METHOD=account
ADMIN_LOGIN=admin@example.com
ADMIN_PASSWORD=your_real_password
SESSION_SECRET=your_long_random_secret
```

### 3. Start the stack

```bash
docker compose up -d
```

Then open <http://localhost:8080>.

### How it works

- **`extra_hosts` / `host.docker.internal`**: the Compose file adds
  `host.docker.internal:host-gateway` so the container can reach a MariaDB
  instance running directly on the Docker host. Leave `DB_HOST` as
  `host.docker.internal` if your database is on the host machine.
- **Reverse-proxy `PORT` / `DOMAIN`**: `PORT` controls the host-side port
  published to the container (the app itself always listens on `8080` inside
  the container). `DOMAIN` is optional metadata passed to the app and logged at
  startup, useful when the app sits behind a reverse proxy such as Nginx.
- An **optional** containerized MariaDB service is included in the Compose file
  as a commented block. To use it, uncomment the `mariadb` service and the
  `volumes` block, then set `DB_HOST=mariadb` in `docker/.env`.

---

## Environment variables

| Variable      | Default            | Purpose                                        |
| ------------- | ------------------ | ---------------------------------------------- |
| `PORT`        | `8080`             | Port the API listens on                        |
| `DOMAIN`      | (none)             | Optional public domain, used as a fallback for canonical URLs and logged at startup |
| `DB_HOST`     | `127.0.0.1`        | MariaDB host                                   |
| `DB_PORT`     | `3306`             | MariaDB port                                   |
| `DB_USER`     | `root`             | MariaDB user                                   |
| `DB_PASSWORD` | (empty)            | MariaDB password                               |
| `DB_NAME`     | `criminalmap`      | Database name (created automatically if absent)|
| `AUTH_METHOD` | `account`          | Authentication mode (only `account` is implemented; invalid values fall back to it) |
| `ADMIN_LOGIN` | (empty)            | Comma separated admin e-mail addresses         |
| `ADMIN_PASSWORD` | (empty)         | Comma separated passwords (plain text or `scrypt$…`), index aligned with `ADMIN_LOGIN` |
| `SESSION_SECRET` | (random)        | Secret used to sign the admin session cookie    |
| `SESSION_LIFETIME` | `720`           | Admin session lifetime in minutes              |
| `SESSION_SECURE_COOKIE` | (auto)      | Force the `Secure` cookie flag (`1`/`true`)     |

---

## Authentication and the admin panel

### Signing in

1. Open <http://localhost:8080/auth/login> (or click **Login** in the header).
2. Sign in with one of the `ADMIN_LOGIN` / `ADMIN_PASSWORD` pairs.

Sessions are kept in a signed, `HttpOnly`, `SameSite=Lax` cookie
(`criminalmap_session`). There is no server-side session store, so sessions
survive restarts as long as `SESSION_SECRET` stays the same. Admin pages are
protected by the `requireAdmin` middleware (`/admin/*`) and every state-changing
admin request is protected by a CSRF token embedded in the forms.

Log out with the **Logout** button in the header (`POST /auth/logout`).

### Routes

| Path                   | Access    | Purpose                                    |
| ---------------------- | --------- | ------------------------------------------ |
| `/`                    | public    | Working graph editor (read-only when the public editor is disabled) |
| `/{prefix}/{shortId}`  | public    | Saved map (only when published)            |
| `/auth/login`          | public    | Login form (`GET`) and login (`POST`)      |
| `/auth/logout`         | admin     | Ends the session                           |
| `/admin`               | admin     | Redirects to `/admin/settings`             |
| `/admin/settings`      | admin     | Tabbed settings panel                      |
| `/admin/maps`          | admin     | Saved map management                       |
| `/robots.txt`          | public    | Dynamic robots file                        |
| `/sitemap.xml`         | public    | Dynamic XML sitemap (when enabled)         |
| `/site.webmanifest`    | public    | PWA manifest built from the settings       |

### Settings tabs

- **Appearance** — site title and subtitle **per language**, logo and favicon
  URLs, default language, default theme and the mobile theme colors.
- **Maps** — the public URL directory (`/m/…` by default), the short ID length
  (3–32, default 6), whether uppercase letters and digits are allowed in new
  links, and whether visitors may edit and clear the working graph.
- **Web Standards** — `robots.txt` toggle and content, `sitemap.xml` toggle, the
  canonical site URL, the default OpenGraph image and the X/Twitter account.
- **HTML** — raw head injection, custom CSS and custom JavaScript applied to
  every page.
- **Maintenance** — clear the working graph, restore the example data and see
  which account is signed in.

Settings are stored in the `settings` key/value table and cached in memory after
every write, so changes apply immediately without a restart.

---

## Saved maps and short URLs

The graph at `/` is a **working canvas**: it is stored in the `nodes` / `edges`
tables and can be edited (and cleared) by anybody unless the admin turns the
public editor off.

**Saving a map** freezes the current canvas into the `maps` / `map_nodes` /
`map_edges` tables and returns a short URL:

```text
https://criminalmap.example.com/m/abcxyz
```

- The short ID is random: 6 lowercase letters by default, configurable in
  *Settings → Maps*.
- The URL directory (`m` by default) is also configurable and validated to
  `[a-z0-9_-]+`.
- Only administrators can create, replace, rename, publish/unpublish or delete
  saved maps.
- Anybody can read a published map — the page is rendered server-side with its
  own title, description, canonical link and OpenGraph tags.
- Maps can be marked **private**, in which case only a signed-in administrator
  can open them (everybody else gets a `404`).

Admins can manage everything under **Admin → Maps**:

| Action                        | Effect                                              |
| ----------------------------- | --------------------------------------------------- |
| Save the working graph as map | Creates a new map from the current editor graph      |
| Save details                  | Renames, re-describes or toggles the visibility      |
| Replace with working graph    | Replaces the stored snapshot with the current graph  |
| Load into editor              | Copies the snapshot back into the working canvas     |
| Delete                        | Removes the map and all of its nodes and edges       |

---

## Web standards (robots.txt, sitemap.xml, manifest)

- `/robots.txt` is served dynamically from the settings (toggle + content).
  Default content:

  ```text
  User-agent: *
  Disallow: /admin
  Disallow: /auth
  ```

- `/sitemap.xml` lists the home page and every **public** map. It is disabled by
  default.
- `/site.webmanifest` renders a small PWA manifest from the site title, theme
  colors and favicon.
- Every rendered page includes a canonical link plus OpenGraph/Twitter meta tags
  built from the settings; admin and login pages are marked `noindex, nofollow`.

---

## Themes (dark / light)

- The header contains a **theme toggle** (sun/moon).
- The effective theme is resolved as: `localStorage` choice → the
  **default theme** configured in the admin panel → `prefers-color-scheme`.
- The chosen theme is applied before the first paint by an inline script, and
  the `theme-color` meta tag is updated when it changes. The graph itself
  re-renders with a palette that matches the active theme.

---

## API endpoints

All endpoints return JSON. The base URL is `http://localhost:8080` in local
setups.

| Method | Path                | Access | Description                                                      |
| ------ | ------------------- | ------ | ---------------------------------------------------------------- |
| GET    | `/api/graph`        | public | Returns the full working graph (nodes + edges)                   |
| GET    | `/api/nodes`        | public | Returns only the `nodes` array                                   |
| GET    | `/api/edges`        | public | Returns only the `edges` array                                   |
| GET    | `/api/settings`     | public | Public settings (default locale/theme, map prefix, locales, …)   |
| GET    | `/api/maps`         | admin  | Lists saved maps with their public URLs                          |
| GET    | `/api/maps/{shortId}` | public | Returns a saved map with its graph (published maps only)       |
| POST   | `/api/parse`        | editor | Parses text, upserts nodes, inserts edges, returns the full graph |
| DELETE | `/api/graph`        | editor | Deletes all edges and nodes from the working graph               |
| POST   | `/api/seed`         | editor | Wipes the graph and re-runs the built-in seed data               |

**Access column**: `editor` means the endpoint is open to everybody while the
public editor is enabled and restricted to administrators once it is disabled in
*Settings → Maps* (a `403` JSON response is returned otherwise). `admin`
endpoints require a signed-in administrator and answer `401` otherwise.

```bash
curl http://localhost:8080/api/settings
curl http://localhost:8080/api/maps/abcxyz
```

### Node shape

```json
{ "id": 1, "label": "Flávio Bolsonaro", "type": "person" }
```

### Edge shape

```json
{
  "id": 1,
  "from": 1,
  "to": 2,
  "topic_description": "Rachadinha (Desvio de salários)",
  "sources": ["https://noticia1.com/rachadinha", "https://noticia2.com/relatorio-coaf"]
}
```

### `GET /api/graph`

```bash
curl http://localhost:8080/api/graph
```

Response:

```json
{
  "nodes": [
    { "id": 1, "label": "Flávio Bolsonaro", "type": "person" },
    { "id": 2, "label": "Fabrício Queiroz", "type": "person" }
  ],
  "edges": [
    {
      "id": 1,
      "from": 1,
      "to": 2,
      "topic_description": "Rachadinha (Desvio de salários)",
      "sources": ["https://noticia1.com/rachadinha"]
    }
  ]
}
```

### `GET /api/nodes`

```bash
curl http://localhost:8080/api/nodes
```

Response:

```json
{
  "nodes": [
    { "id": 1, "label": "Flávio Bolsonaro", "type": "person" }
  ]
}
```

### `GET /api/edges`

```bash
curl http://localhost:8080/api/edges
```

Response:

```json
{
  "edges": [
    {
      "id": 1,
      "from": 1,
      "to": 2,
      "topic_description": "Rachadinha (Desvio de salários)",
      "sources": ["https://noticia1.com/rachadinha"]
    }
  ]
}
```

### `POST /api/parse`

Request body: `{ "text": "..." }`.

```bash
curl -X POST http://localhost:8080/api/parse \
  -H "Content-Type: application/json" \
  -d '{"text":"[A] -> [B] : Met once | Fontes: https://example.com/a"}'
```

On success, the endpoint returns the full graph (same shape as
`GET /api/graph`).

Error cases:

- Empty `text` → `400` with `{ "error": "The \"text\" field is required and must not be empty." }`
- No valid relation lines → `400` with `{ "error": "No valid relation lines were found in the provided text.", "invalidLines": [...] }`

### `DELETE /api/graph`

```bash
curl -X DELETE http://localhost:8080/api/graph
```

Response:

```json
{ "success": true, "removed": { "nodes": 10, "edges": 9 } }
```

### `POST /api/seed`

```bash
curl -X POST http://localhost:8080/api/seed
```

Wipes the current graph, re-inserts the built-in example data from
[`src/seed.js`](src/seed.js:12), and returns the full graph.

---

## Internationalization (i18n)

- Locale dictionaries live in [`public/locales/`](public/locales/pt_BR.json:1)
  as JSON files named after the locale code. Three locales ship with the app:

  | Code    | Language             |
  | ------- | -------------------- |
  | `pt_BR` | Português (Brasil)   |
  | `en_US` | English (US)         |
  | `es_MX` | Español (México)     |

- The **default locale** is configured in *Admin → Appearance* (Portuguese out of
  the box) and applied server-side to `<html lang>`, the page title, the
  subtitle and the meta description.
- The language selector in the header switches the locale at runtime **without a
  page reload** (so unsaved text in the editor is preserved), stores the choice
  in `localStorage` and writes a `locale` cookie so server-rendered pages —
  including the admin panel — use the same language.
- Resolution order: stored choice → default locale from the settings.
- Dictionaries are fetched once and cached per session. The translator in
  [`public/js/i18n.js`](public/js/i18n.js:1) falls back to showing the raw key
  when a translation is missing, which makes missing entries easy to spot.

### Adding a new language

1. Copy an existing dictionary, e.g.
   `cp public/locales/en_US.json public/locales/fr_FR.json`.
2. Translate every string value (keep the keys unchanged).
3. Register the code in [`src/locales.js`](src/locales.js:1) — add an entry to
   `CATALOG` with its label and default title/subtitle.
4. Restart the app. The language selector, the default-language dropdown and the
   `site_title_*` / `site_subtitle_*` settings are all derived from that catalog.

The keys must stay consistent across all locale files. Handy check:

```bash
node -e "const fs=require('fs');const base=JSON.parse(fs.readFileSync('public/locales/en_US.json','utf8'));['pt_BR','en_US','es_MX'].forEach(c=>{const d=JSON.parse(fs.readFileSync('public/locales/'+c+'.json','utf8'));console.log(c, Object.keys(base).filter(k=>!(k in d)))})"
```

---

## GitHub Actions

The repository includes CI/CD workflows in [`.github/workflows/`](.github/workflows/build.yml:1)
that build and publish the container image to
`ghcr.io/ivancarlosti/criminalmap:latest` (plus version tags). These workflows
are part of the release pipeline and **must not be edited** as part of
application changes.

---

## License

MIT — see [`LICENSE`](LICENSE).
