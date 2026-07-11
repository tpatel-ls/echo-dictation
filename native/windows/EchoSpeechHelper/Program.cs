using System.Globalization;
using System.Speech.Recognition;
using System.Text.Json;

internal static class Program
{
    public static int Main(string[] args)
    {
        if (args.Contains("--check"))
        {
            WriteStatus("check");
            return HasEnglishRecognizer() ? 0 : 2;
        }

        if (args.Contains("--server")) WriteStatus("ready");
        string? line;
        while ((line = Console.ReadLine()) is not null) Handle(line);
        return 0;
    }

    private static void Handle(string line)
    {
        string? id = null;
        try
        {
            using var json = JsonDocument.Parse(line);
            var root = json.RootElement;
            var type = root.GetProperty("type").GetString();
            if (type == "check")
            {
                WriteStatus("check");
                return;
            }
            if (type != "transcribe") throw new InvalidDataException("Unknown request type");
            id = root.GetProperty("id").GetString();
            var path = root.GetProperty("path").GetString() ?? throw new InvalidDataException("Missing path");
            var locale = root.TryGetProperty("locale", out var localeValue) ? localeValue.GetString() ?? "en-US" : "en-US";
            var started = Environment.TickCount64;
            var text = Transcribe(path, locale);
            Write(new { type = "result", id, text, elapsedMs = Environment.TickCount64 - started, engine = "System.Speech" });
        }
        catch (Exception error)
        {
            Write(new { type = "error", id, code = "recognition-failed", message = error.Message });
        }
    }

    private static string Transcribe(string path, string locale)
    {
        if (!File.Exists(path)) throw new FileNotFoundException("Audio file does not exist", path);
        var culture = CultureInfo.GetCultureInfo(locale);
        var info = SpeechRecognitionEngine.InstalledRecognizers()
            .FirstOrDefault(item => item.Culture.Name.Equals(culture.Name, StringComparison.OrdinalIgnoreCase))
            ?? throw new InvalidOperationException($"Windows English speech pack {locale} is not installed");
        using var engine = new SpeechRecognitionEngine(info);
        engine.LoadGrammar(new DictationGrammar());
        engine.SetInputToWaveFile(path);
        var result = engine.Recognize(TimeSpan.FromSeconds(55));
        return result?.Text?.Trim() ?? "";
    }

    private static bool HasEnglishRecognizer() => SpeechRecognitionEngine.InstalledRecognizers()
        .Any(item => item.Culture.Name.Equals("en-US", StringComparison.OrdinalIgnoreCase));

    private static void WriteStatus(string type) => Write(new
    {
        type,
        engine = "System.Speech",
        authorization = "not-required",
        localeAvailable = HasEnglishRecognizer(),
        installedLocales = SpeechRecognitionEngine.InstalledRecognizers().Select(item => item.Culture.Name).ToArray()
    });

    private static void Write(object value) => Console.WriteLine(JsonSerializer.Serialize(value));
}
