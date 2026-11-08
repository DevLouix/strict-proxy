# Which file do I use?

This repository has **five Compose files** and **four environment files**. That
is not five ways to deploy it: each one belongs to a different deployment style,
and a normal deployment uses **one Compose file and one environment file**.

Read this page, find your row below, and follow the document named in the last
column. Do not mix files from different rows — the most common beginner mistake
is filling in the wrong `.env` file.

## 1. Choose your path

| I want to… | Compose file | Environment file | Follow |
|---|---|---|---|
| Try it on my laptop (controller runs with `npm`, not Docker) | `docker-compose.yml` (Postgres + Redis only) | `.env`, created for you | [SETUP.md §3](../SETUP.md#3-quick-path-15-minutes) |
| Run it on one Linux VPS with HTTPS | `docker-compose.production.yml` | `.env.docker`, copied from `.env.docker.example` | [SETUP.md §4](../SETUP.md#4-production-path-docker) |
| Run it on **Dokploy** | `docker-compose.dokploy.yml` | controller section of `.env.dokploy.example`, pasted into the Dokploy UI | [DOKPLOY.md](DOKPLOY.md) |
| Add an **exit node** on another VPS, managed by Dokploy | `docker-compose.dokploy-node.yml` | node section of `.env.dokploy.example` | [DOKPLOY.md §5](DOKPLOY.md#5-add-exit-nodes) |
| Add an **exit node** on another VPS, installed with systemd | *(no Compose file)* | `apps/node-agent/deploy/agent.env.example` | [SETUP.md §7](../SETUP.md#7-add-your-first-node) |
| Reproduce a networking problem in a sandbox | `docker-compose.live-test.yml` (an override) | `.env.docker` | this page only — never production |

> **Using Dokploy?** You need exactly two files from this repository:
> `docker-compose.dokploy.yml` (controller server) and
> `docker-compose.dokploy-node.yml` (each exit VPS). Everything else is for a
> different hosting style.

## 2. The Compose files, one by one

### `docker-compose.yml` — local development database only

- **Starts:** Postgres 16 and Redis 7. Nothing else.
- **Use when:** you run the controller with `npm run dev:controller` on your own
  machine and only want the dependencies in containers.
- **Does not use any env file.** The credentials are the throwaway values
  `strict` / `strict`, and both ports are published on `0.0.0.0:5432` and
  `0.0.0.0:6379`.
- **Never use on a public server.** No password on Redis, a guessable Postgres
  password, and database ports open to the network.
- **Command:** `docker compose up -d postgres redis`
- **Related values:** the `.env` file produced by
  `npx tsx apps/controller/src/scripts/generate-env.ts` already points at
  `localhost:5432` and `localhost:6379`.

### `docker-compose.production.yml` — one Linux VPS, bundled Caddy edge

- **Starts:** controller + Postgres + Redis. Optional Caddy HTTPS edge
  (`--profile edge`) and optional local node agent (`--profile node`).
- **Use when:** you have a plain Debian/Ubuntu server and want the repository to
  handle TLS for you. Nothing else in the repository publishes the controller on
  a public port — this file does, through Caddy.
- **Env file:** `.env.docker` (copy `.env.docker.example`). Compose reads it only
  because you pass `--env-file .env.docker`; it is not auto-loaded.
- **Host ports:** controller `127.0.0.1:8080`, Postgres/Redis `127.0.0.1`,
  and 80/443 only when the `edge` profile is on.
- **Commands:**
  ```bash
  docker compose --env-file .env.docker -f docker-compose.production.yml config
  docker compose --env-file .env.docker -f docker-compose.production.yml up -d --build
  docker compose --profile edge --env-file .env.docker -f docker-compose.production.yml up -d --build
  ```
- **Do not use with Dokploy.** Traefik and Caddy would both try to own ports
  80/443, and the published controller port bypasses Dokploy's routing.

### `docker-compose.dokploy.yml` — controller stack for Dokploy

- **Starts:** controller + Postgres + Redis inside Dokploy, with **no host
  ports**, joined to Dokploy's external `dokploy-network`.
- **Use when:** Dokploy is already installed and terminates TLS with its Traefik.
  You assign the domain in the Dokploy UI to the `controller` service on its
  internal port (`CONTROLLER_INTERNAL_PORT`, default `8080`).
- **Env file:** none on disk. Paste the controller section of
  `.env.dokploy.example` into the service's **Environment** tab in Dokploy.
- **Does not include a node.** Nodes are separate services on separate VPSes.
- **Follow:** [DOKPLOY.md](DOKPLOY.md).

### `docker-compose.dokploy-node.yml` — one exit VPS per node (Dokploy)

- **Starts:** a single `node-agent` with host networking, `NET_ADMIN`, and
  `/dev/net/tun`, so sing-box can accept VLESS+REALITY traffic and users' bytes
  leave from that VPS's IP.
- **Use when:** adding a node to a Dokploy deployment. Deploy it as its **own**
  Dokploy Compose service on the exit VPS.
- **Env file:** paste the node section of `.env.dokploy.example` into that
  service. Only the first boot needs `NODE_ENROLLMENT_TOKEN`; remove it and
  redeploy after enrollment.
- **Do not give it a domain.** It is not an HTTP app, and its stats listener is
  loopback-only.
- **Do not run it on the controller server** unless you accept that the API and
  user traffic share one IP and one failure domain.

### `docker-compose.live-test.yml` — sandbox networking override

- **What it is:** a Compose *override*, not a stack. It is layered on top of
  `docker-compose.production.yml` to switch containers to host networking on
  alternate ports (`15432`, `16379`, `18080`, `18081`).
- **Use when:** a restricted Docker bridge blocks container-to-container traffic
  (some CI sandboxes), so the normal stack cannot start.
- **Never use for production.** It removes network isolation on purpose.
- **Requires Compose ≥ 2.24** for `!reset`, and a host-network-capable Linux.
- **Command:**
  ```bash
  docker compose --env-file .env.docker \
    -f docker-compose.production.yml -f docker-compose.live-test.yml up -d
  ```

## 3. The environment files

The naming rule everywhere in this repository: **`something.example` is a
template you copy; the copy is the real file and is gitignored.**

| File | You copy it to | Read by | Notes |
|---|---|---|---|
| `.env.example` | `.env` | the controller when you run it with `npm run dev:controller` | Local development only. Created and filled automatically by `generate-env.ts`; documented variables are for hand-tuning. |
| `.env.docker.example` | `.env.docker` | `docker-compose.production.yml`, always via `--env-file .env.docker` | Production single-server settings: secrets, ports, network subnet, resource limits, Caddy/TLS, optional local node. CI also validates this file. |
| `.env.dokploy.example` | *nowhere* — it is a worksheet | Dokploy's Environment tab (controller section) and each node service (node section) | Dokploy never reads a file from this repository; `${VAR}` is substituted from the UI. |
| `apps/node-agent/deploy/agent.env.example` | `/etc/strict-proxy/agent.env` on the node | the systemd-installed node agent | Only for the `install-node.sh` / systemd path. The Docker and Dokploy nodes get their settings from Compose instead. |

Never commit a filled-in `.env`, `.env.docker`, `.env.dokploy`, or
`signing-key.pem`. All four are gitignored.

### How a value actually reaches the container

This is the part beginners trip over, because "the env file" means three
different things:

1. **Compose interpolation.** Every `${NAME}` in a Compose file is replaced from
   the shell environment plus the file passed with `--env-file`. That is why
   `--env-file .env.docker` must be on **every** command — omit it and Compose
   silently reads `.env` (or nothing) instead.
2. **Dokploy's Environment tab.** Same substitution, done by Dokploy. Editing a
   `.env` file in the repository changes nothing for a running Dokploy service.
3. **Container environment.** The `environment:` block in the Compose file is
   what the process inside the container sees. A variable absent from that block
   never reaches the app, even if it is in the env file.

Consequences worth memorising:

- A required value uses `${NAME:?message}`: missing it makes
  `docker compose config` fail before anything starts. That is the intended
  behaviour, not a bug.
- Inside a container, `localhost` is that container. Use the service names
  `postgres` and `redis` in `CONTROLLER_DATABASE_URL` / `CONTROLLER_REDIS_URL`.
- `$$` in a Compose file means a literal `$` for the container (used by the
  Redis healthcheck and the Postgres healthcheck's shell variables).
- The signing key is one line with `\n` escapes, not a multi-line PEM.
- Compose strips surrounding quotes from values; other tools (plain
  `docker run --env-file`) do not. When in doubt, keep values unquoted and
  avoid `#` and spaces.

## 4. The other files, and whether you touch them

| File | What it is | You edit it? |
|---|---|---|
| `docker/controller.Dockerfile` | Controller image: Node 22, builds TS, runs the entrypoint | Only if you change the runtime |
| `docker/node-agent.Dockerfile` | Node image: Node 22 + pinned sing-box + agent | Only to bump `SING_BOX_VERSION` |
| `docker/controller-entrypoint.sh` | Validates env, waits for DB, applies migrations, starts | No |
| `docker/node-agent-entrypoint.sh` | Waits for/provisions the node identity, launches sing-box | No |
| `docker/validate-controller-env.sh` | The boot-time environment gate | No |
| `docker/Caddyfile`, `docker/edge-entrypoint.sh` | The optional `edge` profile (TLS mode, ACME) | Only to customise TLS |
| `apps/node-agent/deploy/install-node.sh` | Installs the systemd node agent on a VPS | No |
| `apps/node-agent/deploy/strict-proxy-agent.service`, `sing-box.service` | systemd units for the host-install path | No |
| `scripts/check-server-prereqs.sh` | Pre-flight check for the single-server path | No |
| `scripts/generate-secrets.sh` | Generates the controller secrets and the Ed25519 keypair into `secrets.txt` + `signing-key.pem` (both gitignored) | Only to generate or rotate secrets |
| `scripts/smoke-server.sh` | Post-deploy API smoke test (`BASE_URL=… scripts/smoke-server.sh`) | No |
| `scripts/smoke-gatekeeper.ts`, `scripts/smoke-enrollment.ts` | End-to-end checks with a controller and Gatekeeper | No |
| `.github/workflows/server-ci.yml` | Typecheck, unit + integration tests, compose validation, image publishing | No |
| `.github/workflows/client.yml` | Flutter tests/analysis, the native libbox build, and the signed push APK artifact — fails without the release secrets/variables; iOS check is opt-in (`ENABLE_IOS_VERIFICATION`) | No |
| `.github/workflows/client-release.yml` | Signed production APK, built on demand | No — triggered from the Actions tab |
| `apps/client/libbox.ref` | The reviewed sing-box-libbox commit the native engine is built from | Only to upgrade the engine, then rebuild |
| `apps/client/tool/*.sh` | Client build, libbox build and unpack, Android identity, APK signing and verification, release-configuration check, release-secret setup, Linux prerequisites | Only through documented flags |
| `signing-key.pem` (you create it) | Private half of the client-verification key | Back it up; never commit |

## 5. Documentation map

| Read this | When |
|---|---|
| [SETUP.md](../SETUP.md) | You want a step-by-step from a blank server, including the admin dashboard tour |
| [DOKPLOY.md](DOKPLOY.md) | You host on Dokploy |
| [BACKUP.md](BACKUP.md) | You are backing up, restoring, or moving a deployment |
| [RELEASE-CLIENT.md](RELEASE-CLIENT.md) | You are about to hand an APK to users |
| [ARCHITECTURE.md](ARCHITECTURE.md) | You want to understand trust boundaries, data model, and known gaps |
| This page | You are unsure which file to edit |

## 6. Common mistakes, by symptom

| Symptom | You are probably editing / running | Do this instead |
|---|---|---|
| "I changed `.env` but nothing happened" | `.env.example`, or the running container was never restarted | Edit `.env` (local) or `.env.docker` (Docker), then redeploy/restart |
| "I changed `.env.docker` but Dokploy is unchanged" | A file Dokploy never reads | Edit the Environment tab in Dokploy |
| `required controller environment variable is missing` | `--env-file` omitted, or the variable is missing from the env file | Pass `--env-file .env.docker` on every command |
| `docker compose up -d` started only Postgres and Redis | You are in the repository root without `-f`; the default is the local dev file | Add `-f docker-compose.production.yml` (or the Dokploy path) |
| Dokploy returns 404 | No domain/router is attached to the service | Domains → `controller`, host + path `/`, internal port `CONTROLLER_INTERNAL_PORT` |
| Dokploy returns 502 | The domain points at the wrong service or port | Domain → `controller`, internal port matching `CONTROLLER_INTERNAL_PORT` |
| Ports 80/443 already in use on a Dokploy host | You started the `edge` profile too | Use `docker-compose.dokploy.yml`, not `production.yml` |
| Node stays `offline` | Token expired/used, or `NODE_CONTROLLER_URL` is not the public HTTPS URL | Issue a new token, fix the URL, redeploy |
| Every installed client says "tampered configuration" | A new signing key was generated after the APK was built | Rebuild clients with the current public key before rotating |
| `network dokploy-network not found` | Dokploy's shared network is missing | Repair Dokploy, or create the network manually |
