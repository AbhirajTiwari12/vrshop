using System;
using System.IO;
using UnityEngine;
using VRShop.Assistant;
using VRShop.Core;
using VRShop.Furniture;
using VRShop.Input;
using VRShop.Interaction;
using VRShop.Room;
using VRShop.UI;
#if UNITY_ANDROID && !UNITY_EDITOR
using UnityEngine.Android;
#endif

namespace VRShop.Voice
{
    /// <summary>
    /// Talk to the designer: hold X and speak (release to send), or tap the orb once and just talk — it stops by
    /// itself when you pause. It's a conversation over the whole pulled catalog: "black leather sofa under 1500",
    /// "anything cheaper?", "tell me about the second one", "add it to my bag", "put it here". The backend
    /// transcribes, updates the Browse filters (searching live stores only if the catalog has too few matches),
    /// answers with real numbers and may act (open / place / add to bag / checkout); the orb speaks the answer.
    /// If you pointed at the floor while speaking, the next item you place goes there.
    /// </summary>
    public class VoiceCommand : MonoBehaviour
    {
        public static VoiceCommand Instance { get; private set; }

        const int SampleRate = 16000;
        const int MaxSeconds = 12;

        /// <summary>Smoothed microphone level 0..1 while listening (drives the orb).</summary>
        public float Level { get; private set; }
        public bool IsListening => m_Recording;

        AudioClip m_Clip;
        string m_Device;
        bool m_Recording, m_TapMode, m_Busy;
        float m_Started;
        Vector3? m_PointedAt;
        string m_PointedPiece; // a real piece of furniture pointed at while talking ("replace this")
        readonly float[] m_Window = new float[512];
        float m_Noise = 0.01f, m_HeardSpeech, m_Silence;

        AssistantOrb Orb => AssistantOrb.Instance;

        void Awake() => Instance = this;

        void Start()
        {
#if UNITY_ANDROID && !UNITY_EDITOR
            if (!Permission.HasUserAuthorizedPermission(Permission.Microphone)) Permission.RequestUserPermission(Permission.Microphone);
#endif
        }

        /// <summary>Tap the orb: start listening, or send what was said so far.</summary>
        public void ToggleListening()
        {
            if (m_Recording) End();
            else Begin(true);
        }

        void Update()
        {
            var input = XRInput.Instance;
            if (input == null) return;
            if (input.Down(Btn.X)) Begin(false);
            if (!m_Recording) { Level = 0; return; }

            // Remember where the user points while talking ("put it here", "replace this").
            foreach (var lp in FindObjectsByType<LaserPointer>(FindObjectsSortMode.None))
            {
                if (lp.HasHit && (LaserPointer.IsFloor(lp.Hit.collider) || LaserPointer.IsTopFace(lp.Hit))) m_PointedAt = lp.Hit.point; // floor, or a tabletop
                if (lp.Hovered is RealPiece rp && rp != null) m_PointedPiece = rp.Id;
                else if (lp.Hovered is FurnitureItem fi && fi != null && RealFurniture.Instance?.PieceOf(fi) is RealPiece owner) m_PointedPiece = owner.Id;
            }

            var rms = MicRms();
            Level = Mathf.Lerp(Level, Mathf.Clamp01(rms * 9f), 1 - Mathf.Exp(-Time.deltaTime * 20));
            var elapsed = Time.time - m_Started;
            if (m_TapMode)
            {
                // Tap-to-talk: learn the room's noise for a moment, then stop after a pause that follows speech.
                if (elapsed < 0.35f) m_Noise = Mathf.Lerp(m_Noise, rms, 0.2f);
                var speaking = rms > Mathf.Max(0.012f, m_Noise * 2.8f);
                if (speaking) { m_HeardSpeech += Time.deltaTime; m_Silence = 0; }
                else m_Silence += Time.deltaTime;
                if (m_HeardSpeech > 0.3f && m_Silence > 1.2f) { End(); return; }
                if (m_HeardSpeech < 0.1f && elapsed > 7f) { Cancel("I didn't hear anything — tap me and try again."); return; }
            }
            else if (input.Up(Btn.X)) { End(); return; }
            if (elapsed > MaxSeconds) End();
        }

        float MicRms()
        {
            if (m_Clip == null || !Microphone.IsRecording(m_Device)) return 0;
            var pos = Microphone.GetPosition(m_Device);
            if (pos < m_Window.Length) return 0;
            m_Clip.GetData(m_Window, pos - m_Window.Length);
            float sum = 0;
            foreach (var s in m_Window) sum += s * s;
            return Mathf.Sqrt(sum / m_Window.Length);
        }

        void Begin(bool tapMode)
        {
            if (m_Recording) return;
            if (m_Busy) { Orb?.Notify("Still working on your last request…"); return; }
            if (Microphone.devices.Length == 0) { Orb?.Fail("I can't find a microphone. Check the app's microphone permission."); return; }
            m_Device = Microphone.devices[0];
            m_Clip = Microphone.Start(m_Device, false, MaxSeconds + 1, SampleRate);
            m_Recording = true;
            m_TapMode = tapMode;
            m_Started = Time.time;
            m_PointedAt = null;
            // A piece whose card is open counts as "this" too.
            m_PointedPiece = RealFurniture.Instance != null && RealFurniture.Instance.Selected != null ? RealFurniture.Instance.Selected.Id : null;
            m_Noise = 0.01f;
            m_HeardSpeech = m_Silence = 0;
            Orb?.Listen(tapMode);
            XRInput.Instance.Haptic(tapMode ? Hand.Right : Hand.Left, 0.3f, 0.05f);
        }

        void Cancel(string message)
        {
            m_Recording = false;
            Microphone.End(m_Device);
            Level = 0;
            Orb?.Notify(message);
        }

        async void End()
        {
            if (!m_Recording) return;
            m_Recording = false;
            Level = 0;
            if (m_Clip == null) return;
            // A full non-looping clip stops recording and GetPosition returns 0: use the whole clip then.
            var pos = Microphone.IsRecording(m_Device) ? Microphone.GetPosition(m_Device) : m_Clip.samples;
            Microphone.End(m_Device);
            var seconds = pos / (float)m_Clip.frequency;
            if (seconds < 0.4f) { Orb?.Notify("Hold X while you speak — or tap me and just talk.", null); return; }

            var samples = new float[pos * m_Clip.channels];
            m_Clip.GetData(samples, 0);
            var wav = WavEncoder.Encode(samples, m_Clip.channels, m_Clip.frequency);
            Orb?.Think("One moment…");

            var app = VRShopApp.Instance;
            if (app?.Session == null) { Orb?.Fail("I'm not connected to the showroom yet."); return; }
            m_Busy = true;
            try
            {
                // "How much is this one?" refers to the product open in the catalog's detail view.
                var res = await app.Api.Voice(app.Session.id, wav, CatalogPanel.Instance?.FocusedProductId, m_PointedPiece);
                if (!string.IsNullOrEmpty(res.error)) { Orb?.Fail(res.error); return; }
                if (string.IsNullOrEmpty(res.transcript)) { Orb?.Notify("Sorry, I didn't catch that. Try again?"); return; }
                Orb?.Respond(res.transcript, res.reply, res.speechUrl);
                if (res.session != null) app.SetSession(res.session);
                if (res.atPointer && m_PointedAt.HasValue && FurnitureManager.Instance != null) FurnitureManager.Instance.PendingPoint = m_PointedAt;
                var target = string.IsNullOrEmpty(res.productId) ? null : app.Session?.GetProduct(res.productId);
                switch (res.action)
                {
                    case "place" when target != null:
                        FurnitureManager.Instance.Place(target);
                        CatalogPanel.Instance?.Hide();
                        break;
                    case "open" when target != null:
                        CatalogPanel.Instance?.OpenProduct(target.id);
                        break;
                    case "checkout":
                        CatalogPanel.Instance?.ShowVisa(); // the user still approves with one press
                        break;
                    case "replace":
                        // The real piece is painted out and the first match stands in its spot; ↑↓ tries the others.
                        if (res.replace != null) { RealFurniture.Instance?.ApplyVoiceReplace(res.replace); CatalogPanel.Instance?.Hide(); }
                        break;
                    case "add_to_cart":
                    case "remove_from_cart":
                        break; // done on the server; the reply says so and the bag count updates
                    default:
                        if (res.browse != null) CatalogPanel.Instance?.ShowBrowse();
                        break;
                }
            }
            catch (Exception e)
            {
                Orb?.Fail($"Sorry — that didn't go through ({e.Message}).");
            }
            finally { m_Busy = false; }
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
