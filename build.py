#!/usr/bin/env python3
"""
Package the Volume Gesture extension into a ZIP for Edge Add-ons Store submission.

Usage:
    python build.py                  # creates volumeGesture-<version>.zip
    python build.py --native-host    # also creates native-host-<version>.zip (GitHub release asset)
"""

import json
import os
import sys
import zipfile

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

EXTENSION_FILES = [
    "manifest.json",
    "background.js",
    "popup.html",
    "popup.js",
    "styles.css",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
]

NATIVE_HOST_FILES = [
    "native_host/volume_monitor.py",
    "native_host/requirements.txt",
    "native_host/install.bat",
    "native_host/uninstall.bat",
    "native_host/com.volgesture.volumemonitor.json",
    "native_host/volume_monitor_wrapper.bat",
]


def get_version():
    with open(os.path.join(SCRIPT_DIR, "manifest.json")) as f:
        return json.load(f)["version"]


def get_native_host_files():
    """Paths under SCRIPT_DIR; includes volume_monitor.exe when present (release bundle)."""
    out = list(NATIVE_HOST_FILES)
    exe_rel = "native_host/volume_monitor.exe"
    if os.path.exists(os.path.join(SCRIPT_DIR, exe_rel)):
        out.append(exe_rel)
    return out


def build_zip(name, files):
    out_path = os.path.join(SCRIPT_DIR, name)
    zf = zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED)
    try:
        for rel in files:
            full = os.path.join(SCRIPT_DIR, rel)
            if not os.path.exists(full):
                print("  WARNING: missing %s, skipping" % rel)
                continue
            zf.write(full, rel)
            print("  + %s" % rel)
    finally:
        zf.close()
    size_kb = os.path.getsize(out_path) / 1024
    print("\nCreated %s (%.1f KB)" % (name, size_kb))
    return out_path


def main():
    native_host = "--native-host" in sys.argv

    version = get_version()
    print("Volume Gesture v%s\n" % version)

    print("=== Extension ZIP (for store submission) ===")
    build_zip("volumeGesture-%s.zip" % version, EXTENSION_FILES)

    if native_host:
        print("\n=== Native Host ZIP ===")
        build_zip("native-host-%s.zip" % version, get_native_host_files())


if __name__ == "__main__":
    main()
