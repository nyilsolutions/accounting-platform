using System.Runtime.InteropServices;

namespace QbMigrationAgent.Windows;

/// <summary>
/// The QuickBooks SDK's request processor (QBXMLRP2, installed with QuickBooks Desktop), used by
/// late binding so no SDK reference is needed to build. QuickBooks asks the user, the first time,
/// whether to let this application read the company file.
/// </summary>
public sealed class QbXmlRp2Session : IQuickBooksSession
{
    private const int LocalQbd = 1;
    private const int FileOpenDoNotCare = 2;
    private readonly dynamic _rp;
    private readonly string _ticket;

    public string? CompanyFilePath { get; }

    public QbXmlRp2Session(string appName)
    {
        var type = Type.GetTypeFromProgID("QBXMLRP2.RequestProcessor")
            ?? throw new InvalidOperationException("QuickBooks Desktop isn't installed on this computer (its SDK request processor wasn't found).");
        _rp = Activator.CreateInstance(type)!;
        try
        {
            _rp.OpenConnection2("", appName, LocalQbd);
            _ticket = _rp.BeginSession("", FileOpenDoNotCare);
            CompanyFilePath = _rp.GetCurrentCompanyFileName(_ticket) as string;
        }
        catch (COMException e)
        {
            throw new InvalidOperationException($"Couldn't connect to QuickBooks: {e.Message}. Open the company file in QuickBooks Desktop as an administrator, in single-user mode, and try again.", e);
        }
    }

    public string ProcessRequest(string qbXml)
    {
        try
        {
            return (string)_rp.ProcessRequest(_ticket, qbXml);
        }
        catch (COMException e)
        {
            throw new QuickBooksException(e.HResult, e.Message);
        }
    }

    public void Dispose()
    {
        try
        {
            _rp.EndSession(_ticket);
            _rp.CloseConnection();
        }
        catch (COMException)
        {
        }
        Marshal.FinalReleaseComObject(_rp);
    }
}
