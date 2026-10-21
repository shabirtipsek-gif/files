# A Digital Monitoring System for Computers and Other Information Technology Devices at Mukono District Local Government

Live monitoring, alerting and asset verification for district IT equipment — a REST API, a React
administrator dashboard, a Windows monitoring agent, and an optional WPF desktop client.

## Repository layout

```
DigitalMonitoringSystem/
├── 01-Ready-to-Run/          Complete, self-contained system with a bundled Node.js runtime.
│   │                          Double-click START-SYSTEM.bat — nothing to install.
│   ├── server/server.js       Node.js API server, live event stream, SQLite or PostgreSQL storage.
│   ├── public/                Built React dashboard served by the API.
│   ├── agent/                 Monitoring agent copied onto each monitored computer.
│   ├── data/mdm.db            SQLite database (auto-created and re-seeded on first start).
│   ├── node/node.exe          Bundled runtime so target PCs need nothing installed.
│   └── package.json           Only needed for the PostgreSQL option: run `npm install`.
│
├── 02-Source-Code/            Full source for development.
│   ├── DigitalMonitoringSystem.Api/      ASP.NET Core REST API, SignalR hub, alert engine.
│   ├── DigitalMonitoringSystem.Agent/    Windows agent — CPU / memory / disk every 30 s.
│   ├── DigitalMonitoringSystem.Desktop/  Optional WPF administrator dashboard.
│   ├── DigitalMonitoringSystem.Shared/   Shared contracts and models.
│   ├── DigitalMonitoringSystem.Tests/    Unit tests (xUnit).
│   └── mdm-frontend/                     React + Vite + TypeScript dashboard.
│
└── 03-Agent-for-Computers/    Standalone folder to copy onto any computer you want to monitor.
```

## Quick start (no installation)

1. Open `DigitalMonitoringSystem/` and double-click `START-SYSTEM.bat`.
2. The dashboard opens at <http://localhost:5103> — sign in with `admin` / `Admin@123`
   (change this in `01-Ready-to-Run/config.json`, then restart).
3. To monitor other computers, run `ALLOW-NETWORK-ACCESS.bat` as administrator once, then copy
   `03-Agent-for-Computers/` to each target PC and run `RUN-AGENT.bat`.

Full rollout instructions, including network setup and device enrollment, are in
`DigitalMonitoringSystem/01-Ready-to-Run/README.txt`.

## Developing from source

Prerequisites: .NET 10 SDK (API and tests), .NET 8 SDK (agent and desktop client), Node.js 20+.

```powershell
# API — listens on http://localhost:5103
cd DigitalMonitoringSystem/02-Source-Code/DigitalMonitoringSystem.Api
dotnet restore
dotnet run --launch-profile http

# Dashboard — separate terminal
cd DigitalMonitoringSystem/02-Source-Code/mdm-frontend
npm install
npm run dev

# Tests
cd DigitalMonitoringSystem/02-Source-Code
dotnet test
```

The dashboard connects to the API on its own origin, and `vite.config.ts` proxies the
development server's `/api`, `/hub` and `/health` to `http://localhost:5103`, so no `.env`
file is needed. See *Running offline and online* below for the exceptions.

## Running offline and online

The dashboard decides where its API lives in `mdm-frontend/src/lib/api.ts`:

- **Same origin by default.** The ready-to-run server serves the dashboard and the API
  together on one port, so requests stay relative and reach whichever computer served the
  page. No configuration is needed, and it works on the server itself and on every other
  computer on the network.
- **An absolute URL when `VITE_API_BASE_URL` is set**, for a copy of the dashboard hosted
  away from its API. Vite inlines this at build time, so it must be present when
  `npm run build` runs.

### Offline / local network — the default

Nothing to configure. Start the server, run `ALLOW-NETWORK-ACCESS.bat` once as
administrator, and open `http://<server-ip>:5103` from any computer on the network. Agents
enrolled against that address keep working as before.

`npm run dev` is the only case that would normally need a `.env` file, because Vite serves on
a different port than the API. `vite.config.ts` proxies `/api`, `/hub` and `/health` to
`http://localhost:5103` instead, so a fresh clone builds and runs with no environment file at
all. Point the proxy elsewhere with `VITE_DEV_API_TARGET` if your API is not on the default
port.

### Choosing where data is stored

`01-Ready-to-Run/server/server.js` supports two storage engines behind one query interface:

| `DATABASE_URL` | Engine | Needs |
| --- | --- | --- |
| unset | SQLite at `01-Ready-to-Run/data/mdm.db` | Nothing. The package stays dependency-free and works with no internet. |
| set | PostgreSQL | `npm install` once in `01-Ready-to-Run`, plus a reachable server. |

The same code runs on both, so a deployment can be moved between them without changing routes
or the dashboard. With PostgreSQL, several servers — the district server and any hosted copy —
can share one database.

When sharing, set **`JWT_SECRET` to the same long random value on every server**. Tokens are
signed with it, so mismatched secrets mean an administrator who signs in on one copy is
rejected by the other. The server prints a warning at start-up if `DATABASE_URL` is set
without `JWT_SECRET`.

The schema is created automatically on first start, along with the 200 demo records. Against a
remote database that first start takes a minute or two; later starts are immediate.

### Online — dashboard hosted away from its API

Vercel (or any static host) can serve the built dashboard, but it cannot run the API. To put
the dashboard online while the API runs elsewhere:

1. Deploy `01-Ready-to-Run` to a long-running Node host (Railway, Render, Fly.io and similar
   all work — it needs no build step). Set `DATABASE_URL`, `JWT_SECRET`, `ADMIN_USERNAME` and
   `ADMIN_PASSWORD`, then run `npm install` and `npm start`.
2. Give it HTTPS, so browsers on the internet can reach it.
3. In the Vercel project for `mdm-frontend`, set **Root Directory** to
   `DigitalMonitoringSystem/02-Source-Code/mdm-frontend`.
4. Add `VITE_API_BASE_URL=https://your-api-address` under *Environment Variables*, then
   redeploy so the build picks it up.

If the district server also runs, point it at the same `DATABASE_URL` and `JWT_SECRET` so both
show the same devices, or leave `DATABASE_URL` unset there to keep a self-contained offline
copy.

If the dashboard is deployed without `VITE_API_BASE_URL`, the sign-in screen says so
explicitly rather than failing silently. Devices enrolled through the online dashboard still
receive the API's own network address in their `appsettings.json`, so agents report straight to
the server and do not depend on the hosted dashboard.

## Data and privacy

- The dashboard ships with 200 clearly labelled **demo-only** inventory rows plus 200 fictional
  pending-verification candidates. They use documentation-only IP addresses, carry no agent
  tokens or heartbeat data, and do not represent real devices.
- A device shows as **Online** only after an enrolled agent sends a real heartbeat.
- Record verified asset details and approvals in
  `DigitalMonitoringSystem/200-DEVICE-LIVE-MONITORING-TRACKER.csv`. Never put device tokens or
  passwords in that file.
- See `DigitalMonitoringSystem/LIVE-MONITORING-ROLLOUT-REQUIREMENTS.md` for the full preparation
  and rollout checklist.

## Contributors

**Collaborators:** Semakula · Kalungi Isaac

## License

Released under the GNU General Public License v3.0 — see [LICENSE](LICENSE).
