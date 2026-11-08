using System;
using System.Runtime.InteropServices;

public sealed class PrismPackageSession : IDisposable {
    [ComImport, Guid("F27C3930-8029-4AD1-94E3-3DBA417810C1"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface Settings {
        [PreserveSig] int EnableDebugging([MarshalAs(UnmanagedType.LPWStr)] string package, [MarshalAs(UnmanagedType.LPWStr)] string debugger, IntPtr environment);
        [PreserveSig] int DisableDebugging([MarshalAs(UnmanagedType.LPWStr)] string package);
    }
    [ComImport, Guid("2E941141-7F97-4756-BA1D-9DECDE894A3D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface Activation {
        [PreserveSig] int ActivateApplication([MarshalAs(UnmanagedType.LPWStr)] string app, [MarshalAs(UnmanagedType.LPWStr)] string arguments, uint options, out uint pid);
    }
    Settings settings;
    string package;
    IntPtr environment;
    public PrismPackageSession(string name, string command, string environmentBlock) {
        package=name;
        settings=(Settings)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("B1AEC16F-2383-4852-B0E9-8F0B1DC66B4D")));
        environment=environmentBlock==null?IntPtr.Zero:Marshal.StringToHGlobalUni(environmentBlock);
        int result=settings.EnableDebugging(package,command,environment);
        if(result<0) { Release(); Marshal.ThrowExceptionForHR(result); }
    }
    public static void Disable(string package) {
        var settings=(Settings)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("B1AEC16F-2383-4852-B0E9-8F0B1DC66B4D")));
        try { Marshal.ThrowExceptionForHR(settings.DisableDebugging(package)); } finally { Marshal.FinalReleaseComObject(settings); }
    }
    public static uint Activate(string app, string arguments) {
        var activation=(Activation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("45BA127D-10A8-46EA-8AB7-56EA9078943C")));
        try { uint pid; Marshal.ThrowExceptionForHR(activation.ActivateApplication(app,arguments,2,out pid)); return pid; }
        finally { Marshal.FinalReleaseComObject(activation); }
    }
    public void Dispose() {
        if(settings==null) return;
        try { Marshal.ThrowExceptionForHR(settings.DisableDebugging(package)); } finally { Release(); }
    }
    public void ReleaseWithoutDisabling() { Release(); }
    void Release() {
        if(settings!=null) { Marshal.FinalReleaseComObject(settings); settings=null; }
        if(environment!=IntPtr.Zero) { Marshal.FreeHGlobal(environment); environment=IntPtr.Zero; }
    }
}
