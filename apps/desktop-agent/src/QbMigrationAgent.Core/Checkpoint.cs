using System.Text.Json;

namespace QbMigrationAgent;

/// <summary>
/// What has been sent, saved after every step, so a stopped or failed upload resumes where it
/// stopped. The server ignores duplicates, so resuming never double-counts.
/// </summary>
public sealed class Checkpoint
{
    public string MigrationId { get; set; } = "";
    public HashSet<string> DoneEntities { get; set; } = [];
    public Dictionary<string, string> SkippedEntities { get; set; } = [];
    public Dictionary<string, int> Counts { get; set; } = [];
    public HashSet<string> DoneReports { get; set; } = [];
    public HashSet<string> DoneFiles { get; set; } = [];
    public string? FirstTxnDate { get; set; }
    public bool Finished { get; set; }

    private string? _path;

    public static Checkpoint Load(string path, string migrationId)
    {
        Checkpoint? c = null;
        if (File.Exists(path))
        {
            try
            {
                c = JsonSerializer.Deserialize<Checkpoint>(File.ReadAllText(path));
            }
            catch (JsonException)
            {
                c = null;
            }
        }
        // A checkpoint for another migration (a new pairing key) starts over.
        if (c is null || c.MigrationId != migrationId) c = new Checkpoint { MigrationId = migrationId };
        c._path = path;
        return c;
    }

    public void Save()
    {
        if (_path is null) return;
        Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
        var tmp = _path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(this, new JsonSerializerOptions { WriteIndented = true }));
        File.Move(tmp, _path, overwrite: true);
    }

    public static string DefaultPath(string migrationId) =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "QbMigrationAgent", $"{migrationId}.json");
}

/// <summary>The company's Attach (Doc Center) folder: every file, by its path relative to the folder.</summary>
public static class AttachFolder
{
    public const long MaxBytes = 25L * 1024 * 1024;

    public static IEnumerable<(string RelativePath, string FullPath)> Files(string root)
    {
        if (!Directory.Exists(root)) yield break;
        var options = new EnumerationOptions
        {
            RecurseSubdirectories = true,
            IgnoreInaccessible = true,
            AttributesToSkip = FileAttributes.Hidden | FileAttributes.System,
        };
        foreach (var path in Directory.EnumerateFiles(root, "*", options).OrderBy(p => p, StringComparer.OrdinalIgnoreCase))
        {
            var name = Path.GetFileName(path);
            if (name.StartsWith('~') || name.Equals("Thumbs.db", StringComparison.OrdinalIgnoreCase) || name.EndsWith(".tmp", StringComparison.OrdinalIgnoreCase))
                continue;
            yield return (Path.GetRelativePath(root, path).Replace('\\', '/'), path);
        }
    }

    /// <summary>Where QuickBooks keeps attachments for a company file, when it exists.</summary>
    public static string? Guess(string? companyFilePath)
    {
        if (string.IsNullOrEmpty(companyFilePath)) return null;
        var dir = Path.GetDirectoryName(companyFilePath);
        var company = Path.GetFileNameWithoutExtension(companyFilePath);
        if (dir is null) return null;
        foreach (var candidate in new[] { Path.Combine(dir, "Attach", company), Path.Combine(dir, "Attach") })
            if (Directory.Exists(candidate)) return candidate;
        return null;
    }
}
