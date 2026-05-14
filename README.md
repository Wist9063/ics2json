# ics2json

A tiny Node.js sidecar that turns one or more **ICS / iCalendar** feeds into a single JSON endpoint of upcoming events.

I built this for embedding into dashboards like [Glance](https://github.com/glanceapp/glance) without exposing the (secret) ICS feed URLs to the dashboard renderer or the host network.

- **Drop-a-file workflow**: Add a calendar by writing one YAML file into `feeds/`. The watcher hot-reloads; no restart.
- **No OAuth, no Google client setup**: Works with any provider's "secret iCal address" (Google, Apple, Outlook, Fastmail, Proton, Nextcloud, …).
- **Recurring events expanded**: RRULE / EXDATE / per-occurrence overrides honored via `node-ical`.
- **Security-first**: Feed URLs never leave the process, container is non-root + read-only FS + caps-dropped, no host port published.

## Quick start

Prebuilt images are published to GHCR for `linux/amd64` and `linux/arm64`:

```bash
mkdir -p ./ics2json/feeds   # drop your *.yml feeds here (see below)
docker compose up -d
curl http://127.0.0.1:8000/events.json
```

The included [`docker-compose.yml`](./docker-compose.yml) pulls `ghcr.io/wist9063/ics2json:latest` and binds port 8000 to loopback only.

### Embedding alongside a dashboard

When running on the same compose network as e.g. Glance, drop the `ports:` block. The dashboard reaches the sidecar over the internal network and no host port is exposed:

```yaml
services:
  ics2json:
    image: ghcr.io/wist9063/ics2json:latest
    container_name: ics2json
    restart: unless-stopped
    read_only: true
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
    mem_limit: 128m
    pids_limit: 64
    volumes:
      - ./ics2json/feeds:/app/feeds:ro
    # No `ports:`: only your dashboard reaches it
```

> Building from source instead? Swap `image:` for `build: .` and run `docker compose up -d --build`.

## Adding a calendar

Drop a YAML file into `feeds/`:

```yaml
# feeds/personal.yml
url: https://calendar.google.com/calendar/ical/.../basic.ics
color: "#fbbc04"        # optional — defaults to a stable hash of the name
# name: "Personal"      # optional — defaults to the filename (sans extension)
```

- The filename (without `.yml`) becomes the display name unless `name:` is set.
- `url` must be HTTPS.
- `color` must match `^#[0-9a-fA-F]{6}$`; anything else is ignored.

Save the file → the sidecar picks it up within ~1 second. Delete the file → its events disappear on the next request. No restart.

> **Where to find a "private ICS URL":**
>
> - Google Calendar → Settings & sharing → "Secret address in iCal format"
> - Apple iCloud → Calendar → share with public link → copy URL (rewrite `webcal://` → `https://`)
> - Outlook / Microsoft 365 → Calendar → "Publish a calendar"
> - Most self-hosted CalDAV servers expose an ICS export per calendar.

## API

### `GET /events.json`

Example response:

```json
{
  "events": [
    {
      "summary": "TIM 175 - Lecture",
      "start": "2026-05-14T20:30:00.000Z",
      "end":   "2026-05-14T22:05:00.000Z",
      "all_day": false,
      "location": "Kresge Acad 3201",
      "calendar": "class",
      "color": "#E3683E",
      "relative_label": "in 1d 20m"
    }
  ],
  "errors": [
    { "name": "work", "message": "ETIMEDOUT" }
  ]
}
```

- Events are sorted ascending by start time, capped at 50.
- Window is now → +30 days. Already-started events are filtered out.
- `relative_label` omits zero leading units, so a far-out event without a leftover-hour reads `in 5d 17m`, and an event under an hour out collapses to just `in 17m`.
- Per-feed errors surface in `errors[]` as `{ name, message }` only — **never** the URL.

### `GET /healthz`

For docker's healthcheck. Returns 200 if the server is up and the config dir is readable, 500 otherwise.

```json
{ "ok": true, "feeds": 2 }
```

## Glance widget snippet

```yaml
- type: custom-api
  title: Upcoming Events
  cache: 10m
  url: http://ics2json:8000/events.json
  template: |
    {{ if eq (len (.JSON.Array "events")) 0 }}
      <p class="color-subdue">No upcoming events</p>
    {{ else }}
      <ul class="list list-gap-10 collapsible-container" data-collapse-after="5">
        {{ range .JSON.Array "events" }}
          <li>
            <div class="flex justify-between items-start gap-10">
              <div style="min-width: 0;">
                <div class="size-h4 text-truncate">{{ .String "summary" }}</div>
                {{ if ne (.String "location") "" }}
                  <div class="size-h6 color-subdue text-truncate">at {{ .String "location" }}</div>
                {{ end }}
                <div class="size-h5 color-subdue">{{ .String "relative_label" }}</div>
              </div>
              <div class="size-h6" style="color: {{ .String "color" }};">{{ .String "calendar" }}</div>
            </div>
          </li>
        {{ end }}
      </ul>
    {{ end }}
```

## Security model

ICS feed URLs are bearer secrets. So, anyone with the URL can read your calendar.

The design treats them as such:

1. **URLs never leave the trust boundary.** Stored only in `feeds/*.yml`, mounted **read-only** into the container. The HTTP API never echoes the URL.
2. **No SSRF surface.** The sidecar refuses to fetch a URL given over HTTP, feeds come only from disk.
3. **Sidecar is unreachable from the host.** No `ports:` published. Only the internal compose network reaches port 8000.
4. **Container hardening.** Non-root user, read-only root FS, `cap_drop: [ALL]`, `no-new-privileges`, memory/PID caps.
5. **TLS verification stays on.** Only `https://` URLs accepted; per-fetch 10s timeout.
6. **Output safe for HTML embedding.** Glance's `html/template` auto-escapes string fields; the only raw value (`color`) is server-side validated against `^#[0-9a-fA-F]{6}$`.
7. **Pinned dependencies, zero advisories** at the time of the lockfile (`npm audit --omit=dev` clean).

## Tunables (env vars)

| Env var | Default | What it does |
|---|---|---|
| `PORT` | `8000` | HTTP listen port |
| `FEEDS_DIR` | `/app/feeds` | Where to read `*.yml` feed configs from |
| `WINDOW_DAYS` | `30` | How far ahead to include events |
| `CACHE_TTL_MINUTES` | `10` | Per-feed parsed-events cache lifetime |
| `FETCH_TIMEOUT_SECONDS` | `10` | Per-feed network timeout |
| `MAX_EVENTS` | `50` | Cap on events returned |

Set them via `environment:` in compose, or `-e KEY=VAL` with `docker run`. Invalid values fall back to the default and log a warning at startup.

## Limitations

- All-day events use the local-date convention from the source feed. Multi-day all-days work but timezone-only-defined events may render in UTC.
- `node-ical` covers most RRULE patterns but exotic ones (e.g. `BYSETPOS` combined with `BYWEEKNO`) may differ from Google's expansion.
