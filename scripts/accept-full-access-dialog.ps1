param(
    [int]$TimeoutSeconds = 45
)

$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;

public static class ShuguNativeDialog
{
    public delegate bool EnumWindowProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(
        IntPtr parent,
        EnumWindowProc callback,
        IntPtr lParam
    );

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll")]
    public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hwnd, int command);
}
"@

function Get-NativeText {
    param([IntPtr]$Handle)
    $text = New-Object System.Text.StringBuilder 512
    [void][ShuguNativeDialog]::GetWindowText($Handle, $text, $text.Capacity)
    return $text.ToString()
}

function Get-NativeClass {
    param([IntPtr]$Handle)
    $text = New-Object System.Text.StringBuilder 128
    [void][ShuguNativeDialog]::GetClassName($Handle, $text, $text.Capacity)
    return $text.ToString()
}

$deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
while ([DateTime]::UtcNow -lt $deadline) {
    $accepted = $false
    [ShuguNativeDialog]::EnumWindows(
        {
            param([IntPtr]$window, [IntPtr]$state)
            $title = Get-NativeText -Handle $window
            if ($title -notlike "*Activer Full Access*") {
                return $true
            }
            # The smoke test must exercise the native grant without flashing a
            # modal over the user's real desktop session.
            [void][ShuguNativeDialog]::ShowWindow($window, 0)

            [ShuguNativeDialog]::EnumChildWindows(
                $window,
                {
                    param([IntPtr]$child, [IntPtr]$childState)
                    $className = Get-NativeClass -Handle $child
                    $label = Get-NativeText -Handle $child
                    if ($className -eq "Button" -and $label -like "*Activer Full Access*") {
                        # BM_CLICK: exercise the real native confirmation button.
                        [void][ShuguNativeDialog]::SendMessage(
                            $child,
                            0x00F5,
                            [IntPtr]::Zero,
                            [IntPtr]::Zero
                        )
                        $script:accepted = $true
                        return $false
                    }
                    return $true
                },
                [IntPtr]::Zero
            ) | Out-Null
            return -not $script:accepted
        },
        [IntPtr]::Zero
    ) | Out-Null

    if ($accepted) {
        Write-Output "accepted native Full Access session dialog"
        exit 0
    }
    Start-Sleep -Milliseconds 100
}

Write-Error "native Full Access confirmation dialog was not found within $TimeoutSeconds seconds"
exit 1
