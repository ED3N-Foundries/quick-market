# Deploy (containers, three repos only)

Standalone deploy without core-infra. Submission copy for the hackathon;
core-infra's `docker-compose.yml` + `deploy/` stay the ops canonical files.

## Layout

Clone the three repos as siblings:

```bash
git clone https://github.com/ED3N-Foundries/quick-market.git
git clone https://github.com/ED3N-Foundries/quick-market-agent.git
git clone https://github.com/ED3N-Foundries/quick-market-health.git
```

This file's `docker-compose.yml` builds all three:

| Service | Build context | Image |
|---|---|---|
| `quick-market` | `quick-market/` (`Dockerfile` in this repo) | `ed3n/quick-market:bun-1.4.4` |
| `quick-market-agent` | `quick-market-agent/` (its own `Dockerfile`) | `ed3n/quick-market-agent:bun-1.4.4` |
| `quick-market-health` | `quick-market-health/` (its own `Dockerfile`) | `ed3n/quick-market-health:bun-1.4.4` |

## Setup

From `quick-market/`:

```bash
cp deploy.env.example deploy.env   # git-ignored, never commit it
```

Fill the blank keys in `deploy.env`. One file serves market + agent
(compose overrides the agent's `API_URL` to `http://quick-market:3001` and
`DB_PATH` to `/data/quick-market-agent.sqlite`, so the market prefs in that
file match on both sides by construction). Local `bun` runs keep using each
repo's own `.env` (see `README.md`, `quick-market-agent/README.md`).

## Up

```bash
docker compose up -d --build
```

`deploy.env` is required (`required: true` in compose). To use another path:
`DEPLOY_ENV_FILE=/path/to/file docker compose up -d --build`.

## Check

```bash
curl -sf http://127.0.0.1:3001/api/state
curl -sf http://127.0.0.1:3001/api/markets
curl -sf http://127.0.0.1:3011/api/health   # agent stats, host-routed only if published; inside the net it is http://quick-market-agent:3011
curl -sf http://127.0.0.1:3101/api/health
```

Open `http://127.0.0.1:3101` for the admin page (`/api/check?fresh=1` JSON).

## Ports

| Port | What |
|---|---|
| `3001` | market API + `/ws` (published on loopback) |
| `3002` | market process vitals + funding (container net only, health `INTERNAL_URL`) |
| `3011` | agent stats (container net only) |
| `3101` | health page (published on loopback, `${PORT:-3101}`) |

## Containers/logs card (optional)

Default `DOCKER_SOCK` is empty (cards disabled). To enable, uncomment the
socket volume in `docker-compose.yml` and set in the environment:

```bash
DOCKER_SOCK=/var/run/docker.sock DOCKER_GID=$(getent group docker | cut -d: -f3) docker compose up -d
```
