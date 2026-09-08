using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace SubrouterNative;

public sealed class BackendStartException : Exception
{
    public BackendStartException(string message) : base(message) { }
}

/// <summary>
/// Starts and stops the existing zero-dependency server.js under the bundled
/// node.exe, mirroring desktop/main.js (the Electron shell) with one
/// deliberate difference: port selection never scans for a free port. It uses
/// one stable, saved port and fails outright if that port is taken by
/// something else, rather than silently moving - see ResolvePort below.
/// </summary>
public sealed class BackendHost : IDisposable
{
    public const string Host = "127.0.0.1";

    // Distinct from the manual `node server.js` default (8787) and the
    // Electron shell's default (8788), so all three can coexist in dev.
    private const int DefaultPort = 8790;
    private const int HealthTimeoutMs = 20000;

    public string InstanceId { get; } = Guid.NewGuid().ToString("n");
    public int Port { get; private set; }
    public string Origin => $"http://{Host}:{Port}";

    private readonly string _appDataDir;
    private readonly JobObject _jobObject = new();
    private Process? _process;

    public BackendHost()
    {
        _appDataDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "SubrouterNative");
        Directory.CreateDirectory(_appDataDir);
    }

    // Never touches the repo's own config.json - this file lives entirely
    // under %LOCALAPPDATA%\SubrouterNative (or SUBROUTER_CONFIG_PATH), and its
    // content is never read back into a log, console line, or dialog by this
    // host or by server.js.
    private string ConfigPath()
    {
        var overridePath = Environment.GetEnvironmentVariable("SUBROUTER_CONFIG_PATH");
        if (!string.IsNullOrWhiteSpace(overridePath)) return Path.GetFullPath(overridePath);
        return Path.Combine(_appDataDir, "config.json");
    }

    private string StatePath() => Path.Combine(_appDataDir, "desktop-state.json");

    private void EnsureConfig()
    {
        var target = ConfigPath();
        if (File.Exists(target)) return;
        Directory.CreateDirectory(Path.GetDirectoryName(target)!);
        var initial = new
        {
            base_url = "https://router.eva.pink/v1",
            api_key = "",
            mcpServers = new { }
        };
        File.WriteAllText(target, JsonSerializer.Serialize(initial, new JsonSerializerOptions { WriteIndented = true }));
    }

    private static bool PortIsFree(int port)
    {
        try
        {
            using var listener = new TcpListener(IPAddress.Parse(Host), port);
            listener.Start();
            listener.Stop();
            return true;
        }
        catch (SocketException)
        {
            return false;
        }
    }

    // Deliberately does NOT scan forward for a free port the way the Electron
    // shell does. A native shell has no localStorage-continuity reason to hunt
    // silently for a spare port; if the saved/default port is occupied by
    // something else, that is surfaced as a startup failure so the user (or
    // SUBROUTER_DESKTOP_PORT) can decide, instead of quietly moving.
    private int ResolvePort()
    {
        var forcedRaw = Environment.GetEnvironmentVariable("SUBROUTER_DESKTOP_PORT");
        if (int.TryParse(forcedRaw, out var forced) && forced is > 0 and < 65536) return forced;

        var preferred = DefaultPort;
        try
        {
            if (File.Exists(StatePath()))
            {
                using var doc = JsonDocument.Parse(File.ReadAllText(StatePath()));
                if (doc.RootElement.TryGetProperty("port", out var p) && p.TryGetInt32(out var savedPort))
                    preferred = savedPort;
            }
        }
        catch { /* a corrupt state file just falls back to the default */ }

        if (!PortIsFree(preferred))
        {
            throw new BackendStartException(
                $"Port {preferred} is already in use by another process.\n\n" +
                "This app uses one stable port and does not hunt for a free one. " +
                "Close whatever is using it, or set the SUBROUTER_DESKTOP_PORT " +
                "environment variable to a free port, then retry.");
        }

        try
        {
            File.WriteAllText(StatePath(), JsonSerializer.Serialize(new { port = preferred }));
        }
        catch { /* a stale port file is not worth failing startup over */ }

        return preferred;
    }

    // Published layout: <exe dir>\backend\server.js and <exe dir>\node\node.exe
    //
    // Deliberately NOT AppContext.BaseDirectory: with this project's single-file
    // settings (IncludeAllContentForSelfExtract=true), that property resolves to
    // the single-file extraction cache under %TEMP%\.net\Subrouter\<hash>\ rather
    // than the folder actually containing Subrouter.exe, even though these Content
    // items are excluded from the bundle and copied out as physical files next to
    // the exe (see the csproj). Environment.ProcessPath is the real exe path.
    private static string ExeDirectory() =>
        Path.GetDirectoryName(Environment.ProcessPath) ?? AppContext.BaseDirectory;

    private static string BackendRoot() => Path.Combine(ExeDirectory(), "backend");
    private static string NodeExePath() => Path.Combine(ExeDirectory(), "node", "node.exe");

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        EnsureConfig();
        Port = ResolvePort();

        var backendRoot = BackendRoot();
        var serverEntry = Path.Combine(backendRoot, "server.js");
        if (!File.Exists(serverEntry))
            throw new BackendStartException($"server.js not found at {serverEntry}. The package is incomplete.");

        var nodeExe = NodeExePath();
        if (!File.Exists(nodeExe))
            throw new BackendStartException($"node.exe not found at {nodeExe}. The package is incomplete.");

        var psi = new ProcessStartInfo
        {
            FileName = nodeExe,
            WorkingDirectory = backendRoot,
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
        psi.ArgumentList.Add(serverEntry);
        psi.Environment["PORT"] = Port.ToString();
        psi.Environment["SUBROUTER_CONFIG_PATH"] = ConfigPath();
        psi.Environment["SUBROUTER_INSTANCE_ID"] = InstanceId;
        // Windows delivers no real SIGTERM to an external process, so the
        // graceful-shutdown signal here is stdin closing - see server.js and
        // StopAsync below. Opt-in so a hand-run `node server.js` is unaffected.
        psi.Environment["SUBROUTER_STDIN_SHUTDOWN"] = "1";
        psi.Environment["NODE_ENV"] = Environment.GetEnvironmentVariable("NODE_ENV") ?? "production";

        _process = new Process { StartInfo = psi, EnableRaisingEvents = true };
        // Drain but never surface backend stdout/stderr anywhere (no console,
        // no UI, no log file). server.js does not log message content or
        // secrets, but the policy here is "never relay what the child prints"
        // rather than trusting that by proxy.
        _process.OutputDataReceived += (_, _) => { };
        _process.ErrorDataReceived += (_, _) => { };

        if (!_process.Start())
            throw new BackendStartException("Failed to start the backend process.");

        _process.BeginOutputReadLine();
        _process.BeginErrorReadLine();

        // Belt-and-braces: if this app is killed outright (crash, Task
        // Manager, TerminateProcess), the job object takes node.exe and any
        // MCP children it spawned down with it, since neither graceful path
        // below gets a chance to run.
        _jobObject.Assign(_process.Handle);

        await WaitForHealthAsync(cancellationToken);
    }

    private async Task WaitForHealthAsync(CancellationToken cancellationToken)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var deadline = DateTime.UtcNow.AddMilliseconds(HealthTimeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_process is null || _process.HasExited)
                throw new BackendStartException("The local server exited during startup.");

            if (await HealthOnceAsync(http)) return;
            await Task.Delay(150, cancellationToken);
        }
        throw new BackendStartException(
            $"The local server did not answer on {Host}:{Port} within {HealthTimeoutMs / 1000}s.");
    }

    // Only ever proceeds against a server that echoes our own instance id, so
    // this can never end up driving somebody else's process on the same port.
    private async Task<bool> HealthOnceAsync(HttpClient http)
    {
        try
        {
            using var res = await http.GetAsync($"{Origin}/api/health");
            if (!res.IsSuccessStatusCode) return false;
            var body = await res.Content.ReadAsStringAsync();
            using var doc = JsonDocument.Parse(body);
            var root = doc.RootElement;
            var app = root.TryGetProperty("app", out var a) ? a.GetString() : null;
            var instance = root.TryGetProperty("instance", out var i) ? i.GetString() : null;
            return app == "subrouter-web" && instance == InstanceId;
        }
        catch
        {
            return false;
        }
    }

    // Graceful path: close stdin so server.js's opt-in SUBROUTER_STDIN_SHUTDOWN
    // handler sees EOF and shuts itself down cleanly (stopping MCP children,
    // closing the HTTP server) on its own terms. Process.Kill() below (and the
    // Job Object) are the forceful fallback, not the primary mechanism.
    public async Task StopAsync()
    {
        var process = _process;
        if (process is null) return;
        try
        {
            if (!process.HasExited)
            {
                try { process.StandardInput.Close(); } catch { /* already gone */ }

                using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(1500));
                try { await process.WaitForExitAsync(cts.Token); }
                catch (OperationCanceledException) { /* fall through to force kill */ }
            }
        }
        finally
        {
            try { if (!process.HasExited) process.Kill(entireProcessTree: true); } catch { /* already gone */ }
        }
    }

    public void Dispose()
    {
        try { if (_process is { HasExited: false }) _process.Kill(entireProcessTree: true); } catch { }
        _jobObject.Dispose();
        _process?.Dispose();
    }
}
