using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using NAudio.Wave;

namespace EchoMeetingHelper;

// The recording timeline. Both files are 16 kHz mono s16le and sample N of either file is the
// instant t0 + N/16000 s on the QPC clock, where t0 is taken once at record-start.
//
// Every capture stream (a TimelineSource) places its packets by their QPC timestamp rather than by
// counting samples. Process loopback keeps only ~30 ms of buffer and a stalled reader loses the rest
// silently: no DATA_DISCONTINUITY flag, no device-position jump, only the QPC timestamp moves. So:
//   - a packet whose timestamp is more than GapTolerance ahead of where the source has written
//     jumps forward, leaving zeros (the gap is padded);
//   - a packet at or behind the write position is appended (timestamp jitter, a fast device clock);
//   - samples are dropped only when the source would run more than AheadLimit ahead of real time.
// A Channel sums its sources (several loopback PIDs) with clipping as it commits to disk. The
// flusher commits up to the slowest live source, but never lags real time by more than
// LagAllowance, so a channel with no working source (mic unplugged) still advances in silence.

static class Qpc
{
    /// <summary>QueryPerformanceCounter in 100 ns units, the unit WASAPI uses for qpcPosition.</summary>
    public static long Now()
    {
        long ticks = Stopwatch.GetTimestamp();
        long frequency = Stopwatch.Frequency;
        return ticks / frequency * 10_000_000 + ticks % frequency * 10_000_000 / frequency;
    }
}

sealed class Channel : IDisposable
{
    public const int Rate = 16_000;
    public const int GapTolerance = Rate / 100;   // 10 ms
    public const int AheadLimit = Rate / 5;       // 200 ms
    public const int LagAllowance = Rate / 2;     // 500 ms
    const int Capacity = Rate * 8;                // 8 s of uncommitted audio in memory

    public readonly object Gate = new();
    public readonly List<TimelineSource> Sources = new();
    readonly int[] ring = new int[Capacity];
    readonly byte[] output = new byte[Capacity * 2];
    readonly FileStream file;
    readonly long t0;
    long committed;
    long highWater;
    double sumSquares;
    long levelSamples;
    // Muted spans [Start, End) of the timeline (End = long.MaxValue while open). Committed as
    // digital silence, so the real audio of a muted span never reaches the file.
    readonly List<(long Start, long End)> muted = new();

    public Channel(string path, long t0)
    {
        this.t0 = t0;
        file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read | FileShare.Delete, 1 << 16);
    }

    /// <summary>Sample index of a QPC instant (100 ns units) on this recording's timeline.</summary>
    public long PositionOf(long qpc) => (qpc - t0) * Rate / 10_000_000;

    public long Committed { get { lock (Gate) return committed; } }

    public long HighWater { get { lock (Gate) return Math.Max(highWater, committed); } }

    /// <summary>Samples dropped because a source ran more than AheadLimit ahead of real time. Written under Gate.</summary>
    public long Dropped;

    /// <summary>Mix samples in at an absolute position. Caller holds <see cref="Gate"/>. Never allocates.</summary>
    public void Add(ReadOnlySpan<short> samples, long position)
    {
        for (int i = 0; i < samples.Length; i++)
        {
            long p = position + i;
            if (p < committed) continue;                 // already on disk: too late to place
            if (p >= committed + Capacity) break;         // flusher starved: cannot hold more
            ring[p % Capacity] += samples[i];
        }
        long end = Math.Min(position + samples.Length, committed + Capacity);
        if (end > highWater) highWater = end;
    }

    /// <summary>Earliest write position among live sources that have started, or null.</summary>
    public long? SlowestLiveSource()
    {
        lock (Gate)
        {
            long? slowest = null;
            foreach (var source in Sources)
            {
                if (!source.Live || !source.Started) continue;
                if (slowest is null || source.NextPosition < slowest) slowest = source.NextPosition;
            }
            return slowest;
        }
    }

    /// <summary>
    /// Mute (commit silence) from `at`, or unmute from `at`. A position already on disk cannot be
    /// changed, so `at` is moved up to the committed position. Returns the position it applies from.
    /// </summary>
    public long SetMuted(bool on, long at)
    {
        lock (Gate)
        {
            at = Math.Max(at, committed);
            bool open = muted.Count > 0 && muted[^1].End == long.MaxValue;
            if (on && !open) muted.Add((at, long.MaxValue));
            else if (!on && open) muted[^1] = (muted[^1].Start, Math.Max(at, muted[^1].Start));
            return at;
        }
    }

    /// <summary>Caller holds <see cref="Gate"/>. Spans are few and ordered; old ones are pruned on commit.</summary>
    bool IsMuted(long p)
    {
        for (int i = muted.Count - 1; i >= 0; i--)
        {
            if (p >= muted[i].End) return false;
            if (p >= muted[i].Start) return true;
        }
        return false;
    }

    /// <summary>Write everything before `upTo` to disk (clipped sum; never-written and muted samples are silence).</summary>
    public void Commit(long upTo)
    {
        int count;
        lock (Gate)
        {
            count = (int)Math.Clamp(upTo - committed, 0, Capacity);
            for (int i = 0; i < count; i++)
            {
                long p = committed + i;
                int index = (int)(p % Capacity);
                int value = muted.Count > 0 && IsMuted(p) ? 0 : Math.Clamp(ring[index], short.MinValue, short.MaxValue);
                ring[index] = 0;
                sumSquares += (double)value * value;
                output[i * 2] = (byte)value;
                output[i * 2 + 1] = (byte)(value >> 8);
            }
            levelSamples += count;
            committed += count;
            muted.RemoveAll(span => span.End <= committed);
        }
        if (count == 0) return;
        file.Write(output, 0, count * 2);
        file.Flush();
    }

    /// <summary>RMS (0..1) of everything committed since the last call.</summary>
    public double TakeLevel()
    {
        lock (Gate)
        {
            double rms = levelSamples > 0 ? Math.Sqrt(sumSquares / levelSamples) / 32768.0 : 0;
            sumSquares = 0;
            levelSamples = 0;
            return Math.Round(rms, 5);
        }
    }

    public void Dispose()
    {
        file.Flush(true);
        file.Dispose();
    }
}

/// <summary>One capture stream feeding a channel. <see cref="OnPacket"/> runs on the MMCSS capture thread and never allocates.</summary>
sealed class TimelineSource
{
    readonly Channel channel;
    readonly WaveFormat format;
    readonly short[] scratch = new short[Channel.Rate * 2];
    long nextPosition;

    public TimelineSource(Channel channel, WaveFormat format)
    {
        this.channel = channel;
        this.format = format;
    }

    /// <summary>Read under the channel's Gate.</summary>
    public bool Live { get; set; } = true;
    public bool Started { get; private set; }
    public long NextPosition => nextPosition;

    public void OnPacket(ReadOnlySpan<byte> data, long qpc)
    {
        int count = ToMono(data);
        if (count <= 0) return;
        long position = channel.PositionOf(qpc);
        long limit = channel.PositionOf(Qpc.Now()) + Channel.AheadLimit;
        lock (channel.Gate)
        {
            if (!Live) return;
            if (!Started || position > nextPosition + Channel.GapTolerance)
            {
                nextPosition = position;
                Started = true;
            }
            long room = limit - nextPosition;
            int keep = (int)Math.Clamp(room, 0, count);
            if (keep < count) channel.Dropped += count - keep;
            if (keep == 0) return;
            channel.Add(scratch.AsSpan(0, keep), nextPosition);
            nextPosition += keep;
        }
    }

    int ToMono(ReadOnlySpan<byte> data)
    {
        int channels = Math.Max(1, (int)format.Channels);
        if (format.Encoding == WaveFormatEncoding.IeeeFloat && format.BitsPerSample == 32)
        {
            var floats = MemoryMarshal.Cast<byte, float>(data);
            int frames = Math.Min(floats.Length / channels, scratch.Length);
            for (int f = 0; f < frames; f++)
            {
                float sum = 0;
                for (int c = 0; c < channels; c++) sum += floats[f * channels + c];
                scratch[f] = (short)Math.Clamp(sum / channels * 32767f, short.MinValue, short.MaxValue);
            }
            return frames;
        }
        if (format.BitsPerSample == 16)
        {
            var shorts = MemoryMarshal.Cast<byte, short>(data);
            int frames = Math.Min(shorts.Length / channels, scratch.Length);
            if (channels == 1)
            {
                shorts[..frames].CopyTo(scratch);
                return frames;
            }
            for (int f = 0; f < frames; f++)
            {
                int sum = 0;
                for (int c = 0; c < channels; c++) sum += shorts[f * channels + c];
                scratch[f] = (short)(sum / channels);
            }
            return frames;
        }
        return 0;
    }
}
