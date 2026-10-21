# A DIGITAL MONITORING SYSTEM FOR COMPUTERS AND OTHER INFORMATION TECHNOLOGY DEVICES AT MUKONO DISTRICT LOCAL GOVERNMENT

This project contains the API, web dashboard, Windows monitoring agent, optional desktop dashboard, PostgreSQL persistence (with SQLite available for local use) and automated tests.

## Architecture

- `DigitalMonitoringSystem.Api` — ASP.NET Core REST API, SignalR dashboard hub, PostgreSQL persistence and alert engine.
- `DigitalMonitoringSystem.Agent` — Windows monitoring agent. Sends CPU, memory and disk telemetry every 30 seconds.
- `mdm-frontend` — React/Vite administrator dashboard.
- `DigitalMonitoringSystem.Desktop` — optional WPF administrator dashboard.
- `DigitalMonitoringSystem.Tests` — unit tests.
- `DigitalMonitoringSystem.Shared` — shared contracts/models.

## Pending asset verification

The dashboard's **Pending verification** view presents 200 imported entries from
`mdm-frontend/src/data/sample-inventory.csv` as unverified candidates, separate from live monitored devices. The source
explicitly describes the rows as fictional test records and uses placeholder serial numbers and models marked “To verify.”
The review state is not evidence that an item exists or is district-owned. Confirm entries against an authorized asset
register, purchase documentation, and physical inspection before recording any as Mukono District Local Government
property. These entries have no hostnames, IP addresses, or agent telemetry.

## Run the system on one Windows computer

### 1. Install prerequisites

Install:

- .NET 10 SDK for the API/tests
- .NET 8 SDK for the Windows agent/desktop client
- Node.js 20 or newer
- PostgreSQL, running locally or reachable from the API server

### 2. Create the PostgreSQL database

Connect to PostgreSQL as an administrator (for example, with `psql -U postgres -h localhost -d postgres`) and create a dedicated application user and database:

```sql
CREATE ROLE mdm_app WITH LOGIN PASSWORD 'replace-with-a-strong-password';
CREATE DATABASE mdm_db OWNER mdm_app;
```

Keep the application password private. Do not put the connection string in `appsettings.json` or commit it to source control.

From the source-code folder, store the connection and API secrets with .NET user-secrets for local development:

```powershell
dotnet user-secrets set "ConnectionStrings:Mdm" "Host=localhost;Port=5432;Database=mdm_db;Username=mdm_app;Password=replace-with-a-strong-password" --project DigitalMonitoringSystem.Api
dotnet user-secrets set "Jwt:Key" "<a-random-secret-at-least-32-bytes-long>" --project DigitalMonitoringSystem.Api
dotnet user-secrets set "Admin:Username" "admin" --project DigitalMonitoringSystem.Api
dotnet user-secrets set "Admin:Password" "<a-strong-admin-password>" --project DigitalMonitoringSystem.Api
```

For deployments, supply these settings through a secret manager or environment variables instead. The environment variable names are `ConnectionStrings__Mdm`, `Jwt__Key`, `Admin__Username` and `Admin__Password`.

The API defaults to PostgreSQL. Set `Database__Provider=SQLite` to opt into the local `mdm.db` file instead.

### 3. Start the API

Open PowerShell in `DigitalMonitoringSystem.Api`:

```powershell
dotnet restore
dotnet run --launch-profile http
```

On its first start, the API creates the schema in the configured PostgreSQL database. The database itself must already exist. The API listens on port `5103` and is configured to bind to the local network (`0.0.0.0`).

The PostgreSQL API starts with an empty fleet; it does not copy existing records from `01-Ready-to-Run\data\mdm.db`. SQLite-to-PostgreSQL migration must be performed separately before switching if existing records need to be retained.

Health check:

```text
http://localhost:5103/health
```

Development administrator credentials are currently:

- Username: `admin`
- Password: `Admin@123`

Change these before real deployment.

### 4. Start the web dashboard

Open another terminal in `mdm-frontend`:

```powershell
npm install
npm run dev
```

Open the Vite address shown in the terminal, normally:

```text
http://localhost:5173
```

### 5. Enroll a Windows computer

1. Sign in to the dashboard.
2. Open **Enroll a device**.
3. Enter the computer hostname and IP address.
4. Click **Enroll device**.
5. Save the returned **Device ID** and **Enrollment Token**.

### 6. Configure the monitoring agent

Build it:

```powershell
cd ..\DigitalMonitoringSystem.Agent
dotnet publish -c Release -r win-x64 --self-contained true -o publish
```

Edit `publish\appsettings.json`:

```json
{
  "ApiBaseUrl": "http://SERVER-IP:5103",
  "DeviceId": "DEV-...",
  "DeviceToken": "...",
  "IntervalSeconds": 30
}
```

Run:

```powershell
.\publish\DigitalMonitoringSystem.Agent.exe
```

The computer will then send CPU, memory and disk metrics automatically.

## LAN/offline deployment

The application does not require cloud access for normal operation. Put the API server and monitored computers on the same local network.

For example, if the API computer has address `192.168.1.20`, configure an agent as:

```json
{
  "ApiBaseUrl": "http://192.168.1.20:5103",
  "DeviceId": "DEV-...",
  "DeviceToken": "...",
  "IntervalSeconds": 30
}
```

Allow TCP port `5103` through the Windows Firewall on the API computer.

The dashboard finds this API on its own origin: `mdm-frontend/vite.config.ts` proxies
`/api`, `/hub` and `/health` to `http://localhost:5103` during `npm run dev`, so no
environment file is required. Change the target with `VITE_DEV_API_TARGET` if the API runs
on a different address.

Only a built dashboard hosted somewhere other than this API needs an explicit address at
build time:

```text
VITE_API_BASE_URL=http://192.168.1.20:5103
```

If the frontend is served from another computer, add its exact origin to `Cors:AllowedOrigins` or the corresponding environment variable.

## Monitoring behaviour

- Heartbeat interval: 30 seconds by default.
- Device is considered offline after 15 minutes without a heartbeat.
- CPU, memory and disk samples are retained for 7 days by default.
- Background alert evaluation runs every 30 seconds.
- CPU, memory and disk rules support sustained-duration checks.
- Offline rules can raise an incident when a managed computer stops reporting.
- SignalR pushes dashboard changes to connected administrator clients.

## Device-token security

A device token can only submit telemetry for the device to which it was issued. The heartbeat API rejects attempts to use one device token against another device ID.

## Mobile pairing

The dashboard can create a short-lived mobile pairing code. The code is persisted in the configured database and expires after 10 minutes. A mobile client can exchange the code through:

```text
POST /api/mobile/pair/complete
```

with `pairingCode`, `ipAddress` and `location` and receive a device ID plus device token.

## Policy management

Policies can be assigned to managed devices and their assignment is recorded in the configured database. The API reports the assignment state and the administrator who applied it.

The current project models policy definitions and assignments; it does not pretend that a generic policy description automatically changes Windows Group Policy. Actual OS enforcement should be implemented per policy type (for example Windows Defender, firewall, update schedule or software deployment) before calling a policy fully enforced at the operating-system level.

## Tests

From the solution root:

```powershell
dotnet test DigitalMonitoringSystem.slnx
```

## Important production changes

Before deploying beyond a development workstation:

- Change `Admin:Password` and `Jwt:Key` using environment variables or user secrets.
- Restrict `Cors:AllowedOrigins` to trusted frontend origins.
- Prefer HTTPS with a trusted internal certificate if credentials will cross an untrusted network.
- Restrict PostgreSQL network access to the API server and protect database backups. If using SQLite instead, protect its database file and backups.
- Run the monitoring agent as a Windows service or scheduled startup task.
- A new API database starts with no devices, alerts, or policies. Enroll real authorized devices; the API does not insert demonstration computers into the live fleet.
