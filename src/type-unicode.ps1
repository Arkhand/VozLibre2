# VozLibre2 — Tecleo Unicode real (SendInput / KEYEVENTF_UNICODE)
# ==============================================================
# Teclea texto arbitrario como PULSACIONES REALES de teclado, carácter por
# carácter, vía la API Win32 SendInput con KEYEVENTF_UNICODE. Esto:
#   - Soporta CUALQUIER carácter Unicode (acentos, ñ, ¿¡, emojis…) sin teclas muertas.
#   - Funciona en VDI/RDP (son eventos de teclado genuinos, NO portapapeles).
#   - Es invisible (el proceso se lanza con windowsHide; no roba foco).
# El texto llega por STDIN (UTF-8) para no tener problemas de escaping/longitud.
#
# CLAVE: el struct INPUT debe medir 40 bytes en x64 (4 type + 4 padding + 32 del
# union, que reserva el tamaño de MOUSEINPUT). Si no, SendInput devuelve 0 y
# lastErr=87 (ERROR_INVALID_PARAMETER) y NO teclea nada.

$ErrorActionPreference = "Stop"

$signature = @'
using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class UnicodeTyper {
    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT {
        public ushort wVk; public ushort wScan; public uint dwFlags;
        public uint time; public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct MOUSEINPUT {
        public int dx; public int dy; public uint mouseData; public uint dwFlags;
        public uint time; public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Explicit)]
    struct INPUT {
        [FieldOffset(0)] public uint type;
        [FieldOffset(8)] public MOUSEINPUT mi;   // reserva el tamaño del union (32B)
        [FieldOffset(8)] public KEYBDINPUT ki;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    const uint INPUT_KEYBOARD    = 1;
    const uint KEYEVENTF_KEYUP   = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;

    public static void Type(string text, int perCharDelayMs) {
        int size = Marshal.SizeOf(typeof(INPUT)); // 40 en x64
        foreach (char c in text) {
            INPUT[] inputs = new INPUT[2];
            inputs[0].type = INPUT_KEYBOARD;
            inputs[0].ki.wScan = (ushort)c;
            inputs[0].ki.dwFlags = KEYEVENTF_UNICODE;
            inputs[1].type = INPUT_KEYBOARD;
            inputs[1].ki.wScan = (ushort)c;
            inputs[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            SendInput(2, inputs, size);
            if (perCharDelayMs > 0) Thread.Sleep(perCharDelayMs);
        }
    }
}
'@

Add-Type -TypeDefinition $signature -Language CSharp

# Leer TODO el texto desde STDIN como UTF-8 EXPLÍCITO. [Console]::In usa la
# codificación de consola por defecto (CP850/Latin-1 en es-AR) y rompe los acentos
# (á -> ├í). Abrimos el stream crudo con un StreamReader UTF-8 sin BOM.
$stdinStream = [Console]::OpenStandardInput()
$reader = New-Object System.IO.StreamReader($stdinStream, [System.Text.UTF8Encoding]::new($false))
$stdin = $reader.ReadToEnd()
$reader.Dispose()

# Pequeño respiro para asegurar que la app destino tiene el foco.
Start-Sleep -Milliseconds 150

# 2ms entre caracteres: fiable en apps lentas/VDI sin ser perceptible.
[UnicodeTyper]::Type($stdin, 2)
