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
12. [OpenGraph images](#opengraph-images)
13. [Graph behaviour](#graph-behaviour)
14. [Internationalization (i18n)](#internationalization-i18n)
15. [API endpoints](#api-endpoints)
16. [GitHub Actions](#github-actions)

---

## Overview

The system consists of:

- A **Node.js/Express** API that stores the graph in **MariaDB** and renders the
  HTML pages (the map picker home page, the map pages, the login form and the
  admin panel).
- A **plain-text parser** that accepts one relation per line and extracts the
  `from` node, `to` node, topic description, and optional `Fontes:` (sources).
- A **Vanilla JS frontend** that renders the graph with
  [Vis.js](https://visjs.org/) (vis-network, loaded from a CDN with a fallback
  source) and shows an evidence-card modal when a node or edge is clicked.
- An **embedded migration and seed**: on startup the API creates the database
  (if needed), applies [`db/schema.sql`](db/schema.sql:1), and inserts example
  data when the `nodes` table is empty.
- A **map picker home page** (`/`): every visible map is listed, one of them
  (random, or the one requested through `?map=…`) is highlighted and previewed
  on the right. Each entry links to the map in full screen.
- **Saved maps** (`/m/abcxyz`) are the editable unit of the application. Public
  maps can be read by anybody; administrators opening the same URL get an editor
  for the map's relations plus its title, description and visibility.
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
`POST /api/maps/{shortId}/parse` endpoint reports them as `invalidLines` when
**no** valid line exists, so callers can debug malformed input.

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
│   ├── seed.js                   # Example relations and localized demo map labels
│   ├── maps.js                   # Saved maps: create, edit relations, clear
│   ├── shortid.js                # Random short-URL ID generator
│   ├── settings.js               # Cached key/value settings store
│   ├── locales.js                # Supported locale catalog
│   ├── auth.js                   # Login, signed session cookie and CSRF
│   ├── render.js                 # Minimal {{placeholder}} template renderer
│   ├── ogcard/                   # Generated OpenGraph cards (no image dependency)
│   │   ├── index.js              # Versioning, storage volume, regeneration API
│   │   ├── card.js               # Card layout: identity, counts, network sketch
│   │   ├── font.js               # Built-in single-stroke font (glyph data)
│   │   ├── draw.js               # Anti-aliased raster primitives
│   │   └── png.js                # RGB canvas + PNG encoder (Node's zlib)
│   └── cli/
│       └── hash-password.js      # `npm run hash-password` helper
├── views/                        # Server-rendered HTML templates (not public)
│   ├── layout.html               # Shared shell: meta, theme, language, nav
│   ├── index.html                # Home: map picker + selected map preview
│   ├── map.html                  # Saved map (editable for administrators)
│   ├── login.html                # Admin login form
│   └── admin/
│       ├── settings.html         # Tabbed admin settings
│       └── maps.html             # Saved map management
├── db/
│   └── schema.sql                # maps/map_nodes/map_edges, settings (+ legacy staging tables)
├── public/                       # Statically served assets
│   ├── css/
│   │   └── style.css             # Noir dark theme + parchment light theme
│   ├── js/
│   │   ├── app.js                # Graph rendering, modals, map editing, clipboard
│   │   ├── vis-loader.js         # vis-network loader with a CDN fallback
│   │   ├── i18n.js               # Locale loading and translation helpers
│   │   ├── theme.js              # Dark/light toggle and theme-color meta
│   │   ├── help.js               # "?" usage popup in the header
│   │   └── admin.js              # Admin tabs and confirm dialogs
│   └── locales/
│       ├── pt_BR.json            # Brazilian Portuguese strings
│       ├── en_US.json            # American English strings
│       └── es_MX.json            # Mexican Spanish strings
├── docker/
│   ├── docker-compose.yml        # Compose service definition
│   ├── webimages/                # Generated OpenGraph cards (bind mount, git-ignored)
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
authentication is not configured); every map stays read-only for visitors.

### 3. Start the server

```bash
npm start
```

The server:

1. Connects to MariaDB (with retries).
2. Creates the database if it does not exist.
3. Applies [`db/schema.sql`](db/schema.sql:1) — the `CREATE TABLE IF NOT EXISTS`
   statements make the migration idempotent.
4. Checks the `nodes` table; if it is empty, it stages the example relations from
   [`src/seed.js`](src/seed.js:12).
5. Publishes the first map when the database has no map yet: either from the
   staged example relations or from an existing working graph (upgrade), so the
   home page always has content.
6. Loads the settings cache from the `settings` table (defaults are used for
   missing keys, so an existing database needs no manual migration).
7. Starts listening, serves the static assets from [`public/`](public/js/app.js:1)
   and renders the HTML pages from [`views/`](views/index.html:1).

### 4. Open the browser

Visit <http://localhost:8080>. The map picker loads and previews a randomly
selected map (`GET /api/maps/{shortId}`).

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
- **Two ports, one variable**: `PORT` in `docker/.env` is the **host** port
  published by the mapping (`${PORT:-8080}:8080`). The app itself always listens
  on `8080` **inside** the container, so changing the host port is enough — with
  `PORT=7899` the app is served at <http://localhost:7899> and nothing else has
  to change. `DOMAIN` is optional metadata passed to the app and logged at
  startup, useful when the app sits behind a reverse proxy such as Nginx.
  If you really need the app to listen on another port **inside** the container,
  set `environment: PORT` and the right-hand side of `ports` to the same value
  (both the app and the health check read `$PORT`), and keep the host side as
  the port you want to open in the browser.
- **Container health**: the health check requests the public `GET /api/settings`
  on the container's own `PORT` (`8080` by default). That endpoint answers `200`
  without a session and only once the database connection, the schema bootstrap
  and the settings cache are ready, which makes it a reliable readiness signal.
  The check is defined in the image and again in the Compose file (so prebuilt
  images keep reporting correctly) and reads `$PORT` from the environment.
  Inspect it with `docker inspect --format '{{json .State.Health}}' criminalmap`
  and read the probe output with `docker inspect --format '{{json .State.Health.Log}}' criminalmap`.
- An **optional** containerized MariaDB service is included in the Compose file
  as a commented block. To use it, uncomment the `mariadb` service and the
  `volumes` block, then set `DB_HOST=mariadb` in `docker/.env`.
- **Generated images** live on the host at `docker/webimages` (mounted at
  `/app/webimages`). Make it writable by the container user once —
  `mkdir -p webimages && sudo chown -R 1000:1000 webimages` — or switch to the
  named volume shown at the bottom of the Compose file. See
  [OpenGraph images](#opengraph-images).

---

## Environment variables

| Variable      | Default            | Purpose                                        |
| ------------- | ------------------ | ---------------------------------------------- |
| `PORT`        | `8080`             | Port the API listens on; under Docker Compose this is the **host** port published by the mapping (the app keeps listening on `8080` inside the container) |
| `WEBIMAGES_DIR` | `./webimages`    | Directory holding the generated OpenGraph cards (`/app/webimages` in the container) |
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
| `/`                    | public    | Home: map picker with a randomly selected preview |
| `/{prefix}/{shortId}`  | public    | Saved map (editable when signed in as admin) |
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
  (3–32, default 6), and whether uppercase letters and digits are allowed in new
  links.
- **Web Standards** — `robots.txt` toggle and content, `sitemap.xml` toggle, the
  canonical site URL, the default OpenGraph image (used as a fallback) and the
  X/Twitter account.
- **HTML** — raw head injection, custom CSS and custom JavaScript applied to
  every page.
- **Maintenance** — create a brand new example map from the built-in demo data,
  regenerate every OpenGraph image and see which account is signed in.

Settings are stored in the `settings` key/value table and cached in memory after
every write, so changes apply immediately without a restart.

**Per-map OpenGraph images** are generated by the application itself
(`og_card_enabled`) and stored on the `WEBIMAGES_DIR` volume — see
[OpenGraph images](#opengraph-images).

---

## Maps and short URLs

The home page (`/`) is the **map picker**: it lists every map you may see (public
maps for visitors, every map for administrators), highlights one of them — a
random one on every load unless you pass `?map={shortId}` — and previews its
graph on the right. Every entry has a full-screen link that opens the map page.

Map pages live under a short URL:

```text
https://criminalmap.example.com/m/abcxyz
```

- The short ID is random: 6 lowercase letters by default, configurable in
  *Settings → Maps*.
- The URL directory (`m` by default) is also configurable and validated to
  `[a-z0-9_-]+`.
- Anybody can read a published map — the page is rendered server-side with its
  own title, description, canonical link and OpenGraph tags.
- Maps can be marked **private**: they are hidden from the home page and from the
  sitemap, and only a signed-in administrator can open them (everybody else gets
  a `404`).

### Creating and editing a map

1. Sign in as administrator.
2. Click **Create map** in the header (`/?create=1`), fill in the title, the
   description and the visibility and submit. The map is created **empty** and
   the browser is redirected to its own page.
3. On the map page the **Relations** textarea already contains the relations
   saved in the map. Add, edit or remove lines and press **Process**
   (`POST /api/maps/{shortId}/parse` with `mode: "replace"`) to save the whole
   set — removing a line removes that connection from the map. **Copy data**
   copies the editor content to the clipboard and **Clear map**
   (`DELETE /api/maps/{shortId}/graph`) empties the map without deleting it.
4. **Save details** updates the title, description and visibility
   (`POST /admin/maps/{id}/update`) and returns to the same page with a
   confirmation banner.
5. **Delete** removes the map and all of its nodes and edges.

Administrators can also rename, re-describe and publish/unpublish any map from
**Admin → Maps**, which lists every map with its short ID and node/edge counts.
There is no separate "working graph" anymore: each map owns its nodes and edges.

### Initial content

On the first boot the example relations ([`src/seed.js`](src/seed.js:12)) are
staged in the `nodes` / `edges` tables and published as the first map — "Mapa de
exemplo", "Example map" or "Mapa de ejemplo", depending on the default locale. If
a database already holds a working graph but no map (upgrade from `v1.x`), that
graph is published as the first map instead, so no content is lost.
**Settings → Maintenance → Create example map** publishes another demo map at any
time.

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

## OpenGraph images

Every map gets its own **1200×630** card (the 1.91:1 ratio Facebook and LinkedIn
recommend, and the minimum X/Twitter asks for a `summary_large_image`), so a
shared map link shows a real preview instead of the generic one:

- **What is on the card**: the site title, the map title (auto-sized, up to two
  lines), its description, the entity/connection counts, the short URL, the
  domain and a sketch of the network drawn with the same post‑it palette as the
  graph in the browser. The colours follow the **default theme**.
- **How it is rendered**: by the application itself, with no image dependency at
  all — [`src/ogcard/`](src/ogcard/index.js:1) paints a plain RGB buffer and
  writes a standard PNG with Node's `zlib`, and even the text comes from a
  built-in single-stroke font, so the image works on alpine (which ships no
  fonts) and on every architecture the image is built for.
- **When it is regenerated**: after every write to a map — created, details
  saved, relations saved, map emptied — plus once at startup for the initial
  map. Failures are logged and never block the write: a broken volume can not
  make saving a map fail.
- **Where the files live**: `WEBIMAGES_DIR` (default `./webimages`, mapped to
  `/app/webimages` in the container), one file per map:
  `webimages/maps/<shortId>-<version>.png`. Only the current version is kept.
- **The version is content based** (`updated_at` + a hash of title, description,
  visibility, counts and branding), so the URL changes exactly when the card
  does — that is what makes crawlers pick up a new preview — and the file can be
  served with `Cache-Control: immutable`.
- **How it is served**: `GET /media/maps/<shortId>-<version>.png`. A request for
  the current version regenerates the file if it is missing (first hit after a
  deploy, empty volume, restored backup); an older version answers `302` to the
  current one; a **private** map answers `404` to visitors, exactly like its page.
- **On the pages**: the map pages (and the home page, for the map being
  previewed) point `og:image`, `og:image:width/height/type` and
  `twitter:image` at that card, and switch `twitter:card` to
  `summary_large_image` automatically. Administrators also see a preview of the
  card in the map editor.
- **Turning it off**: *Settings → Appearance → Generate an OpenGraph image per
  map*. When it is off, pages fall back to the default OpenGraph image URL
  configured next to it and `/media/maps/…` answers `404`.
- **After changing the branding** (site title, domain, default theme) run
  *Settings → Maintenance → Regenerate OpenGraph images* so the stored cards are
  redrawn.

### Permissions on the image folder

The container runs as the unprivileged `node` user (uid 1000), while a bind mount
is created by Docker as `root`. Make the folder writable by the container user
once — two equivalent ways, **neither of them needs a `docker-compose` change**:

```bash
# from the host, using the container itself (no sudo needed; works on the
# currently running container and fixes the host folder at the same time,
# because a bind mount is the same inode on both sides)
docker exec --user root criminalmap chown -R 1000:1000 /app/webimages

# or directly on the host folder
cd docker && mkdir -p webimages && sudo chown -R 1000:1000 webimages
```

`criminalmap` is the container name (`docker ps` shows it; the same value is
printed in the warning below as `<container>`). **No restart is needed**: the
writability check runs again on every write, so the next map save (or the next
request for a card that is not stored yet) writes the files and the log says
`[ogcard] … is writable again`.

The status is also visible in the admin panel: *Settings → Appearance* shows the
folder and whether it is **writable**, with the command above when it is not.

Without the fix the application still runs: it logs

```text
[ogcard] /app/webimages/maps is not writable (EACCES) — cards are rendered on demand but not stored.
         Fix it once (no docker-compose change needed):
           docker exec --user root <container> chown -R 1000:1000 /app/webimages
         or on the host:  sudo chown -R 1000:1000 <folder mounted at /app/webimages>
         The check is retried on every write, so no restart is needed afterwards.
```

and serves the cards with `Cache-Control: no-store` instead of failing. Prefer a
Docker managed volume? Comment the bind mount out in
[`docker/docker-compose.yml`](docker/docker-compose.yml:1), uncomment the
`volumes:` block at the bottom and use `- webimages:/app/webimages`; named
volumes inherit the ownership set in the image, so no `chown` is needed. Running
the image as root, or shipping an entrypoint that fixes the ownership before
dropping privileges to `node`, are the other alternatives — both require
rebuilding the image.

---

## API endpoints

All endpoints return JSON. The base URL is `http://localhost:8080` in local
setups.

| Method | Path                | Access | Description                                                      |
| ------ | ------------------- | ------ | ---------------------------------------------------------------- |
| GET    | `/api/settings`     | public | Public settings (default locale/theme, map prefix, locales, …)   |
| GET    | `/api/maps`         | admin  | Lists saved maps with their public URLs                          |
| GET    | `/api/maps/{shortId}` | public | Returns a saved map with its graph (published maps only)       |
| POST   | `/api/maps/{shortId}/parse` | admin | Parses text and appends (`mode: "append"`, the default) or replaces (`mode: "replace"`) the map relations |
| DELETE | `/api/maps/{shortId}/graph` | admin | Empties the map (every node and edge; the map itself stays)  |
| GET    | `/media/maps/{shortId}-{version}.png` | public | Generated OpenGraph card of a map (302 for an old version, 404 for private maps) |

**Access column**: `admin` endpoints require a signed-in administrator and answer
`401` (JSON) otherwise; `GET /api/maps/{shortId}` answers `404` for private maps
unless an administrator is signed in.

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

### `GET /api/maps/{shortId}`

```bash
curl http://localhost:8080/api/maps/abcxyz
```

Response:

```json
{
  "map": {
    "short_id": "abcxyz",
    "title": "Caso Queiroz",
    "description": "Desvio de salários",
    "updated_at": "2026-09-15T12:00:00.000Z",
    "url": "http://localhost:8080/m/abcxyz"
  },
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

Private maps answer `404` unless an administrator is signed in.

### `POST /api/maps/{shortId}/parse`

Writes relations into a saved map (administrator only). Request body:
`{ "text": "...", "mode": "append" | "replace" }` — `mode` is optional and
defaults to `append`.

```bash
curl -X POST http://localhost:8080/api/maps/abcxyz/parse \
  -H "Content-Type: application/json" \
  -H "Cookie: criminalmap_session=..." \
  -d '{"text":"[A] -> [B] : Met once | Fontes: https://example.com/a"}'
```

On success it returns the map metadata plus the updated graph:

```json
{
  "map": { "short_id": "abcxyz", "title": "Caso Queiroz", "updated_at": "...", "url": "..." },
  "nodes": [ ... ],
  "edges": [ ... ]
}
```

Error cases:

- Unknown `shortId` → `404` with `{ "error": "Map not found." }`
- Not signed in → `401` with `{ "error": "Authentication required." }`
- Empty `text` → `400` with `{ "error": "The \"text\" field is required and must not be empty." }`
- No valid relation lines → `400` with `{ "error": "No valid relation lines were found in the provided text.", "invalidLines": [...] }`

Nodes are upserted by label (`map_nodes` is unique per map + label), while every
relation becomes a **new** edge row, so repeated relations stay as parallel
edges.

With `mode: "replace"` — what the map editor sends — every node and edge stored
in the map is removed first, so the text is the **full relation set**: lines can
be added, edited and removed, and deleting a line deletes that connection. A
single invalid line answers `400` (with `invalidLines`) and changes nothing, so
the previous content is never lost by accident. An empty `text` is always
refused with `400`; use `DELETE /api/maps/{shortId}/graph` to empty a map.

```bash
# replace every relation of the map with the given lines
curl -X POST http://localhost:8080/api/maps/abcxyz/parse \
  -H "Content-Type: application/json" \
  -H "Cookie: criminalmap_session=..." \
  -d '{"text":"[A] -> [B] : Met once | Fontes: https://example.com/a","mode":"replace"}'
```

### `DELETE /api/maps/{shortId}/graph`

Empties a saved map (administrator only). The map itself, its title, description
and short URL are kept.

```bash
curl -X DELETE http://localhost:8080/api/maps/abcxyz/graph \
  -H "Cookie: criminalmap_session=..."
```

Response:

```json
{ "success": true, "removed": { "nodes": 10, "edges": 9 } }
```

Emptied maps keep their OpenGraph card (title, description and "no entities
yet"), which is regenerated by the same request.

### `GET /media/maps/{shortId}-{version}.png`

The generated OpenGraph card of a map (see
[OpenGraph images](#opengraph-images)). It is public — social crawlers do not have
a session — but it follows the visibility of the map: a **private** map answers
`404`, exactly like its page. The current name is advertised by the map page in
`og:image`.

- Current version → `200 image/png` with
  `Cache-Control: public, max-age=31536000, immutable` (the file is generated on
  the spot when it is not on the volume yet).
- Older/unknown version of an existing map → `302` to the current card.
- Unknown map or malformed file name → `404`.

---

## Graph behaviour

The graph is interactive on touch screens and desktops, but it is kept **calm**:
it settles once and then stops moving.

- **Physics is only used to settle the layout.** After the initial stabilization
  the solver is frozen (`physics.enabled = false`), so nodes do not drift or
  wobble forever after a pinch, a pan or a tap on a phone.
- **The graph only moves while the user moves it.** Dragging a box re-enables the
  solver for as long as the drag lasts (its neighbours follow) and releasing it
  freezes the solver **immediately** — nothing rearranges after the mouse button
  is released. New content (loading a map, pressing **Process**) is the only case
  where the layout relaxes on its own, so freshly added nodes find a place.
- **Middle click** anywhere on the graph resets the zoom by framing the whole
  graph again (animated, unless `prefers-reduced-motion` is set), the wheel zooms
  in and out, clicking a box or a connection opens its details and dragging the
  background pans the map. The **?** button in the header — next to the theme
  toggle, with the same design — opens a popup with those instructions, so
  visitors do not have to guess.
- Narrow viewports (`≤ 900px`) use a more compact physics profile so the same
  graph occupies a smaller area and the automatic `fit` zooms in more (readable
  labels) instead of shrinking the map to an unreadable smudge.
- The graph area on phones has an **explicit height** (CSS `58svh`, pinned in
  pixels at runtime) instead of a flex based one: some mobile browsers resolved
  that to `0`, which left vis-network with a `0×0` canvas — an apparently empty
  graph.
- If the graph cannot be drawn, the reason is written **on the page** (library
  not loaded, area without size, API unreachable) instead of failing silently,
  and `?debug=1` prints the measurements (`library`, container size, node/edge
  counts, zoom) inside the graph area — useful when the browser console is not
  reachable, e.g. on a phone.

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
