using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Web.Script.Serialization;
internal static class StartupGateWorker {
    static void Main() {
        string root=Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName),state=Path.Combine(root,"state");
        File.AppendAllText(Path.Combine(root,"starts.txt"),"started\n");
        Thread.Sleep(800);
        if(!File.Exists(Path.Combine(root,"never-ready"))) {
            var self=Process.GetCurrentProcess();
            File.WriteAllText(Path.Combine(state,"worker.json"),new JavaScriptSerializer().Serialize(new {state="armed",package="fixture-package",pid=self.Id,created=self.StartTime.ToUniversalTime().ToString("o"),at=DateTime.UtcNow.ToString("o")}));
        }
        Thread.Sleep(2500);
    }
}
