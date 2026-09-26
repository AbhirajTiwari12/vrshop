using System.IO;
using System.Xml;
using UnityEditor.Android;
using UnityEngine;

namespace VRShop.EditorTools
{
    /// <summary>
    /// The Quest talks to the backend over plain HTTP on the LAN. Android 9+ blocks cleartext unless the manifest
    /// opts in, and neither Unity's "Allow downloads over HTTP" nor Meta's generated manifest adds the flag, so we
    /// patch the generated Gradle project on every build (Meta's tools rewrite Assets/Plugins/Android/AndroidManifest.xml,
    /// so editing that file by hand wouldn't stick).
    /// </summary>
    class CleartextHttpPostprocessor : IPostGenerateGradleAndroidProject
    {
        const string k_AndroidNs = "http://schemas.android.com/apk/res/android";
        public int callbackOrder => 1000;

        public void OnPostGenerateGradleAndroidProject(string unityLibraryPath)
        {
            var path = Path.Combine(unityLibraryPath, "src", "main", "AndroidManifest.xml");
            var doc = new XmlDocument();
            doc.Load(path);
            if (doc.SelectSingleNode("/manifest/application") is not XmlElement app)
            {
                Debug.LogError($"[VRShop] No <application> in {path}; HTTP to the backend will be blocked on device.");
                return;
            }
            app.SetAttribute("usesCleartextTraffic", k_AndroidNs, "true");
            doc.Save(path);
        }
    }
}
