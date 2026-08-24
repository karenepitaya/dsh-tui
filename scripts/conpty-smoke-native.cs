using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public sealed class DshConPtySmokeResult
{
    public byte[] Output { get; set; }
    public uint ProcessId { get; set; }
    public uint ExitCode { get; set; }
    public bool ProcessGone { get; set; }
    public bool OutputPipeClosed { get; set; }
    public bool NativeHandlesClosed { get; set; }
    public bool PromptInputWritten { get; set; }
    public bool QuiescingInputWritten { get; set; }
}

public static class DshConPtySmoke
{
    private const uint ExtendedStartupInfoPresent = 0x00080000;
    private const uint CreateUnicodeEnvironment = 0x00000400;
    private const uint StartfUseStdHandles = 0x00000100;
    private const uint WaitObject0 = 0;
    private const uint WaitTimeout = 258;
    private const uint StillActive = 259;
    private const string ProductPrompt = "ConPTY 真实输入";
    private static readonly IntPtr PseudoConsoleAttribute = new IntPtr(0x00020016);

    [StructLayout(LayoutKind.Sequential)]
    private struct Coord
    {
        public short X;
        public short Y;

        public Coord(short x, short y)
        {
            X = x;
            Y = y;
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfoEx
    {
        public StartupInfo StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInformation
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CreatePipe(
        out IntPtr hReadPipe,
        out IntPtr hWritePipe,
        IntPtr lpPipeAttributes,
        uint nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int CreatePseudoConsole(
        Coord size,
        IntPtr hInput,
        IntPtr hOutput,
        uint dwFlags,
        out IntPtr phPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern int ResizePseudoConsole(IntPtr hPC, Coord size);

    [DllImport("kernel32.dll")]
    private static extern void ClosePseudoConsole(IntPtr hPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(
        IntPtr lpAttributeList,
        int dwAttributeCount,
        int dwFlags,
        ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(
        IntPtr lpAttributeList,
        uint dwFlags,
        IntPtr attribute,
        IntPtr lpValue,
        IntPtr cbSize,
        IntPtr lpPreviousValue,
        IntPtr lpReturnSize);

    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessW(
        string lpApplicationName,
        StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string lpCurrentDirectory,
        ref StartupInfoEx lpStartupInfo,
        out ProcessInformation lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool ReadFile(
        IntPtr hFile,
        byte[] lpBuffer,
        uint nNumberOfBytesToRead,
        out uint lpNumberOfBytesRead,
        IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool WriteFile(
        IntPtr hFile,
        byte[] lpBuffer,
        uint nNumberOfBytesToWrite,
        out uint lpNumberOfBytesWritten,
        IntPtr lpOverlapped);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    public static DshConPtySmokeResult Run(
        string nodePath,
        string probePath,
        string workingDirectory,
        string scenario,
        int timeoutMilliseconds)
    {
        if (scenario != "driver" && scenario != "controller-flow" && scenario != "controller-force")
        {
            throw new ArgumentOutOfRangeException("scenario", scenario, "Unknown ConPTY smoke scenario.");
        }

        IntPtr pseudoInputRead = IntPtr.Zero;
        IntPtr hostInputWrite = IntPtr.Zero;
        IntPtr hostOutputRead = IntPtr.Zero;
        IntPtr pseudoOutputWrite = IntPtr.Zero;
        IntPtr pseudoConsole = IntPtr.Zero;
        IntPtr attributeList = IntPtr.Zero;
        ProcessInformation process = new ProcessInformation();
        Task outputTask = null;
        Task closeTask = null;
        object outputLock = new object();
        List<byte> output = new List<byte>();
        bool attributeListInitialized = false;
        uint processId = 0;
        uint exitCode = StillActive;
        bool processGone = false;
        bool outputPipeClosed = false;
        bool nativeHandlesClosed = false;
        bool promptInputWritten = false;
        bool quiescingInputWritten = false;

        try
        {
            CheckBoolean(CreatePipe(out pseudoInputRead, out hostInputWrite, IntPtr.Zero, 0), "CreatePipe(input)");
            CheckBoolean(CreatePipe(out hostOutputRead, out pseudoOutputWrite, IntPtr.Zero, 0), "CreatePipe(output)");
            CheckHResult(CreatePseudoConsole(new Coord(80, 24), pseudoInputRead, pseudoOutputWrite, 0, out pseudoConsole), "CreatePseudoConsole");

            StartupInfoEx startup = new StartupInfoEx();
            startup.StartupInfo.cb = Marshal.SizeOf(typeof(StartupInfoEx));
            startup.StartupInfo.dwFlags = StartfUseStdHandles;
            IntPtr attributeListSize = IntPtr.Zero;
            InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attributeListSize);
            if (attributeListSize == IntPtr.Zero)
            {
                throw LastWin32Exception("InitializeProcThreadAttributeList(size)");
            }

            attributeList = Marshal.AllocHGlobal(attributeListSize);
            CheckBoolean(
                InitializeProcThreadAttributeList(attributeList, 1, 0, ref attributeListSize),
                "InitializeProcThreadAttributeList");
            attributeListInitialized = true;
            CheckBoolean(
                UpdateProcThreadAttribute(
                    attributeList,
                    0,
                    PseudoConsoleAttribute,
                    pseudoConsole,
                    new IntPtr(IntPtr.Size),
                    IntPtr.Zero,
                    IntPtr.Zero),
                "UpdateProcThreadAttribute(PSEUDOCONSOLE)");
            startup.lpAttributeList = attributeList;

            StringBuilder commandLine = new StringBuilder(
                QuoteCommandLineArgument(nodePath)
                + " --experimental-transform-types "
                + QuoteCommandLineArgument(probePath)
                + " "
                + QuoteCommandLineArgument(scenario)
                + " "
                + QuoteCommandLineArgument(ProductPrompt));
            CheckBoolean(
                CreateProcessW(
                    null,
                    commandLine,
                    IntPtr.Zero,
                    IntPtr.Zero,
                    false,
                    ExtendedStartupInfoPresent | CreateUnicodeEnvironment,
                    IntPtr.Zero,
                    workingDirectory,
                    ref startup,
                    out process),
                "CreateProcessW(node probe)");
            processId = process.dwProcessId;

            CloseHandleChecked(ref pseudoInputRead);
            CloseHandleChecked(ref pseudoOutputWrite);
            outputTask = Task.Run(delegate { DrainOutput(hostOutputRead, output, outputLock); });

            WaitForMarker(output, outputLock, "[DSH-CONPTY] READY 80x24", timeoutMilliseconds, "initial terminal dimensions");
            CheckHResult(ResizePseudoConsole(pseudoConsole, new Coord(100, 30)), "ResizePseudoConsole");
            WaitForMarker(output, outputLock, "[DSH-CONPTY] RESIZE 100x30", timeoutMilliseconds, "resized terminal dimensions");

            byte[] ctrlC = new byte[] { 0x03 };
            if (scenario == "controller-flow")
            {
                WriteAll(hostInputWrite, Encoding.UTF8.GetBytes(ProductPrompt + "\r"), "UTF-8 prompt + CR");
                promptInputWritten = true;
                WaitForMarker(
                    output,
                    outputLock,
                    "[DSH-CONPTY] FLOW_READY_TO_EXIT",
                    timeoutMilliseconds,
                    "durable product frame and final idle state");
                WriteAll(hostInputWrite, ctrlC, "graceful Ctrl+C");
            }
            else if (scenario == "controller-force")
            {
                WriteAll(hostInputWrite, ctrlC, "first Ctrl+C");
                WaitForMarker(
                    output,
                    outputLock,
                    "[DSH-CONPTY] WHEN_IDLE_BLOCKED",
                    timeoutMilliseconds,
                    "blocked graceful whenIdle phase");
                WriteAll(
                    hostInputWrite,
                    Encoding.UTF8.GetBytes("ignored-during-quiesce\r"),
                    "ordinary quiescing input");
                quiescingInputWritten = true;
                Thread.Sleep(50);
                WriteAll(hostInputWrite, ctrlC, "second Ctrl+C");
            }
            else
            {
                WriteAll(hostInputWrite, ctrlC, "Ctrl+C");
            }

            WaitForMarker(output, outputLock, "[DSH-CONPTY] RESTORED", timeoutMilliseconds, "terminal restoration marker");
            uint wait = WaitForSingleObject(process.hProcess, (uint)timeoutMilliseconds);
            if (wait == WaitTimeout)
            {
                throw new TimeoutException("ConPTY child did not exit after Ctrl+C.");
            }
            if (wait != WaitObject0)
            {
                throw LastWin32Exception("WaitForSingleObject(child)");
            }
            CheckBoolean(GetExitCodeProcess(process.hProcess, out exitCode), "GetExitCodeProcess");
            processGone = exitCode != StillActive;
        }
        finally
        {
            if (process.hProcess != IntPtr.Zero && IsProcessActive(process.hProcess))
            {
                TerminateProcess(process.hProcess, 97);
                WaitForSingleObject(process.hProcess, 2000);
            }

            bool allHandlesClosed = true;
            allHandlesClosed &= CloseHandleQuietly(ref hostInputWrite);
            allHandlesClosed &= CloseHandleQuietly(ref pseudoInputRead);
            allHandlesClosed &= CloseHandleQuietly(ref pseudoOutputWrite);

            bool pseudoConsoleClosed = pseudoConsole == IntPtr.Zero;
            if (pseudoConsole != IntPtr.Zero)
            {
                IntPtr consoleToClose = pseudoConsole;
                pseudoConsole = IntPtr.Zero;
                closeTask = Task.Run(delegate { ClosePseudoConsole(consoleToClose); });
            }

            if (closeTask != null)
            {
                pseudoConsoleClosed = closeTask.Wait(5000);
                if (!pseudoConsoleClosed)
                {
                    allHandlesClosed &= CloseHandleQuietly(ref hostOutputRead);
                    pseudoConsoleClosed = closeTask.Wait(2000);
                }
            }
            if (outputTask == null)
            {
                outputPipeClosed = true;
            }
            else
            {
                outputPipeClosed = outputTask.Wait(5000);
                if (!outputPipeClosed)
                {
                    allHandlesClosed &= CloseHandleQuietly(ref hostOutputRead);
                    outputPipeClosed = outputTask.Wait(2000);
                }
            }

            allHandlesClosed &= CloseHandleQuietly(ref hostOutputRead);
            allHandlesClosed &= CloseHandleQuietly(ref process.hThread);
            allHandlesClosed &= CloseHandleQuietly(ref process.hProcess);

            if (attributeListInitialized)
            {
                DeleteProcThreadAttributeList(attributeList);
                attributeListInitialized = false;
            }
            if (attributeList != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(attributeList);
                attributeList = IntPtr.Zero;
            }
            nativeHandlesClosed = allHandlesClosed
                && pseudoConsoleClosed
                && pseudoConsole == IntPtr.Zero
                && attributeList == IntPtr.Zero
                && !attributeListInitialized;
        }

        byte[] captured;
        lock (outputLock)
        {
            captured = output.ToArray();
        }
        return new DshConPtySmokeResult
        {
            Output = captured,
            ProcessId = processId,
            ExitCode = exitCode,
            ProcessGone = processGone,
            OutputPipeClosed = outputPipeClosed,
            NativeHandlesClosed = nativeHandlesClosed,
            PromptInputWritten = promptInputWritten,
            QuiescingInputWritten = quiescingInputWritten
        };
    }

    private static void DrainOutput(IntPtr outputHandle, List<byte> output, object outputLock)
    {
        byte[] buffer = new byte[4096];
        while (true)
        {
            uint bytesRead;
            bool succeeded = ReadFile(outputHandle, buffer, (uint)buffer.Length, out bytesRead, IntPtr.Zero);
            if (bytesRead > 0)
            {
                lock (outputLock)
                {
                    for (int index = 0; index < bytesRead; index++)
                    {
                        output.Add(buffer[index]);
                    }
                }
            }
            if (!succeeded || bytesRead == 0)
            {
                return;
            }
        }
    }

    private static void WaitForMarker(
        List<byte> output,
        object outputLock,
        string marker,
        int timeoutMilliseconds,
        string description)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMilliseconds);
        while (DateTime.UtcNow < deadline)
        {
            string text;
            lock (outputLock)
            {
                text = Encoding.UTF8.GetString(output.ToArray());
            }
            if (text.IndexOf(marker, StringComparison.Ordinal) >= 0)
            {
                return;
            }
            Thread.Sleep(10);
        }

        string captured;
        lock (outputLock)
        {
            captured = Encoding.UTF8.GetString(output.ToArray());
        }
        throw new TimeoutException(
            "Timed out waiting for " + description + ". Captured output: " + EscapeForMessage(captured));
    }

    private static void WriteAll(IntPtr handle, byte[] bytes, string description)
    {
        uint bytesWritten;
        CheckBoolean(
            WriteFile(handle, bytes, (uint)bytes.Length, out bytesWritten, IntPtr.Zero),
            "WriteFile(" + description + ")");
        if (bytesWritten != bytes.Length)
        {
            throw new InvalidOperationException(
                "WriteFile(" + description + ") performed a partial write.");
        }
    }

    private static string QuoteCommandLineArgument(string value)
    {
        return "\"" + value.Replace("\"", "\\\"") + "\"";
    }

    private static string EscapeForMessage(string value)
    {
        return value.Replace("\u001b", "<ESC>").Replace("\r", "<CR>").Replace("\n", "<LF>");
    }

    private static bool IsProcessActive(IntPtr processHandle)
    {
        uint code;
        return GetExitCodeProcess(processHandle, out code) && code == StillActive;
    }

    private static void CheckHResult(int hresult, string operation)
    {
        if (hresult < 0)
        {
            Marshal.ThrowExceptionForHR(hresult);
        }
    }

    private static void CheckBoolean(bool succeeded, string operation)
    {
        if (!succeeded)
        {
            throw LastWin32Exception(operation);
        }
    }

    private static Exception LastWin32Exception(string operation)
    {
        return new Win32Exception(Marshal.GetLastWin32Error(), operation + " failed");
    }

    private static void CloseHandleChecked(ref IntPtr handle)
    {
        if (handle == IntPtr.Zero)
        {
            return;
        }
        IntPtr value = handle;
        handle = IntPtr.Zero;
        CheckBoolean(CloseHandle(value), "CloseHandle");
    }

    private static bool CloseHandleQuietly(ref IntPtr handle)
    {
        if (handle == IntPtr.Zero)
        {
            return true;
        }
        IntPtr value = handle;
        handle = IntPtr.Zero;
        return CloseHandle(value);
    }
}
