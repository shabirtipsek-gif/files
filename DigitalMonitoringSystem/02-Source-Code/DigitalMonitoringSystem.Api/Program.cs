using System.Text;
using Microsoft.AspNetCore.Authentication.JwtBearer;
using Microsoft.AspNetCore.SignalR;
using Microsoft.EntityFrameworkCore;
using Microsoft.IdentityModel.Tokens;
using DigitalMonitoringSystem.Api;
using DigitalMonitoringSystem.Shared;

var builder = WebApplication.CreateBuilder(args);

builder.Services.AddOpenApi();
builder.Services.AddValidation();
builder.Services.AddSignalR();
var databaseProvider = builder.Configuration["Database:Provider"]?.Trim();
var connectionString = builder.Configuration.GetConnectionString("Mdm");
builder.Services.AddDbContext<MdmDbContext>(options =>
{
    switch (databaseProvider?.ToLowerInvariant())
    {
        case "postgresql":
        case "postgres":
            if (string.IsNullOrWhiteSpace(connectionString))
            {
                throw new InvalidOperationException(
                    "The PostgreSQL connection string is missing. Configure ConnectionStrings:Mdm "
                    + "or the ConnectionStrings__Mdm environment variable.");
            }

            options.UseNpgsql(connectionString, postgres => postgres.EnableRetryOnFailure());
            break;
        case "sqlite":
            options.UseSqlite(string.IsNullOrWhiteSpace(connectionString)
                ? "Data Source=mdm.db"
                : connectionString);
            break;
        default:
            throw new InvalidOperationException(
                $"Unsupported Database:Provider '{databaseProvider}'. Set it to PostgreSQL or SQLite.");
    }
});

var allowedOrigins = builder.Configuration.GetSection("Cors:AllowedOrigins").Get<string[]>() ?? [];
if (allowedOrigins.Length == 0 && !builder.Environment.IsDevelopment())
{
    throw new InvalidOperationException(
        "Cors:AllowedOrigins is empty, which rejects every cross-origin browser call. "
        + "List the exact frontend origins, for example via the Cors__AllowedOrigins__0 environment variable.");
}

builder.Services.AddCors(options =>
{
    options.AddPolicy("AllowLocalFrontend", policy =>
        policy.WithOrigins(allowedOrigins).AllowAnyHeader().AllowAnyMethod());
});

builder.Services.AddScoped<DashboardService>();
builder.Services.AddScoped<AuthService>();
builder.Services.AddScoped<MetricsService>();
builder.Services.AddScoped<AlertRuleService>();
builder.Services.AddScoped<PolicyService>();
builder.Services.AddScoped<DeviceTokenService>();
builder.Services.AddScoped<MobilePairingService>();
builder.Services.AddHostedService<AlertEvaluationService>();

var jwtKey = builder.Configuration["Jwt:Key"];
if (string.IsNullOrWhiteSpace(jwtKey) || Encoding.UTF8.GetByteCount(jwtKey) < 32)
{
    throw new InvalidOperationException(
        "Jwt:Key is missing or shorter than 32 bytes. Configure it per environment, for example "
        + "'dotnet user-secrets --project DigitalMonitoringSystem.Api set \"Jwt:Key\" \"<value>\"' "
        + "or the Jwt__Key environment variable.");
}

if (string.IsNullOrWhiteSpace(builder.Configuration["Admin:Username"])
    || string.IsNullOrWhiteSpace(builder.Configuration["Admin:Password"]))
{
    throw new InvalidOperationException(
        "Admin:Username and Admin:Password must both be configured. Set them per environment, for example "
        + "via the Admin__Username and Admin__Password environment variables.");
}

builder.Services.AddAuthentication(options =>
{
    // Managed devices authenticate with their own token, administrators with a JWT. The selector
    // picks the scheme from the request so both callers reach the same policy pipeline.
    options.DefaultAuthenticateScheme = "AdminOrDevice";
    options.DefaultChallengeScheme = "AdminOrDevice";
})
.AddPolicyScheme("AdminOrDevice", "Administrator JWT or managed device token", options =>
{
    options.ForwardDefaultSelector = context =>
    {
        var authorization = context.Request.Headers.Authorization.ToString();
        var hasDeviceHeader = context.Request.Headers.ContainsKey("X-Device-Token");
        return hasDeviceHeader || authorization.StartsWith(DeviceTokenService.AuthorizationPrefix + " ", StringComparison.OrdinalIgnoreCase)
            ? DeviceTokenAuthenticationHandler.SchemeName
            : JwtBearerDefaults.AuthenticationScheme;
    };
})
.AddJwtBearer(options =>
{
    options.Events = new JwtBearerEvents
    {
        OnMessageReceived = context =>
        {
            var accessToken = context.Request.Query["access_token"];
            if (!string.IsNullOrEmpty(accessToken)
                && context.HttpContext.Request.Path.StartsWithSegments("/hub/dashboard"))
            {
                context.Token = accessToken;
            }

            return Task.CompletedTask;
        }
    };
    options.TokenValidationParameters = new TokenValidationParameters
    {
        ValidateIssuerSigningKey = true,
        IssuerSigningKey = new SymmetricSecurityKey(Encoding.UTF8.GetBytes(jwtKey)),
        ValidateIssuer = true,
        ValidIssuer = "DigitalMonitoringSystem.Api",
        ValidateAudience = true,
        ValidAudience = "DigitalMonitoringSystem.Client",
        ValidateLifetime = true,
        ClockSkew = TimeSpan.FromMinutes(2)
    };
})
.AddScheme<DeviceTokenSchemeOptions, DeviceTokenAuthenticationHandler>(
    DeviceTokenAuthenticationHandler.SchemeName,
    _ => { });

builder.Services.AddAuthorization(options =>
{
    options.AddPolicy("AdminOnly", policy => policy.RequireRole("Administrator"));
    options.AddPolicy("AdminOrDevice", policy => policy.RequireAssertion(context =>
        context.User.IsInRole("Administrator") || context.User.IsInRole(DeviceTokenService.Role)));
});

var app = builder.Build();
var hubContext = app.Services.GetRequiredService<IHubContext<DashboardHub>>();

async Task BroadcastDashboardAsync(DashboardService service)
{
    await hubContext.Clients.All.SendAsync("ReceiveDashboard", service.BuildDashboard());
}

using (var scope = app.Services.CreateScope())
{
    var dbContext = scope.ServiceProvider.GetRequiredService<MdmDbContext>();
    SchemaBootstrapper.Initialize(dbContext, app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("SchemaBootstrapper"));

    // Resolve the service once during startup so database/configuration issues surface immediately.
    scope.ServiceProvider.GetRequiredService<DashboardService>();
}

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

app.UseRouting();
app.UseCors("AllowLocalFrontend");
app.UseAuthentication();
app.UseAuthorization();
if (app.Configuration.GetValue("Security:UseHttpsRedirection", false))
{
    app.UseHttpsRedirection();
}

string ResolveApiBaseUrl(HttpRequest httpRequest)
{
    var host = httpRequest.Host.Host;
    if (string.IsNullOrWhiteSpace(host) || host is "localhost" or "127.0.0.1" or "::1")
    {
        host = app.Configuration["Network:AdvertisedHost"] ?? host ?? "127.0.0.1";
    }

    return $"{httpRequest.Scheme}://{host}:{httpRequest.Host.Port ?? 5103}";
}

app.MapGet("/health", () => new { status = "ok", service = "DigitalMonitoringSystem.Api", version = "1.3" });
app.MapPost("/api/auth/login", (LoginRequest request, AuthService service) =>
{
    var auth = service.Authenticate(request.Username, request.Password);
    return auth is null
        ? Results.Unauthorized()
        : Results.Ok(auth);
});
var adminApi = app.MapGroup("/api").RequireAuthorization("AdminOnly");
adminApi.MapGet("/dashboard", (DashboardService service) => Results.Ok(service.BuildDashboard()));
adminApi.MapGet("/system/overview", (DashboardService service) => Results.Ok(service.GetSystemHealth()));
adminApi.MapGet("/devices", (string? search, string? status, string? location, string? platform, string? vendor,
    bool? managedOnly, string? sortBy, bool? descending, int? page, int? pageSize, DashboardService service) =>
{
    var query = new DeviceQuery
    {
        Search = search ?? string.Empty,
        Status = status ?? string.Empty,
        Location = location ?? string.Empty,
        Platform = platform ?? string.Empty,
        Vendor = vendor ?? string.Empty,
        ManagedOnly = managedOnly ?? false,
        SortBy = string.IsNullOrWhiteSpace(sortBy) ? "Hostname" : sortBy,
        Descending = descending ?? false,
        Page = page ?? 1,
        PageSize = pageSize ?? 50
    };

    return Results.Ok(service.QueryDevices(query));
});
adminApi.MapGet("/devices/{id}", (string id, DashboardService service) =>
{
    var device = service.GetDeviceById(id);
    return device is null
        ? Results.NotFound(new { error = $"Device '{id}' was not found." })
        : Results.Ok(device);
});
adminApi.MapDelete("/devices/{id}", async (string id, DashboardService service) =>
{
    if (!service.RemoveDevice(id))
    {
        return Results.NotFound(new { error = $"Device '{id}' was not found." });
    }

    await BroadcastDashboardAsync(service);
    return Results.Ok(new { deviceId = id, status = "removed" });
});
adminApi.MapGet("/devices/{id}/details", (string id, DashboardService service) =>
{
    var details = service.GetDeviceDetails(id);
    return details is null
        ? Results.NotFound(new { error = $"Device '{id}' was not found." })
        : Results.Ok(details);
});
adminApi.MapGet("/devices/{id}/metrics", (string id, int? windowMinutes, int? maxSamples, DashboardService service, MetricsService metrics) =>
{
    if (service.GetDeviceById(id) is null)
    {
        return Results.NotFound(new { error = $"Device '{id}' was not found." });
    }

    var window = metrics.GetSamples(id, windowMinutes ?? MetricsService.DefaultWindowMinutes, maxSamples ?? MetricsService.DefaultMaxSamples);
    return Results.Ok(new DeviceMetricWindow
    {
        DeviceId = id,
        WindowMinutes = MetricsService.ClampWindow(windowMinutes ?? MetricsService.DefaultWindowMinutes),
        SampleCount = window.Count,
        AvgCpu = window.Count == 0 ? 0 : Math.Round(window.Average(s => s.Cpu), 1),
        AvgMemory = window.Count == 0 ? 0 : Math.Round(window.Average(s => s.Memory), 1),
        PeakCpu = window.Count == 0 ? 0 : window.Max(s => s.Cpu),
        PeakMemory = window.Count == 0 ? 0 : window.Max(s => s.Memory),
        Samples = window.ToList()
    });
});
adminApi.MapPost("/devices/{id}/token", (string id, DashboardService service, DeviceTokenService tokens, HttpRequest httpRequest) =>
{
    var device = service.GetDeviceById(id);
    return device is null
        ? Results.NotFound(new { error = $"Device '{id}' was not found." })
        : Results.Ok(new { deviceId = device.Id, hostname = device.Hostname, enrollmentToken = tokens.Issue(device.Id), apiBaseUrl = ResolveApiBaseUrl(httpRequest) });
});
adminApi.MapGet("/alerts", (DashboardService service) => Results.Ok(service.GetAlerts()));
adminApi.MapGet("/alerts/{id}", (string id, DashboardService service) =>
{
    var alert = service.GetAlertById(id);
    return alert is null
        ? Results.NotFound(new { error = $"Alert '{id}' was not found." })
        : Results.Ok(alert);
});
adminApi.MapPost("/alerts/{id}/acknowledge", async (string id, DashboardService service) =>
{
    var acknowledged = service.AcknowledgeAlert(id);
    if (!acknowledged)
    {
        return Results.NotFound(new { error = $"Alert '{id}' was not found." });
    }

    await BroadcastDashboardAsync(service);
    return Results.Ok(new { alertId = id, status = "acknowledged" });
});

// Managed devices post telemetry with the token they received at enrollment. Administrators are
// accepted too so the endpoint can be exercised from the dashboard.
app.MapPost("/api/devices/{id}/heartbeat", async (string id, DeviceHeartbeatRequest request, HttpContext httpContext, DashboardService service,
    MetricsService metrics, AlertRuleService rules) =>
{
    if (!httpContext.User.IsInRole("Administrator")
        && !string.Equals(httpContext.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value, id, StringComparison.OrdinalIgnoreCase))
    {
        return Results.Forbid();
    }

    var (sample, response) = service.RecordHeartbeat(id, request, metrics);
    if (sample is null || response is null)
    {
        return Results.NotFound(new { error = $"Device '{id}' was not found." });
    }

    // Evaluate immediately so a heartbeat that crosses a threshold surfaces without waiting for
    // the next timer tick.
    var evaluation = rules.Evaluate(DateTimeOffset.UtcNow, id);
    response.TriggeredAlertIds = evaluation.CreatedAlertIds;

    if (evaluation.AlertsCreated > 0 || evaluation.AlertsResolved > 0)
    {
        await BroadcastDashboardAsync(service);
    }

    return Results.Ok(response);
}).RequireAuthorization("AdminOrDevice");

adminApi.MapGet("/alert-rules", (AlertRuleService service) => Results.Ok(service.GetRules()));
adminApi.MapGet("/alert-rules/{id}", (string id, AlertRuleService service) =>
{
    var rule = service.GetRuleById(id);
    return rule is null
        ? Results.NotFound(new { error = $"Alert rule '{id}' was not found." })
        : Results.Ok(rule);
});
adminApi.MapPost("/alert-rules", async (AlertRuleRequest request, AlertRuleService service, DashboardService dashboard) =>
{
    var (rule, errors) = service.Create(request);
    if (rule is null)
    {
        return Results.BadRequest(new { error = "The alert rule is not valid.", details = errors });
    }

    await BroadcastDashboardAsync(dashboard);
    return Results.Created($"/api/alert-rules/{rule.Id}", rule);
});
adminApi.MapPut("/alert-rules/{id}", async (string id, AlertRuleRequest request, AlertRuleService service, DashboardService dashboard) =>
{
    var (rule, errors) = service.Update(id, request);
    if (rule is null)
    {
        var missing = errors.Any(error => error.Field == "id");
        return missing
            ? Results.NotFound(new { error = $"Alert rule '{id}' was not found." })
            : Results.BadRequest(new { error = "The alert rule is not valid.", details = errors });
    }

    await BroadcastDashboardAsync(dashboard);
    return Results.Ok(rule);
});
adminApi.MapDelete("/alert-rules/{id}", async (string id, AlertRuleService service, DashboardService dashboard) =>
{
    if (!service.Delete(id))
    {
        return Results.NotFound(new { error = $"Alert rule '{id}' was not found." });
    }

    await BroadcastDashboardAsync(dashboard);
    return Results.Ok(new { ruleId = id, status = "deleted" });
});
adminApi.MapPost("/alert-rules/evaluate", async (AlertEvaluationService evaluator, DashboardService dashboard) =>
{
    var result = await evaluator.EvaluateOnceAsync();
    await BroadcastDashboardAsync(dashboard);
    return Results.Ok(result);
});

adminApi.MapGet("/policies", (PolicyService service) => Results.Ok(service.GetPolicies()));
adminApi.MapGet("/policies/{id}", (string id, PolicyService service) =>
{
    var policy = service.GetPolicyById(id);
    return policy is null
        ? Results.NotFound(new { error = $"Policy '{id}' was not found." })
        : Results.Ok(policy);
});
adminApi.MapPost("/policies", async (PolicyUpsertRequest request, PolicyService service, DashboardService dashboard) =>
{
    var (policy, errors) = service.Create(request);
    if (policy is null)
    {
        return Results.BadRequest(new { error = "The policy is not valid.", details = errors });
    }

    await BroadcastDashboardAsync(dashboard);
    return Results.Created($"/api/policies/{policy.Id}", policy);
});
adminApi.MapPut("/policies/{id}", async (string id, PolicyUpsertRequest request, PolicyService service, DashboardService dashboard) =>
{
    var (policy, errors) = service.Update(id, request);
    if (policy is null)
    {
        var missing = errors.Any(error => error.Field == "id");
        return missing
            ? Results.NotFound(new { error = $"Policy '{id}' was not found." })
            : Results.BadRequest(new { error = "The policy is not valid.", details = errors });
    }

    await BroadcastDashboardAsync(dashboard);
    return Results.Ok(policy);
});
adminApi.MapDelete("/policies/{id}", async (string id, PolicyService service, DashboardService dashboard) =>
{
    if (!service.Delete(id))
    {
        return Results.NotFound(new { error = $"Policy '{id}' was not found." });
    }

    await BroadcastDashboardAsync(dashboard);
    return Results.Ok(new { policyId = id, status = "deleted" });
});
adminApi.MapGet("/devices/{deviceId}/policies", (string deviceId, PolicyService service, DashboardService dashboard) =>
{
    if (dashboard.GetDeviceById(deviceId) is null)
    {
        return Results.NotFound(new { error = $"Device '{deviceId}' was not found." });
    }

    return Results.Ok(service.GetAssignmentsForDevice(deviceId));
});
adminApi.MapGet("/policies/{policyId}/assignments", (string policyId, PolicyService service) =>
{
    if (service.GetPolicyById(policyId) is null)
    {
        return Results.NotFound(new { error = $"Policy '{policyId}' was not found." });
    }

    return Results.Ok(service.GetAssignmentsForPolicy(policyId));
});
adminApi.MapPost("/devices/{deviceId}/policies/{policyId}/enforce", async (string deviceId, string policyId, PolicyService policies, DashboardService service, HttpContext httpContext) =>
{
    var username = httpContext.User.Identity?.Name ?? "Administrator";
    var (assignment, message) = policies.Assign(deviceId, policyId, username);
    if (assignment is null)
    {
        return Results.BadRequest(new { deviceId, policyId, status = "rejected", message });
    }

    await BroadcastDashboardAsync(service);
    return Results.Ok(new { deviceId, policyId, status = assignment.State, message, assignmentId = assignment.Id });
});
adminApi.MapPost("/devices/{deviceId}/policies/{policyId}/assign", async (string deviceId, string policyId,
    PolicyService service, DashboardService dashboard, HttpContext context) =>
{
    var (assignment, message) = service.Assign(deviceId, policyId, context.User.Identity?.Name ?? "administrator");
    if (assignment is null)
    {
        return Results.BadRequest(new { deviceId, policyId, status = "rejected", message });
    }

    await BroadcastDashboardAsync(dashboard);
    return Results.Ok(assignment);
});
adminApi.MapDelete("/devices/{deviceId}/policies/{policyId}/assign", async (string deviceId, string policyId,
    PolicyService service, DashboardService dashboard) =>
{
    var (assignment, message) = service.Unassign(deviceId, policyId);
    if (assignment is null)
    {
        return Results.NotFound(new { deviceId, policyId, status = "not-assigned", message });
    }

    await BroadcastDashboardAsync(dashboard);
    return Results.Ok(new { deviceId, policyId, status = "unassigned", message });
});
adminApi.MapPost("/devices/enroll", async (DeviceEnrollmentRequest request, DashboardService service, DeviceTokenService tokens, HttpRequest httpRequest) =>
{
    if (string.IsNullOrWhiteSpace(request.Hostname) || string.IsNullOrWhiteSpace(request.IpAddress))
    {
        return Results.BadRequest(new { error = "Device enrollment requires hostname and IP address." });
    }

    if (!System.Net.IPAddress.TryParse(request.IpAddress.Trim(), out _))
    {
        return Results.BadRequest(new { error = "The IP address is not a valid IPv4 or IPv6 address." });
    }

    var enrollment = service.EnrollDevice(request);
    if (enrollment is null)
    {
        return Results.BadRequest(new { error = "Device enrollment requires hostname and IP address." });
    }

    // The agent stores this token and presents it on every heartbeat.
    enrollment.EnrollmentToken = tokens.Issue(enrollment.Id);
    enrollment.ApiBaseUrl = ResolveApiBaseUrl(httpRequest);

    await BroadcastDashboardAsync(service);
    return Results.Ok(enrollment);
});
app.MapHub<DashboardHub>("/hub/dashboard").RequireAuthorization("AdminOnly");

adminApi.MapPost("/mobile/pair", async (MobilePairingRequest request, MobilePairingService pairings, DashboardService service, HttpRequest httpRequest) =>
{
    var pairing = pairings.CreateCode(request.DeviceName, request.Platform);
    var host = httpRequest.Host.Host;
    if (string.IsNullOrWhiteSpace(host) || host is "localhost" or "127.0.0.1" or "::1")
    {
        host = app.Configuration["Network:AdvertisedHost"] ?? host ?? "127.0.0.1";
    }

    var response = new MobilePairingResponse
    {
        PairingCode = pairing.PairingCode,
        Host = host,
        Port = httpRequest.Host.Port ?? 5103,
        Fingerprint = $"SHA256:MDM-LOCAL:{host}",
        ExpiresAt = pairing.ExpiresAt
    };

    await BroadcastDashboardAsync(service);
    return Results.Ok(response);
});

app.MapPost("/api/mobile/pair/complete", (MobilePairCompleteRequest request, MobilePairingService pairings, HttpRequest httpRequest) =>
{
    var baseUrl = $"{httpRequest.Scheme}://{httpRequest.Host}";
    var (response, error) = pairings.Complete(request.PairingCode, request.IpAddress, request.Location, baseUrl);
    return response is null ? Results.BadRequest(new { error }) : Results.Ok(response);
});

app.Run();
