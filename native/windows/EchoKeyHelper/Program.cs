using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text.Json;

internal static class Program
{
    private const int WmInput = 0x00FF;
    private const uint RidInput = 0x10000003;
    private const uint RimTypeKeyboard = 1;
    private const uint RidevInputSink = 0x00000100;
    private const ushort RiKeyBreak = 0x0001;
    private const ushort RiKeyE0 = 0x0002;
    private static readonly object OutputLock = new();

    [STAThread]
    public static int Main(string[] args)
    {
        if (args.Contains("--check") || args.Contains("--prompt"))
        {
            Write(new { type = "check", trusted = true, inputMonitoringTrusted = true });
            return 0;
        }

        using var form = new MessageLoopForm(OnKeyboard);
        if (!form.RegisterKeyboard())
        {
            Write(new { type = "error", message = new Win32Exception().Message });
            return 2;
        }

        Write(new { type = "ready" });
        Application.Run(form);
        return 0;
    }

    private static void OnKeyboard(RawKeyboard data)
    {
        if (!TryKey(data, out var key)) return;
        Write(new { type = "key", key, down = (data.Flags & RiKeyBreak) == 0 });
    }

    private static bool TryKey(RawKeyboard data, out string key)
    {
        key = data.VKey switch
        {
            0xA3 => "rightControl",
            0xA2 => "leftControl",
            // Raw Input commonly reports generic VK_CONTROL and uses E0 for the right key.
            0x11 => (data.Flags & RiKeyE0) != 0 ? "rightControl" : "leftControl",
            0x14 => "capsLock",
            0x77 => "f8",
            _ => ""
        };
        return key.Length > 0;
    }

    private static void Write(object value)
    {
        lock (OutputLock) Console.WriteLine(JsonSerializer.Serialize(value));
    }

    private sealed class MessageLoopForm : Form
    {
        private readonly Action<RawKeyboard> onKeyboard;

        public MessageLoopForm(Action<RawKeyboard> onKeyboard)
        {
            this.onKeyboard = onKeyboard;
            ShowInTaskbar = false;
            FormBorderStyle = FormBorderStyle.None;
            WindowState = FormWindowState.Minimized;
            Opacity = 0;
        }

        public bool RegisterKeyboard()
        {
            var devices = new[]
            {
                new RawInputDevice
                {
                    UsagePage = 0x01,
                    Usage = 0x06,
                    Flags = RidevInputSink,
                    Target = Handle
                }
            };
            return RegisterRawInputDevices(
                devices,
                (uint)devices.Length,
                (uint)Marshal.SizeOf<RawInputDevice>()
            );
        }

        protected override void WndProc(ref Message message)
        {
            if (message.Msg == WmInput) ReadKeyboard(message.LParam);
            base.WndProc(ref message);
        }

        private void ReadKeyboard(IntPtr rawInputHandle)
        {
            var headerSize = (uint)Marshal.SizeOf<RawInputHeader>();
            uint size = 0;
            if (GetRawInputData(rawInputHandle, RidInput, IntPtr.Zero, ref size, headerSize) == uint.MaxValue)
                return;
            if (size < headerSize + Marshal.SizeOf<RawKeyboard>()) return;

            var buffer = Marshal.AllocHGlobal((int)size);
            try
            {
                if (GetRawInputData(rawInputHandle, RidInput, buffer, ref size, headerSize) == uint.MaxValue)
                    return;
                var input = Marshal.PtrToStructure<RawInput>(buffer);
                if (input.Header.Type == RimTypeKeyboard) onKeyboard(input.Keyboard);
            }
            finally
            {
                Marshal.FreeHGlobal(buffer);
            }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RawInputDevice
    {
        public ushort UsagePage;
        public ushort Usage;
        public uint Flags;
        public IntPtr Target;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RawInputHeader
    {
        public uint Type;
        public uint Size;
        public IntPtr Device;
        public UIntPtr WParam;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RawKeyboard
    {
        public ushort MakeCode;
        public ushort Flags;
        public ushort Reserved;
        public ushort VKey;
        public uint Message;
        public uint ExtraInformation;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RawInput
    {
        public RawInputHeader Header;
        public RawKeyboard Keyboard;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterRawInputDevices(
        [In] RawInputDevice[] devices,
        uint numDevices,
        uint size
    );

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetRawInputData(
        IntPtr rawInput,
        uint command,
        IntPtr data,
        ref uint size,
        uint headerSize
    );
}
