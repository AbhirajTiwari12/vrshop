using System;
using TMPro;
using UnityEngine;
using UnityEngine.UI;
using VRShop.Core;
using VRShop.Input;
using VRShop.Interaction;
using VRShop.UI;
using VRShop.Voice;

namespace VRShop.Assistant
{
    public enum OrbState { Idle, Listening, Thinking, Speaking }

    /// <summary>
    /// The designer, in the room with you: a small pearl-and-brass orb that hangs from the middle of the catalog's bottom
    /// edge (or, with the catalog closed, floats low and centered in your view) and talks back. It breathes while idle, ripples with your voice while listening, spins a brass arc while
    /// thinking, and pulses with its own voice while speaking (spoken replies come from the backend's text to speech
    /// and play from the orb's position). A caption bubble to its right, dropping below the catalog so it never covers
    /// a button, shows what it heard and what it says.
    /// Point at it and pull the trigger to talk (or hold X).
    /// </summary>
    public class AssistantOrb : MonoBehaviour, IPointerTarget, IOverlayTarget
    {
        public static AssistantOrb Instance { get; private set; }
        public OrbState State { get; private set; }

        const float OrbPx = 320, OrbScale = 0.0005f, CoreSize = 112;
        const float BubbleW = 580, BubbleCanvasH = 420, BubbleScale = 0.0005f, Pad = 26;
        const float TailY = 40;           // px from the bubble's top to its tail (level with the orb's center)

        // With the catalog closed: ahead, centered, below eye level (meters, relative to your head).
        static readonly Vector3 k_Rest = new Vector3(0f, -0.3f, 0.74f);
        // With the catalog open in front of you: just under the middle of its bottom edge, a little in front of it, a
        // touch larger so it reads at the panel's distance.
        const float k_PanelBelow = 0.045f, k_PanelGap = 0.06f, k_PanelScale = 1.15f;

        static Sprite s_Core, s_Glow, s_Ring, s_Arc;

        Transform m_Orb, m_Bubble;
        Image m_Glow, m_Core, m_Iris, m_Arc, m_Halo;
        readonly Image[] m_Ripples = new Image[2];
        CanvasGroup m_BubbleGroup;
        RectTransform m_BubbleBox;
        Image m_BubbleBg, m_BubbleShadow, m_Tail;
        TextMeshProUGUI m_Eyebrow, m_Heard, m_Text, m_Hint;

        AudioSource m_Audio;
        readonly float[] m_OutBuf = new float[256];
        float m_SpeakLevel;
        int m_SpeechToken;

        float m_BubbleUntil;
        bool m_BubbleSticky;
        float m_Reveal, m_RevealRate;
        float m_RevealHoldUntil;
        float m_ErrorUntil;
        bool m_Hovered;
        bool m_Placed, m_Moving;
        Vector3 m_Vel;

        // smoothed visuals
        float m_GlowA = 0.25f, m_GlowS = 1f, m_CoreS = 1f, m_ArcA, m_IrisA, m_Listen;
        Color m_GlowColor = k_IdleGlow, m_CoreTint = Color.white;

        static readonly Color k_IdleGlow = Theme.Hex("#D9B97F");
        static readonly Color k_ListenGlow = Theme.Hex("#F3DDAE");
        static readonly Color k_ThinkGlow = Theme.Hex("#E2B49C");
        static readonly Color k_SpeakGlow = Theme.Hex("#F0CF95");
        static readonly Color k_ErrorGlow = Theme.Hex("#D9735F");
        static readonly Color k_ErrorCore = Theme.Hex("#F4CFC4");
        static readonly Color k_Ember = Theme.Hex("#E9B45C");          // the golden inner light (listening / speaking)
        static readonly Color k_ListenCore = Theme.Hex("#FFF0D6");
        static readonly Color k_ThinkCore = Theme.Hex("#F3E0E6");       // rose pearl
        static readonly Color k_SpeakCore = Theme.Hex("#FFF3DE");

        public bool IsBusy => State == OrbState.Listening || State == OrbState.Thinking;

        bool TtsAvailable => VRShopApp.Instance != null && VRShopApp.Instance.Capabilities?.tts == true;

        void Awake()
        {
            Instance = this;
            BuildOrb();
            BuildBubble();
            m_Audio = gameObject.AddComponent<AudioSource>();
            m_Audio.playOnAwake = false;
            m_Audio.spatialBlend = 0.7f;      // mostly from the orb, still clear
            m_Audio.minDistance = 1f;
            m_Audio.dopplerLevel = 0;
            m_Audio.volume = 1f;
        }

        // ================================================================== public API
        /// <summary>Start of a voice turn.</summary>
        public void Listen(bool tapMode)
        {
            StopSpeaking();
            SetState(OrbState.Listening);
            ShowBubble("Listening", null, "Go ahead — I'm listening.", tapMode ? "Tap me again when you're done" : "Release X when you're done", sticky: true);
        }

        /// <summary>Waiting on the backend (transcribing / searching / arranging).</summary>
        public void Think(string line = "One moment…", string heard = null)
        {
            SetState(OrbState.Thinking);
            ShowBubble("Thinking", heard, line, null, sticky: true);
        }

        /// <summary>The designer's answer to what the user said: caption now, voice as soon as it's ready.</summary>
        public void Respond(string heard, string reply, string speechUrl)
        {
            ShowBubble("Your designer", heard, reply, null, sticky: false, holdReveal: true);
            Speak(reply, speechUrl);
        }

        /// <summary>A line the designer volunteers (greeting, "I arranged your room").</summary>
        public void Say(string text, string hint = null)
        {
            if (State == OrbState.Listening) return; // never talk over the user
            ShowBubble("Your designer", null, text, hint, sticky: false, holdReveal: true);
            Speak(text, null);
        }

        /// <summary>Caption only (no voice), e.g. "I didn't catch that".</summary>
        public void Notify(string text, string hint = null)
        {
            SetState(OrbState.Idle);
            ShowBubble("Your designer", null, text, hint, sticky: false);
        }

        public void Fail(string text)
        {
            m_ErrorUntil = Time.time + 1.6f;
            SetState(OrbState.Idle);
            ShowBubble("Your designer", null, text, null, sticky: false);
        }

        public void StopSpeaking()
        {
            m_SpeechToken++;
            if (m_Audio != null && m_Audio.isPlaying) m_Audio.Stop();
            if (State == OrbState.Speaking) SetState(OrbState.Idle);
        }

        void SetState(OrbState s) => State = s;

        // ================================================================== speech
        async void Speak(string text, string url)
        {
            var token = ++m_SpeechToken;
            if (m_Audio.isPlaying) m_Audio.Stop();
            var app = VRShopApp.Instance;
            if (app == null || string.IsNullOrWhiteSpace(text) || (string.IsNullOrEmpty(url) && !TtsAvailable))
            {
                FinishWithoutVoice(token);
                return;
            }
            SetState(OrbState.Thinking);
            try
            {
                if (string.IsNullOrEmpty(url)) url = (await app.Api.Speech(text))?.url;
                if (token != m_SpeechToken) return;
                if (string.IsNullOrEmpty(url)) { FinishWithoutVoice(token); return; }
                var bytes = await app.Api.GetBytes(url, 30);
                if (token != m_SpeechToken || this == null) return;
                var clip = WavDecoder.ToClip(bytes, "designer");
                if (clip == null) { FinishWithoutVoice(token); return; }
                if (m_Audio.clip != null) Destroy(m_Audio.clip);
                m_Audio.clip = clip;
                m_Audio.Play();
                SetState(OrbState.Speaking);
                // Captions type out in step with the voice.
                m_RevealHoldUntil = 0;
                m_RevealRate = Mathf.Max(12f, m_Text.text.Length / Mathf.Max(0.5f, clip.length * 0.92f));
                m_BubbleSticky = true;
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[VRShop] designer voice: {e.Message}");
                if (token == m_SpeechToken) FinishWithoutVoice(token);
            }
        }

        void FinishWithoutVoice(int token)
        {
            if (token != m_SpeechToken) return;
            m_RevealHoldUntil = 0;
            m_RevealRate = 60f;
            SetState(OrbState.Idle);
            m_BubbleSticky = false;
            m_BubbleUntil = Time.time + ReadingTime(m_Text.text);
        }

        static float ReadingTime(string text) => 3.5f + (text?.Length ?? 0) / 16f;

        // ================================================================== bubble
        void ShowBubble(string eyebrow, string heard, string text, string hint, bool sticky, bool holdReveal = false)
        {
            m_Eyebrow.text = eyebrow;
            m_Heard.text = string.IsNullOrEmpty(heard) ? "" : $"“{UIKit.Plain(heard)}”";
            m_Text.text = UIKit.Plain(text ?? "");
            m_Hint.text = hint ?? "";
            m_BubbleSticky = sticky;
            m_BubbleUntil = Time.time + ReadingTime(text);
            // Reveal: instant for status lines; typed along with the voice for replies (held briefly for audio).
            m_Reveal = holdReveal ? 0 : 9999;
            m_RevealRate = 60f;
            m_RevealHoldUntil = holdReveal ? Time.time + 2.5f : 0;
            Layout();
        }

        void Layout()
        {
            const float innerW = BubbleW - 2 * Pad;
            var y = Pad - 4;
            Put(m_Eyebrow, ref y, innerW, 22, 8);
            if (m_Heard.text.Length > 0) Put(m_Heard, ref y, innerW, m_Heard.GetPreferredValues(m_Heard.text, innerW, 0).y, 8);
            else m_Heard.gameObject.SetActive(false);
            Put(m_Text, ref y, innerW, m_Text.GetPreferredValues(m_Text.text, innerW, 0).y, 6);
            if (m_Hint.text.Length > 0) Put(m_Hint, ref y, innerW, 24, 0, 6);
            else m_Hint.gameObject.SetActive(false);
            var h = Mathf.Min(BubbleCanvasH, y + Pad - 6);
            // Hangs from the top: the tail stays level with the orb and longer captions grow downward.
            UIKit.Place(m_BubbleBox, 0, 0, BubbleW, h);
            UIKit.Place(m_BubbleShadow.rectTransform, -24, -24 + 8, BubbleW + 48, h + 48);
            UIKit.Place(m_BubbleBg.rectTransform, 0, 0, BubbleW, h);
            UIKit.Place(m_Tail.rectTransform, -9, Mathf.Min(TailY, h / 2) - 9, 18, 18);
        }

        static void Put(TextMeshProUGUI t, ref float y, float w, float h, float gapAfter, float gapBefore = 0)
        {
            t.gameObject.SetActive(true);
            y += gapBefore;
            UIKit.Place(t.rectTransform, Pad, y, w, h + 2);
            y += h + gapAfter;
        }

        // ================================================================== frame
        void Update()
        {
            var t = Time.time;
            var dt = Time.deltaTime;

            // Voice level (speaking) for the pulse.
            if (State == OrbState.Speaking)
            {
                if (!m_Audio.isPlaying)
                {
                    SetState(OrbState.Idle);
                    m_BubbleSticky = false;
                    m_BubbleUntil = t + 2.5f + (m_Text.text?.Length ?? 0) / 40f;
                    m_Reveal = 9999;
                }
                else
                {
                    m_Audio.GetOutputData(m_OutBuf, 0);
                    float sum = 0;
                    foreach (var v in m_OutBuf) sum += v * v;
                    m_SpeakLevel = Mathf.Lerp(m_SpeakLevel, Mathf.Clamp01(Mathf.Sqrt(sum / m_OutBuf.Length) * 5f), 1 - Mathf.Exp(-dt * 18));
                }
            }
            else m_SpeakLevel = Mathf.Lerp(m_SpeakLevel, 0, 1 - Mathf.Exp(-dt * 10));
            var mic = VoiceCommand.Instance != null ? VoiceCommand.Instance.Level : 0f;
            m_Listen = Mathf.Lerp(m_Listen, State == OrbState.Listening ? mic : 0, 1 - Mathf.Exp(-dt * 14));

            // Targets per state.
            var breath = 0.5f + 0.5f * Mathf.Sin(t * 1.7f);
            float glowA, glowS, coreS, arcA = 0, irisA = 0;
            var glowColor = k_IdleGlow;
            var coreTint = Color.white;
            switch (State)
            {
                case OrbState.Listening:
                    // Golden inner light and ripples that follow your voice.
                    glowA = 0.75f + 0.25f * m_Listen; glowS = 1.1f + 0.35f * m_Listen; coreS = 1.06f + 0.14f * m_Listen; irisA = 0.45f + 0.55f * m_Listen;
                    glowColor = k_ListenGlow; coreTint = k_ListenCore;
                    break;
                case OrbState.Thinking:
                {
                    // Rose pearl, a spinning brass arc, a quicker pulse.
                    var pulse = 0.5f + 0.5f * Mathf.Sin(t * 5.5f);
                    glowA = 0.5f + 0.2f * pulse; glowS = 1f + 0.06f * pulse; coreS = 0.97f + 0.03f * pulse; arcA = 1f; irisA = 0.12f * pulse;
                    glowColor = k_ThinkGlow; coreTint = k_ThinkCore;
                    break;
                }
                case OrbState.Speaking:
                    // Warm glow that swells with the designer's voice.
                    glowA = 0.65f + 0.35f * m_SpeakLevel; glowS = 1.05f + 0.35f * m_SpeakLevel; coreS = 1.02f + 0.1f * m_SpeakLevel; irisA = 0.3f + 0.7f * m_SpeakLevel;
                    glowColor = k_SpeakGlow; coreTint = k_SpeakCore;
                    break;
                default:
                    // A quiet pearl that breathes.
                    glowA = 0.35f + 0.15f * breath; glowS = 0.94f + 0.06f * breath; coreS = 1f;
                    break;
            }
            if (t < m_ErrorUntil) { glowColor = k_ErrorGlow; coreTint = k_ErrorCore; }
            if (m_Hovered) { coreS *= 1.1f; glowA += 0.15f; glowS += 0.08f; }

            var k = 1 - Mathf.Exp(-dt * 10);
            m_GlowA = Mathf.Lerp(m_GlowA, glowA, k);
            m_GlowS = Mathf.Lerp(m_GlowS, glowS, k);
            m_CoreS = Mathf.Lerp(m_CoreS, coreS, k);
            m_ArcA = Mathf.Lerp(m_ArcA, arcA, k);
            m_IrisA = Mathf.Lerp(m_IrisA, irisA, k);
            m_GlowColor = Color.Lerp(m_GlowColor, glowColor, 1 - Mathf.Exp(-dt * 6));
            m_CoreTint = Color.Lerp(m_CoreTint, coreTint, 1 - Mathf.Exp(-dt * 6));

            m_Glow.color = Theme.WithAlpha(m_GlowColor, m_GlowA);
            m_Glow.rectTransform.localScale = Vector3.one * m_GlowS;
            m_Core.rectTransform.localScale = Vector3.one * m_CoreS;
            m_Core.color = m_CoreTint;
            m_Iris.color = Theme.WithAlpha(k_Ember, m_IrisA);
            m_Iris.rectTransform.localScale = Vector3.one * (0.8f + 0.35f * Mathf.Max(m_Listen, m_SpeakLevel));
            m_Arc.color = Theme.WithAlpha(Theme.Brass, m_ArcA);
            // A fine brass setting around the pearl; it steps back while the thinking arc spins.
            m_Halo.color = Theme.WithAlpha(Theme.Brass, Mathf.Min(1, 0.7f * (1 - m_ArcA) * (m_Hovered ? 1.4f : 1f)));
            m_Halo.rectTransform.localScale = Vector3.one * m_CoreS;
            m_Arc.rectTransform.localRotation = Quaternion.Euler(0, 0, -t * 320f);
            for (var i = 0; i < m_Ripples.Length; i++)
            {
                var p = Mathf.Repeat(t * 0.9f + i * 0.5f, 1f);
                var on = State == OrbState.Listening ? 1f : 0f;
                m_Ripples[i].rectTransform.localScale = Vector3.one * Mathf.Lerp(1f, 1.9f, p);
                m_Ripples[i].color = Theme.WithAlpha(k_Ember, on * Mathf.Pow(1 - p, 1.3f) * (0.55f + 0.45f * m_Listen));
            }

            // Captions: type out, then fade the bubble when it's done.
            if (t >= m_RevealHoldUntil) m_Reveal += dt * m_RevealRate;
            m_Text.maxVisibleCharacters = m_Reveal >= 9000 ? 99999 : Mathf.FloorToInt(m_Reveal);
            var show = m_BubbleSticky || t < m_BubbleUntil || State != OrbState.Idle;
            m_BubbleGroup.alpha = Mathf.MoveTowards(m_BubbleGroup.alpha, show ? 1 : 0, dt * (show ? 5 : 2.5f));
        }

        void LateUpdate()
        {
            var head = XRInput.Instance != null ? XRInput.Instance.Head : (Camera.main != null ? Camera.main.transform : null);
            if (head == null) return;
            var fwd = Vector3.ProjectOnPlane(head.forward, Vector3.up);
            if (fwd.sqrMagnitude < 0.01f) fwd = Vector3.forward;
            fwd.Normalize();
            var right = Vector3.Cross(Vector3.up, fwd);
            Vector3 target;
            var scale = 1f;
            var panel = CatalogPanel.Instance;
            if (panel != null && panel.InView)
            {
                // Under the main UI: no head turn to find it, and it moves with the panel, not with every glance.
                target = panel.BottomCenter - panel.transform.up * k_PanelBelow - panel.transform.forward * k_PanelGap;
                scale = k_PanelScale;
            }
            else target = head.position + fwd * k_Rest.z + right * k_Rest.x + Vector3.up * k_Rest.y;
            transform.localScale = Vector3.one * Mathf.MoveTowards(transform.localScale.x, scale, Time.deltaTime);

            // Lazy follow: stay put for small head turns, glide back when you look well away.
            if (!m_Placed) { transform.position = target; m_Placed = true; }
            var d = Vector3.Distance(transform.position, target);
            if (d > 0.14f) m_Moving = true;
            if (m_Moving)
            {
                transform.position = Vector3.SmoothDamp(transform.position, target, ref m_Vel, 0.3f);
                if (d < 0.01f) m_Moving = false;
            }

            // Face the viewer; a gentle float.
            var toOrb = transform.position - head.position;
            var face = toOrb.sqrMagnitude > 1e-4f ? Quaternion.LookRotation(toOrb, Vector3.up) : m_Orb.rotation;
            m_Orb.rotation = face;
            m_Orb.localPosition = Vector3.up * (Mathf.Sin(Time.time * 1.3f) * 0.004f);
            // The caption hangs beside the orb, its tail level with the orb, turned to face you from its own center so it
            // reads flat, not skewed.
            var k = transform.localScale.x;
            var slide = (1 - m_BubbleGroup.alpha) * 0.02f;
            var edge = m_Orb.position + face * Vector3.right * (0.052f * k + slide) + face * Vector3.up * (TailY * BubbleScale * k);
            var center = edge + face * Vector3.right * (BubbleW * BubbleScale * k / 2);
            var toBubble = center - head.position;
            var bubbleFace = toBubble.sqrMagnitude > 1e-4f ? Quaternion.LookRotation(toBubble, Vector3.up) : m_Bubble.rotation;
            m_Bubble.SetPositionAndRotation(edge, bubbleFace);
        }

        // ================================================================== pointer (tap to talk)
        public void OnHoverEnter(PointerEvent e)
        {
            m_Hovered = true;
            if (!IsBusy && State != OrbState.Speaking && m_BubbleGroup.alpha < 0.1f)
                ShowBubble("Your designer", null, "Tap to talk to me", null, sticky: false);
        }

        public void OnHoverExit(PointerEvent e) => m_Hovered = false;
        public void OnPress(PointerEvent e) { }

        public void OnRelease(PointerEvent e, bool clicked)
        {
            if (!clicked) return;
            XRInput.Instance?.Haptic(e.hand, 0.4f, 0.05f);
            if (State == OrbState.Speaking) { StopSpeaking(); return; } // tap to interrupt
            VoiceCommand.Instance?.ToggleListening();
        }

        // ================================================================== build
        void BuildOrb()
        {
            var canvas = UIKit.CreateCanvas("OrbCanvas", new Vector2(OrbPx, OrbPx), OrbScale, UIKit.OrderOrb);
            m_Orb = canvas.transform;
            m_Orb.SetParent(transform, false);
            var c = OrbPx / 2;
            m_Glow = Layer("Glow", GlowSprite, OrbPx);
            for (var i = 0; i < m_Ripples.Length; i++) m_Ripples[i] = Layer($"Ripple{i}", RingSprite, CoreSize + 8);
            m_Halo = Layer("Halo", RingSprite, CoreSize + 22);
            m_Core = Layer("Core", CoreSprite, CoreSize);
            m_Iris = Layer("Iris", GlowSprite, CoreSize * 0.9f);
            m_Arc = Layer("Arc", ArcSprite, CoreSize + 34);

            // Tap target: a little bigger than the core, in front of it.
            var col = canvas.gameObject.AddComponent<BoxCollider>();
            col.isTrigger = true;
            col.center = new Vector3(0, 0, -6f);
            col.size = new Vector3(CoreSize * 1.5f, CoreSize * 1.5f, 20f);
            // The collider lives on the canvas object, which is a child: LaserPointer finds this component via GetComponentInParent.
            Image Layer(string name, Sprite sprite, float size)
            {
                var rt = UIKit.Box(canvas.transform, name, c - size / 2, c - size / 2, size, size);
                rt.pivot = new Vector2(0.5f, 0.5f);
                rt.anchoredPosition = new Vector2(c, -c);
                var img = rt.gameObject.AddComponent<Image>();
                img.sprite = sprite;
                img.raycastTarget = false;
                UIKit.Overlay(img);
                return img;
            }
        }

        void BuildBubble()
        {
            var canvas = UIKit.CreateCanvas("BubbleCanvas", new Vector2(BubbleW + 60, BubbleCanvasH), BubbleScale, UIKit.OrderOrb + 1);
            m_Bubble = canvas.transform;
            m_Bubble.SetParent(transform, false);
            var rt = (RectTransform)canvas.transform;
            rt.pivot = new Vector2(0, 1); // top-left corner sits beside the orb
            m_BubbleGroup = canvas.gameObject.AddComponent<CanvasGroup>();
            m_BubbleGroup.alpha = 0;
            m_BubbleBox = UIKit.Box(canvas.transform, "Box", 0, 0, BubbleW, 100);
            m_BubbleShadow = UIKit.Shadow(m_BubbleBox, "Shadow", 0, 0, BubbleW, 100, 24, 0.22f, 8);
            m_Tail = UIKit.Panel(m_BubbleBox, "Tail", -9, 41, 18, 18, Theme.Surface, 4);
            m_Tail.rectTransform.pivot = new Vector2(0.5f, 0.5f);
            m_Tail.rectTransform.localRotation = Quaternion.Euler(0, 0, 45);
            m_BubbleBg = UIKit.Panel(m_BubbleBox, "Bg", 0, 0, BubbleW, 100, Theme.Surface, 24);
            var b = m_BubbleBg.transform;
            m_Eyebrow = UIKit.Eyebrow(b, "Eyebrow", Pad, Pad, BubbleW - 2 * Pad, "Your designer", Theme.Brass, 14);
            m_Heard = UIKit.Text(b, "Heard", Pad, 0, BubbleW - 2 * Pad, 30, "", 18, Theme.Muted, Face.Regular);
            m_Heard.fontStyle = FontStyles.Italic;
            m_Text = UIKit.Text(b, "Text", Pad, 0, BubbleW - 2 * Pad, 30, "", 22, Theme.Ink, Face.Medium);
            m_Text.overflowMode = TextOverflowModes.Truncate;
            m_Hint = UIKit.Text(b, "Hint", Pad, 0, BubbleW - 2 * Pad, 24, "", 15, Theme.Faint, Face.Medium);
            Layout();
        }

        // ================================================================== procedural sprites
        /// <summary>Pearl sphere: warm ivory lit from the upper left, rose-champagne rim, soft highlight.</summary>
        static Sprite CoreSprite => s_Core != null ? s_Core : s_Core = MakeColorSprite("OrbCore", 256, (u, v) =>
        {
            var r2 = u * u + v * v;
            var r = Mathf.Sqrt(r2);
            var a = Mathf.Clamp01((1f - r) * 128f + 0.5f);
            if (a <= 0) return Color.clear;
            var n = new Vector3(u, v, Mathf.Sqrt(Mathf.Max(0, 1 - r2)));
            var diffuse = Mathf.Max(0, Vector3.Dot(n, new Vector3(-0.45f, 0.55f, 0.7f).normalized));
            var fresnel = Mathf.Pow(1 - n.z, 2.2f);
            var col = Color.Lerp(Theme.Hex("#E6D2B3"), Theme.Hex("#FFF9F0"), diffuse);
            col = Color.Lerp(col, Theme.Hex("#E9B8A2"), fresnel * 0.55f);
            var spec = Mathf.Exp(-((u + 0.33f) * (u + 0.33f) + (v - 0.38f) * (v - 0.38f)) / 0.018f);
            col = Color.Lerp(col, Color.white, spec * 0.85f);
            col.a = a;
            return col;
        });

        static Sprite GlowSprite => s_Glow != null ? s_Glow : s_Glow = MakeColorSprite("OrbGlow", 256, (u, v) =>
        {
            var r = Mathf.Sqrt(u * u + v * v);
            var a = Mathf.Exp(-r * r * 2.6f) * (1 - Mathf.SmoothStep(0.75f, 1f, r));
            return new Color(1, 1, 1, a);
        });

        static Sprite RingSprite => s_Ring != null ? s_Ring : s_Ring = MakeColorSprite("OrbRing", 256, (u, v) =>
        {
            var r = Mathf.Sqrt(u * u + v * v);
            var a = Mathf.Clamp01(1 - Mathf.Abs(r - 0.92f) / 0.045f);
            return new Color(1, 1, 1, Mathf.SmoothStep(0, 1, a));
        });

        /// <summary>Comet arc: a thin ring whose opacity grows around the circle to a bright head.</summary>
        static Sprite ArcSprite => s_Arc != null ? s_Arc : s_Arc = MakeColorSprite("OrbArc", 256, (u, v) =>
        {
            var r = Mathf.Sqrt(u * u + v * v);
            var ring = Mathf.Clamp01(1 - Mathf.Abs(r - 0.9f) / 0.06f);
            var ang = Mathf.Repeat(Mathf.Atan2(v, u) / (2 * Mathf.PI), 1f);
            return new Color(1, 1, 1, ring * Mathf.Pow(ang, 2.4f));
        });

        static Sprite MakeColorSprite(string name, int n, Func<float, float, Color> f)
        {
            var tex = new Texture2D(n, n, TextureFormat.RGBA32, true) { wrapMode = TextureWrapMode.Clamp, filterMode = FilterMode.Trilinear, name = name };
            var px = new Color32[n * n];
            for (var y = 0; y < n; y++)
            for (var x = 0; x < n; x++)
                px[y * n + x] = f((x + 0.5f) / n * 2 - 1, (y + 0.5f) / n * 2 - 1);
            tex.SetPixels32(px);
            tex.Apply(true, true);
            return Sprite.Create(tex, new Rect(0, 0, n, n), new Vector2(0.5f, 0.5f), 100);
        }
    }
}
