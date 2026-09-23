using System.Runtime.InteropServices;
using System.Text.Json;

namespace EchoMeetingHelper;

/// <summary>
/// Watches ACTIVE capture sessions on every active capture endpoint and emits the full
/// `mic-sessions` snapshot whenever it changes. Event-driven: session created / state changed,
/// endpoint added / removed / default changed, and the CapabilityAccessManager microphone registry
/// subtree only schedule a debounced re-scan. A 60 s safety re-scan covers missed notifications.
/// Everything runs on MTA threads (session notifications are not delivered otherwise).
/// </summary>
sealed class MicSessionWatcher
{
    const int DebounceMs = 120;
    const int SafetyRescanMs = 60_000;
    const string MicConsentKey = @"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone";

    readonly uint echoPid;
    readonly uint selfPid = (uint)Environment.ProcessId;
    readonly AutoResetEvent dirty = new(false);
    readonly Dictionary<string, EndpointWatch> endpoints = new();
    readonly Dictionary<string, SessionWatch> sessions = new();
    IMMDeviceEnumerator? enumerator;
    EndpointNotifications? endpointNotifications;
    string? lastSnapshot;

    public MicSessionWatcher(uint echoPid)
    {
        this.echoPid = echoPid;
    }

    public void Start()
    {
        var scanner = new Thread(ScanLoop) { IsBackground = true, Name = "mic-sessions" };
        scanner.SetApartmentState(ApartmentState.MTA);
        scanner.Start();
        var registry = new Thread(RegistryLoop) { IsBackground = true, Name = "mic-consent-watch" };
        registry.SetApartmentState(ApartmentState.MTA);
        registry.Start();
    }

    public void Trigger() => dirty.Set();

    void ScanLoop()
    {
        try
        {
            enumerator = CoreAudio.CreateEnumerator();
            endpointNotifications = new EndpointNotifications(this);
            enumerator.RegisterEndpointNotificationCallback(endpointNotifications);
        }
        catch (Exception error)
        {
            Output.Log($"mic-sessions: endpoint notifications unavailable ({error.GetType().Name})");
        }

        bool first = true;
        while (true)
        {
            try
            {
                Scan(first);
            }
            catch (Exception error)
            {
                Output.Log($"mic-sessions: scan failed ({error.GetType().Name} 0x{error.HResult:X8})");
            }
            first = false;
            dirty.WaitOne(SafetyRescanMs);
            // Coalesce bursts (a call start fires created + state-changed + registry writes).
            Thread.Sleep(DebounceMs);
            dirty.Reset();
        }
    }

    void Scan(bool force)
    {
        enumerator ??= CoreAudio.CreateEnumerator();
        var table = ProcessTable.Snapshot();
        var seenEndpoints = new HashSet<string>();
        var seenSessions = new HashSet<string>();
        var found = new List<(string key, object line)>();

        foreach (var device in CoreAudio.ActiveEndpoints(enumerator, CoreAudio.eCapture))
        {
            string endpointId = CoreAudio.DeviceId(device);
            if (endpointId.Length == 0) continue;
            seenEndpoints.Add(endpointId);
            if (!endpoints.TryGetValue(endpointId, out var endpoint))
            {
                var manager = CoreAudio.SessionManager(device);
                if (manager is null) continue;
                var notifier = new SessionCreatedNotifier(this);
                manager.RegisterSessionNotification(notifier);
                endpoint = new EndpointWatch(device, manager, notifier, CoreAudio.FriendlyName(device));
                endpoints[endpointId] = endpoint;
            }

            // GetCount after registering: the session manager discards creation notifications
            // until the client has retrieved the session list once.
            if (endpoint.Manager.GetSessionEnumerator(out var list) < 0) continue;
            if (list.GetCount(out int count) < 0) continue;
            for (int i = 0; i < count; i++)
            {
                if (list.GetSession(i, out var control) < 0 || control is null) continue;
                string? instanceId = CoreAudio.SessionInstanceId(control);
                if (instanceId is null) continue;
                seenSessions.Add(instanceId);
                if (!sessions.ContainsKey(instanceId))
                {
                    var events = new SessionStateEvents(this);
                    if (control.RegisterAudioSessionNotification(events) >= 0)
                        sessions[instanceId] = new SessionWatch(control, events);
                }

                if (control.GetState(out int state) < 0 || state != CoreAudio.AudioSessionStateActive) continue;
                uint pid = CoreAudio.SessionPid(control);
                if (pid == 0 || !table.Exists(pid)) continue;
                if (table.IsInTree(pid, echoPid) || table.IsInTree(pid, selfPid)) continue;
                uint appPid = table.AppPid(pid);
                found.Add(($"{endpointId}|{pid:D10}", new
                {
                    pid,
                    appPid,
                    exe = table.Exe(appPid),
                    path = table.Path(appPid),
                    packageFamily = table.PackageFamily(appPid),
                    endpointId,
                    endpointName = endpoint.Name
                }));
            }
        }

        foreach (var gone in endpoints.Keys.Where(id => !seenEndpoints.Contains(id)).ToList())
        {
            var endpoint = endpoints[gone];
            try { endpoint.Manager.UnregisterSessionNotification(endpoint.Notifier); } catch { /* device gone */ }
            endpoints.Remove(gone);
        }
        foreach (var gone in sessions.Keys.Where(id => !seenSessions.Contains(id)).ToList())
        {
            var session = sessions[gone];
            try { session.Control.UnregisterAudioSessionNotification(session.Events); } catch { /* session gone */ }
            sessions.Remove(gone);
        }

        // Stable order, so an unchanged set never re-emits.
        var result = found.OrderBy(entry => entry.key, StringComparer.Ordinal).Select(entry => entry.line).ToList();
        string snapshot = JsonSerializer.Serialize(new { type = "mic-sessions", sessions = result });
        if (!force && snapshot == lastSnapshot) return;
        lastSnapshot = snapshot;
        Output.Write(new { type = "mic-sessions", sessions = result });
    }

    void RegistryLoop()
    {
        if (Win32.RegOpenKeyExW(Win32.HKEY_CURRENT_USER, MicConsentKey, 0, Win32.KEY_NOTIFY | Win32.KEY_READ, out var key) != 0)
        {
            Output.Log("mic-sessions: consent registry key unavailable; relying on audio notifications");
            return;
        }
        using var changed = new AutoResetEvent(false);
        const int filter = Win32.REG_NOTIFY_CHANGE_NAME | Win32.REG_NOTIFY_CHANGE_LAST_SET | Win32.REG_NOTIFY_THREAD_AGNOSTIC;
        while (true)
        {
            // One-shot: re-arm after every signal, then re-scan (the notification says nothing about what changed).
            if (Win32.RegNotifyChangeKeyValue(key, true, filter, changed.SafeWaitHandle.DangerousGetHandle(), true) != 0)
            {
                Win32.RegCloseKey(key);
                return;
            }
            changed.WaitOne();
            Trigger();
        }
    }

    sealed record EndpointWatch(IMMDevice Device, IAudioSessionManager2 Manager, SessionCreatedNotifier Notifier, string Name);

    sealed record SessionWatch(IAudioSessionControl2 Control, SessionStateEvents Events);

    [ComVisible(true)]
    sealed class SessionCreatedNotifier(MicSessionWatcher owner) : IAudioSessionNotification
    {
        public int OnSessionCreated(IAudioSessionControl2 session)
        {
            owner.Trigger();
            return 0;
        }
    }

    [ComVisible(true)]
    sealed class SessionStateEvents(MicSessionWatcher owner) : IAudioSessionEvents
    {
        public int OnDisplayNameChanged(IntPtr name, IntPtr eventContext) => 0;
        public int OnIconPathChanged(IntPtr path, IntPtr eventContext) => 0;
        public int OnSimpleVolumeChanged(float volume, int muted, IntPtr eventContext) => 0;
        public int OnChannelVolumeChanged(uint channelCount, IntPtr volumes, uint changedChannel, IntPtr eventContext) => 0;
        public int OnGroupingParamChanged(IntPtr groupingId, IntPtr eventContext) => 0;

        public int OnStateChanged(int state)
        {
            owner.Trigger();
            return 0;
        }

        public int OnSessionDisconnected(int reason)
        {
            owner.Trigger();
            return 0;
        }
    }

    [ComVisible(true)]
    sealed class EndpointNotifications(MicSessionWatcher owner) : IMMNotificationClient
    {
        public int OnDeviceStateChanged(string deviceId, int newState)
        {
            owner.Trigger();
            return 0;
        }

        public int OnDeviceAdded(string deviceId)
        {
            owner.Trigger();
            return 0;
        }

        public int OnDeviceRemoved(string deviceId)
        {
            owner.Trigger();
            return 0;
        }

        public int OnDefaultDeviceChanged(int flow, int role, string? defaultDeviceId)
        {
            owner.Trigger();
            return 0;
        }

        public int OnPropertyValueChanged(string deviceId, PropertyKey key) => 0;
    }
}
