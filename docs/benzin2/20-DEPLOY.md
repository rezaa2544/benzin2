# G-18 — deploying one server

One VPS, one domain, one `docker compose up -d`. Everything below is either a command to run or a
thing to look at; nothing needs the codebase open.

Files:

| File                            | What it is                                                                              |
| ------------------------------- | --------------------------------------------------------------------------------------- |
| `infra/docker-compose.prod.yml` | the whole stack (postgres, redis, api, web, admin, caddy, backup, uptime-kuma, migrate) |
| `infra/Caddyfile.prod`          | TLS, the single origin, security headers, access log rotation                           |
| `infra/.env.prod.example`       | every variable the stack needs, with the secrets marked                                 |
| `infra/backup.sh`               | nightly `pg_dump`, verified, pruned, optionally shipped offsite                         |
| `infra/restore-test.sh`         | the drill: restores a dump into a throwaway database and counts rows                    |
| `infra/Dockerfile.*`            | the images (the API image now also carries `infra/migrations`)                          |
| `scripts/check-deploy.mjs`      | asserts the promises this document makes (`node scripts/check-deploy.mjs`)              |

## 1. What the owner has to provide

| Needed                                      | Why              | Where it goes          |
| ------------------------------------------- | ---------------- | ---------------------- |
| A server (2 vCPU / 2 GB / 40 GB is enough)  | the host         | —                      |
| A domain with an `A` record → the server IP | TLS needs a name | DNS panel              |
| An email for Let's Encrypt                  | expiry warnings  | `ACME_EMAIL`           |
| An rclone remote (optional but recommended) | offsite copies   | `BACKUP_RCLONE_REMOTE` |

Nothing else. The merchant id for the payment gateway can arrive later: card-to-card works without
it, and the API boots without `ZARINPAL_MERCHANT_ID`.

## 2. First boot (30 minutes)

```bash
# on the server, as a user with docker
sudo apt update && sudo apt install -y docker.io docker-compose-v2 git curl ufw
sudo usermod -aG docker "$USER" && newgrp docker

git clone https://github.com/rezaa2544/benzin2.git /opt/benzin && cd /opt/benzin
cp infra/.env.prod.example infra/.env.prod
chmod 600 infra/.env.prod
$EDITOR infra/.env.prod          # PUBLIC_HOST, PUBLIC_ORIGIN, ACME_EMAIL + the three secrets
#   openssl rand -base64 48      # for JWT_SECRET / OTP_PEPPER / POSTGRES_PASSWORD

# firewall: ssh, http, https — nothing else. Postgres and Redis never publish a port.
sudo ufw allow 22/tcp && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 443/udp
sudo ufw --force enable

# the file is valid before anything is pulled (fails loudly on a missing secret)
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod config -q

docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod up -d --build
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod ps
```

`migrate` runs once and exits (`0`), then the API starts (`service_completed_successfully`). On the
very first boot the certificate takes 10–60 seconds: Caddy answers the ACME challenge on port 80.

## 3. Is it actually up?

```bash
HOST=https://$(grep PUBLIC_HOST infra/.env.prod | cut -d= -f2)
curl -sS -o /dev/null -w 'healthz   %{http_code}\n' $HOST/healthz          # 200
curl -sS -o /dev/null -w 'site      %{http_code}\n' $HOST/                 # 200
curl -sS -o /dev/null -w 'admin     %{http_code}\n' $HOST/admin/           # 200
curl -sS -o /dev/null -w 'status    %{http_code}\n' $HOST/status/          # 301 → the monitor
curl -sSI $HOST | grep -i strict-transport-security                        # the header is there
curl -sS -o /dev/null -w 'http->https %{http_code} -> %{redirect_url}\n' http://${HOST#https://}/
```

The acceptance line "`/health` green" is `GET /healthz` = `200` (the API calls it `healthz`; the
old `/health` path never existed).

## 4. Backups — the part people skip

The `backup` service runs `backup.sh loop`: every night at `BACKUP_HOUR` (default 03:00 Tehran) it
dumps the database in custom format, **verifies the archive with `pg_restore --list` before moving
it into place**, prunes copies older than `BACKUP_KEEP_DAYS` (14), and copies the fresh dump to
`BACKUP_RCLONE_REMOTE` when that is set.

```bash
# a dump now, without waiting for 3 a.m.
docker compose -f infra/docker-compose.prod.yml exec backup sh /usr/local/bin/backup.sh once
docker compose -f infra/docker-compose.prod.yml exec backup ls -lh /backups
```

### The restore drill (run it monthly, and after every upgrade)

```bash
docker compose -f infra/docker-compose.prod.yml exec postgres \
  sh /drills/restore-test.sh /backups/benzin-YYYYMMDD-HHMMSS.dump
```

It creates a scratch database, restores into it with `--exit-on-error`, prints row counts for
`users / orders / reservations / payments / plans / audit_log` and the number of applied
migrations, then drops the scratch database. A non-zero exit means **the backup is not a backup**;
find out why before the server does.

Offsite rehearsal: `rclone copy` the newest file to a laptop and repeat the same command with
`-v /path/to/file.dump:/tmp/x.dump` mounted.

## 5. Monitoring

Uptime Kuma lives at `https://status.<host>/` (data in the `kumadata` volume); `https://<host>/status/`
redirects there, so either URL in a runbook works. **It needs one extra DNS record** —
`status` → the same IP as the site — because the deployed Kuma image ignores the base-path
variables (verified on 1.23.17: `/` answers, `/status/` 404s), and a monitor behind a broken
prefix is worse than a second A record. Create these two monitors on first login — they are the
acceptance criteria:

| Name       | Type    | Target                                  | Interval | Alert            |
| ---------- | ------- | --------------------------------------- | -------- | ---------------- |
| Benzin API | HTTP(s) | `https://<host>/healthz` — keyword `ok` | 60s      | after 2 failures |
| Benzin Web | HTTP(s) | `https://<host>/` — keyword `root`      | 60s      | after 2 failures |

Optional but cheap: `https://<host>/v1/meta/config` (proves the API's database connection, not just
the process) and a TCP monitor on `:443`.

Notifications: email or Telegram inside Kuma → Settings → Notifications. Kuma itself is a container
with `restart: unless-stopped`; if it dies the monitor is gone, which is why the _external_ free
monitor (or a phone alarm) is still worth having.

## 6. Logs

- Every service uses `json-file` with `max-size: 20m`, `max-file: 5` — a chatty week cannot fill
  the disk (that is `scripts/check-deploy.mjs` check #3).
- Caddy writes JSON access logs to `/data/access.log` inside its volume, rotated at 20 MB with 5
  kept files for 168 hours.
- The API logs structured JSON with a `requestId`; every error response carries the same id, which
  is the one thing support can grep.

```bash
docker compose -f infra/docker-compose.prod.yml logs -f --tail=100 api
docker compose -f infra/docker-compose.prod.yml exec caddy tail -f /data/access.log
docker compose -f infra/docker-compose.prod.yml exec api sh -c 'cat /proc/1/cmdline' # sanity
```

## 7. Upgrading and rolling back

```bash
cd /opt/benzin
git fetch --tags && git checkout <tag-or-sha>
docker compose -f infra/docker-compose.prod.yml --env-file infra/.env.prod up -d --build
docker compose -f infra/docker-compose.prod.yml exec postgres \
  sh /drills/restore-test.sh   # uses the newest dump, proves the backups still work
```

Migrations are forward-only by design (`db:migrate` never rolls back). The documented way back is:

1. `git checkout <previous-sha>` and `up -d --build` again (the code goes back, the schema stays);
2. if the schema itself is the problem, restore the last dump into a fresh volume:
   `docker compose down` → `docker volume rm benzin_pgdata` → `up -d postgres` alone → restore
   with `pg_restore` → `up -d`.

That second path loses everything written since the dump, which is why the drill is monthly.

## 8. Troubleshooting table

| Symptom                                       | Likely cause                               | Fix                                                      |
| --------------------------------------------- | ------------------------------------------ | -------------------------------------------------------- |
| `compose config` errors on `${JWT_SECRET:?…}` | `.env.prod` not passed / empty value       | `--env-file infra/.env.prod`                             |
| Caddy logs `no such host` / ACME fails        | DNS not pointing at the box, or 80 blocked | check `dig +short <host>`, open 80                       |
| `/healthz` 502                                | API not up                                 | `logs api`; usually `DATABASE_URL` or a failed `migrate` |
| `migrate` exits non-zero                      | pending migration + a dirty database       | read the log, never `db:reset` on prod                   |
| Push/OTP never arrives                        | SMS provider not configured                | `POST /v1/admin/sms/test` in the panel                   |
| Kuma page 404                                 | `UPTIME_KUMA_BASE_PATH` mismatch           | it must stay `/status`                                   |
| Disk filling up                               | uploads or Docker images                   | `docker system prune -af --volumes` after a backup       |

## 9. What this task does _not_ include

- Multi-server / zero-downtime deploys. One box, one compose file — deliberately, see
  `15-INFRA-PANEL.md`.
- Offsite _storage setup_: the rclone remote is created by the owner (`rclone config`), the stack
  only ships to it.
- A real payments merchant account (G-12 covers the code path, the id is the owner's).

## 10. The drill this task was signed off on

The whole stack was brought up on a real Docker host (Docker 29.8) with the production compose
file, a real Postgres+PostGIS, and `TLS_MODE=internal` instead of a public domain — same Caddyfile,
same images, ports remapped to 8081/8443 because the host already owned 80/443.

| What | Command | Result |
| --- | --- | --- |
| the file is valid | `docker compose config -q` | exit 0 |
| the stack comes up | `up -d --build` | 9 services; `migrate` exited 0, the rest healthy |
| TLS + proxy | `curl -k https://benzin.local:8443/healthz` | `200` |
| site, panel | `/` and `/admin/` | `200`, `200` |
| http → https | `http://127.0.0.1:8081/` | `308` → `https://benzin.local/` |
| security headers | `curl -D -` | HSTS, `X-Content-Type-Options`, `Referrer-Policy` |
| monitor | `/status/` and `https://status.benzin.local/` | `301` → `200` |
| API through the edge | OTP request/verify → `/v1/me` | `202` → `200` → `200` |
| device registration (G-16) | `POST /v1/me/devices` in the deployed container | `200`, `pushRegistered: true` |
| nightly backup, run manually | `exec backup backup.sh once` | `benzin-20261121-234145.dump` (80K), verified with `pg_restore --list`, pruned at 14 days |
| restore drill | `exec postgres /drills/restore-test.sh` | **PASSED** — `users 2 · plans 4 · audit_logs 2 · migrations 14` |
| log rotation | `docker inspect` | every container: `json-file 20m x5` |
| restart policy | `docker inspect` | every container: `unless-stopped` |

Four defects were found *by running it*, not by reading it — they are the reason this was worth
doing before the server exists:

1. **`migrate` raced the database.** `pg_isready` answered on the unix socket during `initdb`, so
   the healthcheck went green while TCP still refused connections. Fixed with `-h 127.0.0.1` and a
   60-second `start_period`.
2. **A blank secret bricked the API.** `ZARINPAL_MERCHANT_ID=` in `.env.prod` is the *normal* state
   before the merchant account exists, and zod rejected the empty string — the container
   crash-looped. `apps/api/src/config.ts` now treats `''` as absent (`apps/api/test/g18-config.test.ts`).
3. **Kuma has no working base path.** It answered on `/` and 404'd on `/status/`, so the monitor
   moved to `status.<host>` and `/status/` became a redirect.
4. **The restore drill named a table that does not exist** (`audit_log`, it is `audit_logs`), so a
   restore would have "passed" its restore and failed its proof. `scripts/check-deploy.mjs` now
   cross-checks the table list.

Still owner-only: the VPS, the DNS A records (site + `status`), the ACME email, and an rclone
remote for offsite copies. Everything above is reproducible on the real box with
`infra/.env.prod` filled in — §2 is exactly that command sequence.
