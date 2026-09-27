using System.Collections;
using UnityEngine;
using UnityEngine.XR;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

namespace VRShop.Input
{
    public enum Hand { Left = 0, Right = 1 }
    public enum Btn { A, B, X, Y }

    /// <summary>
    /// One place for all input. On the Quest it reads Touch controllers through OVRInput (raw mappings,
    /// independent of Unity's input backend). In the Editor without a headset it simulates the right
    /// controller with the mouse and the face buttons with the keyboard, so the whole app is testable
    /// in Play mode on a Mac.
    ///
    /// Controls (Quest):  trigger = select / drag,  right stick ← → = rotate,  stick ↑ ↓ = next replacement for a
    ///                    replaced real piece,  A = catalog,  B = delete,  hold X = voice,  grip = drag too.
    ///                    (Y is unused: the app is MR-only.)
    /// Controls (Editor): left click = trigger,  scroll = rotate,  Tab = A,  Backspace = B,  hold V = X,
    ///                    WASD + arrow keys = walk / look,  Q/E = down/up.
    /// </summary>
    public class XRInput : MonoBehaviour
    {
        public static XRInput Instance { get; private set; }

        [Tooltip("Tilt the controller ray down (+) or up (-) if pointing feels off.")]
        public float pointerPitchOffset = 0f;

        public bool Simulated { get; private set; }

        OVRCameraRig m_Rig;
        Camera m_Cam;
        float m_Yaw, m_Pitch;

        void Awake()
        {
            Instance = this;
            m_Rig = FindFirstObjectByType<OVRCameraRig>();
        }

        void Start()
        {
            m_Cam = Camera.main;
            // Only the Editor simulates. On the headset the XR device can report inactive at launch (e.g. the app
            // started while the headset was off-face), which used to lock the app into mouse/keyboard mode.
            Simulated = Application.isEditor && !XRSettings.isDeviceActive;
            if (Simulated && m_Cam != null)
            {
                Debug.Log("[VRShop] No XR device: simulating controllers with mouse/keyboard.");
                // Eye height for desktop testing.
                var rigRoot = m_Rig != null ? m_Rig.transform : m_Cam.transform;
                if (rigRoot.position.y < 0.5f) m_Cam.transform.localPosition = new Vector3(0, 1.6f, 0);
            }
        }

        void Update()
        {
            if (Simulated) SimulateLocomotion();
        }

        // ------------------------------------------------------------------ rays
        public Transform Head => m_Cam != null ? m_Cam.transform : (Camera.main != null ? Camera.main.transform : transform);

        public bool IsTracked(Hand h)
        {
            if (Simulated) return h == Hand.Right;
            return OVRInput.IsControllerConnected(h == Hand.Right ? OVRInput.Controller.RTouch : OVRInput.Controller.LTouch);
        }

        public Ray GetRay(Hand h)
        {
            if (Simulated)
            {
                var cam = m_Cam != null ? m_Cam : Camera.main;
                return cam.ScreenPointToRay(MousePosition());
            }
            var anchor = m_Rig != null ? (h == Hand.Right ? m_Rig.rightControllerAnchor : m_Rig.leftControllerAnchor) : null;
            if (anchor == null) return new Ray(Head.position, Head.forward);
            var rot = anchor.rotation * Quaternion.Euler(pointerPitchOffset, 0, 0);
            return new Ray(anchor.position, rot * Vector3.forward);
        }

        // ------------------------------------------------------------------ buttons
        public bool TriggerDown(Hand h) => Simulated ? h == Hand.Right && MouseDown(0) : OVRInput.GetDown(h == Hand.Right ? OVRInput.RawButton.RIndexTrigger : OVRInput.RawButton.LIndexTrigger);
        public bool TriggerUp(Hand h) => Simulated ? h == Hand.Right && MouseUp(0) : OVRInput.GetUp(h == Hand.Right ? OVRInput.RawButton.RIndexTrigger : OVRInput.RawButton.LIndexTrigger);
        public bool TriggerHeld(Hand h) => Simulated ? h == Hand.Right && MouseHeld(0) : OVRInput.Get(h == Hand.Right ? OVRInput.RawButton.RIndexTrigger : OVRInput.RawButton.LIndexTrigger);
        public bool GripHeld(Hand h) => Simulated ? h == Hand.Right && MouseHeld(1) : OVRInput.Get(h == Hand.Right ? OVRInput.RawButton.RHandTrigger : OVRInput.RawButton.LHandTrigger);
        public bool GripDown(Hand h) => Simulated ? h == Hand.Right && MouseDown(1) : OVRInput.GetDown(h == Hand.Right ? OVRInput.RawButton.RHandTrigger : OVRInput.RawButton.LHandTrigger);
        public bool GripUp(Hand h) => Simulated ? h == Hand.Right && MouseUp(1) : OVRInput.GetUp(h == Hand.Right ? OVRInput.RawButton.RHandTrigger : OVRInput.RawButton.LHandTrigger);

        public Vector2 Stick(Hand h)
        {
            if (Simulated) return h == Hand.Right ? new Vector2(Mathf.Clamp(ScrollDelta() * 0.5f, -1, 1), 0) : Vector2.zero;
            return OVRInput.Get(h == Hand.Right ? OVRInput.RawAxis2D.RThumbstick : OVRInput.RawAxis2D.LThumbstick);
        }

        public bool Down(Btn b) => Simulated ? KeyDown(SimKey(b)) : OVRInput.GetDown(Raw(b));
        public bool Up(Btn b) => Simulated ? KeyUp(SimKey(b)) : OVRInput.GetUp(Raw(b));
        public bool Held(Btn b) => Simulated ? KeyHeld(SimKey(b)) : OVRInput.Get(Raw(b));

        static OVRInput.RawButton Raw(Btn b) => b switch
        {
            Btn.A => OVRInput.RawButton.A,
            Btn.B => OVRInput.RawButton.B,
            Btn.X => OVRInput.RawButton.X,
            _ => OVRInput.RawButton.Y,
        };

        public void Haptic(Hand h, float amplitude = 0.3f, float seconds = 0.05f)
        {
            if (Simulated) return;
            StartCoroutine(HapticRoutine(h == Hand.Right ? OVRInput.Controller.RTouch : OVRInput.Controller.LTouch, amplitude, seconds));
        }

        static IEnumerator HapticRoutine(OVRInput.Controller c, float amp, float seconds)
        {
            OVRInput.SetControllerVibration(0.5f, amp, c);
            yield return new WaitForSeconds(seconds);
            OVRInput.SetControllerVibration(0, 0, c);
        }

        // ------------------------------------------------------------------ editor simulation
        enum SimKeyCode { Tab, Backspace, V, M }

        static SimKeyCode SimKey(Btn b) => b switch
        {
            Btn.A => SimKeyCode.Tab,
            Btn.B => SimKeyCode.Backspace,
            Btn.X => SimKeyCode.V,
            _ => SimKeyCode.M,
        };

        void SimulateLocomotion()
        {
            if (m_Cam == null) return;
            var t = m_Rig != null ? m_Rig.transform : m_Cam.transform;
            var move = Vector3.zero;
#if ENABLE_INPUT_SYSTEM
            var k = Keyboard.current;
            if (k == null) return;
            if (k.wKey.isPressed) move.z += 1; if (k.sKey.isPressed) move.z -= 1;
            if (k.dKey.isPressed) move.x += 1; if (k.aKey.isPressed) move.x -= 1;
            if (k.eKey.isPressed) move.y += 1; if (k.qKey.isPressed) move.y -= 1;
            if (k.leftArrowKey.isPressed) m_Yaw -= 90 * Time.deltaTime; if (k.rightArrowKey.isPressed) m_Yaw += 90 * Time.deltaTime;
            if (k.upArrowKey.isPressed) m_Pitch -= 60 * Time.deltaTime; if (k.downArrowKey.isPressed) m_Pitch += 60 * Time.deltaTime;
#else
            if (UnityEngine.Input.GetKey(KeyCode.W)) move.z += 1; if (UnityEngine.Input.GetKey(KeyCode.S)) move.z -= 1;
            if (UnityEngine.Input.GetKey(KeyCode.D)) move.x += 1; if (UnityEngine.Input.GetKey(KeyCode.A)) move.x -= 1;
            if (UnityEngine.Input.GetKey(KeyCode.E)) move.y += 1; if (UnityEngine.Input.GetKey(KeyCode.Q)) move.y -= 1;
            if (UnityEngine.Input.GetKey(KeyCode.LeftArrow)) m_Yaw -= 90 * Time.deltaTime; if (UnityEngine.Input.GetKey(KeyCode.RightArrow)) m_Yaw += 90 * Time.deltaTime;
            if (UnityEngine.Input.GetKey(KeyCode.UpArrow)) m_Pitch -= 60 * Time.deltaTime; if (UnityEngine.Input.GetKey(KeyCode.DownArrow)) m_Pitch += 60 * Time.deltaTime;
#endif
            m_Pitch = Mathf.Clamp(m_Pitch, -80, 80);
            m_Cam.transform.localRotation = Quaternion.Euler(m_Pitch, m_Yaw, 0);
            var flatFwd = Quaternion.Euler(0, m_Yaw, 0);
            var delta = flatFwd * new Vector3(move.x, 0, move.z) * 1.5f * Time.deltaTime + Vector3.up * move.y * Time.deltaTime;
            if (t == m_Cam.transform) t.position += delta;
            else m_Cam.transform.localPosition += Quaternion.Inverse(t.rotation) * delta;
        }

#if ENABLE_INPUT_SYSTEM
        static Vector2 MousePosition() => Mouse.current != null ? Mouse.current.position.ReadValue() : Vector2.zero;
        static bool MouseDown(int b) => Mouse.current != null && (b == 0 ? Mouse.current.leftButton : Mouse.current.rightButton).wasPressedThisFrame;
        static bool MouseUp(int b) => Mouse.current != null && (b == 0 ? Mouse.current.leftButton : Mouse.current.rightButton).wasReleasedThisFrame;
        static bool MouseHeld(int b) => Mouse.current != null && (b == 0 ? Mouse.current.leftButton : Mouse.current.rightButton).isPressed;
        static float ScrollDelta() => Mouse.current != null ? Mouse.current.scroll.ReadValue().y / 120f : 0f;
        static Key ToKey(SimKeyCode k) => k switch { SimKeyCode.Tab => Key.Tab, SimKeyCode.Backspace => Key.Backspace, SimKeyCode.V => Key.V, _ => Key.M };
        static bool KeyDown(SimKeyCode k) => Keyboard.current != null && Keyboard.current[ToKey(k)].wasPressedThisFrame;
        static bool KeyUp(SimKeyCode k) => Keyboard.current != null && Keyboard.current[ToKey(k)].wasReleasedThisFrame;
        static bool KeyHeld(SimKeyCode k) => Keyboard.current != null && Keyboard.current[ToKey(k)].isPressed;
#else
        static Vector2 MousePosition() => UnityEngine.Input.mousePosition;
        static bool MouseDown(int b) => UnityEngine.Input.GetMouseButtonDown(b);
        static bool MouseUp(int b) => UnityEngine.Input.GetMouseButtonUp(b);
        static bool MouseHeld(int b) => UnityEngine.Input.GetMouseButton(b);
        static float ScrollDelta() => UnityEngine.Input.mouseScrollDelta.y;
        static KeyCode ToKey(SimKeyCode k) => k switch { SimKeyCode.Tab => KeyCode.Tab, SimKeyCode.Backspace => KeyCode.Backspace, SimKeyCode.V => KeyCode.V, _ => KeyCode.M };
        static bool KeyDown(SimKeyCode k) => UnityEngine.Input.GetKeyDown(ToKey(k));
        static bool KeyUp(SimKeyCode k) => UnityEngine.Input.GetKeyUp(ToKey(k));
        static bool KeyHeld(SimKeyCode k) => UnityEngine.Input.GetKey(ToKey(k));
#endif
    }
}
