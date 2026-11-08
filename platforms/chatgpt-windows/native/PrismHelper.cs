using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

// Short login entry and single-instance supervisor. It never launches or kills ChatGPT.
internal static class PrismHelper {
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer();
    static Dictionary<string,object> Read(string path) {
        using(var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))
        using(var reader=new StreamReader(stream)) return Json.Deserialize<Dictionary<string,object>>(reader.ReadToEnd());
    }
    static void Save(string path, object value) {
        string temporary=path+"."+Guid.NewGuid().ToString("N")+".tmp";
        File.WriteAllText(temporary,Json.Serialize(value),new UTF8Encoding(false));
        try {
            for(int attempt=0;;attempt++) {
                try { if(File.Exists(path)) File.Replace(temporary,path,null); else File.Move(temporary,path); break; }
                catch(IOException) { if(attempt>=7) throw;Thread.Sleep(20<<Math.Min(attempt,3)); }
                catch(UnauthorizedAccessException) { if(attempt>=7) throw;Thread.Sleep(20<<Math.Min(attempt,3)); }
            }
        } finally { if(File.Exists(temporary)) File.Delete(temporary); }
    }
    static bool Alive(Process process) { try { return process!=null&&!process.HasExited; } catch { return false; } }
    static Process ExistingWorker(string state) {
        try {
            var status=Read(Path.Combine(state,"worker.json"));
            var process=Process.GetProcessById(Convert.ToInt32(status["pid"]));
            if(process.StartTime.ToUniversalTime().ToString("o")!=(string)status["created"]||DateTime.UtcNow-File.GetLastWriteTimeUtc(Path.Combine(state,"worker.json"))>TimeSpan.FromSeconds(15)) return null;
            if((string)status["state"]!="armed"&&(string)status["state"]!="starting") return null;
            return process;
        } catch { return null; }
    }
    static int Main() {
        string root=Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
        string state=Path.Combine(root,"state"),statusPath=Path.Combine(state,"supervisor.json");
        Process worker=null; Mutex mutex=null; bool locked=false; string outcome="stopped",message="Integration stopped";
        int restarts=0; var starts=new Queue<DateTime>(); DateTime began=DateTime.UtcNow,nextStart=began;
        var self=Process.GetCurrentProcess(); string created=self.StartTime.ToUniversalTime().ToString("o");
        try {
            var install=Read(Path.Combine(root,"installation.json"));
            string id=(string)install["id"];
            if((string)install["product"]!="prism-chatgpt"||(string)install["root"]!=root||(string)install["sid"]!=WindowsIdentity.GetCurrent().User.Value||!(bool)install["enabled"]||(File.GetAttributes(root)&FileAttributes.ReparsePoint)!=0) return 1;
            mutex=new Mutex(false,"Local\\PrismChatGPTSupervisor-"+id);
            try { locked=mutex.WaitOne(0); } catch(AbandonedMutexException) { locked=true; }
            if(!locked) return 0;
            bool fixture=install.ContainsKey("fixture")&&(bool)install["fixture"];
            int maxSeconds=fixture?Convert.ToInt32(install["maxSeconds"]):0;
            if(fixture&&(maxSeconds<1||maxSeconds>300)) throw new Exception("Fixture supervisor needs a bounded lifetime");
            worker=ExistingWorker(state);
            while(true) {
                if(File.Exists(Path.Combine(state,"stop"))) break;
                if(maxSeconds>0&&(DateTime.UtcNow-began).TotalSeconds>=maxSeconds) { File.WriteAllText(Path.Combine(state,"stop"),id); break; }
                if(!Alive(worker)&&DateTime.UtcNow>=nextStart) {
                    if(worker!=null) {
                        try { var previous=Read(Path.Combine(state,"worker.json")); if((string)previous["state"]=="unsupported") { outcome="paused";message=(string)previous["message"];break; } } catch { }
                        restarts++;
                    }
                    while(starts.Count>0&&DateTime.UtcNow-starts.Peek()>TimeSpan.FromMinutes(1)) starts.Dequeue();
                    if(starts.Count>=5) { outcome="error";message="Worker exited repeatedly; repair requires checking the recorded error";break; }
                    starts.Enqueue(DateTime.UtcNow);
                    string script=Path.Combine(root,"app","scripts","native","worker.ps1");
                    string arguments="-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \""+script+"\" -InstallRoot \""+root+"\"";
                    if(fixture) {
                        string profile=(string)install["testProfile"],backend=(string)install["testBackend"];
                        if(!profile.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase)||!backend.StartsWith(root+"\\",StringComparison.OrdinalIgnoreCase)) throw new Exception("Fixture profile escaped its root");
                        arguments+=" -TestProfile \""+profile+"\" -TestBackend \""+backend+"\" -MaxSeconds "+maxSeconds;
                        if((bool)install["testNoHook"]) arguments+=" -NoHook";
                    }
                    worker=Process.Start(new ProcessStartInfo {
                        FileName=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System),"WindowsPowerShell","v1.0","powershell.exe"),
                        Arguments=arguments,UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden
                    });
                    nextStart=DateTime.UtcNow.AddSeconds(Math.Min(15,Math.Pow(2,Math.Min(restarts,4))));
                }
                Save(statusPath,new { state="running",pid=self.Id,created=created,at=DateTime.UtcNow.ToString("o"),workerPid=Alive(worker)?(int?)worker.Id:null,restarts=restarts,message="Monitoring the background worker" });
                Thread.Sleep(1000);
            }
        } catch(Exception error) { outcome="error";message=error.Message; }
        finally {
            if(locked) {
                // Intentional stop requests are shared with the worker. Unexpected supervisor
                // failure leaves a healthy worker running for a later supervisor to adopt.
                if(File.Exists(Path.Combine(state,"stop"))&&Alive(worker)) worker.WaitForExit(15000);
                try { Save(statusPath,new {state=outcome,pid=self.Id,created=created,at=DateTime.UtcNow.ToString("o"),restarts=restarts,message=message}); } catch { }
                mutex.ReleaseMutex();
            }
            if(mutex!=null) mutex.Dispose();
        }
        return outcome=="error"?1:0;
    }
}
