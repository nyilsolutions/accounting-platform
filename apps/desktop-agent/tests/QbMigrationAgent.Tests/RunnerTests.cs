using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using System.Xml.Linq;
using Xunit;

namespace QbMigrationAgent.Tests;

/// <summary>A QuickBooks company file in memory: answers queries page by page, and reports.</summary>
internal sealed class FakeQuickBooks : IQuickBooksSession
{
    public readonly Dictionary<string, List<string>> Records = new();
    public readonly List<string> Requests = [];
    public HashSet<string> Unsupported { get; } = [];
    private readonly Dictionary<string, int> _iterators = new();
    public string? CompanyFilePath => null;

    public string ProcessRequest(string qbXml)
    {
        Requests.Add(qbXml);
        var rq = XDocument.Parse(qbXml).Root!.Element("QBXMLMsgsRq")!.Elements().First();
        var name = rq.Name.LocalName;
        var rs = name.Replace("Rq", "Rs");
        if (Unsupported.Contains(name))
            return Wrap($"<{rs} statusCode=\"3120\" statusSeverity=\"Error\" statusMessage=\"Not supported in this version\" />");
        if (name == "CompanyQueryRq")
            return Wrap($"<{rs} statusCode=\"0\" statusSeverity=\"Info\"><CompanyRet><CompanyName>Test Co</CompanyName><FirstMonthFiscalYear>January</FirstMonthFiscalYear></CompanyRet></{rs}>");
        if (name.EndsWith("ReportQueryRq", StringComparison.Ordinal))
            return Wrap($"<{rs} statusCode=\"0\" statusSeverity=\"Info\"><ReportRet><ReportTitle>{rq.Elements().First().Value}</ReportTitle></ReportRet></{rs}>");
        var ret = name.Replace("QueryRq", "Ret");
        var all = Records.GetValueOrDefault(ret) ?? [];
        var max = int.Parse(rq.Element("MaxReturned")?.Value ?? "1000");
        var id = (string?)rq.Attribute("iteratorID") ?? Guid.NewGuid().ToString();
        var at = _iterators.GetValueOrDefault(id);
        var page = all.Skip(at).Take(max).ToList();
        _iterators[id] = at + page.Count;
        var remaining = all.Count - at - page.Count;
        if (all.Count == 0) return Wrap($"<{rs} statusCode=\"1\" statusSeverity=\"Info\" iteratorRemainingCount=\"0\" iteratorID=\"{id}\" />");
        return Wrap($"<{rs} statusCode=\"0\" statusSeverity=\"Info\" iteratorRemainingCount=\"{remaining}\" iteratorID=\"{id}\">{string.Concat(page)}</{rs}>");
    }

    private static string Wrap(string rs) => $"<?xml version=\"1.0\"?><QBXML><QBXMLMsgsRs>{rs}</QBXMLMsgsRs></QBXML>";

    public void Dispose()
    {
    }
}

/// <summary>The server's agent API in memory, keeping what it receives like the real one (by id).</summary>
internal sealed class FakeServer : HttpMessageHandler
{
    public readonly Dictionary<string, Dictionary<string, JsonObject>> Raw = new();
    public readonly List<(string Kind, string AsOf)> Reports = [];
    public readonly List<string> Files = [];
    public readonly List<string> Calls = [];
    public JsonObject? Finished;
    /// <summary>Fail the next N batch calls with 503 (a flaky network or a busy server).</summary>
    public int FailBatches;
    /// <summary>Stop answering after this many batch calls (the laptop went to sleep).</summary>
    public int? CrashAfterBatches;
    private int _batches;

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        Assert.Equal("Bearer qbm_testkeytestkeytestkeytestkey", request.Headers.Authorization?.ToString());
        var path = request.RequestUri!.AbsolutePath.Replace("/api/agent/v1/", "");
        Calls.Add(path);
        switch (path)
        {
            case "session":
                return Json(new JsonObject
                {
                    ["migrationId"] = "m1",
                    ["companyName"] = "Test Co",
                    ["received"] = new JsonObject(),
                    ["attachments"] = new JsonArray(Files.Select(f => (JsonNode?)f).ToArray()),
                    ["apiVersion"] = 1,
                });
            case "batches":
            {
                _batches++;
                if (CrashAfterBatches is { } c && _batches > c) throw new HttpRequestException("connection lost");
                if (FailBatches > 0)
                {
                    FailBatches--;
                    return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
                }
                var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct))!.AsObject();
                var entity = (string)body["entity"]!;
                var bucket = Raw.TryGetValue(entity, out var b) ? b : Raw[entity] = new();
                foreach (var r in body["records"]!.AsArray())
                    bucket[(string?)r!["TxnID"] ?? (string?)r["ListID"] ?? "company"] = r.AsObject();
                return Json(new JsonObject { ["received"] = body["records"]!.AsArray().Count });
            }
            case "reports":
            {
                var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct))!.AsObject();
                Reports.Add(((string)body["kind"]!, (string)body["asOf"]!));
                return Json(new JsonObject { ["rows"] = 0 });
            }
            case "attachments":
                Files.Add(Uri.UnescapeDataString(request.RequestUri.Query.Replace("?path=", "")));
                return Json(new JsonObject { ["documentId"] = "d", ["duplicate"] = false });
            case "finish":
                Finished = JsonNode.Parse(await request.Content!.ReadAsStringAsync(ct))!.AsObject();
                return Json(new JsonObject { ["staged"] = 1, ["errors"] = 0 });
            default:
                return new HttpResponseMessage(HttpStatusCode.NotFound);
        }
    }

    private static HttpResponseMessage Json(JsonObject o) =>
        new(HttpStatusCode.OK) { Content = new StringContent(o.ToJsonString(), Encoding.UTF8, "application/json") };
}

public class RunnerTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), $"qbagent-{Guid.NewGuid():N}");
    private readonly FakeQuickBooks _qb = new();
    private readonly FakeServer _server = new();

    public RunnerTests()
    {
        Directory.CreateDirectory(_dir);
        _qb.Records["CustomerRet"] = Enumerable.Range(1, 7).Select(i => $"<CustomerRet><ListID>C{i}</ListID><Name>Customer {i}</Name></CustomerRet>").ToList();
        _qb.Records["InvoiceRet"] = Enumerable.Range(1, 5).Select(i => $"<InvoiceRet><TxnID>I{i}</TxnID><TxnDate>2023-0{i}-15</TxnDate></InvoiceRet>").ToList();
    }

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private MigrationRunner Runner(MigrationOptions? options = null, int maxAttempts = 3) =>
        new(
            _qb,
            new AgentApiClient(new Uri("https://books.example.com"), "qbm_testkeytestkeytestkeytestkey", _server, (_, _) => Task.CompletedTask) { MaxAttempts = maxAttempts },
            Checkpoint.Load(Path.Combine(_dir, "checkpoint.json"), "m1"),
            options ?? new MigrationOptions { PageSize = 3, BatchSize = 2, Today = new DateOnly(2025, 3, 31) });

    [Fact]
    public async Task Sends_everything_in_pages_and_batches_then_finishes()
    {
        await Runner().RunAsync(CancellationToken.None);
        Assert.Equal(7, _server.Raw["CustomerRet"].Count);
        Assert.Equal(5, _server.Raw["InvoiceRet"].Count);
        Assert.Equal("Test Co", (string?)_server.Raw["CompanyRet"]["company"]["CompanyName"]);
        // Customers page 3 at a time with an iterator; invoices from the first transaction's year.
        Assert.Equal(3, _qb.Requests.Count(r => r.Contains("CustomerQueryRq")));
        // Trial balances at each fiscal year end since the first transaction, and today; agings; a Journal per year.
        Assert.Equal(
            [("trial_balance", "2023-12-31"), ("trial_balance", "2024-12-31"), ("trial_balance", "2025-03-31"), ("ar_aging", "2025-03-31"), ("ap_aging", "2025-03-31"), ("journal", "2023-12-31"), ("journal", "2024-12-31"), ("journal", "2025-03-31")],
            _server.Reports);
        Assert.Equal("2025-03-31", (string?)_server.Finished!["asOf"]);
        Assert.Equal(7, (int)_server.Finished["counts"]!["CustomerRet"]!);
    }

    [Fact]
    public async Task Retries_a_busy_server()
    {
        _server.FailBatches = 2;
        await Runner(maxAttempts: 3).RunAsync(CancellationToken.None);
        Assert.Equal(7, _server.Raw["CustomerRet"].Count);
    }

    [Fact]
    public async Task Resumes_after_a_crash_without_reading_finished_lists_again()
    {
        _server.CrashAfterBatches = 3;
        await Assert.ThrowsAnyAsync<Exception>(() => Runner(maxAttempts: 1).RunAsync(CancellationToken.None));
        var before = _qb.Requests.Count;
        _server.CrashAfterBatches = null;
        await Runner().RunAsync(CancellationToken.None);
        Assert.Equal(7, _server.Raw["CustomerRet"].Count);
        Assert.Equal(5, _server.Raw["InvoiceRet"].Count);
        // Accounts, classes and terms were done before the crash and aren't asked for again.
        Assert.Equal(1, _qb.Requests.Take(before).Count(r => r.Contains("AccountQueryRq")));
        Assert.Equal(0, _qb.Requests.Skip(before).Count(r => r.Contains("AccountQueryRq")));
        Assert.NotNull(_server.Finished);
    }

    [Fact]
    public async Task Skips_a_query_an_older_QuickBooks_doesnt_know()
    {
        _qb.Unsupported.Add("TransferQueryRq");
        await Runner().RunAsync(CancellationToken.None);
        var checkpoint = Checkpoint.Load(Path.Combine(_dir, "checkpoint.json"), "m1");
        Assert.Contains("TransferRet", checkpoint.SkippedEntities.Keys);
        Assert.NotNull(_server.Finished);
    }

    [Fact]
    public async Task Uploads_the_attach_folder_once_and_sends_opening_balances_for_a_later_start()
    {
        var attach = Path.Combine(_dir, "Attach");
        Directory.CreateDirectory(Path.Combine(attach, "Txn", "4-1700000000"));
        await File.WriteAllTextAsync(Path.Combine(attach, "Txn", "4-1700000000", "receipt.pdf"), "%PDF-1.4");
        await File.WriteAllTextAsync(Path.Combine(attach, "~lock.tmp"), "x");
        await File.WriteAllTextAsync(Path.Combine(attach, "empty.pdf"), "");
        var options = new MigrationOptions { AttachFolder = attach, From = new DateOnly(2024, 1, 1), PageSize = 50, Today = new DateOnly(2025, 3, 31) };
        await Runner(options).RunAsync(CancellationToken.None);
        Assert.Equal(["Txn/4-1700000000/receipt.pdf"], _server.Files);
        Assert.Contains(("trial_balance", "2023-12-31"), _server.Reports);
        Assert.Contains(("ar_aging", "2023-12-31"), _server.Reports);
        Assert.Equal("2024-01-01", (string?)_server.Finished!["openingDate"]);
        Assert.Contains(_qb.Requests, r => r.Contains("<FromTxnDate>2024-01-01</FromTxnDate>"));
        // Running again sends nothing twice.
        await Runner(options).RunAsync(CancellationToken.None);
        Assert.Single(_server.Files);
    }

    [Fact]
    public void Refuses_a_key_that_isnt_one()
    {
        Assert.Throws<ArgumentException>(() => new AgentApiClient(new Uri("https://x.example"), "not-a-key"));
        Assert.Equal(TimeSpan.FromSeconds(60), AgentApiClient.Backoff(9));
    }
}
