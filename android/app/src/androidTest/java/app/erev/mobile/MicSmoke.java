package app.erev.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.os.SystemClock;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;

import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;

public final class MicSmoke extends Instrumentation {
    private static final String PAGE = """
        <!doctype html><title>Erev microphone test</title>
        <script>
        window.result = 'waiting';
        async function test() {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}
          });
          const track = stream.getAudioTracks()[0];
          if (!track || !track.enabled || track.readyState !== 'live') throw Error('No live microphone');
          const send = new RTCPeerConnection();
          const receive = new RTCPeerConnection();
          const remote = new Promise(resolve => receive.ontrack = event => resolve(event.track));
          const complete = async (pc, description) => {
            await pc.setLocalDescription(description);
            while (pc.iceGatheringState !== 'complete') await new Promise(r => setTimeout(r, 50));
            return pc.localDescription;
          };
          try {
            send.addTrack(track, stream);
            await receive.setRemoteDescription(await complete(send, await send.createOffer()));
            await send.setRemoteDescription(await complete(receive, await receive.createAnswer()));
            if ((await remote).kind !== 'audio') throw Error('Peer received the wrong track');
            for (let checks = 0; checks < 120; checks++) {
              const stats = await receive.getStats();
              if ([...stats.values()].some(s => s.type === 'inbound-rtp' && s.kind === 'audio' && s.packetsReceived > 0)) {
                window.result = 'mic-and-rtp-ok';
                return;
              }
              await new Promise(r => setTimeout(r, 100));
            }
            throw Error('Peer did not receive microphone RTP packets');
          } finally {
            track.stop();
            send.close();
            receive.close();
          }
        }
        window.addEventListener('load', () => test().catch(error => {
          window.result = error.name + ': ' + error.message;
        }));
        </script>
        """;

    @Override public void onCreate(Bundle args) {
        super.onCreate(args);
        start();
    }

    @Override public void onStart() {
        Bundle result = new Bundle();
        Activity activity = null;
        try {
            if (getTargetContext().checkSelfPermission(Manifest.permission.MODIFY_AUDIO_SETTINGS) != PackageManager.PERMISSION_GRANTED) {
                throw new AssertionError("Android audio routing permission is missing");
            }
            Intent launch = new Intent().setClassName("app.erev.mobile", "app.erev.mobile.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            activity = startActivitySync(launch);
            WebView web = findWebView(activity.getWindow().getDecorView());
            if (web == null) throw new AssertionError("Erev WebView not found");
            waitForIdleSync();
            runOnMainSync(() -> web.loadDataWithBaseURL("https://erev.pages.dev/", PAGE, "text/html", "utf-8", null));
            long deadline = SystemClock.elapsedRealtime() + 40_000;
            String value = "null";
            while (SystemClock.elapsedRealtime() < deadline) {
                ArrayBlockingQueue<String> pending = new ArrayBlockingQueue<>(1);
                runOnMainSync(() -> web.evaluateJavascript("window.result", pending::offer));
                value = pending.poll(2, TimeUnit.SECONDS);
                if (value != null && !value.equals("null") && !value.equals("\"waiting\"")) break;
                SystemClock.sleep(250);
            }
            if (!"\"mic-and-rtp-ok\"".equals(value)) throw new AssertionError("Microphone test: " + value);
            result.putString("result", "mic-and-rtp-ok");
            finish(Activity.RESULT_OK, result);
        } catch (Exception | AssertionError error) {
            result.putString("error", error.toString());
            finish(Activity.RESULT_CANCELED, result);
        } finally {
            if (activity != null) {
                Activity launched = activity;
                runOnMainSync(launched::finish);
            }
        }
    }

    private static WebView findWebView(View view) {
        if (view instanceof WebView web) return web;
        if (view instanceof ViewGroup group) {
            for (int index = 0; index < group.getChildCount(); index++) {
                WebView web = findWebView(group.getChildAt(index));
                if (web != null) return web;
            }
        }
        return null;
    }
}
