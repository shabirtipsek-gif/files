FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src

COPY DigitalMonitoringSystem.slnx ./
COPY DigitalMonitoringSystem.Api/DigitalMonitoringSystem.Api.csproj DigitalMonitoringSystem.Api/
COPY DigitalMonitoringSystem.Shared/DigitalMonitoringSystem.Shared.csproj DigitalMonitoringSystem.Shared/
RUN dotnet restore DigitalMonitoringSystem.Api/DigitalMonitoringSystem.Api.csproj

COPY . .
RUN dotnet publish DigitalMonitoringSystem.Api/DigitalMonitoringSystem.Api.csproj \
    --configuration Release \
    --output /app/publish \
    --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0 AS runtime
WORKDIR /app
COPY --from=build /app/publish .

ENV ASPNETCORE_ENVIRONMENT=Production
EXPOSE 8080

ENTRYPOINT ["sh", "-c", "exec dotnet DigitalMonitoringSystem.Api.dll --urls http://0.0.0.0:${PORT:-8080}"]
