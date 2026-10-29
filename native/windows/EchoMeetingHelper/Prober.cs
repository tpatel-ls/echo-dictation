using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;
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
    const int TabHardCapMs = 900;
    const int MeetBudgetMs = 650;
    const int PeakSamples = 5;
    const int PeakIntervalMs = 25;
    const int MaxTabTreeDepth = 12;
    // A scan abandoned at the hard cap (hung UIA provider) keeps its thread; while it is still
    // stuck, later probes skip the tab scan (detection falls back to window titles) rather than
    // piling up threads at the probe cadence.
    static readonly object ScanGate = new();
    static Task? stuckScan;
    static int nextWindow;

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
        var (tabs, meetDocuments) = Tabs(windows, wanted);

        render.Wait();
        return new
        {
            type = "probe-result",
            id,
            windows = windows.Select(w => (object)new { w.pid, w.appPid, w.exe, w.title, w.className, w.minimized }).ToList(),
            tabs,
            meetDocuments,
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
    static (List<object>, List<object>) Tabs(List<WindowInfo> windows, HashSet<string> wanted)
    {
        var targets = windows
            .Where(w => Browsers.Contains(w.exe) && wanted.Contains(w.exe) && w.title.Length > 0)
            .Where(w => w.className == "Chrome_WidgetWin_1" || w.className == "MozillaWindowClass")
            .ToList();
        var tabs = new List<object>();
        var documents = new List<object>();
        if (targets.Count == 0) return (tabs, documents);
        // Rotate the first window so a large foreground browser cannot permanently use
        // the entire bounded scan budget and starve a call in a background window.
        int first = (int)((uint)Interlocked.Increment(ref nextWindow) % (uint)targets.Count);
        targets = targets.Skip(first).Concat(targets.Take(first)).ToList();

        lock (ScanGate)
        {
            if (stuckScan is { IsCompleted: false }) return (tabs, documents);
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
            // Inspect only a selected Meet document. No tab switching, clicks, chat/caption
            // collection or unbounded descendants queries. Hidden tabs retain the tab fallback.
            foreach (var window in targets.Where(w => IsMeetTitle(w.title)))
            {
                if (clock.ElapsedMilliseconds > MeetBudgetMs) break;
                try
                {
                    var controls = MeetControls(window.hwnd, clock);
                    if (controls.Count > 0)
                        lock (documents) documents.Add(new { window.appPid, window.exe, window.title, controls });
                }
                catch (Exception error)
                {
                    Output.Log($"probe: Meet controls unavailable ({error.GetType().Name})");
                }
            }
            return true;
        });
        // A hung UIA provider must not hold the probe hostage; whatever was found by then is returned.
        if (!scan.Wait(TabHardCapMs))
        {
            lock (ScanGate) stuckScan = scan;
        }
        lock (tabs) lock (documents) return (tabs.ToList(), documents.ToList());
    }

    static bool IsMeetTitle(string title) => Regex.IsMatch(title, @"^Meet\s*[-–]\s*\S", RegexOptions.IgnoreCase);

    static List<string> MeetControls(IntPtr hwnd, Stopwatch clock)
    {
        var labels = new HashSet<string>(StringComparer.Ordinal);
        var request = new CacheRequest { TreeScope = TreeScope.Element };
        request.Add(AutomationElement.NameProperty);
        request.Add(AutomationElement.ControlTypeProperty);
        var frontier = new List<(AutomationElement node, bool meet)> { (AutomationElement.FromHandle(hwnd), false) };
        int visited = 0;
        using (request.Activate())
        {
            for (int depth = 0; depth < 28 && frontier.Count > 0; depth++)
            {
                var next = new List<(AutomationElement, bool)>();
                foreach (var (node, inMeet) in frontier)
                {
                    if (clock.ElapsedMilliseconds > MeetBudgetMs || visited > 2000) return labels.ToList();
                    foreach (AutomationElement child in node.FindAll(TreeScope.Children, Condition.TrueCondition))
                    {
                        if (++visited > 2000 || clock.ElapsedMilliseconds > MeetBudgetMs) return labels.ToList();
                        var type = child.Cached.ControlType;
                        string name = child.Cached.Name ?? "";
                        bool meet = inMeet;
                        if (type == ControlType.Document)
                        {
                            if (!IsMeetTitle(name)) continue;
                            meet = true;
                        }
                        if (meet && name.Length is > 0 and <= 300 &&
                            (type == ControlType.Button || type == ControlType.MenuItem ||
                             Regex.IsMatch(name, @"^(?:People|Participants|In (?:this )?call)\s*\(\d{1,4}\)$", RegexOptions.IgnoreCase)))
                        {
                            labels.Add(name);
                            // Meet sometimes exposes the people count as a child of its button.
                            if (Regex.IsMatch(name, @"^(?:Show everyone|People|Participants)$", RegexOptions.IgnoreCase))
                                foreach (AutomationElement count in child.FindAll(TreeScope.Children, Condition.TrueCondition))
                                    if (Regex.IsMatch(count.Cached.Name ?? "", @"^\d{1,4}$")) labels.Add($"{name} ({count.Cached.Name})");
                        }
                        if (type != ControlType.TabItem) next.Add((child, meet));
                    }
                }
                frontier = next;
            }
        }
        return labels.ToList();
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
