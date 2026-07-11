using System.Runtime.InteropServices;
using System.Text.Json;

internal static class Program
{
    private const uint InputKeyboard = 1;
    private const uint KeyUp = 0x0002;
    private const ushort VkControl = 0x11;
    private const ushort VkC = 0x43;
    private const ushort VkV = 0x56;

    public static int Main(string[] args)
    {
        if (args.Contains("--check") || args.Contains("--prompt"))
        {
            Console.WriteLine(JsonSerializer.Serialize(new { type = "check", trusted = true }));
            return 0;
        }

        var key = args.Contains("--copy") ? VkC : VkV;
        var inputs = new[]
        {
            Keyboard(VkControl, 0),
            Keyboard(key, 0),
            Keyboard(key, KeyUp),
            Keyboard(VkControl, KeyUp)
        };
        var sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<Input>());
        if (sent == inputs.Length) return 0;
        Console.WriteLine(JsonSerializer.Serialize(new { type = "error", message = "SendInput failed" }));
        return 2;
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
        [FieldOffset(0)] public KeyboardInput keyboard;
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

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint count, Input[] inputs, int size);
}
