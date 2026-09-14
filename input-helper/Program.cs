using System.Runtime.InteropServices;
using System.Text.Json;

internal static class Program
{
    private const uint InputMouse = 0;
    private const uint InputKeyboard = 1;
    private const uint MouseMove = 0x0001;
    private const uint MouseLeftDown = 0x0002;
    private const uint MouseLeftUp = 0x0004;
    private const uint MouseRightDown = 0x0008;
    private const uint MouseRightUp = 0x0010;
    private const uint MouseMiddleDown = 0x0020;
    private const uint MouseMiddleUp = 0x0040;
    private const uint MouseWheel = 0x0800;
    private const uint MouseHWheel = 0x01000;
    private const uint MouseAbsolute = 0x8000;
    private const uint KeyUp = 0x0002;
    private const uint KeyExtended = 0x0001;
    private const int WheelDelta = 120;

    private static readonly HashSet<ushort> PressedKeys = [];
    private static readonly HashSet<int> PressedButtons = [];

    private static readonly Dictionary<string, ushort> KeyCodes =
        new(StringComparer.Ordinal)
        {
            ["Backspace"] = 0x08,
            ["Tab"] = 0x09,
            ["Enter"] = 0x0D,
            ["NumpadEnter"] = 0x0D,
            ["ShiftLeft"] = 0xA0,
            ["ShiftRight"] = 0xA1,
            ["ControlLeft"] = 0xA2,
            ["ControlRight"] = 0xA3,
            ["AltLeft"] = 0xA4,
            ["AltRight"] = 0xA5,
            ["Pause"] = 0x13,
            ["CapsLock"] = 0x14,
            ["Escape"] = 0x1B,
            ["Space"] = 0x20,
            ["PageUp"] = 0x21,
            ["PageDown"] = 0x22,
            ["End"] = 0x23,
            ["Home"] = 0x24,
            ["ArrowLeft"] = 0x25,
            ["ArrowUp"] = 0x26,
            ["ArrowRight"] = 0x27,
            ["ArrowDown"] = 0x28,
            ["PrintScreen"] = 0x2C,
            ["Insert"] = 0x2D,
            ["Delete"] = 0x2E,
            ["MetaLeft"] = 0x5B,
            ["MetaRight"] = 0x5C,
            ["ContextMenu"] = 0x5D,
            ["NumLock"] = 0x90,
            ["ScrollLock"] = 0x91,
            ["NumpadMultiply"] = 0x6A,
            ["NumpadAdd"] = 0x6B,
            ["NumpadSubtract"] = 0x6D,
            ["NumpadDecimal"] = 0x6E,
            ["NumpadDivide"] = 0x6F,
            ["Semicolon"] = 0xBA,
            ["Equal"] = 0xBB,
            ["Comma"] = 0xBC,
            ["Minus"] = 0xBD,
            ["Period"] = 0xBE,
            ["Slash"] = 0xBF,
            ["Backquote"] = 0xC0,
            ["BracketLeft"] = 0xDB,
            ["Backslash"] = 0xDC,
            ["BracketRight"] = 0xDD,
            ["Quote"] = 0xDE,
        };

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(
        uint inputCount,
        INPUT[] inputs,
        int inputSize
    );

    private static void Main()
    {
        Console.InputEncoding = System.Text.Encoding.UTF8;
        string? line;
        while ((line = Console.ReadLine()) is not null)
        {
            if (line.Length is 0 or > 4096)
            {
                continue;
            }

            try
            {
                using var document = JsonDocument.Parse(line);
                Handle(document.RootElement);
            }
            catch
            {
                // Invalid or partial messages are ignored.
            }
        }

        ReleaseAll();
    }

    private static void Handle(JsonElement message)
    {
        if (!message.TryGetProperty("t", out var typeProperty))
        {
            return;
        }

        var type = typeProperty.GetString();
        if (type == "release-all")
        {
            ReleaseAll();
            return;
        }

        if (!message.TryGetProperty("kind", out var kindProperty))
        {
            return;
        }

        var kind = kindProperty.GetString();
        if (type == "pointer")
        {
            HandlePointer(message, kind);
        }
        else if (type == "key")
        {
            HandleKey(message, kind);
        }
    }

    private static void HandlePointer(
        JsonElement message,
        string? kind
    )
    {
        switch (kind)
        {
            case "move":
            {
                var x = Clamp01(ReadDouble(message, "x"));
                var y = Clamp01(ReadDouble(message, "y"));
                SendMouse(
                    (int)Math.Round(x * 65535),
                    (int)Math.Round(y * 65535),
                    0,
                    MouseMove | MouseAbsolute
                );
                break;
            }
            case "relative":
            {
                var dx = Math.Clamp(
                    ReadInt(message, "dx"),
                    -1000,
                    1000
                );
                var dy = Math.Clamp(
                    ReadInt(message, "dy"),
                    -1000,
                    1000
                );
                SendMouse(dx, dy, 0, MouseMove);
                break;
            }
            case "down":
            {
                var button = ReadInt(message, "button");
                if (PressedButtons.Add(button))
                {
                    SendMouse(
                        0,
                        0,
                        0,
                        MouseButtonFlag(button, true)
                    );
                }
                break;
            }
            case "up":
            {
                var button = ReadInt(message, "button");
                PressedButtons.Remove(button);
                SendMouse(
                    0,
                    0,
                    0,
                    MouseButtonFlag(button, false)
                );
                break;
            }
            case "wheel":
            {
                var vertical = Math.Clamp(
                    (int)Math.Round(
                        -ReadDouble(message, "deltaY") * 1.2
                    ),
                    -WheelDelta * 10,
                    WheelDelta * 10
                );
                var horizontal = Math.Clamp(
                    (int)Math.Round(
                        ReadDouble(message, "deltaX") * 1.2
                    ),
                    -WheelDelta * 10,
                    WheelDelta * 10
                );
                if (vertical != 0)
                {
                    SendMouse(
                        0,
                        0,
                        unchecked((uint)vertical),
                        MouseWheel
                    );
                }
                if (horizontal != 0)
                {
                    SendMouse(
                        0,
                        0,
                        unchecked((uint)horizontal),
                        MouseHWheel
                    );
                }
                break;
            }
        }
    }

    private static void HandleKey(
        JsonElement message,
        string? kind
    )
    {
        if (
            !message.TryGetProperty("code", out var codeProperty) ||
            codeProperty.GetString() is not { } code ||
            MapCode(code) is not { } virtualKey
        )
        {
            return;
        }

        var isDown = kind == "down";
        var isUp = kind == "up";
        if (!isDown && !isUp)
        {
            return;
        }

        if (isDown)
        {
            PressedKeys.Add(virtualKey);
        }
        else
        {
            PressedKeys.Remove(virtualKey);
        }

        var flags = isUp ? KeyUp : 0u;
        if (IsExtended(code))
        {
            flags |= KeyExtended;
        }
        SendKeyboard(virtualKey, flags);
    }

    private static ushort? MapCode(string code)
    {
        if (
            code.Length == 4 &&
            code.StartsWith("Key", StringComparison.Ordinal) &&
            code[3] is >= 'A' and <= 'Z'
        )
        {
            return code[3];
        }
        if (
            code.Length == 6 &&
            code.StartsWith("Digit", StringComparison.Ordinal) &&
            code[5] is >= '0' and <= '9'
        )
        {
            return code[5];
        }
        if (
            code.Length == 7 &&
            code.StartsWith("Numpad", StringComparison.Ordinal) &&
            code[6] is >= '0' and <= '9'
        )
        {
            return (ushort)(0x60 + (code[6] - '0'));
        }
        if (
            code.StartsWith("F", StringComparison.Ordinal) &&
            int.TryParse(code.AsSpan(1), out var functionKey) &&
            functionKey is >= 1 and <= 24
        )
        {
            return (ushort)(0x70 + functionKey - 1);
        }
        return KeyCodes.TryGetValue(code, out var virtualKey)
            ? virtualKey
            : null;
    }

    private static bool IsExtended(string code)
    {
        return code is
            "ControlRight" or
            "AltRight" or
            "MetaLeft" or
            "MetaRight" or
            "ContextMenu" or
            "Insert" or
            "Delete" or
            "Home" or
            "End" or
            "PageUp" or
            "PageDown" or
            "ArrowLeft" or
            "ArrowUp" or
            "ArrowRight" or
            "ArrowDown" or
            "NumpadDivide" or
            "NumpadEnter";
    }

    private static uint MouseButtonFlag(
        int button,
        bool down
    )
    {
        return button switch
        {
            0 => down ? MouseLeftDown : MouseLeftUp,
            1 => down ? MouseMiddleDown : MouseMiddleUp,
            2 => down ? MouseRightDown : MouseRightUp,
            _ => 0,
        };
    }

    private static void ReleaseAll()
    {
        foreach (var virtualKey in PressedKeys.ToArray())
        {
            SendKeyboard(virtualKey, KeyUp);
        }
        PressedKeys.Clear();

        foreach (var button in PressedButtons.ToArray())
        {
            SendMouse(
                0,
                0,
                0,
                MouseButtonFlag(button, false)
            );
        }
        PressedButtons.Clear();
    }

    private static void SendMouse(
        int dx,
        int dy,
        uint mouseData,
        uint flags
    )
    {
        if (flags == 0)
        {
            return;
        }
        var inputs = new[]
        {
            new INPUT
            {
                type = InputMouse,
                data = new InputUnion
                {
                    mouse = new MOUSEINPUT
                    {
                        dx = dx,
                        dy = dy,
                        mouseData = mouseData,
                        dwFlags = flags,
                        time = 0,
                        dwExtraInfo = UIntPtr.Zero,
                    },
                },
            },
        };
        _ = SendInput(
            1,
            inputs,
            Marshal.SizeOf<INPUT>()
        );
    }

    private static void SendKeyboard(
        ushort virtualKey,
        uint flags
    )
    {
        var inputs = new[]
        {
            new INPUT
            {
                type = InputKeyboard,
                data = new InputUnion
                {
                    keyboard = new KEYBDINPUT
                    {
                        wVk = virtualKey,
                        wScan = 0,
                        dwFlags = flags,
                        time = 0,
                        dwExtraInfo = UIntPtr.Zero,
                    },
                },
            },
        };
        _ = SendInput(
            1,
            inputs,
            Marshal.SizeOf<INPUT>()
        );
    }

    private static double ReadDouble(
        JsonElement message,
        string name
    )
    {
        return message.TryGetProperty(name, out var property) &&
               property.TryGetDouble(out var value)
            ? value
            : 0;
    }

    private static int ReadInt(
        JsonElement message,
        string name
    )
    {
        return message.TryGetProperty(name, out var property) &&
               property.TryGetInt32(out var value)
            ? value
            : 0;
    }

    private static double Clamp01(double value)
    {
        return Math.Clamp(value, 0, 1);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct INPUT
    {
        public uint type;
        public InputUnion data;
    }

    [StructLayout(LayoutKind.Explicit)]
    private struct InputUnion
    {
        [FieldOffset(0)]
        public MOUSEINPUT mouse;

        [FieldOffset(0)]
        public KEYBDINPUT keyboard;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public UIntPtr dwExtraInfo;
    }
}
