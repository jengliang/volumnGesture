"""
Native Messaging Host for Volume Gesture extension.
Monitors Windows system volume changes via pycaw (Core Audio API).
Detects up->down / down->up gestures using peak/valley reversal detection
and simulates OS media keys so navigation works even when browser is minimized.
"""

import sys
import json
import struct
import threading
import time
import ctypes
from ctypes import POINTER, cast
import comtypes
from comtypes import CLSCTX_ALL
from pycaw.pycaw import IAudioEndpointVolume

# Keep in sync with the extension manifest.json "version".
NATIVE_HOST_VERSION = "4.2.0"

VK_MEDIA_NEXT_TRACK = 0xB0
VK_MEDIA_PREV_TRACK = 0xB1
KEYEVENTF_KEYUP = 0x0002
DEVICE_REACQUIRE_INTERVAL = 5.0


def send_message(msg):
    encoded = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(encoded)))
    sys.stdout.buffer.write(encoded)
    sys.stdout.buffer.flush()


def read_message():
    raw_length = sys.stdin.buffer.read(4)
    if not raw_length:
        return None
    length = struct.unpack("<I", raw_length)[0]
    data = sys.stdin.buffer.read(length)
    return json.loads(data.decode("utf-8"))


def simulate_media_key(vk_code):
    ctypes.windll.user32.keybd_event(vk_code, 0, 0, 0)
    ctypes.windll.user32.keybd_event(vk_code, 0, KEYEVENTF_KEYUP, 0)


def get_audio_endpoint():
    from pycaw.pycaw import AudioUtilities

    speakers = AudioUtilities.GetSpeakers()

    if hasattr(speakers, "Activate"):
        interface = speakers.Activate(
            IAudioEndpointVolume._iid_, CLSCTX_ALL, None
        )
        return cast(interface, POINTER(IAudioEndpointVolume))

    raw_dev = getattr(speakers, "_dev", None) or getattr(speakers, "dev", None)
    if raw_dev and hasattr(raw_dev, "Activate"):
        interface = raw_dev.Activate(
            IAudioEndpointVolume._iid_, CLSCTX_ALL, None
        )
        return cast(interface, POINTER(IAudioEndpointVolume))

    from pycaw.pycaw import IMMDeviceEnumerator
    CLSID_MMDeviceEnumerator = comtypes.GUID(
        "{BCDE0395-E52F-467C-8E3D-C4579291692E}"
    )
    enumerator = comtypes.CoCreateInstance(
        CLSID_MMDeviceEnumerator,
        IMMDeviceEnumerator,
        comtypes.CLSCTX_INPROC_SERVER,
    )
    device = enumerator.GetDefaultAudioEndpoint(0, 1)
    interface = device.Activate(
        IAudioEndpointVolume._iid_, CLSCTX_ALL, None
    )
    return cast(interface, POINTER(IAudioEndpointVolume))


class GestureDetector:
    """
    Peak/valley reversal gesture detector.

    Instead of waiting for volume to settle (which kills fast gestures),
    this tracks the extremum (peak or trough) during a volume movement
    and fires immediately when a reversal from that extremum is detected.

    up→reversal_down = "next"   (volume went up then came back down)
    down→reversal_up = "previous" (volume went down then came back up)

    States:
      IDLE       - reference volume tracked; waiting for significant departure
      FIRST_MOVE - first direction detected; tracking peak/trough; watching
                   for reversal within gesture_window
      COOLDOWN   - gesture just fired; all input ignored
    """

    IDLE = 0
    FIRST_MOVE = 1
    COOLDOWN = 2

    def __init__(self, gesture_window=1.0, min_delta=0.005,
                 reversal_threshold=0.015, cooldown_duration=1.0,
                 idle_settle_time=0.2):
        self.gesture_window = gesture_window
        self.min_delta = min_delta
        self.reversal_threshold = reversal_threshold
        self.cooldown_duration = cooldown_duration
        self.idle_settle_time = idle_settle_time
        self.reset(None)

    def reset(self, volume):
        self.state = self.IDLE
        self.reference_volume = volume
        self.extremum = None
        self.first_direction = None
        self.first_move_time = 0.0
        self.cooldown_until = 0.0
        self._idle_stable_since = 0.0

    def update(self, volume, now):
        """Called every poll. Returns 'next', 'previous', or None."""
        if self.reference_volume is None:
            self.reference_volume = volume
            self._idle_stable_since = now
            return None

        # --- COOLDOWN ---
        if self.state == self.COOLDOWN:
            if now >= self.cooldown_until:
                self.state = self.IDLE
                self.reference_volume = volume
                self._idle_stable_since = now
            return None

        # --- IDLE ---
        if self.state == self.IDLE:
            delta = volume - self.reference_volume
            if delta >= self.min_delta:
                self.state = self.FIRST_MOVE
                self.first_direction = "up"
                self.extremum = volume
                self.first_move_time = now
            elif delta <= -self.min_delta:
                self.state = self.FIRST_MOVE
                self.first_direction = "down"
                self.extremum = volume
                self.first_move_time = now
            else:
                # Only update reference after volume has been stable.
                # This prevents the reference from chasing gradual changes
                # which would make the detector miss slow button presses.
                if abs(volume - self.reference_volume) < 0.003:
                    if now - self._idle_stable_since >= self.idle_settle_time:
                        self.reference_volume = volume
                else:
                    self._idle_stable_since = now
            return None

        # --- FIRST_MOVE ---
        if self.state == self.FIRST_MOVE:
            if now - self.first_move_time > self.gesture_window:
                self.state = self.IDLE
                self.reference_volume = volume
                self._idle_stable_since = now
                self.first_direction = None
                return None

            excursion = abs(self.extremum - self.reference_volume)
            required = max(self.reversal_threshold, excursion * 0.4)

            if self.first_direction == "up":
                if volume > self.extremum:
                    self.extremum = volume
                    excursion = abs(self.extremum - self.reference_volume)
                    required = max(self.reversal_threshold, excursion * 0.4)
                reversal = self.extremum - volume
                if reversal >= required:
                    self.state = self.COOLDOWN
                    self.cooldown_until = now + self.cooldown_duration
                    self.first_direction = None
                    return "next"
            else:
                if volume < self.extremum:
                    self.extremum = volume
                    excursion = abs(self.extremum - self.reference_volume)
                    required = max(self.reversal_threshold, excursion * 0.4)
                reversal = volume - self.extremum
                if reversal >= required:
                    self.state = self.COOLDOWN
                    self.cooldown_until = now + self.cooldown_duration
                    self.first_direction = None
                    return "previous"

            return None

        return None


class VolumeMonitor:
    def __init__(self):
        self._lock = threading.Lock()
        self._running = True
        self._detector = GestureDetector()
        self._endpoint = None
        self._last_reacquire = 0.0
        # When False, skip VK_MEDIA_* (e.g. YouTube Shorts — extension handles in-page).
        self._simulate_media_keys = True

    def start(self):
        send_message({
            "type": "status",
            "status": "starting",
            "version": NATIVE_HOST_VERSION,
        })

        try:
            self._endpoint = get_audio_endpoint()
            self._last_reacquire = time.monotonic()
            volume = self._endpoint.GetMasterVolumeLevelScalar()
        except Exception as e:
            send_message({"type": "error", "error": str(e)})
            return

        send_message({
            "type": "status",
            "status": "connected",
            "volume": volume,
            "version": NATIVE_HOST_VERSION,
        })

        poll_thread = threading.Thread(target=self._poll_loop, daemon=True)
        poll_thread.start()

        self._read_loop()

    def _reacquire_endpoint(self, notify=False):
        """Re-acquire audio endpoint to handle device switches.

        notify=True sends a status message (used after error recovery /
        device switch); routine periodic reacquires stay silent.
        """
        try:
            self._endpoint = get_audio_endpoint()
            self._last_reacquire = time.monotonic()
            volume = self._endpoint.GetMasterVolumeLevelScalar()
            with self._lock:
                self._detector.reset(volume)
            if notify:
                send_message({"type": "status", "status": "device_refreshed"})
        except Exception:
            pass

    def _poll_loop(self):
        comtypes.CoInitialize()
        try:
            # Re-acquire endpoint on this thread so COM apartment is correct (silent).
            self._reacquire_endpoint(notify=False)

            while self._running:
                now = time.monotonic()

                if now - self._last_reacquire >= DEVICE_REACQUIRE_INTERVAL:
                    # Periodic silent refresh; no status message needed.
                    self._reacquire_endpoint(notify=False)

                try:
                    volume = self._endpoint.GetMasterVolumeLevelScalar()
                    with self._lock:
                        gesture = self._detector.update(volume, now)
                    if gesture:
                        with self._lock:
                            do_keys = self._simulate_media_keys
                        if do_keys:
                            if gesture == "next":
                                simulate_media_key(VK_MEDIA_NEXT_TRACK)
                            else:
                                simulate_media_key(VK_MEDIA_PREV_TRACK)
                        send_message({"type": "gesture", "gesture": gesture})
                except Exception:
                    # Notify on error-driven reacquire — that's a real device change.
                    self._reacquire_endpoint(notify=True)
                time.sleep(0.03)
        finally:
            comtypes.CoUninitialize()

    def _read_loop(self):
        while self._running:
            try:
                msg = read_message()
                if msg is None:
                    break
                if msg.get("type") == "ping":
                    send_message({"type": "pong"})
                elif msg.get("type") == "config":
                    if "gestureWindowMs" in msg:
                        with self._lock:
                            self._detector.gesture_window = msg["gestureWindowMs"] / 1000.0
                    if "simulateMediaKeys" in msg:
                        with self._lock:
                            self._simulate_media_keys = bool(
                                msg["simulateMediaKeys"]
                            )
                elif msg.get("type") == "quit":
                    break
            except Exception:
                break

        self._running = False


def main():
    try:
        comtypes.CoInitialize()
        monitor = VolumeMonitor()
        monitor.start()
    except Exception as e:
        send_message({"type": "error", "error": str(e)})
    finally:
        try:
            comtypes.CoUninitialize()
        except Exception:
            pass


if __name__ == "__main__":
    main()
