using System;
using System.Linq;
using System.Threading.Tasks;
using UnityEditor;
using UnityEditor.Build.Reporting;
using UnityEngine;

namespace VRShop.EditorTools
{
    /// <summary>
    /// Command-line versions of the Setup Window steps, so the project can be configured and built headless
    /// (and reproducibly) from a terminal or CI. Run from the repo root:
    ///
    ///   Unity -batchmode -projectPath unity -buildTarget Android \
    ///         -executeMethod VRShop.EditorTools.BatchSetup.Setup -backendUrl http://192.168.1.23:8787
    ///   Unity -batchmode -projectPath unity -buildTarget Android \
    ///         -executeMethod VRShop.EditorTools.BatchSetup.BuildApk
    ///
    /// Don't pass -quit: these methods exit Unity themselves once async work (Meta's Fix All) has finished.
    /// </summary>
    public static class BatchSetup
    {
        public static void Setup() => RunAndExit(async () =>
        {
            if (EditorUserBuildSettings.activeBuildTarget != BuildTarget.Android)
                throw new InvalidOperationException("Pass -buildTarget Android on the command line.");
            await ConfigureWithTimeout();
            SceneBuilder.Build(Arg("-backendUrl") ?? "http://localhost:8787");
            AssetDatabase.SaveAssets();
        });

        public static void BuildApk() => RunAndExit(() =>
        {
            var report = VRShopSetupWindow.BuildApk(false);
            if (report == null || report.summary.result != BuildResult.Succeeded)
                throw new Exception($"Build {report?.summary.result}");
            return Task.CompletedTask;
        });

        static async Task ConfigureWithTimeout()
        {
            var work = ProjectConfigurator.ConfigureAllAsync();
            if (await Task.WhenAny(work, Task.Delay(TimeSpan.FromMinutes(3))) != work)
                Debug.LogWarning("[VRShop] Configure timed out waiting on Meta's Project Setup Tool; check it in the Editor.");
            else await work;
        }

        static string Arg(string name)
        {
            var args = Environment.GetCommandLineArgs();
            var i = Array.IndexOf(args, name);
            return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
        }

        static async void RunAndExit(Func<Task> work)
        {
            var code = 0;
            try { await work(); Debug.Log("[VRShop] Batch step finished OK."); }
            catch (Exception e) { Debug.LogError($"[VRShop] Batch step failed: {e}"); code = 1; }
            EditorUtility.ClearProgressBar();
            EditorApplication.Exit(code);
        }
    }
}
