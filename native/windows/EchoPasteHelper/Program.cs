using System.Runtime.InteropServices;
using System.Text.Json;

internal static class Program
{
    private const int MaxAttempts = 3;
    private const uint InputKeyboard = 1;
    private const uint KeyUp = 0x0002;
    private const ushort VkControl = 0x11;
    private const ushort VkC = 0x43;
    private const ushort VkV = 0x56;

    public static int Main(string[] args)
    {
        var inputSize = Marshal.SizeOf<Input>();
        var expectedInputSize = IntPtr.Size == 8 ? 40 : 28;
        // Checked before --check: Echo launches `--server --check`, so an older helper without server
        // mode only reports its check and exits instead of sending a stray Ctrl+V.
        if (args.Contains("--server")) return Serve(inputSize, expectedInputSize);
        if (args.Contains("--check") || args.Contains("--prompt"))
        {
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                type = "check",
                trusted = inputSize == expectedInputSize,
                inputSize,
                expectedInputSize
            }));
            return inputSize == expectedInputSize ? 0 : 3;
        }

        var result = SendChord(args.Contains("--copy") ? VkC : VkV, inputSize);
        if (result.Ok) return 0;
        Console.WriteLine(JsonSerializer.Serialize(ErrorPayload(null, result, inputSize, expectedInputSize)));
        return 2;
    }

    // Persistent mode: one JSON command per stdin line ({"id":"1","action":"paste"}), one JSON reply per
    // stdout line. Starting a self-contained .NET exe costs about half a second per paste; a warm
    // process sends the chord in milliseconds. Exits when Echo closes stdin.
    private static int Serve(int inputSize, int expectedInputSize)
    {
        Console.WriteLine(JsonSerializer.Serialize(new { type = "ready" }));
        string? line;
        while ((line = Console.ReadLine()) is not null)
        {
            string? id = null;
            string? action = null;
            try
            {
                using var document = JsonDocument.Parse(line);
                if (document.RootElement.TryGetProperty("id", out var idElement)) id = idElement.GetString();
                if (document.RootElement.TryGetProperty("action", out var actionElement)) action = actionElement.GetString();
            }
            catch (JsonException)
            {
                // Reported below as an unknown action.
            }

            if (action is not ("paste" or "copy"))
            {
                Console.WriteLine(JsonSerializer.Serialize(new { type = "error", id, message = $"Unknown action {action ?? "(none)"}" }));
                continue;
            }

            var result = SendChord(action == "copy" ? VkC : VkV, inputSize);
            Console.WriteLine(result.Ok
                ? JsonSerializer.Serialize(new { type = "ok", id })
                : JsonSerializer.Serialize(ErrorPayload(id, result, inputSize, expectedInputSize)));
        }
        return 0;
    }

    private readonly record struct ChordResult(bool Ok, uint Sent, int Expected, int WindowsError);

    private static ChordResult SendChord(ushort key, int inputSize)
    {
        var inputs = new[]
        {
            Keyboard(VkControl, 0),
            Keyboard(key, 0),
            Keyboard(key, KeyUp),
            Keyboard(VkControl, KeyUp)
        };
        uint sent = 0;
        var error = 0;

        for (var attempt = 1; attempt <= MaxAttempts; attempt++)
        {
            sent = SendInput((uint)inputs.Length, inputs, inputSize);
            if (sent == (uint)inputs.Length) return new ChordResult(true, sent, inputs.Length, 0);

            error = Marshal.GetLastWin32Error();
            ReleaseKeys(key, inputSize);
            if (attempt < MaxAttempts) Thread.Sleep(20 * attempt);
        }
        return new ChordResult(false, sent, inputs.Length, error);
    }

    private static object ErrorPayload(string? id, ChordResult result, int inputSize, int expectedInputSize) => new
    {
        type = "error",
        id,
        message =
            $"SendInput failed after {MaxAttempts} attempts " +
            $"(sent {result.Sent}/{result.Expected}; Windows error {result.WindowsError}; inputSize {inputSize}, expected {expectedInputSize})",
        sent = result.Sent,
        expected = result.Expected,
        windowsError = result.WindowsError,
        inputSize,
        expectedInputSize
    };

    private static void ReleaseKeys(ushort key, int inputSize)
    {
        var releases = new[]
        {
            Keyboard(key, KeyUp),
            Keyboard(VkControl, KeyUp)
        };
        SendInput((uint)releases.Length, releases, inputSize);
    }

    private static Input Keyboard(ushort key, uint flags) => new()
    {
        type = InputKeyboard,
        data = new InputUnion { keyboard = new KeyboardInput { virtualKey = key, flags = flags } }
    };

    [StructLayout(LayoutKind.Sequential)]
    private struct Input
    {
        public uint type;
        public InputUnion data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)] public MouseInput mouse;
        [FieldOffset(0)] public KeyboardInput keyboard;
        [FieldOffset(0)] public HardwareInput hardware;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MouseInput
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint flags;
        public uint time;
        public UIntPtr extraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KeyboardInput
    {
        public ushort virtualKey;
        public ushort scanCode;
        public uint flags;
        public uint time;
        public UIntPtr extraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct HardwareInput
    {
        public uint message;
        public ushort parameterLow;
        public ushort parameterHigh;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);
}
