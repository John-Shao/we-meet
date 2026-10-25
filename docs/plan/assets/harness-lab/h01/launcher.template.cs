using System;
using System.Diagnostics;
using System.IO;
using System.Security.Cryptography;
using System.Text;

public static class Launcher
{
    private const string NodeHash = "__NODE_HASH__";
    private const string SidecarHash = "__SIDECAR_HASH__";

    private static string Hash(string path)
    {
        using (SHA256 sha = SHA256.Create())
        using (FileStream stream = File.OpenRead(path))
        {
            byte[] hash = sha.ComputeHash(stream);
            StringBuilder builder = new StringBuilder(hash.Length * 2);
            foreach (byte value in hash)
            {
                builder.Append(value.ToString("x2"));
            }
            return builder.ToString();
        }
    }

    public static int Main(string[] args)
    {
        string root = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string node = Path.Combine(root, "node.exe");
        string sidecar = Path.Combine(root, "app", "sidecar.mjs");
        string dataDir = Environment.GetEnvironmentVariable("H01_DATA_DIR");
        if (string.IsNullOrEmpty(dataDir))
        {
            dataDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "WeMeetH01TestData");
        }
        try { Directory.CreateDirectory(dataDir); }
        catch (Exception error)
        {
            Console.Error.WriteLine("cannot create data directory: " + error.Message);
            return 3;
        }

        if (!File.Exists(node) || !File.Exists(sidecar))
        {
            Console.Error.WriteLine("missing bundled node.exe or sidecar");
            return 3;
        }
        if (string.IsNullOrEmpty(dataDir))
        {
            Console.Error.WriteLine("H01_DATA_DIR is required");
            return 3;
        }
        if (!string.Equals(Hash(node), NodeHash, StringComparison.OrdinalIgnoreCase))
        {
            Console.Error.WriteLine("node.exe hash mismatch; refusing to start");
            return 3;
        }
        if (!string.Equals(Hash(sidecar), SidecarHash, StringComparison.OrdinalIgnoreCase))
        {
            Console.Error.WriteLine("sidecar hash mismatch; refusing to start");
            return 3;
        }

        string arguments = "--permission"
            + " --allow-fs-read=\"" + root + "\""
            + " --allow-fs-read=\"" + dataDir + "\""
            + " --allow-fs-write=\"" + dataDir + "\""
            + " \"" + sidecar + "\"";

        ProcessStartInfo info = new ProcessStartInfo();
        info.FileName = node;
        info.Arguments = arguments;
        Console.Error.WriteLine("launcher args: " + arguments);
        info.WorkingDirectory = Path.Combine(root, "app");
        info.UseShellExecute = false;
        info.RedirectStandardOutput = true;
        info.RedirectStandardError = true;
        info.CreateNoWindow = true;

        StringBuilder stdout = new StringBuilder();
        StringBuilder stderr = new StringBuilder();
        using (Process process = new Process())
        {
            process.StartInfo = info;
            process.OutputDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) stdout.AppendLine(e.Data);
            };
            process.ErrorDataReceived += delegate(object sender, DataReceivedEventArgs e)
            {
                if (e.Data != null) stderr.AppendLine(e.Data);
            };
            process.Start();
            Console.Error.WriteLine("launcher: bundled sidecar started");
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            if (!process.WaitForExit(90000))
            {
                try { process.Kill(); } catch { }
                Console.Error.WriteLine("sidecar timed out");
                return 4;
            }
            process.WaitForExit();
            Console.Out.Write(stdout.ToString());
            Console.Error.Write(stderr.ToString());
            Console.Error.WriteLine("launcher: sidecar exit " + process.ExitCode);
            return process.ExitCode;
        }
    }
}
