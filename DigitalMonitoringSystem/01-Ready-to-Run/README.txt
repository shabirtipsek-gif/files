A DIGITAL MONITORING SYSTEM FOR COMPUTERS AND OTHER INFORMATION TECHNOLOGY
DEVICES AT MUKONO DISTRICT LOCAL GOVERNMENT
==========================================================================

NOTHING TO INSTALL. Everything needed (including Node.js) is in this folder.

1. START THE SERVER (on the computer that will act as the server)
   - Extract the whole zip. Double-click  START-SYSTEM.bat
   - The dashboard opens in your browser at http://localhost:5103
   - Sign in:  admin / Admin@123   (change it in config.json, then restart)
   - Keep the black window open. Closing it stops monitoring.

2. LET OTHER COMPUTERS REACH THE SERVER (once)
   - Right-click ALLOW-NETWORK-ACCESS.bat > Run as administrator.
   - The server window shows the network address, e.g. http://192.168.1.20:5103

3. ADD (ENROLL) A NEW COMPUTER
   - Dashboard > "Enroll a device" > type hostname + IP address > Enroll device.
   - Click "Download appsettings.json".
   - Copy the  agent  folder (use DMS-Agent-for-Computers.zip for other PCs)
     to that computer and replace its appsettings.json with the downloaded file.
   - Double-click RUN-AGENT.bat. Within seconds the computer shows ONLINE with
     live CPU, memory and disk figures.
   - Optional: INSTALL-AUTOSTART.bat (as administrator) makes the agent start
     automatically whenever the computer starts.

WHAT YOU GET
   - Administrator login, device enrollment, removal, token re-issue
   - Live dashboard (updates instantly), CPU/memory/disk history per device
   - 200 demo-only inventory rows for dashboard demonstration; add real devices through enrollment
   - Pending verification review list with 200 imported entries (not verified or enrolled computers)
   - Automatic alerts: high CPU (5 min), high memory (5 min), disk > 90%,
     device stopped reporting (15 min). Alerts clear by themselves on recovery.
   - Alert acknowledgement, policy assignment, mobile pairing codes, CSV export
   - Data is stored in data\mdm.db (back this file up).

NOTES
   - Works fully offline on a local network (no internet needed).
   - Demo inventory rows are explicitly labeled DEMO, use documentation-only IP addresses, and have no
     agent tokens or heartbeat data. They are not real or live devices. A row becomes Online only after
     its enrolled agent sends a heartbeat. Additional real devices can be enrolled beyond the 200 demos.
   - The pending review list's source explicitly identifies all 200 rows as fictional test records and
     uses placeholder serial numbers/models. Pending review does not verify existence or district ownership.
     Check an authorized asset register, purchase records, and the physical devices before recording ownership.
     These entries are separate from live monitoring and are not enrolled computers.
   - Complete the parent-folder file 200-DEVICE-LIVE-MONITORING-TRACKER.csv with verified device
     details and recorded approval before enrolling any computer. Never put device tokens or passwords in it.
   - Policy "enforce" records the assignment; it does not change Windows
     settings by itself.
   - Re-issuing a device token disables the old token for that computer.

STORAGE: SQLite (default) or PostgreSQL
---------------------------------------
By default everything is stored in data\mdm.db next to this folder. Nothing to
install, and it keeps working with no internet connection.

To use PostgreSQL instead - for example so the district server and a copy of
this dashboard hosted on the internet share one set of devices - first create
a PostgreSQL role and database. Connect as a PostgreSQL administrator, for
example with `psql -U postgres -h localhost -d postgres`, then run:

  CREATE ROLE mdm_app WITH LOGIN PASSWORD 'replace-with-a-strong-password';
  CREATE DATABASE mdm_db OWNER mdm_app;

In PowerShell, open this folder and install the PostgreSQL driver once using
npm from Node.js 22.5 or newer:

  npm install

Set the connection and secrets in that same PowerShell window, then start the
server:

  $env:DATABASE_URL = "postgresql://mdm_app:replace-with-a-strong-password@localhost:5432/mdm_db"
  $env:JWT_SECRET = (& .\node\node.exe -e "console.log(require('crypto').randomBytes(48).toString('hex'))").Trim()
  $env:ADMIN_PASSWORD = "replace-with-a-strong-admin-password"
  .\START-SYSTEM.bat

Use `admin` and the `ADMIN_PASSWORD` value to sign in. If the database password
contains URL-reserved characters, URL-encode it in `DATABASE_URL`. Keep the
connection string and secrets private; do not put them in `config.json`.

These environment variables apply only to this PowerShell window. Set them
again when starting the server in a new window. PostgreSQL access must be
available from the computer running the server.

Without DATABASE_URL the server never touches npm and stays fully offline.

IMPORTANT: every server pointing at the same database must use the SAME
JWT_SECRET. Otherwise an administrator who signs in on one copy will be
rejected by the other. The server prints a warning at start-up if
DATABASE_URL is set without JWT_SECRET.

The database schema is created automatically the first time a PostgreSQL
server starts, and the 200 demo records are seeded then too. Because they are
inserted one row at a time, that first start can take a minute or two against a
remote database; later starts are immediate.

Do not put your connection string or JWT_SECRET in config.json if you share
this folder - use environment variables instead.
