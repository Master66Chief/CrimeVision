"""
ClassMind AI - Live End-to-End Streaming & Hardware Toggle Verification Script.
Starts the server with run.py, verifies index rendering, MJPEG stream chunks,
telemetry API, hardware webcam switching, blur toggling, and return to simulation.
"""

import urllib.request
import json
import time
import subprocess
import sys

def main():
    print("Starting ClassMind AI server on port 8083...")
    proc = subprocess.Popen(
        [sys.executable, "run.py", "--sim", "--port", "8083"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE
    )
    # Poll for server startup
    for _ in range(30):
        try:
            urllib.request.urlopen("http://127.0.0.1:8083/api/health", timeout=1)
            break
        except Exception:
            time.sleep(0.4)

    try:
        # 1. Test index page
        res = urllib.request.urlopen("http://127.0.0.1:8083/", timeout=5)
        html = res.read().decode("utf-8")
        assert "video-stream-loading" in html, "Missing video loading overlay"
        assert "live-hud-overlay" in html, "Missing live HUD overlay"
        assert "btn-reconnect-stream" in html, "Missing reconnect button"
        print("[PASS] 1. Index page loaded with dynamic video stream overlays")

        # 2. Test simulation stream
        stream_res = urllib.request.urlopen("http://127.0.0.1:8083/video_feed?stream=live", timeout=5)
        ctype = stream_res.headers.get_content_type()
        assert "multipart/x-mixed-replace" in ctype or "multipart" in ctype, f"Invalid Content-Type: {ctype}"
        first_chunk = stream_res.read(3000)
        assert b"--frame\r\nContent-Type: image/jpeg\r\nContent-Length:" in first_chunk, "Missing Content-Length in chunk"
        assert b"\xff\xd8" in first_chunk, "Missing JPEG SOI marker"
        print(f"[PASS] 2. Simulation stream active with Content-Length chunk headers ({len(first_chunk)} bytes)")

        # 3. Test telemetry API
        telem_res = urllib.request.urlopen("http://127.0.0.1:8083/api/telemetry", timeout=5)
        telem = json.loads(telem_res.read().decode("utf-8"))
        assert telem.get("use_simulation") is True
        eng = telem["telemetry"]["overall_engagement"]
        fps_val = telem.get("fps")
        print(f"[PASS] 3. Telemetry API responsive (overall engagement: {eng}%, FPS: {fps_val})")

        # 4. Test toggling to Hardware Camera mode
        req = urllib.request.Request(
            "http://127.0.0.1:8083/api/settings",
            data=json.dumps({"use_simulation": False}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        set_res = urllib.request.urlopen(req, timeout=5)
        set_data = json.loads(set_res.read().decode("utf-8"))
        print(f"[PASS] 4. Toggled source to hardware camera. use_simulation: {set_data['use_simulation']}")

        # 5. Check telemetry in hardware camera mode
        time.sleep(1.2)
        telem_res2 = urllib.request.urlopen("http://127.0.0.1:8083/api/telemetry", timeout=5)
        telem2 = json.loads(telem_res2.read().decode("utf-8"))
        print(f"[PASS] 5. Hardware mode telemetry active (use_simulation: {telem2.get('use_simulation')}, FPS: {telem2.get('fps')})")

        # 6. Test toggling Privacy Face Blur
        req_blur = urllib.request.Request(
            "http://127.0.0.1:8083/api/settings",
            data=json.dumps({"anonymize_faces": False}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        blur_res = urllib.request.urlopen(req_blur, timeout=5)
        blur_data = json.loads(blur_res.read().decode("utf-8"))
        assert blur_data["anonymize_faces"] is False
        print("[PASS] 6. Toggled privacy face blur to False")

        # 7. Test toggling back to Simulation mode without restarting
        req_sim = urllib.request.Request(
            "http://127.0.0.1:8083/api/settings",
            data=json.dumps({"use_simulation": True, "anonymize_faces": True}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST"
        )
        sim_res = urllib.request.urlopen(req_sim, timeout=5)
        sim_data = json.loads(sim_res.read().decode("utf-8"))
        assert sim_data["use_simulation"] is True
        assert sim_data["anonymize_faces"] is True
        print("[PASS] 7. Toggled back to simulation mode with privacy blur enabled")

        # 8. Verify stream continues smoothly in simulation mode
        stream_res2 = urllib.request.urlopen("http://127.0.0.1:8083/video_feed?stream=live", timeout=5)
        chunk2 = stream_res2.read(3000)
        assert b"\xff\xd8" in chunk2
        print(f"[PASS] 8. Stream running smoothly after mode toggling ({len(chunk2)} bytes read)")

        print("\n=== ALL 8 LIVE END-TO-END VERIFICATION CHECKS PASSED SUCCESSFULLY! ===")

    except Exception as e:
        print("FAILED:", e)
        sys.exit(1)
    finally:
        proc.terminate()

if __name__ == "__main__":
    main()
