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
8. [API endpoints](#api-endpoints)
9. [Internationalization (i18n)](#internationalization-i18n)
10. [GitHub Actions](#github-actions)

---

## Overview

The system consists of:

- A **Node.js/Express** API that stores the graph in **MariaDB** and serves the
  frontend static files.
- A **plain-text parser** that accepts one relation per line and extracts the
  `from` node, `to` node, topic description, and optional `Fontes:` (sources).
- A **Vanilla JS frontend** that renders the graph with
  [Vis.js](https://visjs.org/) (vis-network, loaded from CDN) and shows an
  evidence-card modal when a node or edge is clicked.
- An **embedded migration and seed**: on startup the API creates the database
  (if needed), applies [`db/schema.sql`](db/schema.sql:1), and inserts example
  data when the `nodes` table is empty.

The UI is bilingual (Portuguese by default) and supports adding more locales
through JSON files.

---

## Tech stack

| Layer      | Technology                                              |
| ---------- | ------------------------------------------------------- |
| Frontend   | HTML5, CSS3, Vanilla JavaScript                         |
| Graph      | Vis.js (vis-network 9.1.9) via CDN                       |
| Backend    | Node.js, Express 4                                       |
| Database   | MariaDB (accessed through `mysql2`)                      |
| Parsing    | Node.js regular expressions                              |
| Packaging  | Docker, Docker Compose                                   |

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
├── server.js                 # Express app, static serving, API routes
├── package.json              # Node metadata and dependencies
├── Dockerfile                # Production runtime image
├── .dockerignore             # Files excluded from the Docker build context
├── src/
│   ├── db.js                 # MariaDB bootstrap (connect, migrate, seed)
│   ├── parser.js             # Plain-text relation parser
│   └── seed.js               # Seed data and node/edge upsert helpers
├── db/
│   └── schema.sql            # nodes + edges table definitions
├── public/
│   ├── index.html            # Single-page frontend shell
│   ├── css/
│   │   └── style.css         # Noir detective theme
│   ├── js/
│   │   ├── app.js            # Graph rendering, modals, API calls
│   │   └── i18n.js           # Locale loading and translation helpers
│   └── locales/
│       ├── pt_BR.json        # Brazilian Portuguese strings
│       └── en_US.json        # American English strings
├── docker/
│   ├── docker-compose.yml    # Compose service definition
│   └── .env.example          # Environment template for Docker
└── .github/
    └── workflows/            # CI/CD (see GitHub Actions section)
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
```

All variables are optional and fall back to sensible defaults
(`PORT=8080`, `DB_HOST=127.0.0.1`, `DB_PORT=3306`, `DB_USER=root`,
`DB_PASSWORD=` empty, `DB_NAME=criminalmap`).

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
5. Starts listening and serves the frontend from [`public/`](public/index.html:1).

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
| `DOMAIN`      | (none)             | Optional domain name, logged at startup        |
| `DB_HOST`     | `127.0.0.1`        | MariaDB host                                   |
| `DB_PORT`     | `3306`             | MariaDB port                                   |
| `DB_USER`     | `root`             | MariaDB user                                   |
| `DB_PASSWORD` | (empty)            | MariaDB password                               |
| `DB_NAME`     | `criminalmap`      | Database name (created automatically if absent)|

---

## API endpoints

All endpoints return JSON. The base URL is `http://localhost:8080` in local
setups.

| Method | Path           | Description                                                      |
| ------ | -------------- | ---------------------------------------------------------------- |
| GET    | `/api/graph`   | Returns the full graph (nodes + edges)                           |
| GET    | `/api/nodes`   | Returns only the `nodes` array                                    |
| GET    | `/api/edges`   | Returns only the `edges` array                                    |
| POST   | `/api/parse`   | Parses text, upserts nodes, inserts edges, returns the full graph |
| DELETE | `/api/graph`   | Deletes all edges and nodes                                      |
| POST   | `/api/seed`    | Wipes the graph and re-runs the built-in seed data               |

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
{ "success": true }
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
  as JSON files named after the locale code (for example `pt_BR.json`,
  `en_US.json`).
- The default locale is **`pt-BR`** (see [`public/js/i18n.js`](public/js/i18n.js:5)).
- The language selector in the header switches the locale at runtime without a
  page reload; dictionaries are fetched once and cached.

### Adding a new language

1. Copy an existing locale file, e.g. `cp public/locales/en_US.json public/locales/es_ES.json`.
2. Translate every string value (keep the keys unchanged).
3. Add an `<option>` to the `<select id="lang-select">` element in
   [`public/index.html`](public/index.html:21), using the same locale code as
   the file name.

The keys must stay consistent across all locale files. The translator in
[`public/js/i18n.js`](public/js/i18n.js:19) falls back to showing the raw key
when a translation is missing, which makes missing entries easy to spot.

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
