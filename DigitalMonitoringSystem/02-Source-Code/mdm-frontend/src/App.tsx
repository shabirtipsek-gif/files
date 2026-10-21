import { HubConnectionBuilder, LogLevel } from '@microsoft/signalr'
import { useEffect, useMemo, useState } from 'react'
import './App.css'
import { sampleInventory, sampleInventoryCsv } from './lib/sampleInventory'
import {
  acknowledgeAlert,
  API_BASE_URL,
  API_DISPLAY_URL,
  ApiError,
  enrollDevice,
  enforcePolicy,
  issueDeviceToken,
  removeDevice,
  fetchDashboard,
  fetchSystemHealth,
  fetchDeviceMetrics,
  type DeviceMetricWindow,
  login,
  pairMobileDevice,
  type AuthenticationResult,
  type DashboardSummary,
  type DeviceEnrollmentRequest,
  type DeviceEnrollmentResponse,
  type MobilePairingResponse,
  type SystemHealthSnapshot,
} from './lib/api'

const defaultDashboard: DashboardSummary = {
  totalDevices: 0,
  onlineDevices: 0,
  openAlerts: 0,
  criticalAlerts: 0,
  avgCpu: 0,
  avgMemory: 0,
  devices: [],
  alerts: [],
  policies: [],
}

const AUTH_STORAGE_KEY = 'mdm-session'

const blankEnrollment: DeviceEnrollmentRequest = {
  hostname: '',
  ipAddress: '',
  vendor: '',
  platform: 'Windows 11',
  location: '',
}

function App() {
  const [dashboard, setDashboard] = useState<DashboardSummary>(defaultDashboard)
  const [systemHealth, setSystemHealth] = useState<SystemHealthSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [auth, setAuth] = useState<AuthenticationResult | null>(() => {
    const storedSession = window.localStorage.getItem(AUTH_STORAGE_KEY)
    if (!storedSession) {
      return null
    }

    try {
      return JSON.parse(storedSession) as AuthenticationResult
    } catch {
      return null
    }
  })
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [authError, setAuthError] = useState<string | null>(null)
  const [actionMessage, setActionMessage] = useState<string | null>(null)
  const [pairing, setPairing] = useState<MobilePairingResponse | null>(null)
  const [mobileDeviceName, setMobileDeviceName] = useState('Supervisor Tablet')
  const [mobilePlatform, setMobilePlatform] = useState('Android')
  const [enrollment, setEnrollment] = useState<DeviceEnrollmentRequest>(blankEnrollment)
  const [lastEnrollment, setLastEnrollment] = useState<(DeviceEnrollmentResponse & { hostname: string }) | null>(null)
  const [loggingIn, setLoggingIn] = useState(false)
  const [enrolling, setEnrolling] = useState(false)
  const [deviceQuery, setDeviceQuery] = useState('')
  const [inventoryQuery, setInventoryQuery] = useState('')
  const [alertFilter, setAlertFilter] = useState<'All' | 'High' | 'Medium' | 'Info'>('All')
  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(null)
  const [selectedAlertId, setSelectedAlertId] = useState<string | null>(null)
  const [selectedMetrics, setSelectedMetrics] = useState<DeviceMetricWindow | null>(null)
  const [activeNav, setActiveNav] = useState('dashboard')

  useEffect(() => {
    let active = true

    if (!auth?.token) {
      setDashboard(defaultDashboard)
      setSystemHealth(null)
      setLoading(false)
      return
    }

    const loadDashboard = async () => {
      try {
        const [dashboardPayload, healthPayload] = await Promise.all([
          fetchDashboard(auth.token),
          fetchSystemHealth(auth.token),
        ])

        if (active) {
          setDashboard(dashboardPayload)
          setSystemHealth(healthPayload)
          setError(null)
        }
      } catch (loadError) {
        if (active) {
          if (loadError instanceof ApiError && loadError.status === 401) {
            setAuth(null)
            setAuthError(loadError.message)
          } else {
            setError(loadError instanceof Error ? loadError.message : 'Unable to load dashboard data.')
          }
        }
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    loadDashboard()
    const intervalId = window.setInterval(loadDashboard, 15000)

    return () => {
      active = false
      window.clearInterval(intervalId)
    }
  }, [auth?.token])

  useEffect(() => {
    if (!auth?.token) {
      return
    }

    const connection = new HubConnectionBuilder()
      .withUrl(`${API_BASE_URL}/hub/dashboard`, {
        accessTokenFactory: () => auth.token,
      })
      .withAutomaticReconnect()
      .configureLogging(LogLevel.Warning)
      .build()

    connection.on('ReceiveDashboard', (payload: DashboardSummary) => {
      setDashboard(payload)
      setError(null)
      setLoading(false)
    })

    void connection.start().catch(() => {
      setError('Live dashboard updates are unavailable. Falling back to polling.')
    })

    return () => {
      void connection.stop()
    }
  }, [auth?.token])

  useEffect(() => {
    if (auth) {
      window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(auth))
    } else {
      window.localStorage.removeItem(AUTH_STORAGE_KEY)
    }
  }, [auth])

  const reportFailure = (failure: unknown, fallback: string) => {
    if (failure instanceof ApiError && failure.status === 401) {
      setAuth(null)
      setAuthError(failure.message)
      return
    }
    setActionMessage(null)
    setError(failure instanceof Error ? failure.message : fallback)
  }

  const handleLogin = async () => {
    if (!username.trim() || !password) {
      setAuthError('Enter the administrator username and password.')
      return
    }

    try {
      setAuthError(null)
      setLoggingIn(true)
      const nextAuth = await login(username.trim(), password)
      setAuth(nextAuth)
      setPassword('')
      setError(null)
      setLoading(true)
      setActionMessage(`Signed in as ${nextAuth.username} (${nextAuth.role})`)
    } catch (loginError) {
      setAuthError(loginError instanceof Error ? loginError.message : 'Unable to sign in.')
      setAuth(null)
    } finally {
      setLoggingIn(false)
    }
  }

  const handleSignOut = () => {
    setAuth(null)
    setDashboard(defaultDashboard)
    setSystemHealth(null)
    setPairing(null)
    setLastEnrollment(null)
    setError(null)
    setAuthError(null)
    setActionMessage(null)
  }

  const handleExportDeviceReport = () => {
    const rows = [
      ['Hostname', 'IP address', 'Status', 'CPU %', 'Memory %', 'Location'],
      ...dashboard.devices.map((device) => [
        device.hostname,
        device.ipAddress,
        device.status,
        String(device.cpu),
        String(device.memory),
        device.location,
      ]),
    ]
    const csv = rows
      .map((row) => row.map((value) => `"${value.replaceAll('"', '""')}"`).join(','))
      .join('\r\n')
    const downloadUrl = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = `mdm-device-report-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(downloadUrl)
  }

  const handleDownloadPendingInventory = () => {
    const downloadUrl = URL.createObjectURL(new Blob([sampleInventoryCsv], { type: 'text/csv;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = downloadUrl
    link.download = 'unverified-asset-candidate-list.csv'
    link.click()
    URL.revokeObjectURL(downloadUrl)
  }

  const handleEnforcePolicy = async (deviceId: string, policyId: string) => {
    if (!auth?.token) {
      setActionMessage('Sign in with the administrator account to enforce a policy.')
      return
    }
    if (dashboard.devices.find((device) => device.id === deviceId)?.status.toLowerCase() === 'demo only') {
      setActionMessage('Demo-only inventory records cannot receive policies.')
      return
    }

    try {
      setActionMessage(null)
      const result = await enforcePolicy(deviceId, policyId, auth.token)
      setActionMessage(`Policy ${result.policyId} enforced for ${result.deviceId}. Status: ${result.status}`)
      const refreshed = await fetchDashboard(auth.token)
      setDashboard(refreshed)
    } catch (policyError) {
      reportFailure(policyError, 'Unable to enforce policy.')
    }
  }

  const handleEnrollDevice = async () => {
    if (!auth?.token) {
      setActionMessage('Sign in as administrator before enrolling a device.')
      return
    }

    const hostname = enrollment.hostname.trim()
    const ipAddress = enrollment.ipAddress.trim()
    if (!hostname || !ipAddress) {
      setError('Hostname and IP address are required to enroll a device.')
      return
    }

    const looksLikeIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(ipAddress) || ipAddress.includes(':')
    if (!looksLikeIp) {
      setError('Enter a valid IP address, for example 192.168.1.45.')
      return
    }

    try {
      setError(null)
      setActionMessage(null)
      setEnrolling(true)
      const created = await enrollDevice({ ...enrollment, hostname, ipAddress }, auth.token)
      setEnrollment(blankEnrollment)
      setLastEnrollment(created)
      setActionMessage(
        created.reEnrolled
          ? `${created.hostname} was already enrolled. Its details were updated and a new token was issued.`
          : `Device ${created.hostname} enrolled. Copy the agent settings below onto that computer.`,
      )
      setDashboard(await fetchDashboard(auth.token))
    } catch (enrollmentError) {
      reportFailure(enrollmentError, 'Enrollment failed.')
    } finally {
      setEnrolling(false)
    }
  }

  const handleRemoveDevice = async (deviceId: string, hostname: string) => {
    if (!auth?.token) return
    if (!window.confirm(`Remove ${hostname} from the fleet? Its metrics and policy assignments will be deleted.`)) return

    try {
      setError(null)
      await removeDevice(deviceId, auth.token)
      setActionMessage(`${hostname} was removed from the fleet.`)
      if (lastEnrollment?.id === deviceId) setLastEnrollment(null)
      setDashboard(await fetchDashboard(auth.token))
    } catch (removeError) {
      reportFailure(removeError, 'Unable to remove the device.')
    }
  }

  const handleReissueToken = async (deviceId: string, hostname: string) => {
    if (!auth?.token) return
    if (dashboard.devices.find((device) => device.id === deviceId)?.status.toLowerCase() === 'demo only') {
      setActionMessage('Demo-only inventory records cannot receive monitoring tokens.')
      return
    }
    try {
      setError(null)
      const result = await issueDeviceToken(deviceId, auth.token)
      setLastEnrollment({
        id: result.deviceId,
        hostname,
        status: 'Managed',
        isManaged: true,
        policyState: 'Pending',
        enrollmentToken: result.enrollmentToken,
        apiBaseUrl: result.apiBaseUrl,
        reEnrolled: true,
      })
      setActionMessage(`A new agent token was issued for ${hostname}. Update that computer's agent settings.`)
    } catch (tokenError) {
      reportFailure(tokenError, 'Unable to issue a token.')
    }
  }

  const agentConfig = lastEnrollment
    ? JSON.stringify(
        {
          // The agent runs on another computer, so it needs an absolute address it can
          // reach. The server supplies the LAN address; the page origin is the fallback.
          ApiBaseUrl: lastEnrollment.apiBaseUrl || API_DISPLAY_URL,
          DeviceId: lastEnrollment.id,
          DeviceToken: lastEnrollment.enrollmentToken,
          IntervalSeconds: 30,
        },
        null,
        2,
      )
    : ''

  const copyAgentConfig = async () => {
    try {
      await navigator.clipboard.writeText(agentConfig)
      setActionMessage('Agent settings copied to the clipboard.')
    } catch {
      setError('Copy failed. Select the settings text and copy it manually.')
    }
  }

  const downloadAgentConfig = () => {
    const url = URL.createObjectURL(new Blob([agentConfig], { type: 'application/json' }))
    const link = document.createElement('a')
    link.href = url
    link.download = 'appsettings.json'
    link.click()
    URL.revokeObjectURL(url)
  }

  const handlePairMobileDevice = async () => {
    if (!auth?.token) {
      setActionMessage('Sign in as administrator before creating a mobile pairing code.')
      return
    }

    try {
      setActionMessage(null)
      const result = await pairMobileDevice(mobileDeviceName, mobilePlatform, auth.token)
      setPairing(result)
      setActionMessage(`Mobile pairing code ${result.pairingCode} created for ${result.host}:${result.port}.`)
    } catch (pairingError) {
      reportFailure(pairingError, 'Unable to create pairing code.')
    }
  }

  const handleAcknowledgeAlert = async (alertId: string) => {
    if (!auth?.token) {
      setActionMessage('Sign in as administrator before acknowledging an alert.')
      return
    }

    try {
      setActionMessage(null)
      const result = await acknowledgeAlert(alertId, auth.token)
      setActionMessage(`Alert ${result.alertId} marked as ${result.status}.`)
      const refreshed = await fetchDashboard(auth.token)
      setDashboard(refreshed)
    } catch (alertError) {
      reportFailure(alertError, 'Unable to acknowledge alert.')
    }
  }

  const filteredDevices = useMemo(() => {
    const normalized = deviceQuery.trim().toLowerCase()
    return dashboard.devices.filter((device) => {
      if (!normalized) {
        return true
      }

      return [device.hostname, device.ipAddress, device.status, device.location]
        .join(' ')
        .toLowerCase()
        .includes(normalized)
    })
  }, [dashboard.devices, deviceQuery])

  const filteredInventory = useMemo(() => {
    const normalized = inventoryQuery.trim().toLowerCase()
    if (!normalized) {
      return sampleInventory
    }

    return sampleInventory.filter((asset) =>
      Object.values(asset).some((value) => value.toLowerCase().includes(normalized)),
    )
  }, [inventoryQuery])

  const filteredAlerts = useMemo(() => {
    return dashboard.alerts.filter((alert) => {
      if (alertFilter === 'All') {
        return true
      }

      return alert.severity.toLowerCase() === alertFilter.toLowerCase()
    })
  }, [alertFilter, dashboard.alerts])

  useEffect(() => {
    if (!dashboard.devices.length) {
      setSelectedDeviceId(null)
      return
    }

    if (!selectedDeviceId || !dashboard.devices.some((device) => device.id === selectedDeviceId)) {
      setSelectedDeviceId(dashboard.devices[0].id)
    }
  }, [dashboard.devices, selectedDeviceId])

  useEffect(() => {
    if (!dashboard.alerts.length) {
      setSelectedAlertId(null)
      return
    }

    if (!selectedAlertId || !dashboard.alerts.some((alert) => alert.id === selectedAlertId)) {
      setSelectedAlertId(dashboard.alerts[0].id)
    }
  }, [dashboard.alerts, selectedAlertId])

  const selectedDevice = useMemo(
    () => dashboard.devices.find((device) => device.id === selectedDeviceId) ?? dashboard.devices[0] ?? null,
    [dashboard.devices, selectedDeviceId],
  )

  const selectedAlert = useMemo(
    () => dashboard.alerts.find((alert) => alert.id === selectedAlertId) ?? dashboard.alerts[0] ?? null,
    [dashboard.alerts, selectedAlertId],
  )

  useEffect(() => {
    if (!auth?.token || !selectedDevice) {
      setSelectedMetrics(null)
      return
    }

    let active = true
    void fetchDeviceMetrics(selectedDevice.id, auth.token, 60)
      .then((metrics) => {
        if (active) setSelectedMetrics(metrics)
      })
      .catch(() => {
        if (active) setSelectedMetrics(null)
      })

    return () => { active = false }
  }, [auth?.token, selectedDevice?.id])


  const stats = useMemo(
    () => [
      { label: 'Inventory records', value: dashboard.totalDevices, tone: 'neutral' },
      { label: 'Reporting live', value: dashboard.onlineDevices, tone: 'success' },
      { label: 'Open Alerts', value: dashboard.openAlerts, tone: 'warning' },
      { label: 'Critical Alerts', value: dashboard.criticalAlerts, tone: 'danger' },
      { label: 'Policies', value: dashboard.policies.length, tone: 'neutral' },
    ],
    [dashboard],
  )

  const fleetSummary = useMemo(() => {
    const demoDevices = dashboard.devices.filter((device) => device.status.toLowerCase() === 'demo only')
    const realDevices = dashboard.devices.filter((device) => device.status.toLowerCase() !== 'demo only')
    const reportingDevices = realDevices.filter((device) => device.status.toLowerCase() === 'online').length
    const locationCounts = realDevices.reduce<Record<string, number>>((accumulator, device) => {
      const location = device.location || 'Unassigned'
      accumulator[location] = (accumulator[location] ?? 0) + 1
      return accumulator
    }, {})
    const busiestLocation = Object.entries(locationCounts).sort((left, right) => right[1] - left[1])[0]

    return [
      { label: 'Reporting live', value: `${reportingDevices}/${realDevices.length}`, tone: reportingDevices ? 'success' : 'neutral' },
      { label: 'Demo-only records', value: String(demoDevices.length), tone: 'warning' },
      { label: 'Not reporting', value: String(realDevices.length - reportingDevices), tone: 'neutral' },
      { label: 'Busiest site', value: busiestLocation ? `${busiestLocation[0]} (${busiestLocation[1]})` : 'None', tone: 'info' },
    ]
  }, [dashboard.devices])

  const operationsQueue = useMemo(
    () => [...dashboard.policies]
      .sort((left, right) => (left.updatedAt > right.updatedAt ? -1 : 1))
      .slice(0, 4)
      .map((policy) => ({
        id: policy.id,
        name: policy.name,
        status: policy.status,
        scope: policy.scope,
        updatedAt: policy.updatedAt,
      })),
    [dashboard.policies],
  )

  const navigateTo = (section: string) => {
    setActiveNav(section)
    document.getElementById(section)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  if (!auth) {
    return (
      <div className="login-screen">
        <form
          className="login-card"
          onSubmit={(event) => {
            event.preventDefault()
            void handleLogin()
          }}
        >
          <div className="brand">MDM</div>
          <h1>A DIGITAL MONITORING SYSTEM FOR COMPUTERS AND OTHER INFORMATION TECHNOLOGY DEVICES AT MUKONO DISTRICT LOCAL GOVERNMENT</h1>
          <p className="muted">Administrator sign-in</p>
          {authError && <div className="alert-banner">{authError}</div>}
          <input
            type="text"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            placeholder="Username"
            autoComplete="username"
            autoFocus
          />
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Password"
            autoComplete="current-password"
          />
          <button className="primary-btn" type="submit" disabled={loggingIn}>
            {loggingIn ? 'Signing in…' : 'Sign in'}
          </button>
          <small className="muted">API: {API_DISPLAY_URL}</small>
          {!API_BASE_URL && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1' && (
            <small className="muted">
              This copy is being served from a different computer than its API. Set{' '}
              <code>VITE_API_BASE_URL</code> when building so it knows where to connect.
            </small>
          )}
        </form>
      </div>
    )
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">MDM</div>
        <nav>
          <button className={`nav-item ${activeNav === 'dashboard' ? 'active' : ''}`} onClick={() => navigateTo('dashboard')}>Dashboard</button>
          <button className={`nav-item ${activeNav === 'devices' ? 'active' : ''}`} onClick={() => navigateTo('devices')}>Devices</button>
          <button className={`nav-item ${activeNav === 'inventory' ? 'active' : ''}`} onClick={() => navigateTo('inventory')}>Pending verification</button>
          <button className={`nav-item ${activeNav === 'alerts' ? 'active' : ''}`} onClick={() => navigateTo('alerts')}>Alerts</button>
          <button className={`nav-item ${activeNav === 'reports' ? 'active' : ''}`} onClick={() => navigateTo('reports')}>Reports</button>
          <button className={`nav-item ${activeNav === 'settings' ? 'active' : ''}`} onClick={() => navigateTo('settings')}>Settings</button>
        </nav>

        <div className="auth-panel" id="settings">
          <div className="auth-header">Admin access</div>
          <div className="auth-user">{auth.username}</div>
          <div className="auth-role">{auth.role}</div>
          <button className="secondary-btn" onClick={handleSignOut}>Sign out</button>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar" id="dashboard">
          <div>
            <p className="eyebrow">Operations overview</p>
            <h1>A DIGITAL MONITORING SYSTEM FOR COMPUTERS AND OTHER INFORMATION TECHNOLOGY DEVICES AT MUKONO DISTRICT LOCAL GOVERNMENT</h1>
          </div>
          <button className="primary-btn" onClick={handlePairMobileDevice} disabled={!auth}>Pair mobile device</button>
        </header>

        {error && <div className="alert-banner">{error}</div>}
        {authError && <div className="alert-banner">{authError}</div>}
        {actionMessage && <div className="success-banner">{actionMessage}</div>}
        {dashboard.devices.some((device) => device.status.toLowerCase() === 'demo only') && (
          <div className="demo-banner">
            Demo inventory is for demonstration only. These records are not real district assets and do not report live data.
            Enroll authorized computers and install their agents to see real monitoring.
          </div>
        )}

        <section className="system-health-panel panel">
          <div className="panel-header">
            <h2>System health</h2>
            <span className={`health-status ${systemHealth?.status?.toLowerCase() ?? 'unknown'}`}>
              {systemHealth?.status ?? 'Checking'}
            </span>
          </div>
          <div className="health-grid">
            <div>
              <label>Service</label>
              <strong>{systemHealth?.serviceName ?? 'DigitalMonitoringSystem.Api'}</strong>
            </div>
            <div>
              <label>Last sync</label>
              <strong>
                {systemHealth ? new Date(systemHealth.lastSyncUtc).toLocaleString() : 'Waiting for sync'}
              </strong>
            </div>
            <div>
              <label>Open alerts</label>
              <strong>{dashboard.openAlerts}</strong>
            </div>
            <div>
              <label>Online devices</label>
              <strong>{dashboard.onlineDevices}/{dashboard.totalDevices}</strong>
            </div>
          </div>
        </section>

        <section className="stats-grid">
          {stats.map((stat) => (
            <article key={stat.label} className={`stat-card ${stat.tone}`}>
              <span>{stat.label}</span>
              <strong>{loading ? '…' : stat.value}</strong>
            </article>
          ))}
        </section>

        <section className="panel fleet-summary-panel">
          <div className="panel-header">
            <h2>Fleet summary</h2>
          </div>
          <div className="fleet-summary-grid">
            {fleetSummary.map((item) => (
              <div key={item.label} className={`fleet-summary-card ${item.tone}`}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
              </div>
            ))}
          </div>
        </section>

        <section className="panel operations-panel">
          <div className="panel-header">
            <h2>Operations lifecycle</h2>
          </div>
          <div className="operations-list">
            {operationsQueue.map((item) => (
              <div key={item.id} className="operation-item">
                <div>
                  <strong>{item.name}</strong>
                  <small>{item.scope}</small>
                </div>
                <div className="operation-meta">
                  <span className={`status ${item.status.toLowerCase().replace(/\s+/g, '-')}`}>{item.status}</span>
                  <small>{new Date(item.updatedAt).toLocaleString()}</small>
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel report-panel" id="reports">
          <div className="panel-header">
            <div>
              <h2>Device inventory report</h2>
              <small>{dashboard.devices.length} devices in the current fleet snapshot</small>
            </div>
            <button
              className="inline-action"
              onClick={handleExportDeviceReport}
              disabled={!auth || dashboard.devices.length === 0}
            >
              Export CSV
            </button>
          </div>
        </section>

        {auth && (
          <section className="panel pairing-panel">
            <div className="panel-header">
              <h2>Mobile pairing</h2>
            </div>
            <div className="enrollment-grid">
              <input
                type="text"
                value={mobileDeviceName}
                onChange={(event) => setMobileDeviceName(event.target.value)}
                placeholder="Device name"
              />
              <input
                type="text"
                value={mobilePlatform}
                onChange={(event) => setMobilePlatform(event.target.value)}
                placeholder="Platform"
              />
              <button className="primary-btn" onClick={handlePairMobileDevice}>Create pairing code</button>
              {pairing && (
                <>
                  <div className="pairing-code">{pairing.pairingCode}</div>
                  <div className="pairing-meta">
                    <strong>Host:</strong> {pairing.host} | <strong>Port:</strong> {pairing.port}
                  </div>
                  <div className="pairing-meta">
                    <strong>Fingerprint:</strong> {pairing.fingerprint}
                  </div>
                  <div className="pairing-meta">
                    <strong>Expires:</strong> {new Date(pairing.expiresAt).toLocaleString()}
                  </div>
                </>
              )}
            </div>
          </section>
        )}

        <section className="panel policy-panel">
          <div className="panel-header">
            <h2>Policy coverage</h2>
            {auth && (
              <button
                className="inline-action"
                onClick={() => selectedDevice && dashboard.policies[0] && handleEnforcePolicy(selectedDevice.id, dashboard.policies[0].id)}
              >
                Enforce baseline
              </button>
            )}
          </div>
          <div className="policy-list">
            {dashboard.policies.map((policy) => (
              <div key={policy.id} className="policy-item">
                <div>
                  <strong>{policy.name}</strong>
                  <small>{policy.category}</small>
                </div>
                <div className="policy-right">
                  <span className={`status ${policy.status.toLowerCase().replace(/\s+/g, '-')}`}>
                    {policy.status}
                  </span>
                  {auth && (
                    <button
                      className="tiny-btn"
                      onClick={() => selectedDevice && handleEnforcePolicy(selectedDevice.id, policy.id)}
                    >
                      Enforce
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="panel enrollment-panel">
          <div className="panel-header">
            <h2>Enroll a device</h2>
          </div>
          {lastEnrollment && (
            <div className="agent-config">
              <p>
                <strong>{lastEnrollment.hostname}</strong> — Device ID <code>{lastEnrollment.id}</code>
              </p>
              <p className="muted">
                Put this in <code>appsettings.json</code> next to the agent on that computer, then start the agent.
                The token is shown only now, so copy it before leaving this page.
              </p>
              <pre>{agentConfig}</pre>
              <div className="detail-actions">
                <button className="primary-btn" onClick={copyAgentConfig}>Copy settings</button>
                <button className="secondary-btn" onClick={downloadAgentConfig}>Download appsettings.json</button>
                <button className="secondary-btn" onClick={() => setLastEnrollment(null)}>Dismiss</button>
              </div>
            </div>
          )}
          <div className="enrollment-grid">
            <input
              type="text"
              value={enrollment.hostname}
              onChange={(event) => setEnrollment((current) => ({ ...current, hostname: event.target.value }))}
              placeholder="Hostname *"
              onKeyDown={(event) => event.key === 'Enter' && handleEnrollDevice()}
            />
            <input
              type="text"
              value={enrollment.ipAddress}
              onChange={(event) => setEnrollment((current) => ({ ...current, ipAddress: event.target.value }))}
              placeholder="IP address * (e.g. 192.168.1.45)"
              onKeyDown={(event) => event.key === 'Enter' && handleEnrollDevice()}
            />
            <input
              type="text"
              value={enrollment.vendor}
              onChange={(event) => setEnrollment((current) => ({ ...current, vendor: event.target.value }))}
              placeholder="Vendor"
            />
            <input
              type="text"
              value={enrollment.platform}
              onChange={(event) => setEnrollment((current) => ({ ...current, platform: event.target.value }))}
              placeholder="Platform"
            />
            <input
              type="text"
              value={enrollment.location}
              onChange={(event) => setEnrollment((current) => ({ ...current, location: event.target.value }))}
              placeholder="Location"
            />
            <button className="primary-btn" onClick={handleEnrollDevice} disabled={!auth || enrolling}>
              {enrolling ? 'Enrolling…' : 'Enroll device'}
            </button>
          </div>
        </section>

        <section className="content-grid">
          <div className="panel" id="devices">
            <div className="panel-header">
              <h2>Recent device activity</h2>
            </div>
            <div className="toolbar">
              <input
                type="text"
                value={deviceQuery}
                onChange={(event) => setDeviceQuery(event.target.value)}
                placeholder="Search devices"
              />
            </div>
            <table>
              <thead>
                <tr>
                  <th>Device</th>
                  <th>IP</th>
                  <th>Status</th>
                  <th>CPU</th>
                  <th>Memory</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredDevices.map((device) => (
                  <tr
                    key={device.id}
                    className={selectedDevice?.id === device.id ? 'selected-row' : ''}
                    onClick={() => setSelectedDeviceId(device.id)}
                  >
                    <td>{device.hostname}</td>
                    <td>{device.ipAddress}</td>
                    <td>
                      <span className={`status ${device.status.toLowerCase().replace(/\s+/g, '-')}`}>{device.status}</span>
                    </td>
                    <td>{device.cpu}%</td>
                    <td>{device.memory}%</td>
                    <td className="row-actions">
                      {device.status.toLowerCase() !== 'demo only' && (
                        <button
                          className="tiny-btn"
                          onClick={(event) => { event.stopPropagation(); void handleReissueToken(device.id, device.hostname) }}
                        >
                          New token
                        </button>
                      )}
                      <button
                        className="tiny-btn danger-btn"
                        onClick={(event) => { event.stopPropagation(); void handleRemoveDevice(device.id, device.hostname) }}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="panel" id="alerts">
            <div className="panel-header">
              <h2>Active incidents</h2>
            </div>
            <div className="toolbar">
              <select value={alertFilter} onChange={(event) => setAlertFilter(event.target.value as 'All' | 'High' | 'Medium' | 'Info')}>
                <option value="All">All severities</option>
                <option value="High">High</option>
                <option value="Medium">Medium</option>
                <option value="Info">Info</option>
              </select>
            </div>
            <div className="alert-list">
              {filteredAlerts.map((alert) => (
                <div
                  key={alert.id}
                  className={`alert-item ${selectedAlert?.id === alert.id ? 'selected-alert' : ''}`}
                  onClick={() => setSelectedAlertId(alert.id)}
                >
                  <span className={`severity ${alert.severity.toLowerCase()}`}>{alert.severity}</span>
                  <div className="alert-copy">
                    <p>{alert.title}</p>
                    <small>{alert.source}</small>
                  </div>
                  {auth && !alert.acknowledged && (
                    <button className="tiny-btn" onClick={() => handleAcknowledgeAlert(alert.id)}>
                      Acknowledge
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="panel sample-inventory-panel" id="inventory">
          <div className="panel-header">
            <div>
              <h2>Assets pending verification</h2>
              <small>{filteredInventory.length} of {sampleInventory.length} imported entries</small>
            </div>
            <button className="inline-action" onClick={handleDownloadPendingInventory}>
              Download source list
            </button>
          </div>
          <div className="sample-data-notice" role="note">
            <strong>Not verified; do not treat as district property.</strong> The supplied source explicitly identifies
            all {sampleInventory.length} entries as fictional test records, with placeholder serial numbers and models
            marked “To verify.” This review queue does not establish that the assets exist or belong to Mukono District
            Local Government. Confirm each item against an authorized asset register, purchase documentation, and physical
            inspection before recording ownership. These are not enrolled computers and have no hostnames, IP addresses,
            or live telemetry.
          </div>
          <div className="toolbar">
            <input
              type="text"
              value={inventoryQuery}
              onChange={(event) => setInventoryQuery(event.target.value)}
              placeholder="Search pending entries"
              aria-label="Search assets pending verification"
            />
          </div>
          <div className="sample-inventory-table-wrap">
            <table className="sample-inventory-table">
              <thead>
                <tr>
                  <th>Asset ID</th>
                  <th>Type</th>
                  <th>Brand / model</th>
                  <th>Serial number</th>
                  <th>Department</th>
                  <th>Office</th>
                  <th>Assigned to</th>
                  <th>Purchase date</th>
                  <th>Condition</th>
                  <th>Verification</th>
                  <th>Source note</th>
                </tr>
              </thead>
              <tbody>
                {filteredInventory.map((asset) => (
                  <tr key={asset.assetId}>
                    <td><strong>{asset.assetId}</strong></td>
                    <td>{asset.deviceType}</td>
                    <td>{asset.brand} / {asset.model}</td>
                    <td>{asset.serialNumber}</td>
                    <td>{asset.department}</td>
                    <td>{asset.location}</td>
                    <td>{asset.assignedTo}</td>
                    <td>{asset.purchaseDate}</td>
                    <td>{asset.condition}</td>
                    <td><span className="sample-record-badge">UNVERIFIED</span></td>
                    <td>{asset.notes}</td>
                  </tr>
                ))}
                {filteredInventory.length === 0 && (
                  <tr><td colSpan={11} className="empty-inventory">No pending entries match this search.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="detail-grid">
          <div className="panel detail-panel">
            <div className="panel-header">
              <h2>Selected device</h2>
            </div>
            {selectedDevice ? (
              <>
                <div className="detail-list">
                  <div><label>Hostname</label><strong>{selectedDevice.hostname}</strong></div>
                  <div><label>IP address</label><strong>{selectedDevice.ipAddress}</strong></div>
                  <div><label>Status</label><span className={`status ${selectedDevice.status.toLowerCase().replace(/\s+/g, '-')}`}>{selectedDevice.status}</span></div>
                  <div><label>CPU</label><strong>{selectedDevice.cpu}%</strong></div>
                  <div><label>Memory</label><strong>{selectedDevice.memory}%</strong></div>
                  <div><label>Location</label><strong>{selectedDevice.location}</strong></div>
                  <div><label>Last 60 min samples</label><strong>{selectedMetrics?.sampleCount ?? 0}</strong></div>
                  <div><label>Average CPU</label><strong>{selectedMetrics?.avgCpu ?? 0}%</strong></div>
                  <div><label>Average memory</label><strong>{selectedMetrics?.avgMemory ?? 0}%</strong></div>
                  <div><label>Peak CPU</label><strong>{selectedMetrics?.peakCpu ?? selectedDevice.cpu}%</strong></div>
                  <div><label>Peak memory</label><strong>{selectedMetrics?.peakMemory ?? selectedDevice.memory}%</strong></div>
                </div>
                <div className="detail-actions">
                  <button
                    className="primary-btn"
                    onClick={() => dashboard.policies[0] && handleEnforcePolicy(selectedDevice.id, dashboard.policies[0].id)}
                    disabled={!auth || dashboard.policies.length === 0}
                  >
                    {auth ? 'Enforce baseline policy' : 'Sign in to enforce'}
                  </button>
                </div>
              </>
            ) : (
              <p>No device selected.</p>
            )}
          </div>

          <div className="panel detail-panel">
            <div className="panel-header">
              <h2>Selected incident</h2>
            </div>
            {selectedAlert ? (
              <>
                <div className="detail-list">
                  <div><label>Title</label><strong>{selectedAlert.title}</strong></div>
                  <div><label>Severity</label><span className={`severity ${selectedAlert.severity.toLowerCase()}`}>{selectedAlert.severity}</span></div>
                  <div><label>Source</label><strong>{selectedAlert.source}</strong></div>
                  <div><label>Time</label><strong>{selectedAlert.timestamp}</strong></div>
                  <div><label>Status</label><strong>{selectedAlert.acknowledged ? 'Acknowledged' : 'Open'}</strong></div>
                </div>
                <div className="detail-actions">
                  <button
                    className="primary-btn"
                    onClick={() => handleAcknowledgeAlert(selectedAlert.id)}
                    disabled={!auth || selectedAlert.acknowledged}
                  >
                    {selectedAlert.acknowledged ? 'Already acknowledged' : 'Acknowledge alert'}
                  </button>
                </div>
              </>
            ) : (
              <p>No alert selected.</p>
            )}
          </div>
        </section>
      </main>
    </div>
  )
}

export default App
