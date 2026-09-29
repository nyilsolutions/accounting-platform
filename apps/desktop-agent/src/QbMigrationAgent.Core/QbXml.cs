using System.Globalization;
using System.Security;
using System.Text;
using System.Text.Json.Nodes;
using System.Xml.Linq;

namespace QbMigrationAgent;

/// <summary>What the agent asks QuickBooks for: a list or transaction query, run with an iterator when QuickBooks supports one.</summary>
public sealed record QueryDefinition(
    string Request,
    string Ret,
    bool Iterator,
    bool IsList,
    bool LineItems = false,
    bool LinkedTxns = false);

/// <summary>
/// Every query the agent runs, in dependency order. The server maps the results (the agent stays
/// thin, so mapping fixes never need a new agent). Paychecks, inventory adjustments and other
/// types without a query here arrive through the Journal report.
/// </summary>
public static class Queries
{
    public static readonly IReadOnlyList<QueryDefinition> All =
    [
        new("AccountQueryRq", "AccountRet", Iterator: false, IsList: true),
        new("ClassQueryRq", "ClassRet", Iterator: false, IsList: true),
        new("StandardTermsQueryRq", "StandardTermsRet", Iterator: false, IsList: true),
        new("DateDrivenTermsQueryRq", "DateDrivenTermsRet", Iterator: false, IsList: true),
        new("PaymentMethodQueryRq", "PaymentMethodRet", Iterator: false, IsList: true),
        new("CustomerQueryRq", "CustomerRet", Iterator: true, IsList: true),
        new("VendorQueryRq", "VendorRet", Iterator: true, IsList: true),
        new("EmployeeQueryRq", "EmployeeRet", Iterator: true, IsList: true),
        new("OtherNameQueryRq", "OtherNameRet", Iterator: true, IsList: true),
        new("ItemServiceQueryRq", "ItemServiceRet", Iterator: true, IsList: true),
        new("ItemNonInventoryQueryRq", "ItemNonInventoryRet", Iterator: true, IsList: true),
        new("ItemOtherChargeQueryRq", "ItemOtherChargeRet", Iterator: true, IsList: true),
        new("ItemInventoryQueryRq", "ItemInventoryRet", Iterator: true, IsList: true),
        new("ItemInventoryAssemblyQueryRq", "ItemInventoryAssemblyRet", Iterator: true, IsList: true),
        new("ItemGroupQueryRq", "ItemGroupRet", Iterator: true, IsList: true),
        new("ItemDiscountQueryRq", "ItemDiscountRet", Iterator: true, IsList: true),
        new("ItemSalesTaxQueryRq", "ItemSalesTaxRet", Iterator: true, IsList: true),
        new("ItemSalesTaxGroupQueryRq", "ItemSalesTaxGroupRet", Iterator: true, IsList: true),
        new("ItemSubtotalQueryRq", "ItemSubtotalRet", Iterator: true, IsList: true),
        new("ItemPaymentQueryRq", "ItemPaymentRet", Iterator: true, IsList: true),
        new("EstimateQueryRq", "EstimateRet", Iterator: true, IsList: false, LineItems: true, LinkedTxns: true),
        new("InvoiceQueryRq", "InvoiceRet", Iterator: true, IsList: false, LineItems: true, LinkedTxns: true),
        new("SalesReceiptQueryRq", "SalesReceiptRet", Iterator: true, IsList: false, LineItems: true),
        new("CreditMemoQueryRq", "CreditMemoRet", Iterator: true, IsList: false, LineItems: true, LinkedTxns: true),
        new("ReceivePaymentQueryRq", "ReceivePaymentRet", Iterator: true, IsList: false, LineItems: true),
        new("DepositQueryRq", "DepositRet", Iterator: true, IsList: false, LineItems: true),
        new("PurchaseOrderQueryRq", "PurchaseOrderRet", Iterator: true, IsList: false, LineItems: true, LinkedTxns: true),
        new("BillQueryRq", "BillRet", Iterator: true, IsList: false, LineItems: true, LinkedTxns: true),
        new("VendorCreditQueryRq", "VendorCreditRet", Iterator: true, IsList: false, LineItems: true, LinkedTxns: true),
        new("CheckQueryRq", "CheckRet", Iterator: true, IsList: false, LineItems: true),
        new("CreditCardChargeQueryRq", "CreditCardChargeRet", Iterator: true, IsList: false, LineItems: true),
        new("CreditCardCreditQueryRq", "CreditCardCreditRet", Iterator: true, IsList: false, LineItems: true),
        new("BillPaymentCheckQueryRq", "BillPaymentCheckRet", Iterator: true, IsList: false, LineItems: true),
        new("BillPaymentCreditCardQueryRq", "BillPaymentCreditCardRet", Iterator: true, IsList: false, LineItems: true),
        new("TransferQueryRq", "TransferRet", Iterator: true, IsList: false),
        new("JournalEntryQueryRq", "JournalEntryRet", Iterator: true, IsList: false, LineItems: true),
    ];
}

/// <summary>Builds qbXML requests. Element order matters to QuickBooks and follows the qbXML schema.</summary>
public static class QbXmlRequests
{
    public const string Version = "13.0";

    public static string Wrap(string body) =>
        $"<?xml version=\"1.0\" encoding=\"utf-8\"?>\n<?qbxml version=\"{Version}\"?>\n<QBXML><QBXMLMsgsRq onError=\"stopOnError\">{body}</QBXMLMsgsRq></QBXML>";

    public static string Company() => Wrap("<CompanyQueryRq requestID=\"1\" />");

    /// <summary>A query; `iteratorId` continues an iterator started by an earlier call.</summary>
    public static string Query(QueryDefinition q, int maxReturned, string? iteratorId, DateOnly? from = null)
    {
        var attrs = new StringBuilder($" requestID=\"1\"");
        if (q.Iterator)
            attrs.Append(iteratorId is null ? " iterator=\"Start\"" : $" iterator=\"Continue\" iteratorID=\"{Escape(iteratorId)}\"");
        var body = new StringBuilder();
        if (q.Iterator) body.Append($"<MaxReturned>{maxReturned}</MaxReturned>");
        // An iterator remembers the rest of its query.
        if (iteratorId is not null) return Wrap($"<{q.Request}{attrs}>{body}</{q.Request}>");
        if (q.IsList) body.Append("<ActiveStatus>All</ActiveStatus>");
        else if (from is { } f)
            body.Append($"<TxnDateRangeFilter><FromTxnDate>{Date(f)}</FromTxnDate></TxnDateRangeFilter>");
        if (q.LineItems) body.Append("<IncludeLineItems>true</IncludeLineItems>");
        if (q.LinkedTxns) body.Append("<IncludeLinkedTxns>true</IncludeLinkedTxns>");
        return Wrap($"<{q.Request}{attrs}>{body}</{q.Request}>");
    }

    public static string TrialBalance(DateOnly from, DateOnly to) =>
        Wrap(
            "<GeneralSummaryReportQueryRq requestID=\"1\">" +
            "<GeneralSummaryReportType>TrialBalance</GeneralSummaryReportType>" +
            $"<ReportPeriod><FromReportDate>{Date(from)}</FromReportDate><ToReportDate>{Date(to)}</ToReportDate></ReportPeriod>" +
            "<ReportBasis>Accrual</ReportBasis>" +
            "</GeneralSummaryReportQueryRq>");

    public static string Aging(string type, DateOnly asOf) =>
        Wrap(
            "<AgingReportQueryRq requestID=\"1\">" +
            $"<AgingReportType>{type}</AgingReportType>" +
            $"<ReportPeriod><ToReportDate>{Date(asOf)}</ToReportDate></ReportPeriod>" +
            "</AgingReportQueryRq>");

    /// <summary>The Journal: every transaction's GL lines, with its TxnID.</summary>
    public static string Journal(DateOnly from, DateOnly to)
    {
        var columns = string.Concat(
            new[] { "TxnID", "TxnType", "Date", "RefNumber", "Name", "Memo", "Account", "Debit", "Credit" }
                .Select(c => $"<IncludeColumn>{c}</IncludeColumn>"));
        return Wrap(
            "<GeneralDetailReportQueryRq requestID=\"1\">" +
            "<GeneralDetailReportType>Journal</GeneralDetailReportType>" +
            $"<ReportPeriod><FromReportDate>{Date(from)}</FromReportDate><ToReportDate>{Date(to)}</ToReportDate></ReportPeriod>" +
            columns +
            "<ReportBasis>Accrual</ReportBasis>" +
            "</GeneralDetailReportQueryRq>");
    }

    public static string Date(DateOnly d) => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    private static string Escape(string v) => SecurityElement.Escape(v) ?? "";
}

/// <summary>One qbXML response: status, iterator position, and the Ret elements.</summary>
public sealed record QbXmlResponse(int StatusCode, string Severity, string Message, int IteratorRemaining, string? IteratorId, IReadOnlyList<XElement> Rets)
{
    /// <summary>Status 1: "no matching objects", which is an empty result, not an error.</summary>
    public bool Ok => StatusCode == 0 || StatusCode == 1 || Severity == "Info" || Severity == "Warn";

    public static QbXmlResponse Parse(string xml, string retName)
    {
        var doc = XDocument.Parse(xml);
        var rs = doc.Root?.Element("QBXMLMsgsRs")?.Elements().FirstOrDefault()
            ?? throw new QuickBooksException(-1, "QuickBooks returned an empty response.");
        int.TryParse((string?)rs.Attribute("statusCode"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var code);
        int.TryParse((string?)rs.Attribute("iteratorRemainingCount"), NumberStyles.Integer, CultureInfo.InvariantCulture, out var remaining);
        return new QbXmlResponse(
            code,
            (string?)rs.Attribute("statusSeverity") ?? "",
            (string?)rs.Attribute("statusMessage") ?? "",
            remaining,
            (string?)rs.Attribute("iteratorID"),
            rs.Elements(retName).ToList());
    }
}

public sealed class QuickBooksException(int code, string message) : Exception(message)
{
    public int Code { get; } = code;
}

/// <summary>
/// qbXML elements → JSON, the shape the server's mapper reads: attributes and child elements
/// become properties, repeated children become arrays, and a leaf's text becomes a string.
/// </summary>
public static class QbXmlConverter
{
    public static JsonNode? ToJson(XElement e)
    {
        var children = e.Elements().ToList();
        if (children.Count == 0 && !e.HasAttributes) return JsonValue.Create(e.Value);
        var o = new JsonObject();
        foreach (var a in e.Attributes()) o[a.Name.LocalName] = a.Value;
        if (children.Count == 0 && e.Value.Length > 0) o["#text"] = e.Value;
        foreach (var group in children.GroupBy(c => c.Name.LocalName))
        {
            var items = group.ToList();
            if (items.Count == 1) o[group.Key] = ToJson(items[0]);
            else
            {
                var arr = new JsonArray();
                foreach (var item in items) arr.Add(ToJson(item));
                o[group.Key] = arr;
            }
        }
        return o;
    }

    public static JsonObject ToObject(XElement e) => ToJson(e) as JsonObject ?? new JsonObject();
}
