# Edge Add-ons Store Listing

## Short Description (max 132 characters)

Navigate between videos with quick volume gestures from your Bluetooth headset or any headset with volume control, even when the browser is minimized.

## Detailed Description

Volume Gesture lets you skip to the next or previous video using quick volume button sequences on your headset or keyboard — no need to touch the screen or switch apps.

**How it works:**
- Volume Up then Down (within the configured window, 1–4 seconds) → Next video
- Volume Down then Up (within the configured window, 1–4 seconds) → Previous video

**Works everywhere:**
- YouTube — uses built-in next/previous navigation
- Facebook — scrolls between videos in feed, Watch, and Reels
- Other video sites — finds next/previous buttons or scrolls between video elements

**Key features:**
- Bluetooth headset support — control videos with your headset's volume buttons, even while the browser is minimized or in the background
- Keyboard volume keys — works with any volume control that changes the system volume
- Smart gesture detection — filters out accidental triggers with adaptive thresholds
- Visual feedback — a brief on-screen overlay confirms each gesture
- Configurable timing — gesture window 1–4 s; feed scroll 80–100% for scroll-to-play sites (e.g. MSN)

**Setup:**
1. Install from the Microsoft Edge Add-ons Store: [Volume Gesture](https://microsoftedge.microsoft.com/addons/detail/dafhmbjblhplgpnbkbhajnpheaenfdcb)
2. Download **`native-host-4.2.0.zip`** from the **[v4.2.0 release](https://github.com/jengliang/volumeGesture/releases/tag/v4.2.0)** on GitHub, extract, run `install.bat`, and press Enter when asked for the extension ID (defaults to the store extension).

The native host monitors your system volume to detect gestures from hardware buttons. A standalone `.exe` build requires no Python.

## Category

Productivity

## Support URL

https://github.com/jengliang/volumeGesture/issues

## Website URL

https://github.com/jengliang/volumeGesture
