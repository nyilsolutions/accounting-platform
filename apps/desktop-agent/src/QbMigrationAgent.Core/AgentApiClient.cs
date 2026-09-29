using System.Net;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace QbMigrationAgent;

public sealed record AgentSession(string MigrationId, string CompanyName, Dictionary<string, int> Received, List<string> Attachments, int ApiVersion);

public sealed record AttachmentResult(string? DocumentId, bool Duplicate, string? Refused);

/// <summary>An error the user must act on (a revoked key, a completed migration); retrying won't help.</summary>
public sealed class AgentApiException(HttpStatusCode status, string message) : Exception(message)
{
    public HttpStatusCode Status { get; } = status;
}

/// <summary>
/// The server's agent API (`/api/agent/v1`), authenticated by the pairing key. Network failures,
/// throttling and server errors are retried with backoff; everything the agent sends is idempotent
/// on the server, so a retried or resumed upload never duplicates.
/// </summary>
public sealed class AgentApiClient
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly HttpClient _http;
    private readonly Func<TimeSpan, CancellationToken, Task> _delay;
    public int MaxAttempts { get; init; } = 6;

    public AgentApiClient(Uri serverUrl, string pairingKey, HttpMessageHandler? handler = null, Func<TimeSpan, CancellationToken, Task>? delay = null)
    {
        if (!pairingKey.StartsWith("qbm_", StringComparison.Ordinal))
            throw new ArgumentException("A pairing key starts with qbm_. Copy it from the migration page in the app.");
        var baseUri = new Uri(serverUrl.ToString().TrimEnd('/') + "/api/agent/v1/");
        _http = handler is null ? new HttpClient() : new HttpClient(handler, disposeHandler: false);
        _http.BaseAddress = baseUri;
        _http.Timeout = TimeSpan.FromMinutes(5);
        _http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", pairingKey);
        _http.DefaultRequestHeaders.UserAgent.ParseAdd("QbMigrationAgent/1.0");
        _delay = delay ?? Task.Delay;
    }

    public Task<AgentSession> SessionAsync(CancellationToken ct) =>
        SendAsync<AgentSession>(() => new HttpRequestMessage(HttpMethod.Get, "session"), ct);

    public Task<JsonObject> BatchAsync(string entity, IReadOnlyList<JsonObject> records, CancellationToken ct)
    {
        var body = new JsonObject { ["entity"] = entity, ["records"] = new JsonArray(records.Select(r => (JsonNode)r.DeepClone()).ToArray()) };
        return SendAsync<JsonObject>(() => Post("batches", body), ct);
    }

    public Task<JsonObject> ReportAsync(string kind, DateOnly asOf, DateOnly? from, JsonObject report, CancellationToken ct)
    {
        var body = new JsonObject { ["kind"] = kind, ["asOf"] = QbXmlRequests.Date(asOf), ["report"] = report.DeepClone() };
        if (from is { } f) body["from"] = QbXmlRequests.Date(f);
        return SendAsync<JsonObject>(() => Post("reports", body), ct);
    }

    public Task<AttachmentResult> AttachmentAsync(string relativePath, byte[] data, CancellationToken ct) =>
        SendAsync<AttachmentResult>(() =>
        {
            var content = new ByteArrayContent(data);
            content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
            return new HttpRequestMessage(HttpMethod.Post, $"attachments?path={Uri.EscapeDataString(relativePath)}") { Content = content };
        }, ct);

    public Task<JsonObject> FinishAsync(JsonObject body, CancellationToken ct) => SendAsync<JsonObject>(() => Post("finish", body), ct);

    private static HttpRequestMessage Post(string path, JsonObject body) =>
        new(HttpMethod.Post, path) { Content = JsonContent.Create(body, options: Json) };

    private async Task<T> SendAsync<T>(Func<HttpRequestMessage> build, CancellationToken ct)
    {
        for (var attempt = 1; ; attempt++)
        {
            HttpResponseMessage? res = null;
            try
            {
                using var req = build();
                res = await _http.SendAsync(req, ct).ConfigureAwait(false);
                if (res.IsSuccessStatusCode)
                    return (await res.Content.ReadFromJsonAsync<T>(Json, ct).ConfigureAwait(false))!;
                var retryable = res.StatusCode is HttpStatusCode.TooManyRequests or HttpStatusCode.RequestTimeout || (int)res.StatusCode >= 500;
                if (!retryable || attempt >= MaxAttempts)
                    throw new AgentApiException(res.StatusCode, await MessageOf(res, ct).ConfigureAwait(false));
            }
            catch (HttpRequestException) when (attempt < MaxAttempts)
            {
                // The network dropped: wait and send the same request again.
            }
            catch (TaskCanceledException) when (!ct.IsCancellationRequested && attempt < MaxAttempts)
            {
                // Timed out.
            }
            finally
            {
                res?.Dispose();
            }
            await _delay(Backoff(attempt), ct).ConfigureAwait(false);
        }
    }

    /// <summary>2, 4, 8, 16, 32 seconds, capped at one minute.</summary>
    public static TimeSpan Backoff(int attempt) => TimeSpan.FromSeconds(Math.Min(60, Math.Pow(2, attempt)));

    private static async Task<string> MessageOf(HttpResponseMessage res, CancellationToken ct)
    {
        try
        {
            var body = await res.Content.ReadFromJsonAsync<JsonObject>(Json, ct).ConfigureAwait(false);
            var message = body?["message"];
            if (message is JsonValue v) return v.ToString();
        }
        catch (JsonException)
        {
        }
        return $"The server answered {(int)res.StatusCode} {res.ReasonPhrase}.";
    }
}
