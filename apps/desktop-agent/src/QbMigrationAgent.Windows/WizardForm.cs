namespace QbMigrationAgent.Windows;

/// <summary>
/// The agent's wizard: 1) the server and pairing key, 2) connect to the open QuickBooks company,
/// 3) years and the Attach folder, 4) upload with progress (resumable), 5) done.
/// </summary>
public sealed class WizardForm : Form
{
    private const string AppName = "QuickBooks migration agent";
    private readonly TextBox _server = new() { Width = 420, Text = "https://" };
    private readonly TextBox _key = new() { Width = 420, UseSystemPasswordChar = true };
    private readonly Label _company = new() { AutoSize = true, Text = "Not connected" };
    private readonly RadioButton _allYears = new() { Text = "All years (recommended: the Migration Report can check every year)", AutoSize = true, Checked = true };
    private readonly RadioButton _fromYear = new() { Text = "From the start of", AutoSize = true };
    private readonly NumericUpDown _year = new() { Minimum = 1990, Maximum = 2100, Value = DateTime.Today.Year - 2, Width = 80 };
    private readonly TextBox _attach = new() { Width = 360 };
    private readonly ProgressBar _bar = new() { Width = 520, Maximum = 1000 };
    private readonly Label _status = new() { AutoSize = true, MaximumSize = new Size(520, 0) };
    private readonly ListBox _log = new() { Width = 520, Height = 180 };
    private readonly Button _connect = new() { Text = "Connect to QuickBooks", AutoSize = true };
    private readonly Button _start = new() { Text = "Start upload", AutoSize = true, Enabled = false };
    private readonly Button _cancel = new() { Text = "Stop", AutoSize = true, Enabled = false };
    private IQuickBooksSession? _qb;
    private CancellationTokenSource? _cts;

    public WizardForm()
    {
        Text = AppName;
        AutoSize = true;
        AutoSizeMode = AutoSizeMode.GrowAndShrink;
        Padding = new Padding(16);
        StartPosition = FormStartPosition.CenterScreen;
        Font = new Font("Segoe UI", 9.5f);

        var browse = new Button { Text = "Browse…", AutoSize = true };
        browse.Click += (_, _) =>
        {
            using var dialog = new FolderBrowserDialog { Description = "The company's Attach (Doc Center) folder" };
            if (dialog.ShowDialog(this) == DialogResult.OK) _attach.Text = dialog.SelectedPath;
        };
        _connect.Click += (_, _) => Connect();
        _start.Click += async (_, _) => await StartAsync();
        _cancel.Click += (_, _) => _cts?.Cancel();

        var layout = new TableLayoutPanel { ColumnCount = 1, AutoSize = true, Dock = DockStyle.Fill };
        void Step(string title, params Control[] controls)
        {
            layout.Controls.Add(new Label { Text = title, AutoSize = true, Font = new Font(Font, FontStyle.Bold), Margin = new Padding(0, 12, 0, 4) });
            var row = new FlowLayoutPanel { AutoSize = true, FlowDirection = FlowDirection.TopDown, WrapContents = false };
            row.Controls.AddRange(controls);
            layout.Controls.Add(row);
        }
        Step(
            "1. Your migration",
            new Label { Text = "Server address (the address you sign in at):", AutoSize = true },
            _server,
            new Label { Text = "Pairing key (Migration › QuickBooks Desktop › Create a pairing key):", AutoSize = true },
            _key);
        Step(
            "2. QuickBooks",
            new Label { Text = "Open the company file in QuickBooks Desktop (single-user mode, as an administrator), then:", AutoSize = true, MaximumSize = new Size(520, 0) },
            _connect,
            _company);
        var yearRow = new FlowLayoutPanel { AutoSize = true };
        yearRow.Controls.AddRange([_fromYear, _year, new Label { Text = "(earlier years come in as opening balances)", AutoSize = true }]);
        var attachRow = new FlowLayoutPanel { AutoSize = true };
        attachRow.Controls.AddRange([_attach, browse]);
        Step("3. What to bring", _allYears, yearRow, new Label { Text = "Attach folder (leave empty to skip attachments):", AutoSize = true }, attachRow);
        var buttons = new FlowLayoutPanel { AutoSize = true };
        buttons.Controls.AddRange([_start, _cancel]);
        Step("4. Upload", buttons, _bar, _status, _log);
        Controls.Add(layout);
        FormClosing += (_, _) => _qb?.Dispose();
    }

    private void Connect()
    {
        try
        {
            _qb?.Dispose();
            _qb = new QbXmlRp2Session(AppName);
            var company = QbXmlResponse.Parse(_qb.ProcessRequest(QbXmlRequests.Company()), "CompanyRet").Rets.FirstOrDefault();
            _company.Text = $"Connected: {company?.Element("CompanyName")?.Value ?? "company file"}";
            if (string.IsNullOrEmpty(_attach.Text)) _attach.Text = AttachFolder.Guess(_qb.CompanyFilePath) ?? "";
            _start.Enabled = true;
        }
        catch (Exception e)
        {
            MessageBox.Show(this, e.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
    }

    private async Task StartAsync()
    {
        if (_qb is null) return;
        if (!Uri.TryCreate(_server.Text.Trim(), UriKind.Absolute, out var server) || server.Scheme != Uri.UriSchemeHttps)
        {
            MessageBox.Show(this, "Enter the server address, starting with https://", AppName);
            return;
        }
        _start.Enabled = false;
        _connect.Enabled = false;
        _cancel.Enabled = true;
        _cts = new CancellationTokenSource();
        var progress = new Progress<ProgressEvent>(p =>
        {
            _bar.Value = (int)Math.Clamp(p.Fraction * 1000, 0, 1000);
            _status.Text = p.Message;
            _log.Items.Add($"{DateTime.Now:T}  {p.Message}");
            _log.TopIndex = Math.Max(0, _log.Items.Count - 1);
        });
        try
        {
            var api = new AgentApiClient(server, _key.Text.Trim());
            var session = await api.SessionAsync(_cts.Token);
            var checkpoint = Checkpoint.Load(Checkpoint.DefaultPath(session.MigrationId), session.MigrationId);
            var options = new MigrationOptions
            {
                AttachFolder = string.IsNullOrWhiteSpace(_attach.Text) ? null : _attach.Text,
                From = _fromYear.Checked ? new DateOnly((int)_year.Value, 1, 1) : null,
            };
            await Task.Run(() => new MigrationRunner(_qb, api, checkpoint, options, progress).RunAsync(_cts.Token));
            MessageBox.Show(this, "Everything is uploaded. Go back to the app and run the import.", AppName);
        }
        catch (OperationCanceledException)
        {
            _status.Text = "Stopped. Start again to resume where it stopped.";
        }
        catch (Exception e)
        {
            _status.Text = $"Stopped: {e.Message} Start again to resume.";
            MessageBox.Show(this, e.Message, AppName, MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        finally
        {
            _start.Enabled = true;
            _connect.Enabled = true;
            _cancel.Enabled = false;
        }
    }
}
