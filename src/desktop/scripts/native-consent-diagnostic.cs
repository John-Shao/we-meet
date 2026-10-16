// Standalone diagnostic parent for the exact delivery.8 helper. No network,
// Arm, Input, Lease, UI automation, or production session credentials.
// Compile with the Windows .NET Framework C# compiler and System.Web.Extensions.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class NativeConsentDiagnostic
{
    private const string HelperHash = "4eb311a19cc362426f2ec2f073ad297818cc282b4610eb3b58f5fed2c5cd6083";
    private static readonly object LogLock = new object(), PipeLock = new object();
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    private static readonly ManualResetEvent Hello = new ManualResetEvent(false), Displays = new ManualResetEvent(false),
        Done = new ManualResetEvent(false), OutputClosed = new ManualResetEvent(false);
    private static StreamWriter Log;
    private static Process Worker;
    private static Timer Pulse;
    private static Dictionary<string, object> Display;
    private static volatile bool Ready, Allowed, Failed;
    private static int GuardianCleanup = int.MinValue;

    private static void Write(string name, object value)
    {
        lock (LogLock)
        {
            string line = Json.Serialize(new { time = DateTime.UtcNow.ToString("o"), kind = name, data = value });
            Log.WriteLine(line); Log.Flush(); Console.WriteLine(line);
        }
    }

    private static void Receive(object sender, DataReceivedEventArgs args)
    {
        if (args.Data == null) { OutputClosed.Set(); return; }
        try
        {
            // Parse only helper JSON; never copy arbitrary process output to the report.
            if (args.Data.Length > 65536) throw new InvalidDataException();
            var row = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(args.Data);
            string kind = (string)row["event"];
            var safe = new Dictionary<string, object>();
            foreach (string key in new[] { "event", "reason", "ready", "cleanup", "pid", "guardianPid", "wasActive" })
                if (row.ContainsKey(key)) safe[key] = row[key];
            Write("native", safe);
            if (kind == "hello") { Ready = row.ContainsKey("ready") && (bool)row["ready"]; Hello.Set(); }
            if (kind == "displays")
            {
                var items = (ArrayList)row["displays"];
                foreach (Dictionary<string, object> item in items)
                    if (Convert.ToInt32(item["left"]) == 0 && Convert.ToInt32(item["top"]) == 0)
                    {
                        if (Display != null) throw new InvalidDataException("ambiguous_primary_display");
                        Display = item;
                    }
                if (Display == null) throw new InvalidDataException("primary_display_required");
                var bounds = new Dictionary<string, object>();
                foreach (string key in new[] { "left", "top", "width", "height", "rotation", "dpiX", "dpiY" }) bounds[key] = Display[key];
                Write("display", bounds); Displays.Set();
            }
            if (kind == "consentAllowed") { Allowed = true; Done.Set(); }
            if (kind == "guardianClosed") GuardianCleanup = Convert.ToInt32(row["cleanup"]);
            if (kind == "closed" || kind == "guardianClosed" || kind == "fatal" || kind == "failed") Done.Set();
            if (kind == "armed" || kind == "inputAck") { Failed = true; Done.Set(); }
        }
        catch { Failed = true; Write("error", "native_event_invalid"); Done.Set(); Hello.Set(); Displays.Set(); }
    }

    private static void Send(uint command, byte[] body)
    {
        // A fixed allowlist prevents this diagnostic from arming or injecting.
        if (command != 1 && command != 4 && command != 5 && command != 8) throw new InvalidOperationException();
        lock (PipeLock)
        {
            var writer = new BinaryWriter(Worker.StandardInput.BaseStream);
            writer.Write((uint)body.Length); writer.Write(command); writer.Write(body); writer.Flush();
        }
    }

    private static byte[] Proposal()
    {
        using (var stream = new MemoryStream())
        using (var writer = new BinaryWriter(stream))
        {
            // All identifiers are fresh, unrelated to the meeting. No private
            // key is needed: this tool cannot sign or send an input packet.
            for (int i = 0; i < 3; ++i) writer.Write(Guid.NewGuid().ToByteArray());
            writer.Write((uint)1);
            foreach (string key in new[] { "left", "top", "width", "height" }) writer.Write(Convert.ToInt32(Display[key]));
            writer.Write((uint)15000);
            // Public P-256 generator point, solely a syntactically valid key.
            string point = "6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296" +
                "4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5";
            for (int i = 0; i < point.Length; i += 2) writer.Write(Convert.ToByte(point.Substring(i, 2), 16));
            writer.Write((uint)60000); writer.Write(Guid.NewGuid().ToByteArray());
            byte[] label = new byte[320];
            Encoding.Unicode.GetBytes("We-Meet native consent test（不发送键鼠输入）").CopyTo(label, 0);
            writer.Write(label); writer.Flush();
            if (stream.Length != 476) throw new InvalidDataException();
            return stream.ToArray();
        }
    }

    private static int Run()
    {
        string helper = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "we-meet-remote-input.exe");
        using (var hash = SHA256.Create())
        using (var file = File.OpenRead(helper))
        {
            string actual = BitConverter.ToString(hash.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
            if (actual != HelperHash) throw new InvalidDataException("helper_hash_mismatch");
            Write("helperSha256", actual);
        }
        Worker = new Process();
        Worker.StartInfo = new ProcessStartInfo(helper, "--parent " + Process.GetCurrentProcess().Id) {
            UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8
        };
        Worker.OutputDataReceived += Receive;
        // Drain stderr without retaining unstructured content or paths.
        Worker.ErrorDataReceived += (s, e) => { };
        Worker.Start(); Worker.BeginOutputReadLine(); Worker.BeginErrorReadLine();
        Pulse = new Timer(s => { try { Send(4, new byte[0]); } catch { Done.Set(); } }, null, 0, 200);
        try
        {
            if (!Hello.WaitOne(5000) || !Ready || Failed) throw new InvalidOperationException("native_not_ready");
            Send(1, new byte[0]);
            if (!Displays.WaitOne(3000) || Display == null || Failed) throw new InvalidOperationException("display_unavailable_or_multiple");
            Console.WriteLine("请在原生窗口点击“允许本次控制”。本诊断不会发送任何键鼠输入。最多等待 60 秒。");
            Send(8, Proposal());
            if (!Done.WaitOne(65000)) Write("error", "diagnostic_timeout");
            if (Allowed) Thread.Sleep(2000); // Observe the Confirm -> Waiting transition.
        }
        finally
        {
            // Stop heartbeat only when EOF has been sent. Guardian survives
            // worker exit and reports cleanup through the inherited stdout.
            Pulse.Dispose();
            lock (PipeLock)
            {
                try { Send(5, new byte[0]); } catch { }
                try { Worker.StandardInput.Close(); } catch { }
            }
            if (!Worker.WaitForExit(5000)) { Write("error", "worker_shutdown_timeout"); Worker.Kill(); Worker.WaitForExit(3000); }
            if (!OutputClosed.WaitOne(5000)) { Failed = true; Write("error", "guardian_report_timeout"); }
            Write("result", new { allowed = Allowed, cleanup = GuardianCleanup, workerExitCode = Worker.ExitCode,
                failed = Failed, inputCommandsSent = 0 });
        }
        return Allowed && !Failed && GuardianCleanup == 1 ? 0 : 1;
    }

    private static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;
        string report = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "native-consent-" + DateTime.Now.ToString("yyyyMMdd-HHmmss-fff") + ".jsonl");
        int result = 1;
        using (Log = new StreamWriter(report, false, new UTF8Encoding(false)))
        {
            Write("diagnostic", new { version = 1, machineNameRecorded = false, network = false, inputCommandsAllowed = false });
            try { result = Run(); }
            catch (Exception error) { Write("error", error.GetType().Name); }
            Console.WriteLine("诊断已结束，日志：" + Path.GetFileName(report));
            Console.WriteLine("无需再次授权。请把此 JSONL 文件交回分析。");
        }
        if (args.Length == 0) { Console.WriteLine("按回车关闭此窗口。"); Console.ReadLine(); }
        return result;
    }
}
