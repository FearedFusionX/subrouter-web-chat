using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;

namespace SubrouterNative;

public partial class App : Application
{
    // Local, not Global\ - this is a per-user single-instance lock, matching
    // the Electron shell's app.requestSingleInstanceLock() semantics.
    private const string MutexName = "Local\\SubrouterNative-SingleInstance-Lock";
    private const string WindowTitle = "Subrouter";

    private Mutex? _instanceMutex;
    private BackendHost? _backend;

    [DllImport("user32.dll")]
    private static extern IntPtr FindWindow(string? lpClassName, string lpWindowName);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hWnd);

    private const int SW_RESTORE = 9;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        ShutdownMode = ShutdownMode.OnExplicitShutdown;

        _instanceMutex = new Mutex(initiallyOwned: true, MutexName, out bool createdNew);
        if (!createdNew)
        {
            var existing = FindWindow(null, WindowTitle);
            if (existing != IntPtr.Zero)
            {
                ShowWindow(existing, SW_RESTORE);
                SetForegroundWindow(existing);
            }
            Shutdown();
            return;
        }

        _backend = new BackendHost();
        try
        {
            await _backend.StartAsync(CancellationToken.None);
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Subrouter could not start", MessageBoxButton.OK, MessageBoxImage.Error);
            _backend.Dispose();
            ReleaseMutex();
            Shutdown(1);
            return;
        }

        var window = new MainWindow(_backend);
        MainWindow = window;
        ShutdownMode = ShutdownMode.OnMainWindowClose;
        window.Show();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        // MainWindow's Closing handler already ran BackendHost.StopAsync to
        // completion before the window (and therefore the app) was allowed to
        // close - see MainWindow.xaml.cs. This is just final cleanup.
        _backend?.Dispose();
        ReleaseMutex();
        base.OnExit(e);
    }

    private void ReleaseMutex()
    {
        try { _instanceMutex?.ReleaseMutex(); } catch { /* not owned, e.g. second instance */ }
        _instanceMutex?.Dispose();
    }
}
