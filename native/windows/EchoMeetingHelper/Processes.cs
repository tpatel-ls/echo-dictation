using System.Text;

namespace EchoMeetingHelper;

/// <summary>
/// One snapshot of the process list, with lazily resolved creation times, image paths and
/// package families. Parent links are trusted only when the parent was created before the child,
/// which guards every tree walk against PID reuse.
/// </summary>
sealed class ProcessTable
{
    readonly Dictionary<uint, (uint parent, string exe)> entries = new();
    readonly Dictionary<uint, long> created = new();
    readonly Dictionary<uint, string> paths = new();
    readonly Dictionary<uint, string?> families = new();

    public static ProcessTable Snapshot()
    {
        var table = new ProcessTable();
        var snapshot = Win32.CreateToolhelp32Snapshot(Win32.TH32CS_SNAPPROCESS, 0);
        if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) return table;
        try
        {
            var entry = new Win32.PROCESSENTRY32W { dwSize = (uint)System.Runtime.InteropServices.Marshal.SizeOf<Win32.PROCESSENTRY32W>() };
            for (bool ok = Win32.Process32FirstW(snapshot, ref entry); ok; ok = Win32.Process32NextW(snapshot, ref entry))
            {
                table.entries[entry.th32ProcessID] = (entry.th32ParentProcessID, (entry.szExeFile ?? "").ToLowerInvariant());
            }
        }
        finally
        {
            Win32.CloseHandle(snapshot);
        }
        return table;
    }

    public bool Exists(uint pid) => entries.ContainsKey(pid);

    /// <summary>Lower-case image file name, e.g. 'chrome.exe'; empty when the process is gone.</summary>
    public string Exe(uint pid) => entries.TryGetValue(pid, out var entry) ? entry.exe : "";

    /// <summary>The parent PID when the link is trustworthy (parent still exists and is older), else 0.</summary>
    public uint TrustedParent(uint pid)
    {
        if (!entries.TryGetValue(pid, out var entry)) return 0;
        uint parent = entry.parent;
        if (parent == 0 || parent == pid || !entries.ContainsKey(parent)) return 0;
        long child = CreationTime(pid);
        long parentCreated = CreationTime(parent);
        // Unreadable creation times (protected processes) cannot be validated; accept the link.
        if (child != 0 && parentCreated != 0 && parentCreated >= child) return 0;
        return parent;
    }

    /// <summary>Topmost ancestor with the same image name: the root of the app's process tree.</summary>
    public uint AppPid(uint pid)
    {
        string exe = Exe(pid);
        uint current = pid;
        for (int depth = 0; depth < 64; depth++)
        {
            uint parent = TrustedParent(current);
            if (parent == 0 || Exe(parent) != exe) break;
            current = parent;
        }
        return current;
    }

    /// <summary>True when `pid` is `root` or one of its (validated) descendants.</summary>
    public bool IsInTree(uint pid, uint root)
    {
        if (root == 0) return false;
        uint current = pid;
        for (int depth = 0; depth < 64 && current != 0; depth++)
        {
            if (current == root) return true;
            current = TrustedParent(current);
        }
        return false;
    }

    public string Path(uint pid)
    {
        if (paths.TryGetValue(pid, out var cached)) return cached;
        string path = "";
        WithProcess(pid, handle =>
        {
            var buffer = new StringBuilder(1024);
            int size = buffer.Capacity;
            if (Win32.QueryFullProcessImageNameW(handle, 0, buffer, ref size)) path = buffer.ToString(0, size);
        });
        paths[pid] = path;
        return path;
    }

    public string? PackageFamily(uint pid)
    {
        if (families.TryGetValue(pid, out var cached)) return cached;
        string? family = null;
        WithProcess(pid, handle =>
        {
            uint length = 0;
            int rc = Win32.GetPackageFamilyName(handle, ref length, null);
            if (rc == Win32.APPMODEL_ERROR_NO_PACKAGE || length == 0) return;
            var buffer = new StringBuilder((int)length);
            if (Win32.GetPackageFamilyName(handle, ref length, buffer) == 0) family = buffer.ToString();
        });
        families[pid] = family;
        return family;
    }

    long CreationTime(uint pid)
    {
        if (created.TryGetValue(pid, out var cached)) return cached;
        long value = 0;
        WithProcess(pid, handle =>
        {
            if (Win32.GetProcessTimes(handle, out var creation, out _, out _, out _)) value = creation;
        });
        created[pid] = value;
        return value;
    }

    static void WithProcess(uint pid, Action<IntPtr> use)
    {
        var handle = Win32.OpenProcess(Win32.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (handle == IntPtr.Zero) return;
        try
        {
            use(handle);
        }
        finally
        {
            Win32.CloseHandle(handle);
        }
    }
}
