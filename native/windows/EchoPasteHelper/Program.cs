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

        var key = args.Contains("--copy") ? VkC : VkV;
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
            if (sent == (uint)inputs.Length) return 0;

            error = Marshal.GetLastWin32Error();
            ReleaseKeys(key, inputSize);
            if (attempt < MaxAttempts) Thread.Sleep(20 * attempt);
        }

        var message =
            $"SendInput failed after {MaxAttempts} attempts " +
            $"(sent {sent}/{inputs.Length}; Windows error {error}; inputSize {inputSize}, expected {expectedInputSize})";
        Console.WriteLine(JsonSerializer.Serialize(new
        {
            type = "error",
            message,
            sent,
            expected = inputs.Length,
            windowsError = error,
            inputSize,
            expectedInputSize
        }));
        return 2;
    }

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
