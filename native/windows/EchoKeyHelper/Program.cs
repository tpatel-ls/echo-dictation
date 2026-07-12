using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

internal static class Program
{
    private const int WhKeyboardLl = 13;
    private const int WmKeyDown = 0x0100;
    private const int WmKeyUp = 0x0101;
    private const int WmSysKeyDown = 0x0104;
    private const int WmSysKeyUp = 0x0105;
    private const uint LlkhfInjected = 0x10;
    private static readonly object OutputLock = new();
    private static readonly LowLevelKeyboardProc HookProc = OnKeyboard;
    private static IntPtr hook;

    public static int Main(string[] args)
    {
        if (args.Contains("--check") || args.Contains("--prompt"))
        {
            Write(new { type = "check", trusted = true, inputMonitoringTrusted = true });
            return 0;
        }

        using var process = Process.GetCurrentProcess();
        using var module = process.MainModule;
        hook = SetWindowsHookEx(WhKeyboardLl, HookProc, GetModuleHandle(module?.ModuleName), 0);
        if (hook == IntPtr.Zero)
        {
            Write(new { type = "error", message = new Win32Exception().Message });
            return 2;
        }

        Write(new { type = "ready" });
        try
        {
            while (GetMessage(out var message, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
        }
        finally
        {
            UnhookWindowsHookEx(hook);
        }
        return 0;
    }

    private static IntPtr OnKeyboard(int code, IntPtr wParam, IntPtr lParam)
    {
        if (code >= 0)
        {
            var data = Marshal.PtrToStructure<KbdLlHookStruct>(lParam);
            if ((data.flags & LlkhfInjected) == 0 && TryKey(data.vkCode, out var key))
            {
                var message = wParam.ToInt32();
                if (message is WmKeyDown or WmSysKeyDown)
                    Write(new { type = "key", key, down = true });
                else if (message is WmKeyUp or WmSysKeyUp)
                    Write(new { type = "key", key, down = false });
            }
        }
        return CallNextHookEx(hook, code, wParam, lParam);
    }

    private static bool TryKey(uint vkCode, out string key)
    {
        key = vkCode switch
        {
            0xA3 => "rightControl",
            0xA2 => "leftControl",
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

    private delegate IntPtr LowLevelKeyboardProc(int code, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    private struct KbdLlHookStruct
    {
        public uint vkCode;
        public uint scanCode;
        public uint flags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Msg
    {
        public IntPtr hwnd;
        public uint message;
        public UIntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public int ptX;
        public int ptY;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc callback, IntPtr module, uint threadId);

    [DllImport("user32.dll")]
    private static extern bool UnhookWindowsHookEx(IntPtr hookHandle);

    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hookHandle, int code, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetMessage(out Msg message, IntPtr window, uint min, uint max);

    [DllImport("user32.dll")]
    private static extern bool TranslateMessage(ref Msg message);

    [DllImport("user32.dll")]
    private static extern IntPtr DispatchMessage(ref Msg message);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string? moduleName);
}
