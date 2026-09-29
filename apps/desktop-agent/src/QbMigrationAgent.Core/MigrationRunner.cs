using System.Text.Json.Nodes;
using System.Xml.Linq;

namespace QbMigrationAgent;

/// <summary>A connection to the open QuickBooks company file (the SDK's request processor on Windows).</summary>
public interface IQuickBooksSession : IDisposable
{
    /// <summary>The open company file's path, when QuickBooks reports it.</summary>
    string? CompanyFilePath { get; }

    /// <summary>Sends a qbXML request and returns QuickBooks' qbXML response.</summary>
    string ProcessRequest(string qbXml);
}

public sealed record MigrationOptions
{
    /// <summary>The Attach folder to upload; null skips attachments.</summary>
    public string? AttachFolder { get; init; }

    /// <summary>First day to import. Earlier years arrive as opening balances (null: all years).</summary>
    public DateOnly? From { get; init; }

    public int PageSize { get; init; } = 200;
    public int BatchSize { get; init; } = 500;
    public DateOnly Today { get; init; } = DateOnly.FromDateTime(DateTime.Today);
}

public sealed record ProgressEvent(string Step, string Message, double Fraction);

/// <summary>
/// The whole Desktop migration: read every list and transaction through qbXML, send them in
/// batches, then QuickBooks' own trial balances, agings and Journal, then the Attach folder, then
/// tell the server it has everything. Each step is checkpointed, so a rerun resumes.
/// </summary>
public sealed class MigrationRunner(IQuickBooksSession qb, AgentApiClient api, Checkpoint checkpoint, MigrationOptions options, IProgress<ProgressEvent>? progress = null)
{
    public async Task<JsonObject> RunAsync(CancellationToken ct)
    {
        var session = await api.SessionAsync(ct).ConfigureAwait(false);
        Report("Connect", $"Uploading to {session.CompanyName}", 0);

        var company = Single(QbXmlRequests.Company(), "CompanyRet");
        if (!checkpoint.DoneEntities.Contains("CompanyRet") && company is not null)
        {
            await api.BatchAsync("CompanyRet", [QbXmlConverter.ToObject(company)], ct).ConfigureAwait(false);
            checkpoint.DoneEntities.Add("CompanyRet");
            checkpoint.Save();
        }
        var fyStartMonth = int.TryParse(FirstMonth(company), out var m) && m is >= 1 and <= 12 ? m : 1;

        // 1. Lists and transactions.
        var queries = Queries.All;
        for (var i = 0; i < queries.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            var q = queries[i];
            if (checkpoint.DoneEntities.Contains(q.Ret) || checkpoint.SkippedEntities.ContainsKey(q.Ret)) continue;
            Report("Records", $"Reading {Label(q.Ret)}", 0.05 + 0.55 * i / queries.Count);
            try
            {
                var count = await SendQueryAsync(q, ct).ConfigureAwait(false);
                checkpoint.Counts[q.Ret] = count;
                checkpoint.DoneEntities.Add(q.Ret);
            }
            catch (QuickBooksException e)
            {
                // An older QuickBooks may not support a query: the Journal still carries its GL lines.
                checkpoint.SkippedEntities[q.Ret] = e.Message;
                Report("Records", $"Skipped {Label(q.Ret)}: {e.Message}", 0.05 + 0.55 * i / queries.Count);
            }
            checkpoint.Save();
        }

        // 2. QuickBooks' own figures, for the Migration Report.
        var first = options.From ?? (checkpoint.FirstTxnDate is { } fd ? DateOnly.Parse(fd, System.Globalization.CultureInfo.InvariantCulture) : options.Today);
        var last = options.Today;
        var reports = new List<(string Key, Func<Task> Send)>();
        for (var end = FiscalYearEnd(first, fyStartMonth); end < last; end = FiscalYearEnd(end.AddDays(1), fyStartMonth))
        {
            var e = end;
            reports.Add(($"tb:{e}", () => SendReportAsync("trial_balance", e, null, QbXmlRequests.TrialBalance(FiscalYearStart(e, fyStartMonth), e), ct)));
        }
        reports.Add(($"tb:{last}", () => SendReportAsync("trial_balance", last, null, QbXmlRequests.TrialBalance(FiscalYearStart(last, fyStartMonth), last), ct)));
        reports.Add(($"ar:{last}", () => SendReportAsync("ar_aging", last, null, QbXmlRequests.Aging("ARAgingSummary", last), ct)));
        reports.Add(($"ap:{last}", () => SendReportAsync("ap_aging", last, null, QbXmlRequests.Aging("APAgingSummary", last), ct)));
        if (options.From is { } from)
        {
            // Balances brought forward: the trial balance and agings the day before the first day.
            var before = from.AddDays(-1);
            reports.Add(($"tb:{before}", () => SendReportAsync("trial_balance", before, null, QbXmlRequests.TrialBalance(FiscalYearStart(before, fyStartMonth), before), ct)));
            reports.Add(($"ar:{before}", () => SendReportAsync("ar_aging", before, null, QbXmlRequests.Aging("ARAgingSummary", before), ct)));
            reports.Add(($"ap:{before}", () => SendReportAsync("ap_aging", before, null, QbXmlRequests.Aging("APAgingSummary", before), ct)));
        }
        // The Journal year by year keeps each response a manageable size.
        for (var start = FiscalYearStart(first, fyStartMonth); start <= last; start = FiscalYearEnd(start, fyStartMonth).AddDays(1))
        {
            var s = start;
            var e = FiscalYearEnd(s, fyStartMonth) < last ? FiscalYearEnd(s, fyStartMonth) : last;
            reports.Add(($"journal:{s}", () => SendReportAsync("journal", e, s, QbXmlRequests.Journal(s, e), ct)));
        }
        for (var i = 0; i < reports.Count; i++)
        {
            ct.ThrowIfCancellationRequested();
            if (checkpoint.DoneReports.Contains(reports[i].Key)) continue;
            Report("Reports", $"Reading QuickBooks reports ({i + 1} of {reports.Count})", 0.6 + 0.15 * i / reports.Count);
            await reports[i].Send().ConfigureAwait(false);
            checkpoint.DoneReports.Add(reports[i].Key);
            checkpoint.Save();
        }

        // 3. Attachments.
        if (options.AttachFolder is { } folder)
        {
            var files = AttachFolder.Files(folder).ToList();
            var already = new HashSet<string>(session.Attachments, StringComparer.Ordinal);
            for (var i = 0; i < files.Count; i++)
            {
                ct.ThrowIfCancellationRequested();
                var (rel, full) = files[i];
                if (checkpoint.DoneFiles.Contains(rel) || already.Contains(rel)) continue;
                Report("Attachments", $"Uploading {rel}", 0.75 + 0.2 * i / Math.Max(1, files.Count));
                var info = new FileInfo(full);
                if (info.Length is 0 or > AttachFolder.MaxBytes)
                {
                    checkpoint.DoneFiles.Add(rel);
                    continue;
                }
                var result = await api.AttachmentAsync(rel, await File.ReadAllBytesAsync(full, ct).ConfigureAwait(false), ct).ConfigureAwait(false);
                if (result.Refused is not null) Report("Attachments", $"Not accepted: {rel} ({result.Refused})", 0.75 + 0.2 * i / Math.Max(1, files.Count));
                checkpoint.DoneFiles.Add(rel);
                checkpoint.Save();
            }
        }

        // 4. Done: the server maps everything.
        Report("Finish", "Preparing the import", 0.97);
        var finish = new JsonObject
        {
            ["companyName"] = company?.Element("CompanyName")?.Value,
            ["asOf"] = QbXmlRequests.Date(last),
            ["counts"] = new JsonObject(checkpoint.Counts.Select(kv => KeyValuePair.Create(kv.Key, (JsonNode?)kv.Value))),
        };
        if (options.From is { } f2) finish["openingDate"] = QbXmlRequests.Date(f2);
        var result2 = await api.FinishAsync(finish, ct).ConfigureAwait(false);
        checkpoint.Finished = true;
        checkpoint.Save();
        Report("Finish", "Everything is uploaded. Run the import in the app.", 1);
        return result2;
    }

    private async Task<int> SendQueryAsync(QueryDefinition q, CancellationToken ct)
    {
        var total = 0;
        string? iterator = null;
        var batch = new List<JsonObject>();
        while (true)
        {
            var response = QbXmlResponse.Parse(qb.ProcessRequest(QbXmlRequests.Query(q, options.PageSize, iterator, q.IsList ? null : options.From)), q.Ret);
            if (!response.Ok) throw new QuickBooksException(response.StatusCode, response.Message);
            foreach (var ret in response.Rets)
            {
                // The earliest transaction decides which fiscal years get a trial balance.
                if (!q.IsList && ret.Element("TxnDate")?.Value is { } d && (checkpoint.FirstTxnDate is null || string.CompareOrdinal(d, checkpoint.FirstTxnDate) < 0))
                    checkpoint.FirstTxnDate = d;
                batch.Add(QbXmlConverter.ToObject(ret));
                if (batch.Count >= options.BatchSize)
                {
                    await api.BatchAsync(q.Ret, batch, ct).ConfigureAwait(false);
                    total += batch.Count;
                    batch.Clear();
                }
            }
            if (!q.Iterator || response.IteratorRemaining <= 0 || response.IteratorId is null) break;
            iterator = response.IteratorId;
        }
        if (batch.Count > 0)
        {
            await api.BatchAsync(q.Ret, batch, ct).ConfigureAwait(false);
            total += batch.Count;
        }
        return total;
    }

    private async Task SendReportAsync(string kind, DateOnly asOf, DateOnly? from, string request, CancellationToken ct)
    {
        var xml = XDocument.Parse(qb.ProcessRequest(request));
        var rs = xml.Root?.Element("QBXMLMsgsRs")?.Elements().FirstOrDefault();
        var report = rs?.Element("ReportRet");
        if (report is null)
        {
            var message = (string?)rs?.Attribute("statusMessage") ?? "QuickBooks returned no report";
            throw new QuickBooksException(-1, message);
        }
        await api.ReportAsync(kind, asOf, from, QbXmlConverter.ToObject(report), ct).ConfigureAwait(false);
    }

    private XElement? Single(string request, string ret) => QbXmlResponse.Parse(qb.ProcessRequest(request), ret).Rets.FirstOrDefault();

    private static string? FirstMonth(XElement? company)
    {
        var v = company?.Element("FirstMonthFiscalYear")?.Value;
        if (v is null) return null;
        var months = new[] { "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December" };
        var i = Array.FindIndex(months, x => x.Equals(v, StringComparison.OrdinalIgnoreCase));
        return i >= 0 ? (i + 1).ToString(System.Globalization.CultureInfo.InvariantCulture) : v;
    }

    public static DateOnly FiscalYearStart(DateOnly d, int startMonth) =>
        new(d.Month >= startMonth ? d.Year : d.Year - 1, startMonth, 1);

    public static DateOnly FiscalYearEnd(DateOnly d, int startMonth) => FiscalYearStart(d, startMonth).AddYears(1).AddDays(-1);

    private static string Label(string ret) =>
        System.Text.RegularExpressions.Regex.Replace(ret.Replace("Ret", ""), "(?<=[a-z])(?=[A-Z])", " ").ToLowerInvariant() + "s";

    private void Report(string step, string message, double fraction) => progress?.Report(new ProgressEvent(step, message, fraction));
}
