using System;
using System.IO;
using UnityEngine;
using VRShop.Core;
using VRShop.Furniture;
using VRShop.Input;
using VRShop.Interaction;
using VRShop.UI;
#if UNITY_ANDROID && !UNITY_EDITOR
using UnityEngine.Android;
#endif

namespace VRShop.Voice
{
    /// <summary>
    /// Hold X, say what you want ("a tall plant for this corner under 80 dollars"), release.
    /// Audio goes to the backend (OpenAI transcription + intent), which searches real stores and adds a new
    /// row to the catalog. If you pointed at the floor while speaking, the next item you place goes there.
    /// </summary>
    public class VoiceCommand : MonoBehaviour
    {
        const int SampleRate = 16000;
        const int MaxSeconds = 12;

        AudioClip m_Clip;
        string m_Device;
        bool m_Recording;
        float m_Started;
        Vector3? m_PointedAt;

        void Start()
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            if (!Permission.HasUserAuthorizedPermission(Permission.Microphone)) Permission.RequestUserPermission(Permission.Microphone);
#endif
        }

        void Update()
        {
            var input = XRInput.Instance;
            if (input == null) return;
            if (input.Down(Btn.X)) Begin();
            if (m_Recording)
            {
                // remember where the user points while talking ("put it here")
                foreach (var lp in FindObjectsByType<LaserPointer>(FindObjectsSortMode.None))
                    if (lp.HasHit && LaserPointer.IsFloor(lp.Hit.collider)) m_PointedAt = lp.Hit.point;
                if (input.Up(Btn.X) || Time.time - m_Started > MaxSeconds) End();
            }
        }

        void Begin()
        {
            if (m_Recording) return;
            if (Microphone.devices.Length == 0) { Toast.Show("No microphone found"); return; }
            m_Device = Microphone.devices[0];
            m_Clip = Microphone.Start(m_Device, false, MaxSeconds, SampleRate);
            m_Recording = true;
            m_Started = Time.time;
            m_PointedAt = null;
            Toast.Sticky("Listening…  release X when you're done");
            XRInput.Instance.Haptic(Hand.Left, 0.3f, 0.05f);
        }

        async void End()
        {
            if (!m_Recording) return;
            m_Recording = false;
            var pos = Microphone.GetPosition(m_Device);
            Microphone.End(m_Device);
            var seconds = pos / (float)SampleRate;
            if (m_Clip == null || seconds < 0.4f) { Toast.Show("Hold X while you speak"); return; }

            var samples = new float[pos * m_Clip.channels];
            m_Clip.GetData(samples, 0);
            var wav = WavEncoder.Encode(samples, m_Clip.channels, SampleRate);
            Toast.Sticky("Searching real stores…");

            var app = VRShopApp.Instance;
            if (app?.Session == null) { Toast.Show("Not connected yet"); return; }
            try
            {
                var res = await app.Api.Voice(app.Session.id, wav);
                if (!string.IsNullOrEmpty(res.error)) { Toast.Show(res.error, 4); return; }
                if (string.IsNullOrEmpty(res.transcript)) { Toast.Show("Sorry, I didn't catch that", 3); return; }
                Toast.Show($"\"{res.transcript}\"\n<size=24>{res.reply}</size>", 5);
                if (res.session != null) app.SetSession(res.session);
                if (res.atPointer && m_PointedAt.HasValue && FurnitureManager.Instance != null) FurnitureManager.Instance.PendingPoint = m_PointedAt;
                if (res.result != null) CatalogPanel.Instance?.Focus(res.result.category);
            }
            catch (Exception e)
            {
                Toast.Show($"Voice search failed: {e.Message}", 4);
            }
        }
    }

    public static class WavEncoder
    {
        /// <summary>16-bit PCM mono WAV (downmixes if needed).</summary>
        public static byte[] Encode(float[] samples, int channels, int sampleRate)
        {
            var frames = samples.Length / Math.Max(1, channels);
            using var ms = new MemoryStream(44 + frames * 2);
            using var w = new BinaryWriter(ms);
            w.Write(new[] { 'R', 'I', 'F', 'F' });
            w.Write(36 + frames * 2);
            w.Write(new[] { 'W', 'A', 'V', 'E', 'f', 'm', 't', ' ' });
            w.Write(16);
            w.Write((short)1);          // PCM
            w.Write((short)1);          // mono
            w.Write(sampleRate);
            w.Write(sampleRate * 2);    // byte rate
            w.Write((short)2);          // block align
            w.Write((short)16);         // bits
            w.Write(new[] { 'd', 'a', 't', 'a' });
            w.Write(frames * 2);
            for (var i = 0; i < frames; i++)
            {
                float s = 0;
                for (var c = 0; c < channels; c++) s += samples[i * channels + c];
                s /= Math.Max(1, channels);
                w.Write((short)(Mathf.Clamp(s, -1f, 1f) * short.MaxValue));
            }
            w.Flush();
            return ms.ToArray();
        }
    }
}
