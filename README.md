# Frame (personal watch-party beta)

A lightweight static web app, using WebRTC via PeerJS Cloud for signaling. No account or billing needed for the prototype. The host stays online and relays room state over data channels; media is peer to peer. Maximum six participants, including host. No database, storage or recording of calls/messages. Anyone who has the unguessable invitation can join. Keep it private. This is not audited or production hardened.

## Publish on GitHub Pages
1. Create a public repository called `frame` in your GitHub account (initialize with a README if using the web UI).
2. Upload **the files inside this folder**, not the folder itself, to the repository root, replacing the initial README if desired. Commit to `main`.
3. Settings > Pages > Build and deployment > Deploy from a branch > main > / (root) > Save. Wait for GitHub to report successful deployment and use the published URL displayed there. HTTPS is required for media permissions.
4. Open the site on two devices on different networks. Create a room, copy the invitation, join, allow microphone/camera, send messages, and try desktop tab sharing with audio. Test before relying on it for a movie night.

## Use
- Enter a nickname and create a room, or open an invitation. The original host must keep the room open.
- Turn on mic/camera independently. Use headphones to avoid echo. Adjust each guest's volume with their tile slider, and movie volume independently.
- For external sites, share a browser tab in desktop Chrome/Edge and check Share tab audio. For a direct public HTTPS video file, the host can paste the URL and control playback for everyone. Direct video links must be playable by each browser. Local files are not uploaded. Choose Local video in the room, select a supported MP4 or WebM, and play it in the main stage. Guests receive the captured video and audio via WebRTC; capture support varies. Use desktop Chrome or Edge first.
- No DRM bypass, no cloud browser, no YouTube-specific sync, no games in this build. Mobile viewing/calling depends on browser permissions; mobile screen sharing is generally unavailable. Install the Android PWA from Chrome using Install app or Add to Home screen. No native APK is provided. Android sending of local or screen video depends on capture API availability; receiving and calling require testing.
- Free public PeerJS signaling and STUN are best effort. There is no configured TURN relay; some networks may fail to establish connections. At six people, host upload and device resources can become bottlenecks. Rejoin after disconnects. A live cross-network test is required. Room links are bearer secrets; the public repo/site contains no room secrets.

## Local development
Run `python -m http.server 8000` in this folder and visit `http://localhost:8000`. Requires internet for PeerJS CDN/signaling. No npm build required.
