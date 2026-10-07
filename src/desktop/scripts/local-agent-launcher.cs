using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
[assembly: AssemblyVersion("0.3.1.0")]
[assembly: AssemblyFileVersion("0.3.1.0")]
// No Python registry/PATH lookup; inherited stdio belongs to Electron.
class LocalAgentLauncher {
  static void Pump(Stream source, Stream target) {
    var buffer = new byte[8192]; int count;
    while ((count = source.Read(buffer, 0, buffer.Length)) > 0) {
      target.Write(buffer, 0, count); target.Flush();
    }
  }
  static string Quote(string value) {
    return "\"" + System.Text.RegularExpressions.Regex.Replace(value, "(\\\\*)\"", "$1$1\\\"")
      .TrimEnd('\\') + new string('\\', 2 * (value.Length - value.TrimEnd('\\').Length)) + "\"";
  }
  static int Main(string[] args) {
    try {
      var root = AppDomain.CurrentDomain.BaseDirectory;
      var info = new ProcessStartInfo(Path.Combine(root, "python.exe"),
        "-I -B -m work_agent.local " + String.Join(" ", args.Select(Quote))) {
        UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = root,
        RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
      };
      using (var child = Process.Start(info)) {
        var input = System.Threading.Tasks.Task.Factory.StartNew(() => {
          try { Pump(Console.OpenStandardInput(), child.StandardInput.BaseStream); }
          finally { child.StandardInput.Close(); }
        });
        var output = System.Threading.Tasks.Task.Factory.StartNew(() => Pump(child.StandardOutput.BaseStream, Console.OpenStandardOutput()));
        var error = System.Threading.Tasks.Task.Factory.StartNew(() => Pump(child.StandardError.BaseStream, Console.OpenStandardError()));
        child.WaitForExit();
        System.Threading.Tasks.Task.WaitAll(output, error);
        return child.ExitCode;
      }
    } catch { return 1; }
  }
}
