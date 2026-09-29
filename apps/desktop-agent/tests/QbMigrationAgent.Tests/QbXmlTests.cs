using System.Xml.Linq;
using Xunit;

namespace QbMigrationAgent.Tests;

public class QbXmlTests
{
    [Fact]
    public void Converts_elements_to_the_json_the_server_reads()
    {
        var ret = XElement.Parse("""
            <InvoiceRet>
              <TxnID>4-1700000000</TxnID>
              <CustomerRef><ListID>80000001-1600000000</ListID><FullName>Baker Farms:Greenhouse</FullName></CustomerRef>
              <InvoiceLineRet><Amount>300.00</Amount></InvoiceLineRet>
              <InvoiceLineRet><Amount>25.00</Amount><Desc>Local delivery</Desc></InvoiceLineRet>
              <DataExtRet><DataExtName>Job no</DataExtName><DataExtValue>A-7</DataExtValue></DataExtRet>
            </InvoiceRet>
            """);
        var json = QbXmlConverter.ToObject(ret);
        Assert.Equal("4-1700000000", (string?)json["TxnID"]);
        Assert.Equal("Baker Farms:Greenhouse", (string?)json["CustomerRef"]!["FullName"]);
        // Repeated elements become arrays; single ones stay objects (the server accepts both).
        Assert.Equal(2, json["InvoiceLineRet"]!.AsArray().Count);
        Assert.Equal("A-7", (string?)json["DataExtRet"]!["DataExtValue"]);
    }

    [Fact]
    public void Never_uploads_tax_ids_ssns_or_card_numbers()
    {
        var ret = XElement.Parse("""<VendorRet><ListID>80-1</ListID><Name>Green Supply</Name><VendorTaxIdent>12-3456789</VendorTaxIdent><IsVendorEligibleFor1099>true</IsVendorEligibleFor1099></VendorRet>""");
        var json = QbXmlConverter.ToObject(ret).ToJsonString();
        Assert.DoesNotContain("12-3456789", json);
        Assert.Contains("IsVendorEligibleFor1099", json);

        var emp = XElement.Parse("""<EmployeeRet><ListID>90-1</ListID><Name>Ann Lee</Name><SSN>123-45-6789</SSN><BirthDate>1990-01-02</BirthDate></EmployeeRet>""");
        var e = QbXmlConverter.ToObject(emp).ToJsonString();
        Assert.DoesNotContain("123-45-6789", e);
        Assert.DoesNotContain("1990-01-02", e);

        var cust = XElement.Parse("""<CustomerRet><ListID>70-1</ListID><CreditCardInfo><CreditCardNumber>4111111111111111</CreditCardNumber></CreditCardInfo></CustomerRet>""");
        Assert.DoesNotContain("4111", QbXmlConverter.ToObject(cust).ToJsonString());
    }

    [Fact]
    public void Keeps_report_attributes()
    {
        var row = XElement.Parse("""<DataRow rowNumber="1"><RowData rowType="account" value="Utilities:Gas" /><ColData colID="1" value="Gas" /><ColData colID="2" value="120.00" /></DataRow>""");
        var json = QbXmlConverter.ToObject(row);
        Assert.Equal("Utilities:Gas", (string?)json["RowData"]!["value"]);
        Assert.Equal("120.00", (string?)json["ColData"]![1]!["value"]);
    }

    [Fact]
    public void Builds_queries_in_qbxml_order_and_continues_iterators()
    {
        var invoice = Queries.All.Single(q => q.Ret == "InvoiceRet");
        var start = XDocument.Parse(QbXmlRequests.Query(invoice, 100, null, new DateOnly(2023, 1, 1)));
        var rq = start.Root!.Element("QBXMLMsgsRq")!.Element("InvoiceQueryRq")!;
        Assert.Equal("Start", (string?)rq.Attribute("iterator"));
        Assert.Equal(
            ["MaxReturned", "TxnDateRangeFilter", "IncludeLineItems", "IncludeLinkedTxns"],
            rq.Elements().Select(e => e.Name.LocalName).ToArray());
        var next = XDocument.Parse(QbXmlRequests.Query(invoice, 100, "{abc}"));
        var rq2 = next.Root!.Element("QBXMLMsgsRq")!.Element("InvoiceQueryRq")!;
        Assert.Equal("Continue", (string?)rq2.Attribute("iterator"));
        Assert.Equal("{abc}", (string?)rq2.Attribute("iteratorID"));
        Assert.Equal(["MaxReturned"], rq2.Elements().Select(e => e.Name.LocalName).ToArray());

        var accounts = XDocument.Parse(QbXmlRequests.Query(Queries.All[0], 100, null));
        Assert.Contains("<ActiveStatus>All</ActiveStatus>", accounts.ToString(SaveOptions.DisableFormatting));
        Assert.Contains("<?qbxml version=\"13.0\"?>", QbXmlRequests.Company());
    }

    [Fact]
    public void Reads_status_and_iterator_position()
    {
        var r = QbXmlResponse.Parse(
            """<QBXML><QBXMLMsgsRs><CustomerQueryRs requestID="1" statusCode="0" statusSeverity="Info" statusMessage="Status OK" iteratorRemainingCount="3" iteratorID="{x}"><CustomerRet><ListID>1</ListID></CustomerRet></CustomerQueryRs></QBXMLMsgsRs></QBXML>""",
            "CustomerRet");
        Assert.True(r.Ok);
        Assert.Equal(3, r.IteratorRemaining);
        Assert.Equal("{x}", r.IteratorId);
        Assert.Single(r.Rets);
        var none = QbXmlResponse.Parse(
            """<QBXML><QBXMLMsgsRs><CheckQueryRs statusCode="1" statusSeverity="Info" statusMessage="A query request did not find a matching object in QuickBooks" /></QBXMLMsgsRs></QBXML>""",
            "CheckRet");
        Assert.True(none.Ok);
        Assert.Empty(none.Rets);
    }

    [Fact]
    public void Works_out_fiscal_years()
    {
        Assert.Equal(new DateOnly(2024, 7, 1), MigrationRunner.FiscalYearStart(new DateOnly(2025, 3, 1), 7));
        Assert.Equal(new DateOnly(2025, 6, 30), MigrationRunner.FiscalYearEnd(new DateOnly(2025, 3, 1), 7));
        Assert.Equal(new DateOnly(2024, 12, 31), MigrationRunner.FiscalYearEnd(new DateOnly(2024, 1, 1), 1));
    }
}
