# Echo sync service

A tiny self-hosted REST service that syncs Echo's **transcript history** and
**dictionary** across devices (desktop ⇄ Android). Stores everything in a single
SQLite file via `sql.js`, resolves conflicts last-write-wins, and authenticates with a
shared bearer token. Designed to run on your tailnet (e.g. the Mac Mini) — never expose
it to the public internet.

## Run it

From the project root on the host machine:

```sh
npm install
SYNC_TOKEN='<a-long-random-secret>' npm run sync-server
```

You should see:

```
[echo-sync] listening on http://0.0.0.0:8787  (db: .../sync-data/sync.sqlite)
```

Point your desktop Echo and the Android app at `http://<tailnet-host>:8787` with the
same `SYNC_TOKEN`.

### Configuration (environment variables)

| Var             | Default                              | Purpose                                        |
| --------------- | ------------------------------------ | ---------------------------------------------- |
| `SYNC_TOKEN`    | _(required)_                         | Shared bearer secret. The service won't start without it. |
| `SYNC_PORT`     | `8787`                               | Listen port.                                   |
| `SYNC_HOST`     | `0.0.0.0`                            | Bind address. Set to your **tailnet IP** to refuse non-tailnet traffic. |
| `SYNC_DB`       | `./sync-data/sync.sqlite`            | SQLite file path (created if missing).         |
| `SYNC_WASM_DIR` | `./node_modules/sql.js/dist`         | Where the `sql.js` `.wasm` lives.              |

## API

All routes require `Authorization: Bearer <SYNC_TOKEN>` except `/health`.

- `GET  /health` → `{ ok: true }`
- `GET  /sync/:collection?since=<cursor>&limit=<n>` → `{ records, cursor, hasMore }`
- `POST /sync/:collection` with `{ records: [...] }` → `{ applied }`

`:collection` is `transcripts` or `dictionary`. Clients advance their pull cursor only
from `GET` responses (a push returns a count, not a cursor).

## Keep it running (macOS launchd)

Create `~/Library/LaunchAgents/com.echo.sync.plist` (edit the paths and token):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>com.echo.sync</string>
    <key>WorkingDirectory</key><string>/Users/you/path/to/voiceapp</string>
    <!-- Run `which npm` and use that absolute path: Apple-Silicon Homebrew is
         /opt/homebrew/bin/npm, Intel is /usr/local/bin/npm, nvm differs again. -->
    <key>ProgramArguments</key>
    <array>
      <string>/opt/homebrew/bin/npm</string>
      <string>run</string>
      <string>sync-server</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
      <key>SYNC_TOKEN</key><string>REPLACE_WITH_LONG_RANDOM_SECRET</string>
      <key>SYNC_HOST</key><string>100.x.y.z</string>
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>StandardOutPath</key><string>/tmp/echo-sync.log</string>
    <key>StandardErrorPath</key><string>/tmp/echo-sync.err</string>
  </dict>
</plist>
```

Then:

```sh
launchctl load ~/Library/LaunchAgents/com.echo.sync.plist
launchctl start com.echo.sync
tail -f /tmp/echo-sync.log
```

> **Security:** keep `SYNC_TOKEN` out of git (use the launchd env or a shell profile, not a
> committed file), set `SYNC_HOST` to the tailnet IP, and rely on Tailscale for transport —
> the service has no TLS of its own.
