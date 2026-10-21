export type DeviceSummary = {
  id: string
  hostname: string
  ipAddress: string
  status: string
  cpu: number
  memory: number
  location: string
}

export type AlertSummary = {
  id: string
  title: string
  severity: string
  source: string
  timestamp: string
  acknowledged: boolean
}

export type PolicyDefinition = {
  id: string
  name: string
  category: string
  scope: string
  status: string
  assignedDevices: number
  updatedAt: string
}

export type DeviceMetricSample = {
  id: string
  deviceId: string
  cpu: number
  memory: number
  disk: number
  capturedAt: string
  capturedAtEpochMs: number
}

export type DeviceMetricWindow = {
  deviceId: string
  windowMinutes: number
  sampleCount: number
  avgCpu: number
  avgMemory: number
  peakCpu: number
  peakMemory: number
  samples: DeviceMetricSample[]
}

export type DashboardSummary = {
  totalDevices: number
  onlineDevices: number
  openAlerts: number
  criticalAlerts: number
  avgCpu: number
  avgMemory: number
  devices: DeviceSummary[]
  alerts: AlertSummary[]
  policies: PolicyDefinition[]
}

export type SystemHealthSnapshot = {
  serviceName: string
  status: string
  lastSyncUtc: string
  summary: DashboardSummary
}

export type AuthenticationResult = {
  username: string
  role: string
  token: string
}

export type LoginRequest = {
  username: string
  password: string
}

export type DeviceEnrollmentRequest = {
  hostname: string
  ipAddress: string
  vendor: string
  platform: string
  location: string
}

export type DeviceEnrollmentResponse = {
  id: string
  hostname: string
  status: string
  isManaged: boolean
  policyState: string
  enrollmentToken: string
  apiBaseUrl: string
  reEnrolled: boolean
}

export type DeviceTokenResponse = {
  deviceId: string
  hostname: string
  enrollmentToken: string
  apiBaseUrl: string
}

export type MobilePairingRequest = {
  deviceName: string
  platform: string
}

export type MobilePairingResponse = {
  pairingCode: string
  host: string
  port: number
  fingerprint: string
  expiresAt: string
}

/**
 * Where the API lives, as a prefix for every request.
 *
 * Defaults to the empty string, meaning "same origin". The ready-to-run build serves the
 * dashboard and the API from a single server on a single port, so relative URLs always reach
 * the correct host — both on the server itself and on every other computer on the network.
 * Hard-coding an absolute address here would make the dashboard call its own localhost on any
 * machine other than the one running the server.
 *
 * Set `VITE_API_BASE_URL` to an absolute URL only when the dashboard is hosted away from its
 * API, for example a copy deployed to Vercel talking to an API reachable over the internet.
 * Vite inlines this at build time, so the variable must exist when `npm run build` runs.
 */
const configuredBaseUrl = import.meta.env.VITE_API_BASE_URL?.trim().replace(/\/+$/, '') ?? ''

export const API_BASE_URL = configuredBaseUrl

/**
 * The API address to show to a person. Same-origin requests have no meaningful prefix of
 * their own, so the page's own origin is displayed instead.
 */
export const API_DISPLAY_URL = API_BASE_URL || window.location.origin

export class ApiError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, token: string | null, init: RequestInit = {}, failure = 'Request failed'): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) }
  if (init.body) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`

  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers })
  } catch {
    throw new ApiError(`Cannot reach the API at ${API_DISPLAY_URL}. Is it running?`, 0)
  }

  if (!response.ok) {
    let detail = ''
    try {
      const body = (await response.json()) as { error?: string; message?: string }
      detail = body.error ?? body.message ?? ''
    } catch {
      // Response had no JSON body; fall back to the status code.
    }
    const message = response.status === 401
      ? 'Your session has expired. Please sign in again.'
      : detail || `${failure} (${response.status})`
    throw new ApiError(message, response.status)
  }

  return response.json() as Promise<T>
}

export const fetchDashboard = (token: string) =>
  request<DashboardSummary>('/api/dashboard', token, {}, 'Failed to load dashboard')

export const fetchSystemHealth = (token: string) =>
  request<SystemHealthSnapshot>('/api/system/overview', token, {}, 'Failed to load system health')

export async function login(username: string, password: string): Promise<AuthenticationResult> {
  try {
    return await request<AuthenticationResult>(
      '/api/auth/login',
      null,
      { method: 'POST', body: JSON.stringify({ username, password } satisfies LoginRequest) },
      'Sign-in failed',
    )
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      throw new ApiError('Incorrect username or password.', 401)
    }
    throw error
  }
}

export const fetchDeviceMetrics = (deviceId: string, token: string, windowMinutes = 60) =>
  request<DeviceMetricWindow>(
    `/api/devices/${encodeURIComponent(deviceId)}/metrics?windowMinutes=${windowMinutes}&maxSamples=120`,
    token,
    {},
    'Failed to load device metrics',
  )

export const enforcePolicy = (deviceId: string, policyId: string, token: string) =>
  request<{ deviceId: string; policyId: string; status: string }>(
    `/api/devices/${encodeURIComponent(deviceId)}/policies/${encodeURIComponent(policyId)}/enforce`,
    token,
    { method: 'POST' },
    'Policy enforcement failed',
  )

export const enrollDevice = (payload: DeviceEnrollmentRequest, token: string) =>
  request<DeviceEnrollmentResponse>(
    '/api/devices/enroll',
    token,
    { method: 'POST', body: JSON.stringify(payload) },
    'Device enrollment failed',
  )

export const issueDeviceToken = (deviceId: string, token: string) =>
  request<DeviceTokenResponse>(
    `/api/devices/${encodeURIComponent(deviceId)}/token`,
    token,
    { method: 'POST' },
    'Could not issue a new token',
  )

export const removeDevice = (deviceId: string, token: string) =>
  request<{ deviceId: string; status: string }>(
    `/api/devices/${encodeURIComponent(deviceId)}`,
    token,
    { method: 'DELETE' },
    'Could not remove the device',
  )

export const pairMobileDevice = (deviceName: string, platform: string, token: string) =>
  request<MobilePairingResponse>(
    '/api/mobile/pair',
    token,
    { method: 'POST', body: JSON.stringify({ deviceName, platform } satisfies MobilePairingRequest) },
    'Mobile pairing failed',
  )

export const acknowledgeAlert = (alertId: string, token: string) =>
  request<{ alertId: string; status: string }>(
    `/api/alerts/${encodeURIComponent(alertId)}/acknowledge`,
    token,
    { method: 'POST' },
    'Alert acknowledgement failed',
  )
