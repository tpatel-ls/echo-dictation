using System.IO;
using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace EchoMeetingHelper;

/// <summary>
/// One meeting recording: `mic.pcm` (shared-mode capture of the meeting app's microphone, converted
/// to 16 kHz mono by the audio engine) and `others.pcm` (process loopback of the meeting app's
/// render PIDs, requested directly as 16 kHz mono). See Timeline.cs for how both stay aligned.
/// All public methods are called from the single request thread.
/// </summary>
sealed class Recording
{
    static readonly WaveFormat Pcm16kMono = new(Channel.Rate, 16, 1);
    const int FlushIntervalMs = 250;
    const int MicReopenIntervalMs = 1000;

    // Test hook for the stall-resilience check: pause the first loopback reader once, 5 s in.
    static readonly int StallTestMs = int.TryParse(Environment.GetEnvironmentVariable("ECHO_MEETING_HELPER_STALL_TEST_MS"), out var ms) ? ms : 0;

    public readonly string Id;
    readonly uint echoPid;
    readonly long t0;
    readonly Channel mic;
    readonly Channel others;
    readonly Dictionary<uint, Capture> loopbacks = new();
    Capture? systemLoopback;
    Capture? micCapture;
    readonly Thread flusher;
    readonly object micGate = new();
    volatile bool stopping;
    int stallArmed;

    sealed class Capture(WasapiRecorder recorder, TimelineSource source, MMDevice? device)
    {
        public readonly WasapiRecorder Recorder = recorder;
        public readonly TimelineSource Source = source;
        public readonly MMDevice? Device = device;
    }

    public long StartedAt { get; }
    public string OthersMode { get; private set; } = "process";
    public string MicName { get; private set; } = "";

    Recording(string id, string dir, uint echoPid)
    {
        Id = id;
        this.echoPid = echoPid;
        // Sample 0 of both files: one QPC reading and the wall clock read back to back.
        t0 = Qpc.Now();
        StartedAt = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        mic = new Channel(Path.Combine(dir, "mic.pcm"), t0);
        others = new Channel(Path.Combine(dir, "others.pcm"), t0);
        stallArmed = StallTestMs > 0 ? 1 : 0;
        flusher = new Thread(FlushLoop) { IsBackground = true, Name = "record-flush" };
    }

    public static Recording Start(string id, string dir, IReadOnlyList<uint> otherPids, string? micEndpointId, uint echoPid)
    {
        Directory.CreateDirectory(dir);
        var recording = new Recording(id, dir, echoPid);
        recording.flusher.Start();
        recording.OpenOthers(otherPids);
        if (recording.loopbacks.Count == 0) recording.StartSystemLoopback();
        recording.OpenMic(micEndpointId);
        if (recording.micCapture is null)
        {
            recording.Warn("mic-lost", "No microphone could be opened; recording silence on the mic channel until one appears");
            recording.ScheduleMicReopen();
        }
        return recording;
    }

    /// <summary>Rebuild the loopback set. Unchanged PIDs keep their stream, so the timeline never gaps.</summary>
    public void Retarget(IReadOnlyList<uint> otherPids)
    {
        var wanted = otherPids.Distinct().ToHashSet();
        var removed = loopbacks.Keys.Where(pid => !wanted.Contains(pid)).ToList();
        OpenOthers(wanted.Where(pid => !loopbacks.ContainsKey(pid)).ToList());
        foreach (var pid in removed)
        {
            Close(loopbacks[pid], others);
            loopbacks.Remove(pid);
        }
        if (loopbacks.Count > 0 && systemLoopback is not null)
        {
            Close(systemLoopback, others);
            systemLoopback = null;
        }
        if (loopbacks.Count == 0 && systemLoopback is null) StartSystemLoopback();
        string mode = loopbacks.Count > 0 ? $"{loopbacks.Count} process(es)" : "system audio except Echo";
        Warn("others-retargeted", $"Others channel now captures {mode}");
    }

    /// <summary>
    /// Pause (or resume) the mic channel from the instant the request arrived: while paused, digital
    /// silence is written in place of the microphone, so the timeline stays aligned and the real
    /// audio never reaches disk. Returns the mic.pcm sample index the new state applies from.
    /// </summary>
    public long SetMicPaused(bool paused, long requestedQpc) => mic.SetMuted(paused, mic.PositionOf(requestedQpc));

    /// <summary>Stop capture, pad both files to the same length, flush and close. Returns that length.</summary>
    public long Stop()
    {
        long stopPosition = mic.PositionOf(Qpc.Now());
        stopping = true;
        flusher.Join();
        foreach (var capture in loopbacks.Values) Close(capture, others);
        loopbacks.Clear();
        if (systemLoopback is not null) Close(systemLoopback, others);
        systemLoopback = null;
        lock (micGate)
        {
            if (micCapture is not null) Close(micCapture, mic);
            micCapture = null;
        }

        // The recording ends at the instant the stop was requested. Streams keep delivering while they
        // are torn down; audio stamped after that instant is not part of the recording.
        // (A flush racing the stop may already have written a few ms past it; never cut into that.)
        long final = Math.Max(stopPosition, Math.Max(mic.Committed, others.Committed));
        Output.Log($"record: stop at {stopPosition}, mic end {mic.HighWater}, others end {others.HighWater}, " +
                   $"dropped ahead-of-clock mic {mic.Dropped} others {others.Dropped}");
        // Commit writes at most the ring's capacity per call; loop so both files reach `final`.
        while (mic.Committed < final) mic.Commit(final);
        while (others.Committed < final) others.Commit(final);
        mic.Dispose();
        others.Dispose();
        return final;
    }

    void OpenOthers(IReadOnlyCollection<uint> pids)
    {
        var table = ProcessTable.Snapshot();
        foreach (uint pid in pids)
        {
            // Activation succeeds even for a PID that no longer exists, so check first.
            if (!table.Exists(pid) || table.IsInTree(pid, echoPid)) continue;
            var capture = TryLoopback(pid, ProcessLoopbackMode.IncludeTargetProcessTree);
            if (capture is not null) loopbacks[pid] = capture;
        }
    }

    void StartSystemLoopback()
    {
        OthersMode = "system";
        systemLoopback = TryLoopback(echoPid, ProcessLoopbackMode.ExcludeTargetProcessTree);
        if (systemLoopback is null) Warn("others-lost", "Could not capture other participants' audio");
    }

    Capture? TryLoopback(uint pid, ProcessLoopbackMode mode)
    {
        try
        {
            var recorder = new WasapiRecorderBuilder()
                .WithProcessLoopback(pid, mode)
                .WithFormat(Pcm16kMono)
                .WithMmcssThreadPriority("Audio")
                .BuildAsync()
                .GetAwaiter()
                .GetResult();
            return Attach(recorder, others, null, isMic: false);
        }
        catch (Exception error)
        {
            Output.Log($"record: loopback activation failed for a target ({error.GetType().Name} 0x{error.HResult:X8})");
            return null;
        }
    }

    void OpenMic(string? endpointId)
    {
        MMDevice? device = null;
        bool attached = false;
        try
        {
            using var enumerator = new MMDeviceEnumerator();
            if (!string.IsNullOrEmpty(endpointId))
            {
                try
                {
                    device = enumerator.GetDevice(endpointId);
                    if (device.State != DeviceState.Active)
                    {
                        device.Dispose();
                        device = null;
                    }
                }
                catch (Exception)
                {
                    device?.Dispose();
                    device = null;
                }
            }
            if (device is null && enumerator.TryGetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications, out var fallback))
                device = fallback;
            if (device is null) return;

            var recorder = new WasapiRecorderBuilder()
                .WithDevice(device)
                .WithSharedMode()
                .WithFormat(Pcm16kMono)
                .WithBufferLength(200)
                .WithMmcssThreadPriority("Audio")
                .Build();
            micCapture = Attach(recorder, mic, device, isMic: true);
            attached = true;
            MicName = device.FriendlyName;
        }
        catch (Exception error)
        {
            Output.Log($"record: microphone open failed ({error.GetType().Name} 0x{error.HResult:X8})");
            micCapture = null;
            // Attach owns the device once it succeeds; before that it is ours to release.
            if (!attached)
            {
                try { device?.Dispose(); } catch { /* already released */ }
            }
        }
    }

    Capture Attach(WasapiRecorder recorder, Channel channel, MMDevice? device, bool isMic)
    {
        var format = recorder.WaveFormat;
        if (format.SampleRate != Channel.Rate) throw new InvalidOperationException($"capture delivered {format.SampleRate} Hz");
        var source = new TimelineSource(channel, format);
        var capture = new Capture(recorder, source, device);
        bool stallThis = !isMic && Interlocked.Exchange(ref stallArmed, 0) == 1;
        long stallAfter = Qpc.Now() + 50_000_000;
        recorder.DataAvailable += (buffer, flags, devicePosition, qpcPosition) =>
        {
            if (stallThis && qpcPosition > stallAfter)
            {
                stallThis = false;
                SuspendReaderOnce(Win32.GetCurrentThreadId());
            }
            source.OnPacket(buffer, qpcPosition);
        };
        recorder.RecordingStopped += (_, e) =>
        {
            if (stopping) return;
            lock (channel.Gate)
            {
                if (!source.Live) return;
                source.Live = false;
            }
            // Never dispose on the capture thread; the request thread owns teardown.
            if (isMic) Task.Run(() => OnMicLost(capture));
            else Warn("others-lost", $"A loopback stream stopped ({e.Exception?.GetType().Name ?? "ended"})");
        };
        lock (channel.Gate) channel.Sources.Add(source);
        recorder.StartRecording();
        return capture;
    }

    /// <summary>
    /// Stall-test hook: suspend the reader thread from outside for StallTestMs, the way a GC or
    /// scheduler pause would, once the callback has returned and the thread waits for the next packet.
    /// </summary>
    static void SuspendReaderOnce(uint threadId)
    {
        ThreadPool.QueueUserWorkItem(_ =>
        {
            Thread.Sleep(3);
            var thread = Win32.OpenThread(Win32.THREAD_SUSPEND_RESUME, false, threadId);
            if (thread == IntPtr.Zero) return;
            Win32.SuspendThread(thread);
            Thread.Sleep(StallTestMs);
            Win32.ResumeThread(thread);
            Win32.CloseHandle(thread);
            Output.Log($"record: stall test suspended a loopback reader for {StallTestMs} ms");
        });
    }

    void OnMicLost(Capture lost)
    {
        lock (micGate)
        {
            if (stopping || micCapture != lost) return;
            micCapture = null;
            Warn("mic-lost", "The microphone went away; padding silence and reopening the default communications microphone");
            DisposeQuietly(lost, mic);
        }
        ScheduleMicReopen();
    }

    void ScheduleMicReopen()
    {
        Task.Run(async () =>
        {
            while (!stopping)
            {
                lock (micGate)
                {
                    if (stopping) return;
                    OpenMic(null);
                    if (micCapture is not null)
                    {
                        Warn("mic-reopened", "Recording from the default communications microphone");
                        return;
                    }
                }
                await Task.Delay(MicReopenIntervalMs);
            }
        });
    }

    void Close(Capture capture, Channel channel)
    {
        lock (channel.Gate) capture.Source.Live = false;
        DisposeQuietly(capture, channel);
    }

    static void DisposeQuietly(Capture capture, Channel channel)
    {
        try { capture.Recorder.Dispose(); } catch { /* device already gone */ }
        try { capture.Device?.Dispose(); } catch { /* already released */ }
        lock (channel.Gate) channel.Sources.Remove(capture.Source);
    }

    void FlushLoop()
    {
        int tick = 0;
        while (!stopping)
        {
            Thread.Sleep(FlushIntervalMs);
            if (stopping) break;
            try
            {
                long now = mic.PositionOf(Qpc.Now());
                Flush(mic, now);
                Flush(others, now);
                if (++tick % 2 == 0)
                {
                    Output.Write(new
                    {
                        type = "record-levels",
                        id = Id,
                        mic = mic.TakeLevel(),
                        others = others.TakeLevel(),
                        samples = Math.Min(mic.Committed, others.Committed)
                    });
                }
            }
            catch (Exception error)
            {
                Output.Log($"record: flush failed ({error.GetType().Name})");
                Warn("gap", "Writing the recording to disk failed; audio may be missing");
            }
        }
    }

    /// <summary>Commit up to the slowest live source, but never lag real time by more than LagAllowance.</summary>
    static void Flush(Channel channel, long now)
    {
        long floor = now - Channel.LagAllowance;
        long frontier = Math.Max(channel.SlowestLiveSource() ?? floor, floor);
        channel.Commit(frontier);
    }

    void Warn(string code, string message)
    {
        Output.Write(new { type = "record-warning", id = Id, code, message });
    }
}
