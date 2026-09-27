using System;
using System.Collections.Generic;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using UnityEngine;
using UnityEngine.Networking;

namespace VRShop.Api
{
    /// <summary>Thin async wrapper over the VRShop backend REST API (see backend/src/server.ts).</summary>
    public class ApiClient
    {
        public string BaseUrl { get; private set; }

        static readonly JsonSerializerSettings k_Json = new JsonSerializerSettings
        {
            NullValueHandling = NullValueHandling.Ignore,
            MissingMemberHandling = MissingMemberHandling.Ignore,
        };

        public ApiClient(string baseUrl) => SetBaseUrl(baseUrl);

        public void SetBaseUrl(string url) => BaseUrl = (url ?? "").Trim().TrimEnd('/');

        public string Abs(string url)
        {
            if (string.IsNullOrEmpty(url)) return url;
            return url.StartsWith("http", StringComparison.OrdinalIgnoreCase) ? url : BaseUrl + (url.StartsWith("/") ? "" : "/") + url;
        }

        /// <summary>Product images go through the backend proxy: always JPEG (Unity can't decode WebP) and resized.</summary>
        public string ImageUrl(string url, int width = 384) =>
            string.IsNullOrEmpty(url) ? null : $"{BaseUrl}/api/img?u={UnityWebRequest.EscapeURL(url)}&w={width}";

        // ------------------------------------------------------------------ endpoints
        public Task<Health> Health() => Send<Health>("GET", "/api/health", null, 5);
        public Task<Session> LatestSession() => Send<Session>("GET", "/api/sessions/latest");
        public Task<Session> GetSession(string id, long since = 0) => Send<Session>("GET", $"/api/sessions/{id}" + (since > 0 ? $"?since={since}" : ""));
        public Task<Session> CreateDemoSession() => Send<Session>("POST", "/api/sessions/demo", new { });
        public Task PostGeometry(string id, RoomGeometryDto g) => Send<object>("POST", $"/api/sessions/{id}/geometry", g);
        public Task<LayoutResponse> Layout(string id, List<string> productIds, UserDto user, List<FixedPlacement> fixedPlacements = null) =>
            Send<LayoutResponse>("POST", $"/api/sessions/{id}/layout", new { productIds, user, @fixed = fixedPlacements ?? new List<FixedPlacement>() }, 20);
        public Task PutPlacements(string id, List<Placement> placements) => Send<object>("PUT", $"/api/sessions/{id}/placements", new { placements });
        public Task<Session> SetCart(string id, string productId, int qty) => Send<Session>("POST", $"/api/sessions/{id}/cart", new { productId, qty });
        public Task<Product> EnsureModel(string productId, bool generate = true) => Send<Product>("POST", $"/api/products/{productId}/model", new { generate });
        public Task<Product> GetProduct(string productId) => Send<Product>("GET", $"/api/products/{productId}");
        public Task<SearchResponse> Search(string id, string text) => Send<SearchResponse>("POST", $"/api/sessions/{id}/search", new { text }, 60);
        public Task<VoiceResponse> Ask(string id, string text, string focusProductId = null, string pieceId = null) => Send<VoiceResponse>("POST", $"/api/sessions/{id}/ask", new { text, focusProductId, pieceId }, 60);
        /// <summary>Keep / replace one real piece, change its type, or set the product standing in for it.</summary>
        public Task<Session> SetRealPiece(string id, string pieceId, object patch) => Send<Session>("PUT", $"/api/sessions/{id}/real/{UnityWebRequest.EscapeURL(pieceId)}", patch);
        public Task<CandidatesResponse> ReplacementCandidates(string id, string pieceId, string category = null, int limit = 12) =>
            Send<CandidatesResponse>("GET", $"/api/sessions/{id}/real/{UnityWebRequest.EscapeURL(pieceId)}/candidates?limit={limit}" + (string.IsNullOrEmpty(category) ? "" : $"&category={UnityWebRequest.EscapeURL(category)}"), null, 45);
        public Task<Session> SetBrowse(string id, Filters filters) => Send<Session>("PUT", $"/api/sessions/{id}/browse", new { filters });
        public Task<Quote> Quote(string id) => Send<Quote>("GET", $"/api/sessions/{id}/checkout/quote");
        public Task<Session> StartCheckout(string id, bool allowOverBudget) => Send<Session>("POST", $"/api/sessions/{id}/checkout", new { via = "headset", allowOverBudget });
        public Task<Session> Swap(string id, string from, string to) => Send<Session>("POST", $"/api/sessions/{id}/cart/swap", new { from, to });
        public Task<BrowseMoreResponse> BrowseMore(string id) => Send<BrowseMoreResponse>("POST", $"/api/sessions/{id}/browse/more", new { }, 60);
        /// <summary>Register a line for the designer to say; returns the WAV URL (synthesized once on the server, cached).</summary>
        public Task<SpeechResponse> Speech(string text) => Send<SpeechResponse>("POST", "/api/speech", new { text }, 15);

        /// <summary>Raw bytes of a backend resource (e.g. a speech WAV).</summary>
        public async Task<byte[]> GetBytes(string url, int timeoutSec = 30)
        {
            using var req = UnityWebRequest.Get(Abs(url));
            req.timeout = timeoutSec;
            await SendAsync(req);
            if (req.result != UnityWebRequest.Result.Success)
                throw new ApiException((int)req.responseCode, ErrorText(req, req.downloadHandler?.text));
            return req.downloadHandler.data;
        }

        public async Task<VoiceResponse> Voice(string sessionId, byte[] wav, string focusProductId = null, string pieceId = null)
        {
            var form = new List<IMultipartFormSection> { new MultipartFormFileSection("audio", wav, "speech.wav", "audio/wav") };
            if (!string.IsNullOrEmpty(focusProductId)) form.Add(new MultipartFormDataSection("focusProductId", focusProductId));
            if (!string.IsNullOrEmpty(pieceId)) form.Add(new MultipartFormDataSection("pieceId", pieceId));
            using var req = UnityWebRequest.Post($"{BaseUrl}/api/sessions/{sessionId}/voice", form);
            req.timeout = 60;
            await SendAsync(req);
            var text = req.downloadHandler?.text;
            if (req.result != UnityWebRequest.Result.Success)
                return new VoiceResponse { error = ErrorText(req, text) };
            return JsonConvert.DeserializeObject<VoiceResponse>(text, k_Json);
        }

        // ------------------------------------------------------------------ core
        public async Task<T> Send<T>(string method, string path, object body = null, int timeoutSec = 30)
        {
            using var req = new UnityWebRequest(BaseUrl + path, method) { downloadHandler = new DownloadHandlerBuffer(), timeout = timeoutSec };
            if (body != null)
            {
                var json = JsonConvert.SerializeObject(body, k_Json);
                req.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(json)) { contentType = "application/json" };
                req.SetRequestHeader("Content-Type", "application/json");
            }
            await SendAsync(req);
            var text = req.downloadHandler.text;
            if (req.result != UnityWebRequest.Result.Success)
                throw new ApiException((int)req.responseCode, ErrorText(req, text));
            if (typeof(T) == typeof(object) || string.IsNullOrEmpty(text)) return default;
            return JsonConvert.DeserializeObject<T>(text, k_Json);
        }

        static string ErrorText(UnityWebRequest req, string body)
        {
            if (!string.IsNullOrEmpty(body) && body.Contains("\"error\""))
            {
                try { return JsonConvert.DeserializeObject<Dictionary<string, object>>(body)?["error"]?.ToString(); }
                catch { /* fall through */ }
            }
            return req.responseCode > 0 ? $"HTTP {req.responseCode}: {req.error}" : req.error;
        }

        public static Task SendAsync(UnityWebRequest req)
        {
            var tcs = new TaskCompletionSource<bool>();
            var op = req.SendWebRequest();
            op.completed += _ => tcs.TrySetResult(true);
            return tcs.Task;
        }
    }

    public class ApiException : Exception
    {
        public readonly int Status;
        public ApiException(int status, string message) : base(message) => Status = status;
    }
}
