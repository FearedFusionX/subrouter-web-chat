using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Windows;
using System.Windows.Interop;
using Microsoft.Web.WebView2.Core;

namespace SubrouterNative;

public partial class MainWindow : Window
{
    private readonly BackendHost _backend;
    private bool _cleanedUp;
    private string? _appOrigin;

    public MainWindow(BackendHost backend)
    {
        _backend = backend;
        InitializeComponent();
        Loaded += MainWindow_Loaded;
    }

    protected override void OnSourceInitialized(EventArgs e)
    {
        HwndSource.FromHwnd(new WindowInteropHelper(this).Handle)?.AddHook(ResizeHitTest);
        base.OnSourceInitialized(e);
    }

    private IntPtr ResizeHitTest(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg != 0x0084 || WindowState != WindowState.Normal) return IntPtr.Zero;
        var point = PointFromScreen(new Point(unchecked((short)lParam.ToInt64()),
            unchecked((short)(lParam.ToInt64() >> 16))));
        double x = point.X, y = point.Y;
        if (x < 0 || y < 0 || x >= ActualWidth || y >= ActualHeight) return IntPtr.Zero;
        bool left = x < 8, right = x >= ActualWidth - 8;
        bool top = y < 8, bottom = y >= ActualHeight - 8;
        int hit = (top && x < 16) || (left && y < 16) ? 13
            : (top && x >= ActualWidth - 16) || (right && y < 16) ? 14
            : (bottom && x < 16) || (left && y >= ActualHeight - 16) ? 16
            : (bottom && x >= ActualWidth - 16) || (right && y >= ActualHeight - 16) ? 17
            : left ? 10 : right ? 11 : top ? 12 : bottom ? 15 : 0;
        if (hit == 0) return IntPtr.Zero;
        handled = true;
        return new IntPtr(hit);
    }

    private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
    {
        _appOrigin = _backend.Origin;

        var userDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "SubrouterNative", "WebView2");
        Directory.CreateDirectory(userDataFolder);

        var envOptions = new CoreWebView2EnvironmentOptions
        {
            // No JS<->host bridge of any kind is wired up (see below), so
            // there is nothing for a compromised/renegade page to reach.
            AllowSingleSignOnUsingOSPrimaryAccount = false
        };
        var environment = await CoreWebView2Environment.CreateAsync(userDataFolder: userDataFolder, options: envOptions);
        await Browser.EnsureCoreWebView2Async(environment);

        var core = Browser.CoreWebView2;
        var settings = core.Settings;

        // --- lock the shell down -------------------------------------------------
        settings.AreDevToolsEnabled = false;
        settings.AreDefaultContextMenusEnabled = true;   // keeps native copy/paste in text fields
        settings.AreHostObjectsAllowed = false;           // no AddHostObjectToScript is ever called; belt-and-braces
        settings.IsWebMessageEnabled = false;              // no postMessage bridge to the host at all
        settings.IsGeneralAutofillEnabled = false;
        settings.IsPasswordAutosaveEnabled = false;
        settings.IsPinchZoomEnabled = false;
        settings.IsStatusBarEnabled = false;
        settings.IsSwipeNavigationEnabled = false;
        settings.IsBuiltInErrorPageEnabled = true;
        settings.IsZoomControlEnabled = true;

        // Only ever allow navigation within our own local origin. Anything
        // else (an external link, a redirect off-origin) is cancelled and,
        // if it's http(s)/mailto, handed to the OS's default handler instead
        // - mirroring the Electron shell's openExternally().
        core.NavigationStarting += (_, args) =>
        {
            if (!IsAppUrl(args.Uri))
            {
                args.Cancel = true;
                OpenExternally(args.Uri);
            }
        };
        core.NewWindowRequested += (_, args) =>
        {
            args.Handled = true;
            OpenExternally(args.Uri);
        };

        // Clipboard read/write and downloads are allowed (Export data, copy
        // buttons); everything else - camera, mic, geolocation, notifications,
        // sensors, etc. - is denied. A local static page needs none of it.
        core.PermissionRequested += (_, args) =>
        {
            args.State = args.PermissionKind switch
            {
                CoreWebView2PermissionKind.ClipboardRead => CoreWebView2PermissionState.Allow,
                CoreWebView2PermissionKind.MultipleAutomaticDownloads => CoreWebView2PermissionState.Allow,
                _ => CoreWebView2PermissionState.Deny
            };
        };

        core.NavigationCompleted += (_, args) =>
        {
            if (args.IsSuccess) LoadingOverlay.Visibility = Visibility.Collapsed;
        };

        Browser.Source = new Uri(_appOrigin + "/");
    }

    private bool IsAppUrl(string target)
    {
        if (_appOrigin is null) return false;
        try
        {
            var candidate = new Uri(target);
            var origin = new Uri(_appOrigin);
            return candidate.Scheme == origin.Scheme && candidate.Host == origin.Host && candidate.Port == origin.Port;
        }
        catch
        {
            return false;
        }
    }

    private static void OpenExternally(string target)
    {
        if (!Uri.TryCreate(target, UriKind.Absolute, out var uri)) return;
        if (uri.Scheme != Uri.UriSchemeHttps && uri.Scheme != "mailto") return;
        try { Process.Start(new ProcessStartInfo(uri.AbsoluteUri) { UseShellExecute = true }); }
        catch { /* no default handler registered - nothing more we can do */ }
    }

    // --- custom titlebar buttons ---------------------------------------------

    private void MinimizeButton_Click(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    private void MaximizeButton_Click(object sender, RoutedEventArgs e) =>
        WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;

    private void CloseButton_Click(object sender, RoutedEventArgs e) => Close();

    // Standard WindowChrome fix: a maximized borderless window otherwise draws
    // under the taskbar / off the visible work area.
    private void MainWindow_StateChanged(object? sender, EventArgs e)
    {
        RootGrid.Margin = WindowState == WindowState.Maximized
            ? new Thickness(SystemParameters.WindowResizeBorderThickness.Left,
                             SystemParameters.WindowResizeBorderThickness.Top,
                             SystemParameters.WindowResizeBorderThickness.Right,
                             SystemParameters.WindowResizeBorderThickness.Bottom)
            : new Thickness(0);
    }

    // Graceful shutdown: hide immediately (fast, feels responsive), close the
    // backend's stdin (its opt-in shutdown signal - see server.js), wait for
    // it to exit on its own, THEN let the app actually close. The Job Object
    // in BackendHost is still there as a hard backstop if this path never
    // gets a chance to run (crash, kill from Task Manager, etc).
    private async void MainWindow_Closing(object? sender, CancelEventArgs e)
    {
        if (_cleanedUp) return;
        e.Cancel = true;
        Hide();
        await _backend.StopAsync();
        _cleanedUp = true;
        Application.Current.Shutdown();
    }
}
