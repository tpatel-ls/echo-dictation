using System.IO;
using System.Text;
using System.Text.Json;

namespace EchoMeetingHelper;

/// <summary>
/// Helper → main: one JSON object per stdout line. Property names are written exactly as the
/// anonymous objects declare them (they mirror `HelperLine` in src/shared/meeting-types.ts).
/// Never pass window titles, tab names or audio to <see cref="Log"/>.
/// </summary>
static class Output
{
    static readonly object Gate = new();
    static readonly StreamWriter Writer = new(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };

    public static void Write(object line)
    {
        string json = JsonSerializer.Serialize(line);
        lock (Gate)
        {
            try
            {
                Writer.WriteLine(json);
            }
            catch (IOException)
            {
                // Echo closed the pipe; stdin EOF shuts the helper down.
            }
        }
    }

    public static void Log(string message) => Write(new { type = "log", message });

    public static void Error(string? id, string code, string message)
    {
        if (id is null) Write(new { type = "error", code, message });
        else Write(new { type = "error", id, code, message });
    }
}
