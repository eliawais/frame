const sessionCookie = "__Host-erev-session";
const stateCookie = "__Host-erev-oauth";
const day = 86_400_000;
const invitePattern = /^(?:[a-z0-9-]{1,24}\.)?(?:[a-f0-9]{32}|[0-9a-hjkmnp-tv-z]{16})$/;
const opaquePattern = /^[A-Za-z0-9_-]{43}$/;

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function randomToken() {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}

async function digest(value) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function readCookie(request, name) {
  const item = (request.headers.get("Cookie") || "").split(";").find(value => value.trimStart().startsWith(name + "="));
  const value = item?.trim().slice(name.length + 1) || "";
  return opaquePattern.test(value) ? value : "";
}

function cookie(name, value, age) {
  return name + "=" + value + "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=" + age;
}

function headers(type) {
  return new Headers({
    "Content-Type": type,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
  });
}

function redirect(path, cookies = []) {
  const out = headers("text/plain; charset=utf-8");
  out.set("Location", path);
  for (const value of cookies) out.append("Set-Cookie", value);
  return new Response(null, { status: 303, headers: out });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: headers("application/json; charset=utf-8") });
}

function escape(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[char]);
}

function page(title, body, status = 200) {
  const out = headers("text/html; charset=utf-8");
  out.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
  return new Response(
    '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
    escape(title) + ' | Erev</title><link rel="icon" href="/icon.svg"><style>' +
    ':root{color-scheme:dark;background:#141515;color:#f5eedc;font:16px system-ui,sans-serif}body{margin:0}main{max-width:48rem;margin:12vh auto;padding:2rem}' +
    'a{color:#c4e972}header{display:flex;align-items:center;gap:.55rem;font-size:1.5rem;font-weight:800}header img{width:2rem;height:2rem}h1{margin:1.25rem 0 .5rem;font-size:clamp(2rem,5vw,3rem)}p{color:#c8c9c0;line-height:1.55}' +
    'button,.button{display:inline-block;background:#c4e972;color:#18200d;border:0;border-radius:.55rem;font:inherit;font-weight:700;padding:.65rem .8rem;cursor:pointer;text-decoration:none}button.secondary{background:#30332d;color:#f5eedc}' +
    'table{width:100%;border-collapse:collapse;margin:1.3rem 0}th,td{padding:.6rem .35rem;text-align:left;border-bottom:1px solid #383b33;overflow-wrap:anywhere}td form{display:inline-block;margin:.18rem 0}small{color:#c8c9c0}@media(max-width:560px){main{margin-top:6vh;padding:1rem}th,td{font-size:.82rem}}</style>' +
    '<main><header><img src="/icon.svg" alt="">erev.</header><h1>' + escape(title) + "</h1>" + body + "</main></html>",
    { status, headers: out }
  );
}

const logoutForm = '<form action="/auth/logout" method="post"><button class="secondary">Sign out</button></form>';
const signInForm = '<a class="button" id="google-sign-in" href="/auth/google">Continue with Google</a><script src="/beta-invite.js" defer></script>';

function signInPage(configured, error = false) {
  return page("Request access to Erev", '<p>Movie nights for friends, wherever you are. Erev is an approval-only beta.</p>' +
    (configured ? (error ? '<p>Google sign-in didn’t finish. Try again.</p>' : '') + signInForm :
      '<p>Signups will open once Google sign-in is set up.</p><script src="/beta-invite.js" defer></script>'));
}

function accountStatus(user) {
  const text = {
    pending: ["Waiting for approval", "Your request is in the queue. You can return here to check its status."],
    declined: ["Access declined", "Your request was declined."],
    revoked: ["Access revoked", "This account no longer has access to the beta."],
  }[user.status];
  return page(text[0], "<p>" + text[1] + "</p><p>Signed in as " + escape(user.email) + ".</p>" + logoutForm);
}

async function currentUser(request, db) {
  const token = readCookie(request, sessionCookie);
  if (!token) return null;
  return db.prepare(
    "SELECT users.* FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?"
  ).bind(await digest(token), Date.now()).first();
}

function isAdmin(user, env) {
  if (!user || user.status !== "approved") return false;
  return user.email.toLowerCase() === env.ADMIN_EMAIL?.toLowerCase();
}

async function googleStart(url, env) {
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) return signInPage(false);
  const now = Date.now();
  const state = randomToken();
  const verifier = randomToken();
  const value = url.searchParams.get("invite") || "";
  const invite = invitePattern.test(value) ? value : "";
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sign_in_attempts WHERE expires_at <= ?").bind(now),
    env.DB.prepare("INSERT INTO sign_in_attempts (state_hash, verifier, invite, expires_at) VALUES (?, ?, ?, ?)")
      .bind(await digest(state), verifier, invite, now + 600_000),
  ]);
  const query = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: env.PUBLIC_ORIGIN + "/auth/google/callback",
    response_type: "code",
    scope: "openid email profile",
    code_challenge: await digest(verifier),
    code_challenge_method: "S256",
    state,
  });
  return redirect("https://accounts.google.com/o/oauth2/v2/auth?" + query, [cookie(stateCookie, state, 600)]);
}

async function googleCallback(request, url, env) {
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const clear = cookie(stateCookie, "", 0);
  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET || !code ||
      code.length > 2048 || !state || state !== readCookie(request, stateCookie)) return redirect("/?sign-in-error=1", [clear]);
  const now = Date.now();
  const attempt = await env.DB.prepare(
    "DELETE FROM sign_in_attempts WHERE state_hash = ? AND expires_at > ? RETURNING verifier, invite"
  ).bind(await digest(state), now).first();
  if (!attempt) return redirect("/?sign-in-error=1", [clear]);
  const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      code_verifier: attempt.verifier,
      grant_type: "authorization_code",
      redirect_uri: env.PUBLIC_ORIGIN + "/auth/google/callback",
    }),
  });
  if (!tokenResponse.ok) return redirect("/?sign-in-error=1", [clear]);
  const token = await tokenResponse.json();
  if (typeof token.access_token !== "string" || !token.access_token) return redirect("/?sign-in-error=1", [clear]);
  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: "Bearer " + token.access_token },
  });
  if (!profileResponse.ok) return redirect("/?sign-in-error=1", [clear]);
  const profile = await profileResponse.json();
  if (typeof profile.sub !== "string" || !profile.sub || profile.sub.length > 255 ||
      profile.email_verified !== true || typeof profile.email !== "string" || profile.email.length > 254) {
    return redirect("/?sign-in-error=1", [clear]);
  }
  const email = profile.email.toLowerCase();
  const label = (typeof profile.name === "string" ? profile.name.trim() : "").slice(0, 80) || email;
  const admin = email.endsWith("@gmail.com") && email === env.ADMIN_EMAIL?.toLowerCase();
  const session = randomToken();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, email, name, status, created_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name, " +
      "status=CASE WHEN excluded.status='approved' THEN 'approved' ELSE users.status END"
    ).bind(profile.sub, email, label, admin ? "approved" : "pending", now),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(await digest(session), profile.sub, now + 7 * day),
  ]);
  return redirect("/" + (attempt.invite ? "#" + attempt.invite : ""), [clear, cookie(sessionCookie, session, 7 * 86400)]);
}

async function adminPage(env, notice) {
  const result = await env.DB.prepare(
    "SELECT users.id, users.email, users.name, users.status, approval_emails.sent_at " +
    "FROM users LEFT JOIN approval_emails ON users.approval_id = approval_emails.id " +
    "WHERE users.email <> ? ORDER BY CASE users.status WHEN 'pending' THEN 0 ELSE 1 END, users.created_at DESC LIMIT 200"
  ).bind(env.ADMIN_EMAIL.toLowerCase()).all();
  const message = {
    sent: "Approval saved and the email was accepted by Resend.",
    unsent: "Approval saved. The email has not been sent. Check the sender configuration and retry.",
    saved: "Access updated.",
  }[notice];
  const rows = result.results.map(user => {
    const actions = user.status === "approved" ? ["Revoke", ...(!user.sent_at ? ["Retry email"] : [])] :
      user.status === "pending" ? ["Approve", "Decline"] : ["Approve"];
    const buttons = actions.map(action =>
      '<form action="/admin/access" method="post"><input type="hidden" name="user" value="' + escape(user.id) +
      '"><button name="action" value="' + action + '"' + (action === "Approve" ? "" : ' class="secondary"') + ">" +
      action + "</button></form>"
    ).join(" ");
    return "<tr><td>" + escape(user.name) + "<br><small>" + escape(user.email) + "</small></td><td>" + escape(user.status) +
      (user.status === "approved" ? "<br><small>" + (user.sent_at ? "Email sent" : "Email pending") + "</small>" : "") +
      "</td><td>" + buttons + "</td></tr>";
  }).join("");
  return page("Beta access", '<p><a href="/">Open Erev</a></p>' + (message ? '<p role="status">' + message + "</p>" : "") +
    (rows ? '<table><thead><tr><th scope="col">Account</th><th scope="col">Status</th><th scope="col">Actions</th></tr></thead><tbody>' +
      rows + "</tbody></table>" : "<p>No access requests yet.</p>") + logoutForm);
}

async function sendApproval(env, userId) {
  if (!env.RESEND_API_KEY || !env.RESEND_FROM) return false;
  const item = await env.DB.prepare(
    "SELECT approval_emails.* FROM users JOIN approval_emails ON users.approval_id=approval_emails.id " +
    "WHERE users.id=? AND users.status='approved' AND users.email=approval_emails.email"
  ).bind(userId).first();
  if (!item || item.sent_at) return Boolean(item?.sent_at);
  const now = Date.now();
  if (item.first_attempt_at && now - item.first_attempt_at > 23 * 60 * 60_000) return false;
  await env.DB.prepare("UPDATE approval_emails SET first_attempt_at=COALESCE(first_attempt_at,?) WHERE id=?")
    .bind(now, item.id).run();
  let response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.RESEND_API_KEY,
        "Content-Type": "application/json",
        "Idempotency-Key": "erev-approval/" + item.id,
      },
      body: JSON.stringify({
        from: env.RESEND_FROM,
        to: [item.email],
        subject: "Your Erev access is approved",
        text: "You’re approved to join the Erev beta.\n\nOpen " + env.PUBLIC_ORIGIN +
          "/ and sign in with the same Google account to create or join a room.\n\nSee you at movie night,\nErev",
      }),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  const sent = await response.json();
  await env.DB.prepare("UPDATE approval_emails SET sent_at=?, provider_id=? WHERE id=?")
    .bind(Date.now(), sent.id || null, item.id).run();
  return true;
}

async function changeAccess(request, env, admin) {
  const form = await request.formData();
  const userId = form.get("user");
  const action = form.get("action");
  if (typeof userId !== "string" || !userId || userId.length > 255 || userId === admin.id) {
    return json({ error: "Invalid account" }, 400);
  }
  if (action === "Approve") {
    const id = crypto.randomUUID();
    const now = Date.now();
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET status='approved', approval_id=? WHERE id=? AND status <> 'approved'").bind(id, userId),
      env.DB.prepare(
        "INSERT INTO approval_emails (id,user_id,email,created_at) SELECT approval_id,id,email,? FROM users WHERE id=? AND approval_id=?"
      ).bind(now, userId, id),
    ]);
  } else if (action === "Decline" || action === "Revoke") {
    const before = action === "Decline" ? "pending" : "approved";
    const after = action === "Decline" ? "declined" : "revoked";
    await env.DB.prepare("UPDATE users SET status=?, approval_id=NULL WHERE id=? AND status=?").bind(after, userId, before).run();
    return redirect("/admin?done=saved");
  } else if (action !== "Retry email") {
    return json({ error: "Invalid action" }, 400);
  }
  return redirect("/admin?done=" + ((await sendApproval(env, userId)) ? "sent" : "unsent"));
}

async function roomAccess(request, env) {
  const { action, code } = await request.json();
  if (typeof code !== "string" || !invitePattern.test(code) || code.includes(".")) {
    return json({ error: "Invalid room code" }, 400);
  }
  const now = Date.now();
  if (action === "create") {
    const signalingCode = crypto.randomUUID().replaceAll("-", "");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM rooms WHERE expires_at <= ?").bind(now),
      env.DB.prepare("INSERT OR IGNORE INTO rooms(invite_code, signaling_code, expires_at) VALUES(?, ?, ?)").bind(code, signalingCode, now + 7 * day),
    ]);
    const room = await env.DB.prepare("SELECT signaling_code FROM rooms WHERE invite_code=?").bind(code).first();
    if (room?.signaling_code !== signalingCode) return json({ error: "Try creating the room again." }, 409);
    return json({ signalingCode });
  }
  if (action !== "join") return json({ error: "Invalid room action" }, 400);
  const room = await env.DB.prepare("SELECT signaling_code FROM rooms WHERE invite_code=? AND expires_at > ?").bind(code, now).first();
  return room ? json({ signalingCode: room.signaling_code }) : json({ error: "Room not found. Ask the host for a current invite." }, 404);
}

const browserHelper = "const link=document.getElementById('google-sign-in');const invite=location.hash.slice(1)||new URL(location.href).searchParams.get('room');if(link&&invite)link.search=new URLSearchParams({invite});if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).catch(()=>{});";
const publicAssets = new Set(["/icon.svg", "/icon-maskable.svg", "/sw.js", "/manifest.webmanifest"]);

export function handler(files) {
  return {
    async fetch(request, env) {
      try {
        const url = new URL(request.url);
        const { pathname: path } = url;
        const origin = env.PUBLIC_ORIGIN;
        const method = request.method;
        if (!origin) return page("Erev beta", "<p>Signups are being set up.</p>", 503);
        if (url.origin !== origin) return redirect(origin + "/" + (url.searchParams.has("room") ?
          "?room=" + encodeURIComponent(url.searchParams.get("room")) : ""));
        if (!["GET", "HEAD", "POST"].includes(method)) return json({ error: "Method not allowed" }, 405);
        const length = Number(request.headers.get("Content-Length") || 0);
        if (method === "POST" &&
            (request.headers.get("Origin") !== origin || request.headers.get("Sec-Fetch-Site") === "cross-site")) {
          return json({ error: "Forbidden" }, 403);
        }
        if (method === "POST" && length > 4096) return json({ error: "Request too large" }, 413);
        if (method !== "POST" && path === "/beta-invite.js") {
          return new Response(browserHelper, { headers: headers("text/javascript; charset=utf-8") });
        }
        const asset = files.get(path === "/" ? "/index.html" : path);
        if (asset && method !== "POST" && publicAssets.has(path)) {
          return new Response(method === "HEAD" ? null : asset[1], { headers: headers(asset[0]) });
        }
        if (!env.DB) return page("Erev beta", "<p>Signups are being set up.</p>", 503);
        if (method === "GET" && path === "/auth/google") return await googleStart(url, env);
        if (method === "GET" && path === "/auth/google/callback") return await googleCallback(request, url, env);
        if (method === "POST" && path === "/auth/logout") {
          const token = readCookie(request, sessionCookie);
          if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash=?").bind(await digest(token)).run();
          return redirect("/", [cookie(sessionCookie, "", 0)]);
        }
        const user = await currentUser(request, env.DB);
        if (path === "/account" && method === "GET") {
          if (!user) return redirect("/");
          return page("Your account", "<p>Signed in as " + escape(user.email) + '.</p><p><a href="/">Open Erev</a>' +
            (isAdmin(user, env) ? ' · <a href="/admin">Manage beta access</a>' : "") + "</p>" + logoutForm);
        }
        if (path === "/admin" || path === "/admin/access") {
          if (!isAdmin(user, env)) return json({ error: "Forbidden" }, 403);
          if (path === "/admin" && method === "GET") return await adminPage(env, url.searchParams.get("done"));
          if (path === "/admin/access" && method === "POST") return await changeAccess(request, env, user);
        }
        if (path.startsWith("/api/")) {
          if (!user) return json({ error: "Sign in to use Erev." }, 401);
          if (user.status !== "approved") return json({ error: "This account needs approval." }, 403);
          if (path === "/api/me" && method === "GET") return json({ name: user.name, admin: isAdmin(user, env) });
          if (path === "/api/rooms" && method === "POST") {
            if (!(request.headers.get("Content-Type") || "").startsWith("application/json")) return json({ error: "JSON required" }, 415);
            return await roomAccess(request, env);
          }
          return json({ error: "Not found" }, 404);
        }
        if (method === "POST") return json({ error: "Not found" }, 404);
        if (path === "/" || path === "/index.html") {
          if (!user) return signInPage(Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), url.searchParams.has("sign-in-error"));
          if (user.status !== "approved") return accountStatus(user);
        }
        if (!asset) return json({ error: "Not found" }, 404);
        if (!user || user.status !== "approved") return json({ error: "Forbidden" }, 403);
        const h = headers(asset[0]);
        if (path === "/" || path === "/index.html") h.set("X-Frame-Options", "DENY");
        return new Response(method === "HEAD" ? null : asset[1], { headers: h });
      } catch (error) {
        console.error("Erev request failed", { name: error?.name || "Error" });
        return json({ error: "Erev is temporarily unavailable. Try again." }, 503);
      }
    },
  };
}
