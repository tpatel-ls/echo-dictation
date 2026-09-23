using System.Diagnostics;
using System.Text;
using System.Windows.Automation;

namespace EchoMeetingHelper;

/// <summary>
/// `probe`: meeting evidence for a set of apps — their visible top-level windows, the tab-strip
/// names of their browser windows, and their render sessions with a short peak-meter sample.
/// Reading a peak meter captures no audio.
/// </summary>
static class Prober
{
    static readonly HashSet<string> Browsers = new(StringComparer.Ordinal)
    {
        "chrome.exe", "msedge.exe", "brave.exe", "arc.exe", "vivaldi.exe", "opera.exe", "firefox.exe"
    };

    const int TabBudgetMs = 150;
    const int TabHardCapMs = 400;
    const int PeakSamples = 5;
    const int PeakIntervalMs = 25;
    const int MaxTabTreeDepth = 12;
    // A scan abandoned at the hard cap (hung UIA provider) keeps its thread; while it is still
    // stuck, later probes skip the tab scan (detection falls back to window titles) rather than
    // piling up threads at the probe cadence.
    static readonly object ScanGate = new();
    static Task? stuckScan;

    /// <summary>
    /// The first UI Automation call in a process costs ~500 ms (client start-up), which would blow
    /// the tab budget of the first probe. Pay it once at start-up, off the request path.
    /// </summary>
    public static void WarmUp()
    {
        RunMta(() =>
        {
            try
            {
                AutomationElement.RootElement.FindFirst(TreeScope.Children, Condition.TrueCondition);
            }
            catch (Exception)
            {
                // Probing still works; the first one is just slower.
            }
            return true;
        });
    }

    public static object Probe(string id, IReadOnlyCollection<string> exes)
    {
        var wanted = new HashSet<string>(exes.Select(exe => exe.ToLowerInvariant()), StringComparer.Ordinal);
        var table = ProcessTable.Snapshot();

        // Render meters need ~100 ms of sampling; run them alongside the window and tab scan.
        // ProcessTable caches lazily and is not thread-safe, so the render thread takes its own.
        var render = RunMta(() => RenderSessions(ProcessTable.Snapshot(), wanted));
        var windows = Windows(table, wanted);
        var tabs = Tabs(windows, wanted);

        render.Wait();
        return new
        {
            type = "probe-result",
            id,
            windows = windows.Select(w => (object)new { w.pid, w.appPid, w.exe, w.title, w.className, w.minimized }).ToList(),
            tabs,
            render = render.Result
        };
    }

    sealed record WindowInfo(IntPtr hwnd, uint pid, uint appPid, string exe, string title, string className, bool minimized);

    static List<WindowInfo> Windows(ProcessTable table, HashSet<string> wanted)
    {
        var found = new List<WindowInfo>();
        Win32.EnumWindows((hwnd, _) =>
        {
            if (!Win32.IsWindowVisible(hwnd)) return true;
            // Cloaked windows (other virtual desktops, suspended UWP frames) are not on screen.
            if (Win32.DwmGetWindowAttribute(hwnd, 14 /* DWMWA_CLOAKED */, out int cloaked, sizeof(int)) == 0 && cloaked != 0) return true;
            Win32.GetWindowThreadProcessId(hwnd, out uint pid);
            string exe = table.Exe(pid);
            if (exe.Length == 0) return true;
            uint appPid = table.AppPid(pid);
            if (!wanted.Contains(exe) && !wanted.Contains(table.Exe(appPid))) return true;
            found.Add(new WindowInfo(hwnd, pid, appPid, table.Exe(appPid), WindowText(hwnd), ClassName(hwnd), Win32.IsIconic(hwnd)));
            return true;
        }, IntPtr.Zero);
        return found;
    }

    static string WindowText(IntPtr hwnd)
    {
        int length = Win32.GetWindowTextLengthW(hwnd);
        if (length <= 0) return "";
        var buffer = new StringBuilder(length + 1);
        Win32.GetWindowTextW(hwnd, buffer, buffer.Capacity);
        return buffer.ToString();
    }

    static string ClassName(IntPtr hwnd)
    {
        var buffer = new StringBuilder(256);
        return Win32.GetClassNameW(hwnd, buffer, buffer.Capacity) > 0 ? buffer.ToString() : "";
    }

    /// <summary>
    /// Tab-strip names of browser windows. Walks the browser UI one level at a time (one cached
    /// FindAll per node) and never descends into Document elements, so a browser with web-content
    /// accessibility switched on is not made to serialise its pages. Bounded to ~150 ms.
    /// </summary>
    static List<object> Tabs(List<WindowInfo> windows, HashSet<string> wanted)
    {
        var targets = windows
            .Where(w => Browsers.Contains(w.exe) && wanted.Contains(w.exe) && w.title.Length > 0)
            .Where(w => w.className == "Chrome_WidgetWin_1" || w.className == "MozillaWindowClass")
            .ToList();
        var tabs = new List<object>();
        if (targets.Count == 0) return tabs;

        lock (ScanGate)
        {
            if (stuckScan is { IsCompleted: false }) return tabs;
            stuckScan = null;
        }
        var clock = Stopwatch.StartNew();
        var scan = RunMta(() =>
        {
            foreach (var window in targets)
            {
                if (clock.ElapsedMilliseconds > TabBudgetMs) break;
                try
                {
                    foreach (string name in TabNames(window.hwnd, clock))
                    {
                        lock (tabs) tabs.Add(new { appPid = window.appPid, exe = window.exe, name });
                    }
                }
                catch (Exception error)
                {
                    // Window closed mid-scan or UIA refused; other windows still count.
                    Output.Log($"probe: tab scan failed for a window ({error.GetType().Name} 0x{error.HResult:X8})");
                }
            }
            return true;
        });
        // A hung UIA provider must not hold the probe hostage; whatever was found by then is returned.
        if (!scan.Wait(TabHardCapMs))
        {
            lock (ScanGate) stuckScan = scan;
        }
        lock (tabs) return tabs.ToList();
    }

    static List<string> TabNames(IntPtr hwnd, Stopwatch clock)
    {
        var names = new List<string>();
        var root = AutomationElement.FromHandle(hwnd);
        var request = new CacheRequest { TreeScope = TreeScope.Element };
        request.Add(AutomationElement.NameProperty);
        request.Add(AutomationElement.ControlTypeProperty);

        var frontier = new List<AutomationElement> { root };
        using (request.Activate())
        {
            for (int depth = 0; depth < MaxTabTreeDepth && frontier.Count > 0; depth++)
            {
                var next = new List<AutomationElement>();
                foreach (var node in frontier)
                {
                    if (clock.ElapsedMilliseconds > TabBudgetMs) return names;
                    foreach (AutomationElement child in node.FindAll(TreeScope.Children, Condition.TrueCondition))
                    {
                        var type = child.Cached.ControlType;
                        if (type == ControlType.TabItem)
                        {
                            string name = child.Cached.Name;
                            if (!string.IsNullOrEmpty(name)) names.Add(name);
                        }
                        else if (type != ControlType.Document)
                        {
                            next.Add(child);
                        }
                    }
                }
                // Once a tab strip has been found at this depth, nothing deeper is browser chrome we need.
                if (names.Count > 0) break;
                frontier = next;
            }
        }
        return names;
    }

    static List<object> RenderSessions(ProcessTable table, HashSet<string> wanted)
    {
        var enumerator = CoreAudio.CreateEnumerator();
        var matches = new List<(uint pid, uint appPid, string exe, string endpointId, bool active, IAudioMeterInformation? meter)>();
        foreach (var device in CoreAudio.ActiveEndpoints(enumerator, CoreAudio.eRender))
        {
            string endpointId = CoreAudio.DeviceId(device);
            var manager = CoreAudio.SessionManager(device);
            if (manager is null || manager.GetSessionEnumerator(out var list) < 0 || list.GetCount(out int count) < 0) continue;
            for (int i = 0; i < count; i++)
            {
                if (list.GetSession(i, out var control) < 0 || control is null) continue;
                uint pid = CoreAudio.SessionPid(control);
                if (pid == 0 || !table.Exists(pid)) continue;
                uint appPid = table.AppPid(pid);
                if (!wanted.Contains(table.Exe(pid)) && !wanted.Contains(table.Exe(appPid))) continue;
                bool active = control.GetState(out int state) >= 0 && state == CoreAudio.AudioSessionStateActive;
                matches.Add((pid, appPid, table.Exe(appPid), endpointId, active, control as IAudioMeterInformation));
            }
        }

        var peaks = new float[matches.Count];
        for (int sample = 0; sample < PeakSamples && matches.Count > 0; sample++)
        {
            if (sample > 0) Thread.Sleep(PeakIntervalMs);
            for (int i = 0; i < matches.Count; i++)
            {
                var meter = matches[i].meter;
                if (meter is not null && meter.GetPeakValue(out float peak) >= 0 && peak > peaks[i]) peaks[i] = peak;
            }
        }
        return matches
            .Select((m, i) => (object)new { m.pid, m.appPid, m.exe, m.endpointId, m.active, peak = Math.Round((double)peaks[i], 5) })
            .ToList();
    }

    static Task<T> RunMta<T>(Func<T> work)
    {
        var done = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try
            {
                done.SetResult(work());
            }
            catch (Exception error)
            {
                done.SetException(error);
            }
        }) { IsBackground = true };
        thread.SetApartmentState(ApartmentState.MTA);
        thread.Start();
        return done.Task;
    }
}
