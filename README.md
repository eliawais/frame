# Frame (personal watch-party beta)

A lightweight static web app, using WebRTC via PeerJS Cloud for signaling. No account or billing needed for the prototype. The host stays online and relays room state over data channels; media is peer to peer. Maximum six participants, including host. No database, storage or recording of calls/messages. Anyone who has the unguessable invitation can join. Keep it private. This is not audited or production hardened.

## Publish on GitHub Pages
1. Create a public repository called `frame` in your GitHub account (initialize with a README if using the web UI).
2. Upload **the files inside this folder**, not the folder itself, to the repository root, replacing the initial README if desired. Commit to `main`.
3. Settings > Pages > Build and deployment > Deploy from a branch > main > / (root) > Save. Wait for GitHub to report successful deployment and use the published URL displayed there. HTTPS is required for media permissions.
4. Open the site on two devices on different networks. Create a room, copy the invitation, join, allow microphone/camera, send messages, and try desktop tab sharing with audio. Test before relying on it for a movie night.

## Use
- Enter a nickname and create a room, or open an invitation. New room codes are 16 random base32 characters (80 bits); optionally add a custom name, e.g. `#movie-night.4q8h2m6t9x7p3w5k`. The name is cosmetic; the random code is required to join. Copied invitations exclude tracking parameters. Legacy 32-character codes are accepted. The original host must keep the room open.
- Turn on mic/camera independently. Use headphones to avoid echo. Adjust each guest's volume with their tile slider, and movie volume independently.
- For external sites, share a browser tab in desktop Chrome/Edge and check Share tab audio. For a direct public HTTPS video file, the host can paste the URL and control playback for everyone. Direct video links must be playable by each browser. Local files are not uploaded. Choose Local video in the room, select a supported MP4 or WebM, and play it in the main stage. Guests receive the captured video and audio via WebRTC; capture support varies. Use desktop Chrome or Edge first.
- No DRM bypass, no cloud browser, no YouTube-specific sync, no games in this build. Mobile viewing/calling depends on browser permissions; mobile screen sharing is generally unavailable. Install the Android PWA from Chrome using Install app or Add to Home screen. No native APK is provided. Android sending of local or screen video depends on capture API availability; receiving and calling require testing.
- Free public PeerJS signaling and the default STUN and TURN servers are best effort. Apply a private TURN configuration before entering a room to use a dedicated relay. Some networks may fail to establish connections. At six people, host upload and device resources can become bottlenecks. Rejoin after disconnects. A live cross-network test is required. Room links are bearer secrets; the public repo/site contains no room secrets.

## Browser mode and guest permissions
- Browser mode loads compatible external HTTPS pages in sandboxed iframes. The room host controls the shared address by default; the host can grant all guests browser interaction and shared URL navigation. Each participant has an independent iframe; clicks and in-page playback cannot be synchronized across third-party websites. Some sites disallow embedding or require permissions not granted by the sandbox. There is no proxy, DRM bypass, remote browser, or remote mouse control. Use regular screen sharing for a shared view of content you have permission to watch.
- The host can enable or revoke guest play/pause for direct videos and in-room local video streams. The host validates requests; local video commands are relayed to the participant sharing the file. Screen sharing and arbitrary iframe playback cannot be remotely controlled. Guest permissions default off and reset for each new room. Refresh all devices to the same version before joining.
- The host must stay connected, and the local video sender's browser may require an interaction to resume playback.

## Cross-network connectivity (0.5)
- Frame uses direct ICE connections when possible and the documented PeerJS public TURN fallback. Media calls retry on ICE failure; the stage displays connection and autoplay errors, with a retry button. Network shows selected direct/relay candidate types when browser statistics are available.
- For a reliable fallback, provision a TURN provider with UDP and TCP/TLS (port 443) support. Generate temporary ICE server credentials on the provider's trusted backend; paste only the returned ICE server array into Network on each device before joining. Settings are per browser tab, not shared in URLs or committed. Never enter account API keys or master secrets. Both participants may use separate valid credentials. A private configuration uses the plan and quota of the account that issued the credentials.
- Test on different networks (e.g. Wi-Fi and mobile data). Join, send a message, enable mic and stream a local video. Check Network; if media fails with the public relay, configure a dedicated provider. Browser embedding restrictions are separate from WebRTC connectivity.

## Voice compatibility (0.6)
- Standard voice uses independent remote audio elements rather than the camera tile; voice status reports expected remote mic streams and autoplay blocks. Click Enable sound if required. The mic is off until explicitly enabled.
- If standard voice is silent but room chat works, the host can enable Voice compatibility. Both devices should tap Enable sound if shown and turn on their mics. This alternative sends low-rate mono 16 kHz PCM through the existing encrypted WebRTC data channels, relayed by the room host. No recording or storage is added. The host can hear/process room audio as a participant; this is not end-to-end encrypted against the host. It is intended as a best-effort fallback for small rooms, may add latency or drop audio under congestion, and does not repair failed data connections. The sender's browser must support Web Audio; ScriptProcessor is deprecated but supported by many current browsers. The mode is off by default.
- A dedicated TURN relay remains necessary if both the data channel and media connections fail. Test between different networks before relying on either mode.

## Metered TURN and relay testing
- In Metered, open the dedicated TURN credential and select **Show ICE Servers Array**. In Frame, open **Network**, paste just the JSON array, and choose **Apply for next room**. Use this on each browser tab that should use Metered. Keep Metered account and project API keys out of Frame, the repository, and invitations. Prefer expiring credentials for regular use.
- With a private TURN array applied, Frame uses only the ICE servers in that array. Metered's array includes STUN for direct connections and TURN with UDP, TCP and TLS options for relay when needed. Without private settings, Frame uses the public defaults.
- For a connectivity check, enable **Relay only for the next room** before joining. Use Wi-Fi for one device and cellular data for the other. Check **Network** for the room, voice/camera and shared-video paths while testing both directions of voice and camera and one shared video. The status **via configured TURN** confirms a selected relay path through the configured provider. Turn relay-only mode off for normal use to conserve relay data.
- Settings last for the browser tab and are applied on room entry. Use **Use default** to clear them. A room invitation does not transfer TURN settings. Automatic guest provisioning would require a trusted credential service outside GitHub Pages.

## Local development
Run `python -m http.server 8000` in this folder and visit `http://localhost:8000`. Requires internet for PeerJS CDN/signaling. No npm build required.
