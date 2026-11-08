using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Security.Principal;
using System.Web.Script.Serialization;
internal static class StartupGateTests {
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer();
    static void Check(bool value,string message) { if(!value) throw new Exception(message); }
    static void Save(string path,object value) { File.WriteAllText(path,Json.Serialize(value)); }
    static void Main(string[] args) {
        string root=Path.GetFullPath(args[0]),state=Path.Combine(root,"state"),config=Path.Combine(state,"callback.json"),marker=Path.Combine(root,"installation.json");
        Directory.CreateDirectory(state);
        var install=new Dictionary<string,object>{{"product","prism-chatgpt"},{"enabled",true},{"package","fixture-package"},{"root",root},{"sid",WindowsIdentity.GetCurrent().User.Value}};
        Save(marker,install); Save(config,new {package="fixture-package"});
        // Fresh timestamps alone must not pass a stopped worker or reused PID.
        Save(Path.Combine(state,"worker.json"),new {state="stopped",package="fixture-package",pid=Process.GetCurrentProcess().Id,created="stale",at=DateTime.UtcNow.ToString("o")});
        try {
            var watch=Stopwatch.StartNew();
            Check((string)ActivationCallback.EnsureReady(config,"fixture-package",3000)["package"]=="fixture-package","Missing config");
            Check(watch.ElapsedMilliseconds>=700,"Did not wait for the checked worker");
            ActivationCallback.EnsureReady(config,"fixture-package",3000);
            Check(File.ReadAllLines(Path.Combine(root,"starts.txt")).Length==1,"Healthy worker started twice");
            install["enabled"]=false; Save(marker,install);
            bool rejected=false;try { ActivationCallback.EnsureReady(config,"fixture-package",300); } catch { rejected=true; }
            Check(rejected,"Disabled installation was started");
            install["enabled"]=true; Save(marker,install);
            File.WriteAllText(Path.Combine(state,"stop"),"stop");
            rejected=false;try { ActivationCallback.EnsureReady(config,"fixture-package",300); } catch { rejected=true; }
            Check(rejected,"Explicit removal was ignored");
            File.Delete(Path.Combine(state,"stop"));
            foreach(var child in Process.GetProcessesByName("PrismHelper")) {
                using(child) { try { if(child.MainModule.FileName==Path.Combine(root,"PrismHelper.exe")) {child.Kill();child.WaitForExit();} } catch { } }
            }
            File.WriteAllText(Path.Combine(root,"never-ready"),"");
            rejected=false;watch.Restart();try { ActivationCallback.EnsureReady(config,"fixture-package",350); } catch { rejected=true; }
            Check(rejected&&watch.ElapsedMilliseconds<2000,"Unready helper did not fail within the bound");
            Console.WriteLine("Delayed cold helper, healthy reuse, disabled/stop checks, and bounded timeout passed");
        } finally {
            foreach(var child in Process.GetProcessesByName("PrismHelper")) {
                using(child) { try { if(child.MainModule.FileName==Path.Combine(root,"PrismHelper.exe")) {child.Kill();child.WaitForExit();} } catch { } }
            }
        }
    }
}
