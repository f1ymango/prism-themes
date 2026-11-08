using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Web.Script.Serialization;
using System.Threading;

// Called by Windows only for new package activations. Changes initial argument data,
// then resumes the validated initial thread. Existing processes and package files stay intact.
internal static class ActivationCallback {
    [StructLayout(LayoutKind.Sequential)] struct Basic { public IntPtr exit, peb, affinity, priority, pid, parent; }
    [StructLayout(LayoutKind.Sequential)] struct Unicode { public ushort length, capacity; public IntPtr buffer; }
    [StructLayout(LayoutKind.Sequential)] struct Parameters {
        [MarshalAs(UnmanagedType.ByValArray, SizeConst=16)] public byte[] reserved;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst=10)] public IntPtr[] pointers;
        public Unicode image, command;
    }
    [DllImport("kernel32", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32", SetLastError=true)] static extern IntPtr OpenThread(uint access, bool inherit, uint tid);
    [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32")] static extern uint GetProcessIdOfThread(IntPtr thread);
    [DllImport("kernel32", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long created, out long exit, out long kernel, out long user);
    [DllImport("kernel32", SetLastError=true)] static extern bool GetThreadTimes(IntPtr thread, out long created, out long exit, out long kernel, out long user);
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder value, ref uint size);
    [DllImport("kernel32", CharSet=CharSet.Unicode)] static extern int GetPackageFullName(IntPtr process, ref uint length, StringBuilder name);
    [DllImport("kernel32", CharSet=CharSet.Unicode)] static extern int GetPackagePathByFullName(string package, ref uint length, StringBuilder path);
    [DllImport("kernel32", SetLastError=true)] static extern bool IsWow64Process(IntPtr process, out bool wow);
    [DllImport("advapi32", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("ntdll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, out Basic value, uint size, out uint returned);
    [DllImport("kernel32", SetLastError=true)] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] bytes, UIntPtr size, out UIntPtr read);
    [DllImport("kernel32", SetLastError=true)] static extern bool WriteProcessMemory(IntPtr process, IntPtr address, byte[] bytes, UIntPtr size, out UIntPtr written);
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)] static extern uint GetFinalPathNameByHandle(IntPtr file, StringBuilder path, uint capacity, uint flags);
    [DllImport("kernel32", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("shell32", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CommandLineToArgvW(string command, out int count);
    [DllImport("kernel32")] static extern IntPtr LocalFree(IntPtr memory);

    static byte[] Read(IntPtr process, IntPtr address, int size) {
        var bytes=new byte[size]; UIntPtr count;
        if(!ReadProcessMemory(process,address,bytes,(UIntPtr)size,out count)||count.ToUInt64()!=(ulong)size) throw new Win32Exception(Marshal.GetLastWin32Error());
        return bytes;
    }
    static void Write(IntPtr process, IntPtr address, byte[] bytes) {
        UIntPtr count;
        if(!WriteProcessMemory(process,address,bytes,(UIntPtr)bytes.Length,out count)||count.ToUInt64()!=(ulong)bytes.Length) throw new Win32Exception(Marshal.GetLastWin32Error());
    }
    static T Decode<T>(byte[] bytes) {
        var pin=GCHandle.Alloc(bytes,GCHandleType.Pinned);
        try { return (T)Marshal.PtrToStructure(pin.AddrOfPinnedObject(),typeof(T)); } finally { pin.Free(); }
    }
    static byte[] Encode<T>(T value) {
        int size=Marshal.SizeOf(typeof(T)); var bytes=new byte[size]; var pointer=Marshal.AllocHGlobal(size);
        try { for(int i=0;i<size;i++) Marshal.WriteByte(pointer,i,0); Marshal.StructureToPtr(value,pointer,false); Marshal.Copy(pointer,bytes,0,size); return bytes; } finally { Marshal.FreeHGlobal(pointer); }
    }
    static string Text(IntPtr process, Unicode value) {
        if(value.buffer==IntPtr.Zero||value.length==0||value.length%2!=0||value.length>value.capacity) throw new Exception("Invalid process string layout");
        return Encoding.Unicode.GetString(Read(process,value.buffer,value.length));
    }
    static string[] Arguments(string command) {
        int count; var pointer=CommandLineToArgvW(command,out count);
        if(pointer==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try { var values=new string[count]; for(int i=0;i<count;i++) values[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer,i*IntPtr.Size)); return values; } finally { LocalFree(pointer); }
    }
    static string Value(string[] args,string key) { int i=Array.IndexOf(args,key); if(i<0||i+1>=args.Length) throw new Exception("Missing callback argument "+key); return args[i+1]; }
    static Dictionary<string,object> ReadJson(string path) {
        using(var stream=new FileStream(path,FileMode.Open,FileAccess.Read,FileShare.ReadWrite|FileShare.Delete))
        using(var reader=new StreamReader(stream)) return new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(reader.ReadToEnd());
    }
    static bool HelperReady(string state,string package) {
        try {
            var worker=ReadJson(Path.Combine(state,"worker.json"));
            if((string)worker["state"]!="armed"||(string)worker["package"]!=package||DateTime.UtcNow-DateTime.Parse((string)worker["at"]).ToUniversalTime()>TimeSpan.FromSeconds(10)) return false;
            using(var process=Process.GetProcessById(Convert.ToInt32(worker["pid"]))) return process.StartTime.ToUniversalTime().ToString("o")== (string)worker["created"];
        } catch { return false; }
    }
    // A first activation can beat the delayed Windows login startup entry. Wake the
    // owned supervisor and wait for its build-checked worker before resuming it.
    internal static Dictionary<string,object> EnsureReady(string configPath,string package,int timeoutMs) {
        string state=Path.GetDirectoryName(Path.GetFullPath(configPath)),root=Path.GetDirectoryName(state);
        if(!String.Equals(configPath,Path.Combine(root,"state","callback.json"),StringComparison.OrdinalIgnoreCase)) throw new Exception("Unexpected callback configuration path");
        var install=ReadJson(Path.Combine(root,"installation.json"));
        if((string)install["product"]!="prism-chatgpt"||!(bool)install["enabled"]||(string)install["package"]!=package||!String.Equals((string)install["root"],root,StringComparison.OrdinalIgnoreCase)||(string)install["sid"]!=WindowsIdentity.GetCurrent().User.Value||(File.GetAttributes(root)&FileAttributes.ReparsePoint)!=0||File.Exists(Path.Combine(state,"stop"))) throw new Exception("Inactive installation; native activation preserved");
        if(!HelperReady(state,package)) {
            Process.Start(new ProcessStartInfo { FileName=Path.Combine(root,"PrismHelper.exe"),UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden });
            var deadline=DateTime.UtcNow.AddMilliseconds(timeoutMs);
            while(!HelperReady(state,package)) {
                if(File.Exists(Path.Combine(state,"stop"))||DateTime.UtcNow>=deadline) throw new Exception("Helper readiness timed out; native activation preserved");
                Thread.Sleep(100);
            }
        }
        return ReadJson(configPath);
    }
    static string Package(IntPtr process) {
        uint size=0; if(GetPackageFullName(process,ref size,null)!=122||size>1024) throw new Exception("Missing package identity");
        var name=new StringBuilder((int)size); int error=GetPackageFullName(process,ref size,name); if(error!=0) throw new Win32Exception(error); return name.ToString();
    }
    static string PackagePath(string package) {
        uint size=0; if(GetPackagePathByFullName(package,ref size,null)!=122||size>32768) throw new Exception("Missing package path");
        var path=new StringBuilder((int)size); int error=GetPackagePathByFullName(package,ref size,path); if(error!=0) throw new Win32Exception(error); return path.ToString();
    }
    static string FinalPath(string path) {
        var file=CreateFile(path,0,7,IntPtr.Zero,3,0,IntPtr.Zero);
        if(file==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try { var result=new StringBuilder(32768); uint length=GetFinalPathNameByHandle(file,result,(uint)result.Capacity,0); if(length==0||length>=result.Capacity) throw new Exception("Cannot resolve image alias"); return result.ToString(); } finally { CloseHandle(file); }
    }
    static void AppendDebugArguments(IntPtr process,string expectedImage,string expectedProfile,string imageAlias) {
        bool wow; if(IntPtr.Size!=8||!IsWow64Process(process,out wow)||wow) throw new Exception("Only native x64 is supported");
        Basic basic; uint returned;
        if(NtQueryInformationProcess(process,0,out basic,(uint)Marshal.SizeOf(typeof(Basic)),out returned)!=0) throw new Exception("Cannot read process parameters");
        // PEB.ProcessParameters is at offset 0x20 in the documented x64 layout.
        var parametersAddress=new IntPtr(BitConverter.ToInt64(Read(process,IntPtr.Add(basic.peb,0x20),8),0));
        var parameters=Decode<Parameters>(Read(process,parametersAddress,Marshal.SizeOf(typeof(Parameters))));
        string image=Text(process,parameters.image); if(image.StartsWith(@"\??\")) image=image.Substring(4);
        if(!String.Equals(image,expectedImage,StringComparison.OrdinalIgnoreCase)) throw new Exception("Parameter image does not match");
        string command=Text(process,parameters.command); var args=Arguments(command);
        if(Array.Exists(args,x=>x.StartsWith("--type=",StringComparison.OrdinalIgnoreCase))) throw new Exception("Child process preserved");
        if(!String.IsNullOrEmpty(expectedProfile)) {
            if(!Array.Exists(args,x=>String.Equals(x,"--user-data-dir="+expectedProfile,StringComparison.OrdinalIgnoreCase))) throw new Exception("Unmarked test activation preserved");
        } else if(Array.Exists(args,x=>x.StartsWith("--user-data-dir",StringComparison.OrdinalIgnoreCase))) throw new Exception("Custom profile preserved");
        if(Array.Exists(args,x=>x.StartsWith("--remote-debugging",StringComparison.OrdinalIgnoreCase))) throw new Exception("Existing debugging arguments preserved");
        if(!Path.IsPathRooted(imageAlias)||!String.Equals(FinalPath(imageAlias),FinalPath(expectedImage),StringComparison.OrdinalIgnoreCase)) throw new Exception("Alias does not resolve to the installed image");
        if(!command.StartsWith("\"")) throw new Exception("Executable token is not quoted");
        int end=command.IndexOf('"',1); if(end<1||!String.Equals(FinalPath(command.Substring(1,end-1)),FinalPath(expectedImage),StringComparison.OrdinalIgnoreCase)) throw new Exception("Executable token mismatch");
        string replacement="\""+imageAlias+"\""+command.Substring(end+1)+" --remote-debugging-port=0";
        byte[] text=Encoding.Unicode.GetBytes(replacement+"\0");
        if(text.Length>parameters.command.capacity) throw new Exception("Replacement does not fit the existing startup buffer");
        var descriptor=IntPtr.Add(parametersAddress,(int)Marshal.OffsetOf(typeof(Parameters),"command"));
        byte[] original=Read(process,descriptor,Marshal.SizeOf(typeof(Unicode)));
        byte[] originalText=Read(process,parameters.command.buffer,parameters.command.capacity);
        try {
            Write(process,parameters.command.buffer,text);
            var updated=parameters.command; updated.length=(ushort)(text.Length-2);
            Write(process,descriptor,Encode(updated));
            if(Text(process,Decode<Unicode>(Read(process,descriptor,Marshal.SizeOf(typeof(Unicode)))))!=replacement) throw new Exception("Argument readback failed");
        } catch {
            Write(process,parameters.command.buffer,originalText); Write(process,descriptor,original); throw;
        }
    }
    static int Main(string[] args) {
        IntPtr process=IntPtr.Zero,thread=IntPtr.Zero; bool resume=false; string log=null;
        var result=new Dictionary<string,object> { {"patched",false},{"resumed",false},{"error",null} };
        var json=new JavaScriptSerializer();
        try {
            uint pid=UInt32.Parse(Value(args,"-p")),tid=UInt32.Parse(Value(args,"-tid")); result["pid"]=pid;
            process=OpenProcess(0x1438,false,pid); if(process==IntPtr.Zero) process=OpenProcess(0x1000,false,pid);
            if(process==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            long created,exit,kernel,user; if(!GetProcessTimes(process,out created,out exit,out kernel,out user)) throw new Win32Exception(Marshal.GetLastWin32Error());
            long now=DateTime.UtcNow.ToFileTimeUtc(); result["created"]=created.ToString();
            string package=Package(process); if(!Regex.IsMatch(package,@"^OpenAI\.Codex_[0-9.]+_x64__2p2nqsd0c76g0$")) throw new Exception("Unsupported package");
            var image=new StringBuilder(32768); uint size=(uint)image.Capacity;
            if(!QueryFullProcessImageName(process,0,image,ref size)) throw new Win32Exception(Marshal.GetLastWin32Error());
            if(!image.ToString().StartsWith(PackagePath(package)+"\\",StringComparison.OrdinalIgnoreCase)) throw new Exception("Image outside package");
            IntPtr token; if(!OpenProcessToken(process,8,out token)) throw new Win32Exception(Marshal.GetLastWin32Error());
            try { using(var identity=new WindowsIdentity(token)) if(identity.User.Value!=WindowsIdentity.GetCurrent().User.Value) throw new Exception("Different user"); } finally { CloseHandle(token); }
            thread=OpenThread(0x802,false,tid); if(thread==IntPtr.Zero||GetProcessIdOfThread(thread)!=pid) throw new Exception("Callback thread mismatch");
            long threadCreated; if(!GetThreadTimes(thread,out threadCreated,out exit,out kernel,out user)||threadCreated<created||threadCreated-created>TimeSpan.FromSeconds(2).Ticks) throw new Exception("Not an initial thread");
            resume=true;
            string configPath=Path.GetFullPath(Value(args,"--config"));
            var config=ReadJson(configPath); log=(string)config["log"];
            if(!String.Equals(image.ToString(),(string)config["image"],StringComparison.OrdinalIgnoreCase)) throw new Exception("Auxiliary process preserved");
            var readiness=Stopwatch.StartNew();
            config=EnsureReady(configPath,package,12000);
            result["helperWaitMs"]=readiness.ElapsedMilliseconds;
            now=DateTime.UtcNow.ToFileTimeUtc();
            long expires=Convert.ToInt64(config["expires"]);
            if(created>now||now-created>TimeSpan.FromSeconds(30).Ticks||package!=(string)config["package"]||created<Convert.ToInt64(config["notBefore"])||(expires>0&&now>expires)) throw new Exception("Activation scope expired or mismatched");
            if(!String.Equals(image.ToString(),(string)config["image"],StringComparison.OrdinalIgnoreCase)) throw new Exception("Auxiliary process preserved");
            AppendDebugArguments(process,(string)config["image"],(string)config["profile"],(string)config["imageAlias"]); result["patched"]=true;
        } catch(Exception error) { result["error"]=error.Message; }
        finally {
            if(resume) { uint count=ResumeThread(thread); result["resumePreviousCount"]=count; result["resumed"]=count!=UInt32.MaxValue&&count<=1; }
            if(thread!=IntPtr.Zero) CloseHandle(thread); if(process!=IntPtr.Zero) CloseHandle(process);
            if(log!=null) try { if(File.Exists(log)&&new FileInfo(log).Length>1048576) File.WriteAllText(log,""); File.AppendAllText(log,json.Serialize(result)+Environment.NewLine); } catch { }
        }
        return (bool)result["resumed"]?0:1;
    }
}
