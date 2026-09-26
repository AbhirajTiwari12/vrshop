using System.Collections.Generic;
using System.Threading.Tasks;
using UnityEngine;
using UnityEngine.Networking;

namespace VRShop.Api
{
    /// <summary>Downloads product thumbnails (JPEG via the backend proxy) with an in-memory LRU cache.</summary>
    public static class TextureCache
    {
        const int k_Max = 160;
        static readonly Dictionary<string, Task<Texture2D>> s_Tasks = new Dictionary<string, Task<Texture2D>>();
        static readonly LinkedList<string> s_Lru = new LinkedList<string>();

        public static Task<Texture2D> Get(string url)
        {
            if (string.IsNullOrEmpty(url)) return Task.FromResult<Texture2D>(null);
            if (s_Tasks.TryGetValue(url, out var t))
            {
                s_Lru.Remove(url);
                s_Lru.AddFirst(url);
                return t;
            }
            t = Download(url);
            s_Tasks[url] = t;
            s_Lru.AddFirst(url);
            while (s_Lru.Count > k_Max)
            {
                var old = s_Lru.Last.Value;
                s_Lru.RemoveLast();
                if (s_Tasks.TryGetValue(old, out var ot) && ot.IsCompleted && ot.Result != null) Object.Destroy(ot.Result);
                s_Tasks.Remove(old);
            }
            return t;
        }

        static async Task<Texture2D> Download(string url)
        {
            using var req = UnityWebRequestTexture.GetTexture(url, true);
            req.timeout = 20;
            await ApiClient.SendAsync(req);
            if (req.result != UnityWebRequest.Result.Success)
            {
                Debug.LogWarning($"[VRShop] image failed {url}: {req.error}");
                s_Tasks.Remove(url);
                s_Lru.Remove(url);
                return null;
            }
            var tex = DownloadHandlerTexture.GetContent(req);
            tex.wrapMode = TextureWrapMode.Clamp;
            tex.anisoLevel = 2;
            return tex;
        }
    }
}
