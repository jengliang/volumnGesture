# Privacy Policy — Volume Gesture

**Last updated:** August 17, 2026 (extension / native host v4.2.0)

## Data Collection

Volume Gesture does **not** collect, store, transmit, or share any personal data, browsing history, usage analytics, or telemetry of any kind.

## Permissions Explained

The extension requests the following browser permissions solely for its core functionality:

| Permission | Why it's needed |
|------------|----------------|
| `storage` | Save your settings (enabled/disabled, gesture timing) locally in your browser. No data leaves your device. |
| `nativeMessaging` | Communicate with the optional native host application that monitors system volume for Bluetooth headset support. Communication is strictly local (between the browser and a process on your own computer). |
| `tabs` | Identify which tab is playing audio so the gesture can be applied to the correct tab. |
| `scripting` | Inject the navigation and visual overlay code into the active video page. |
| `alarms` | Keep the connection to the native host alive while the browser is running. |
| `<all_urls>` (host permission) | Allow gesture detection and video navigation on any website, not just specific domains. |

## Native Host

The optional native host (`volume_monitor`) runs locally on your computer. It monitors your system's master volume level to detect gestures from hardware volume buttons. It does not access the internet, transmit any data externally, or record audio. All communication occurs over the browser's native messaging channel (a local stdio pipe).

## Third-Party Services

Volume Gesture does not use any third-party services, analytics platforms, or remote servers.

## Changes

If this policy changes, the update will be posted here with a new date.

## Contact

For questions about this policy, open an issue at https://github.com/jengliang/volumeGesture/issues.
