using System.Collections.Concurrent;
using System.IO;
using System.Text;
using System.Text.Json;
using EchoMeetingHelper;

// EchoMeetingHelper.exe --server --echo-pid <pid>
// Long-lived helper for meeting notes: JSON lines on stdout (HelperLine), requests on stdin
// (HelperRequest); both mirror src/shared/meeting-types.ts. It watches which apps capture the
// microphone, probes meeting evidence on request, and records mic.pcm + others.pcm.
// stdin EOF (Echo exited or crashed) finishes any recording and exits 0.

const int ProtocolVersion = 1;

if (!args.Contains("--server"))
{
    Console.Error.WriteLine("usage: EchoMeetingHelper.exe --server --echo-pid <pid>");
    return 2;
}
uint echoPid = 0;
int pidIndex = Array.IndexOf(args, "--echo-pid");
if (pidIndex < 0 || pidIndex + 1 >= args.Length || !uint.TryParse(args[pidIndex + 1], out echoPid))
{
    Console.Error.WriteLine("--echo-pid <pid> is required");
    return 2;
}

// Recording requests run strictly in order on one thread; probes run alongside them.
var recordQueue = new BlockingCollection<Action>();
Recording? recording = null;
var recordThread = new Thread(() =>
{
    foreach (var work in recordQueue.GetConsumingEnumerable())
    {
        try
        {
            work();
        }
        catch (Exception error)
        {
            Output.Log($"record: request failed ({error.GetType().Name})");
        }
    }
}) { IsBackground = true, Name = "record-requests" };
recordThread.SetApartmentState(ApartmentState.MTA);
recordThread.Start();

bool processLoopback = OperatingSystem.IsWindowsVersionAtLeast(10, 0, 19041);
Output.Write(new { type = "ready", version = ProtocolVersion, processLoopback });
var watcher = new MicSessionWatcher(echoPid);
watcher.Start();
Prober.WarmUp();

using var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
while (true)
{
    string? line;
    try
    {
        line = stdin.ReadLine();
    }
    catch (IOException)
    {
        line = null;
    }
    if (line is null) break;
    if (string.IsNullOrWhiteSpace(line)) continue;
    if (!Handle(line)) break;
}

// shutdown or EOF: finish the recording exactly like record-stop, then exit.
var finished = new ManualResetEventSlim();
recordQueue.Add(() =>
{
    StopRecording(recording?.Id);
    finished.Set();
});
finished.Wait(TimeSpan.FromSeconds(10));
return 0;

bool Handle(string line)
{
    JsonElement request;
    try
    {
        using var document = JsonDocument.Parse(line);
        request = document.RootElement.Clone();
    }
    catch (JsonException)
    {
        Output.Error(null, "bad-request", "Request is not valid JSON");
        return true;
    }
    if (request.ValueKind != JsonValueKind.Object || !TryString(request, "type", out var type))
    {
        Output.Error(null, "bad-request", "Request has no type");
        return true;
    }
    if (type == "shutdown") return false;
    if (!TryString(request, "id", out var id))
    {
        Output.Error(null, "bad-request", $"'{type}' needs a string id");
        return true;
    }

    switch (type)
    {
        case "probe":
            if (!TryStrings(request, "exes", out var exes))
            {
                Output.Error(id, "bad-request", "probe needs exes: string[]");
                break;
            }
            var probeThread = new Thread(() =>
            {
                try
                {
                    Output.Write(Prober.Probe(id, exes));
                }
                catch (Exception error)
                {
                    Output.Error(id, "probe-failed", $"Probe failed ({error.GetType().Name})");
                }
            }) { IsBackground = true, Name = "probe" };
            probeThread.SetApartmentState(ApartmentState.MTA);
            probeThread.Start();
            break;

        case "record-start":
            if (!TryString(request, "dir", out var dir) || dir.Length == 0 || !TryPids(request, "otherPids", out var otherPids)
                || !request.TryGetProperty("micEndpointId", out var micElement)
                || (micElement.ValueKind != JsonValueKind.String && micElement.ValueKind != JsonValueKind.Null))
            {
                Output.Error(id, "bad-request", "record-start needs dir, otherPids and micEndpointId");
                break;
            }
            string? micEndpointId = micElement.ValueKind == JsonValueKind.String ? micElement.GetString() : null;
            recordQueue.Add(() =>
            {
                if (recording is not null)
                {
                    Output.Error(id, "busy", "A recording is already in progress");
                    return;
                }
                try
                {
                    recording = Recording.Start(id, dir, otherPids, micEndpointId, echoPid);
                    Output.Write(new
                    {
                        type = "record-started",
                        id,
                        startedAt = recording.StartedAt,
                        othersMode = recording.OthersMode,
                        micName = recording.MicName
                    });
                }
                catch (Exception error)
                {
                    recording = null;
                    Output.Error(id, "record-failed", $"Could not start recording ({error.GetType().Name})");
                }
            });
            break;

        case "record-retarget":
            if (!TryPids(request, "otherPids", out var retargetPids))
            {
                Output.Error(id, "bad-request", "record-retarget needs otherPids: number[]");
                break;
            }
            recordQueue.Add(() =>
            {
                if (recording is null || recording.Id != id) Output.Error(id, "not-recording", "No recording with that id");
                else recording.Retarget(retargetPids);
            });
            break;

        case "record-mic-pause":
            if (!request.TryGetProperty("paused", out var pausedElement)
                || (pausedElement.ValueKind != JsonValueKind.True && pausedElement.ValueKind != JsonValueKind.False))
            {
                Output.Error(id, "bad-request", "record-mic-pause needs paused: boolean");
                break;
            }
            bool paused = pausedElement.ValueKind == JsonValueKind.True;
            // The pause applies from when it was asked for, even if the request thread is busy.
            long requestedQpc = Qpc.Now();
            recordQueue.Add(() =>
            {
                if (recording is null || recording.Id != id) Output.Error(id, "not-recording", "No recording with that id");
                else Output.Write(new { type = "record-mic-paused", id, paused, samples = recording.SetMicPaused(paused, requestedQpc) });
            });
            break;

        case "record-stop":
            recordQueue.Add(() =>
            {
                if (recording is null || recording.Id != id) Output.Error(id, "not-recording", "No recording with that id");
                else StopRecording(id);
            });
            break;

        default:
            Output.Error(id, "unknown-request", $"Unknown request type '{type}'");
            break;
    }
    return true;
}

void StopRecording(string? id)
{
    if (recording is null || id is null) return;
    var current = recording;
    recording = null;
    try
    {
        long samples = current.Stop();
        Output.Write(new { type = "record-stopped", id, samples });
    }
    catch (Exception error)
    {
        Output.Error(id, "record-failed", $"Could not finish the recording ({error.GetType().Name})");
    }
}

static bool TryString(JsonElement element, string name, out string value)
{
    value = "";
    if (!element.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.String) return false;
    value = property.GetString() ?? "";
    return true;
}

static bool TryStrings(JsonElement element, string name, out List<string> values)
{
    values = new List<string>();
    if (!element.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.Array) return false;
    foreach (var item in property.EnumerateArray())
    {
        if (item.ValueKind != JsonValueKind.String) return false;
        values.Add(item.GetString() ?? "");
    }
    return true;
}

static bool TryPids(JsonElement element, string name, out List<uint> pids)
{
    pids = new List<uint>();
    if (!element.TryGetProperty(name, out var property) || property.ValueKind != JsonValueKind.Array) return false;
    foreach (var item in property.EnumerateArray())
    {
        if (item.ValueKind != JsonValueKind.Number || !item.TryGetUInt32(out var pid)) return false;
        pids.Add(pid);
    }
    return true;
}
