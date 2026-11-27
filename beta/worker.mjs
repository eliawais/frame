const sessionCookie = "__Host-erev-session";
const stateCookie = "__Host-erev-oauth";
const day = 86_400_000;
const invitePattern = /^(?:[a-z0-9-]{1,24}\.)?(?:[a-f0-9]{32}|[0-9a-hjkmnp-tv-z]{16})$/;
const opaquePattern = /^[A-Za-z0-9_-]{43}$/;
const peerPattern = /^erev-beta-v2-[a-f0-9]{32}$/;
const roomLease = 60_000;
const activeMembers = "FROM room_members m JOIN sessions s ON s.token_hash=m.session_hash " +
  "JOIN users u ON u.id=s.user_id WHERE m.room_id=? AND m.expires_at>? AND s.expires_at>? AND u.status='approved'";

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
    'button,.button{display:inline-block;background:#c4e972;color:#18200d;border:0;border-radius:.55rem;font:inherit;font-weight:700;padding:.65rem .8rem;cursor:pointer;text-decoration:none}button.secondary{background:#30332d;color:#f5eedc}label[for=email-address]{display:block;margin-bottom:.4rem}input[type=email]{border:1px solid #555b4c;border-radius:.55rem;padding:.65rem .8rem;font:inherit;margin:0 .45rem .65rem 0;max-width:90%}' +
    'table{width:100%;border-collapse:collapse;margin:1.3rem 0}th,td{padding:.6rem .35rem;text-align:left;border-bottom:1px solid #383b33;overflow-wrap:anywhere;vertical-align:top}td form{display:inline-block;margin:.18rem 0}small{color:#c8c9c0}' +
    '.account-details{margin:.5rem 0 0;font-size:.82em;color:#c8c9c0}.account-details div{margin:.2rem 0}.account-details dt,.account-details dd{display:inline;margin:0}.account-details dt{font-weight:650;margin-right:.35rem}' +
    '@media(max-width:560px){main{margin-top:6vh;padding:1rem}th,td{font-size:.82rem}}</style>' +
    '<main><header><img src="/icon.svg" alt="">erev.</header><h1>' + escape(title) + "</h1>" + body + "</main></html>",
    { status, headers: out }
  );
}

const logoutForm = '<form action="/auth/logout" method="post"><button class="secondary">Sign out</button></form>';
const googleForm = '<a class="button" id="google-sign-in" href="/auth/google">Continue with Google</a>';
const emailForm = '<form action="/auth/email" method="post"><label for="email-address">Email address</label>' +
  '<input type="email" id="email-address" name="email" autocomplete="email" maxlength="254" required>' +
  '<input type="hidden" name="invite" id="email-invite"><button>Send sign-in link</button></form>';
const browserScript = '<script src="/beta-invite.js" defer></script>';

function emailConfigured(env) {
  return Boolean(env.RESEND_API_KEY && env.RESEND_FROM);
}

function googleConfigured(env) {
  return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
}

function signInPage(env, error = false) {
  const email = emailConfigured(env);
  const google = googleConfigured(env);
  return page("Request access to Erev", '<p>Movie nights for friends, wherever you are. Erev is an approval-only beta.</p>' +
    (error ? '<p>Sign-in didn’t finish. Try again.</p>' : "") +
    (email ? emailForm : "") + (google ? googleForm : "") +
    (!email && !google ? '<p>Signups will open once sign-in is set up.</p>' : "") + browserScript);
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
    "SELECT users.*, sessions.token_hash AS session_hash FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ? AND sessions.expires_at > ?"
  ).bind(await digest(token), Date.now()).first();
}

function isAdmin(user, env) {
  if (!user || user.status !== "approved") return false;
  return user.email.toLowerCase() === env.ADMIN_EMAIL?.toLowerCase();
}

function adminSignInPage(user, env) {
  const intro = user
    ? "<p>You’re signed in as " + escape(user.email) + ". To manage the beta, switch to your Erev admin account.</p>"
    : "<p>Sign in with your Erev admin account to manage beta access.</p>";
  const action = googleConfigured(env)
    ? '<p><a class="button" href="/auth/google?next=admin">Choose Google account</a></p>'
    : "";
  return page(user ? "Admin access required" : "Sign in to manage Erev",
    intro + action + '<p><a href="/">Back to Erev</a></p>', user ? 403 : 401);
}

async function googleStart(request, url, env) {
  if (!googleConfigured(env)) return signInPage(env);
  const now = Date.now();
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!await takeSendSlot(env.DB, "google-ip:" + await digest(ip), 600_000, 20, now) ||
      !await takeSendSlot(env.DB, "google-daily", day, 2000, now)) {
    return page("Try signing in later", '<p>Too many sign-in attempts. <a href="/">Return to Erev</a>.</p>', 429);
  }
  const state = randomToken();
  const verifier = randomToken();
  const value = url.searchParams.get("invite") || "";
  const adminRequested = url.searchParams.get("next") === "admin";
  const invite = adminRequested ? "/admin" : (invitePattern.test(value) ? value : "");
  await env.DB.batch([
    env.DB.prepare("DELETE FROM email_rate_limits WHERE expires_at <= ?").bind(now),
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
  if (adminRequested) query.set("prompt", "select_account");
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
  return await startSession(env, { id: profile.sub, email, label, admin, invite: attempt.invite }, [clear]);
}

async function startSession(env, { id, email, label, admin, invite }, cookies = []) {
  const now = Date.now();
  const session = randomToken();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO users (id, email, name, status, created_at) VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(id) DO UPDATE SET email=excluded.email, name=excluded.name, " +
      "status=CASE WHEN excluded.status='approved' THEN 'approved' ELSE users.status END"
    ).bind(id, email, label, admin ? "approved" : "pending", now),
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now),
    env.DB.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
      .bind(await digest(session), id, now + 7 * day),
  ]);
  const destination = invite === "/admin" ? "/admin" : "/" + (invite ? "#" + invite : "");
  return redirect(destination, [...cookies, cookie(sessionCookie, session, 7 * 86400)]);
}

async function sendEmail(env, { to, subject, text, key }) {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      redirect: "error",
      headers: {
        Authorization: "Bearer " + env.RESEND_API_KEY,
        "Content-Type": "application/json",
        "Idempotency-Key": key,
      },
      body: JSON.stringify({ from: env.RESEND_FROM, to: [to], subject, text }),
    });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
}

async function takeSendSlot(db, bucket, window, limit, now) {
  const start = Math.floor(now / window) * window;
  return db.prepare(
    "INSERT INTO email_rate_limits (bucket, count, expires_at) VALUES (?, 1, ?) " +
    "ON CONFLICT(bucket) DO UPDATE SET count=count+1 WHERE count < ? RETURNING count"
  ).bind(bucket + ":" + start, start + window, limit).first();
}

async function emailStart(request, env) {
  if (!emailConfigured(env)) return signInPage(env);
  const form = await request.formData();
  const address = form.get("email");
  const email = typeof address === "string" ? address.trim().toLowerCase() : "";
  if (email.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(email)) {
    return page("Check your email address", '<p><a href="/">Try again</a></p>', 400);
  }
  const invite = form.get("invite");
  const now = Date.now();
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!await takeSendSlot(env.DB, "email:" + await digest(email), 3_600_000, 3, now) ||
      !await takeSendSlot(env.DB, "ip:" + await digest(ip), 3_600_000, 12, now) ||
      !await takeSendSlot(env.DB, "daily", day, 60, now)) {
    return page("Try again later", '<p>Sign-in links are temporarily limited. <a href="/">Return to Erev</a>.</p>', 429);
  }
  const token = randomToken();
  const hash = await digest(token);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM email_rate_limits WHERE expires_at <= ?").bind(now),
    env.DB.prepare("DELETE FROM email_challenges WHERE expires_at <= ?").bind(now),
    env.DB.prepare("INSERT INTO email_challenges (token_hash, email, invite, expires_at) VALUES (?, ?, ?, ?)")
      .bind(hash, email, typeof invite === "string" && invitePattern.test(invite) ? invite : "", now + 900_000),
  ]);
  const sent = await sendEmail(env, {
    to: email,
    subject: "Your Erev sign-in link",
    text: "Sign in to the Erev beta:\n\n" + env.PUBLIC_ORIGIN + "/auth/email/verify#" + token +
      "\n\nThis single-use link expires in 15 minutes. If you didn’t request it, you can ignore this email.",
    key: "erev-sign-in/" + hash,
  });
  if (!sent) {
    await env.DB.prepare("DELETE FROM email_challenges WHERE token_hash=?").bind(hash).run();
    return page("Email couldn't be sent", '<p>Try again in a few minutes. <a href="/">Return to Erev</a>.</p>', 503);
  }
  return page("Check your inbox", '<p>Open the sign-in link in your Erev email. It expires in 15 minutes.</p><p><a href="/">Back to Erev</a></p>');
}

function emailConfirmation(env) {
  if (!emailConfigured(env)) return signInPage(env);
  return page("Sign in to Erev", '<p>Continue to verify your email address and sign in.</p>' +
    '<form method="post" action="/auth/email/verify"><input type="hidden" name="token" id="email-token">' +
    '<button id="verify-email" disabled>Verify and sign in</button></form>' +
    '<p><a href="/">Request a new link</a></p>' + browserScript);
}

async function verifyEmail(request, env) {
  if (!emailConfigured(env)) return signInPage(env);
  const token = (await request.formData()).get("token");
  if (typeof token !== "string" || !opaquePattern.test(token)) return redirect("/?sign-in-error=1");
  const attempt = await env.DB.prepare(
    "DELETE FROM email_challenges WHERE token_hash = ? AND expires_at > ? RETURNING email, invite"
  ).bind(await digest(token), Date.now()).first();
  if (!attempt) return page("Sign-in link expired or used", '<p><a href="/">Request a new link</a></p>', 400);
  const { email, invite } = attempt;
  return await startSession(env, {
    id: "email:" + email,
    email,
    label: email.split("@", 1)[0].slice(0, 80),
    admin: email === env.ADMIN_EMAIL?.toLowerCase(),
    invite,
  });
}

const adminTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Karachi",
  day: "numeric",
  month: "short",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function adminDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(value) || !Number.isFinite(date.getTime())) return "Unavailable";
  return '<time datetime="' + date.toISOString() + '">' + adminTime.format(date) + " PKT</time>";
}

async function adminPage(env, notice) {
  const result = await env.DB.prepare(
    "SELECT users.id, users.email, users.name, users.status, users.created_at, approval_emails.sent_at " +
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
    const method = user.id.startsWith("email:") ? "Email link" : "Google";
    const status = user.status.charAt(0).toUpperCase() + user.status.slice(1);
    const details = '<dl class="account-details"><div><dt>Signed up</dt><dd>' + adminDate(user.created_at) +
      "</dd></div><div><dt>Sign-in method</dt><dd>" + method +
      "</dd></div><div><dt>Account ID</dt><dd>" + escape(user.id) + "</dd></div></dl>";
    return "<tr><td>" + escape(user.name) + "<br><small>" + escape(user.email) + "</small>" + details +
      "</td><td>" + escape(status) +
      (user.status === "approved" ? "<br><small>" + (user.sent_at ? "Email sent " + adminDate(user.sent_at) : "Email pending") + "</small>" : "") +
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
  const sent = await sendEmail(env, {
    to: item.email,
    subject: "Your Erev access is approved",
    text: "You’re approved to join the Erev beta.\n\nOpen " + env.PUBLIC_ORIGIN +
      "/ and sign in with the same email address to create or join a room.\n\nSee you at movie night,\nErev",
    key: "erev-approval/" + item.id,
  });
  if (!sent) return false;
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

async function roomAccess(request, env, user) {
  let body;
  try { body = await request.json(); } catch { return json({ error: "Invalid room request" }, 400); }
  const { action, code, peerId, publicKey } = body ?? {};
  if (typeof code !== "string" || !invitePattern.test(code) || code.includes(".")) {
    return json({ error: "Invalid room code" }, 400);
  }
  const now = Date.now();
  if (action === "sync" || action === "leave") {
    if (typeof peerId !== "string" || !peerPattern.test(peerId)) return json({ error: "Invalid peer" }, 400);
    const row = await env.DB.prepare(
      "SELECT room_id, expires_at FROM room_members WHERE peer_id=? AND session_hash=? AND " +
      "room_id=(SELECT signaling_code FROM rooms WHERE invite_code=? AND expires_at>?)"
    ).bind(peerId, user.session_hash, code, now).first();
    if (!row) return json({ error: "Room membership ended." }, 403);
    if (action === "leave") {
      await env.DB.prepare("DELETE FROM room_members WHERE peer_id=? AND session_hash=?").bind(peerId, user.session_hash).run();
      return json({ left: true });
    }
    if (row.expires_at <= now) return json({ error: "Room membership expired." }, 403);
    const renew = row.expires_at - now <= 45_000;
    if (renew) {
      await env.DB.prepare(
        "UPDATE room_members SET expires_at=? WHERE peer_id=? AND session_hash=? AND expires_at>?"
      ).bind(now + roomLease, peerId, user.session_hash, now).run();
    }
    const members = await env.DB.prepare("SELECT m.peer_id AS peerId, m.public_key AS publicKey, m.is_host AS host " + activeMembers)
      .bind(row.room_id, now, now).all();
    if (!members.results.some(member => member.host)) return json({ error: "The host left the room." }, 403);
    if (!members.results.some(member => member.peerId === peerId)) return json({ error: "Room membership ended." }, 403);
    return json({ members: members.results, leaseMs: renew ? roomLease : row.expires_at - now, serverTime: now });
  }
  if (action !== "create" && action !== "join") return json({ error: "Invalid room action" }, 400);
  if (typeof publicKey !== "string" || !/^B[A-Za-z0-9_-]{86}$/.test(publicKey)) {
    return json({ error: "Invalid room identity. Refresh Erev and try again." }, 400);
  }
  try {
    const raw = Uint8Array.from(atob(publicKey.replaceAll("-", "+").replaceAll("_", "/") + "="), c => c.charCodeAt(0));
    await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  } catch {
    return json({ error: "Invalid room identity" }, 400);
  }
  if (!await takeSendSlot(env.DB, "room:" + user.id, 600_000, 30, now)) {
    return json({ error: "Too many room requests. Try again shortly." }, 429);
  }
  const newPeer = "erev-beta-v2-" + crypto.randomUUID().replaceAll("-", "");
  await env.DB.prepare("DELETE FROM room_members WHERE expires_at <= ?").bind(now).run();
  if (action === "create") {
    const signalingCode = crypto.randomUUID().replaceAll("-", "");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM rooms WHERE expires_at <= ?").bind(now),
      env.DB.prepare("INSERT OR IGNORE INTO rooms(invite_code, signaling_code, expires_at) VALUES(?, ?, ?)").bind(code, signalingCode, now + 7 * day),
      env.DB.prepare(
        "INSERT INTO room_members(peer_id,room_id,session_hash,public_key,is_host,expires_at) " +
        "SELECT ?,signaling_code,?,?,1,? FROM rooms WHERE invite_code=? AND signaling_code=?"
      ).bind(newPeer, user.session_hash, publicKey, now + roomLease, code, signalingCode),
    ]);
    const room = await env.DB.prepare("SELECT signaling_code FROM rooms WHERE invite_code=?").bind(code).first();
    if (room?.signaling_code !== signalingCode) return json({ error: "Try creating the room again." }, 409);
    return json({ signalingCode, peerId: newPeer, hostPeerId: newPeer, hostKey: publicKey, leaseMs: roomLease, serverTime: now });
  }
  const room = await env.DB.prepare("SELECT signaling_code FROM rooms WHERE invite_code=? AND expires_at>?").bind(code, now).first();
  if (!room) return json({ error: "Room not found. Ask the host for a current invite." }, 404);
  const host = await env.DB.prepare("SELECT m.peer_id AS id, m.public_key AS key " + activeMembers + " AND m.is_host=1")
    .bind(room.signaling_code, now, now).first();
  if (!host) return json({ error: "The host is offline. Ask for a new room invite." }, 404);
  const admitted = await env.DB.prepare(
    "INSERT INTO room_members(peer_id,room_id,session_hash,public_key,is_host,expires_at) " +
    "SELECT ?,?,?,?,0,? WHERE (SELECT COUNT(*) " + activeMembers + ") < 6 RETURNING peer_id"
  ).bind(newPeer, room.signaling_code, user.session_hash, publicKey, now + roomLease, room.signaling_code, now, now).first();
  if (!admitted) return json({ error: "Room is full." }, 409);
  return json({ signalingCode: room.signaling_code, peerId: newPeer, hostPeerId: host.id, hostKey: host.key, leaseMs: roomLease, serverTime: now });
}

const browserHelper = "const hash=location.hash.slice(1);const token=document.getElementById('email-token');" +
  "if(token){if(/^[A-Za-z0-9_-]{43}$/.test(hash)){token.value=hash;document.getElementById('verify-email').disabled=false;}" +
  "if(hash)history.replaceState(null,'',location.pathname);}" +
  "else{const invite=hash||new URL(location.href).searchParams.get('room');const field=document.getElementById('email-invite');" +
  "const link=document.getElementById('google-sign-in');if(invite){if(field)field.value=invite;if(link)link.search=new URLSearchParams({invite});}}" +
  "if('serviceWorker'in navigator)navigator.serviceWorker.register('/sw.js',{updateViaCache:'none'}).catch(()=>{});";
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
        if (method === "GET" && path === "/auth/google") return await googleStart(request, url, env);
        if (method === "GET" && path === "/auth/google/callback") return await googleCallback(request, url, env);
        if (method === "POST" && path === "/auth/email") return await emailStart(request, env);
        if (path === "/auth/email/verify") {
          if (method === "GET") return emailConfirmation(env);
          if (method === "POST") return await verifyEmail(request, env);
        }
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
        if (path === "/admin" && method === "GET") {
          if (!isAdmin(user, env)) return adminSignInPage(user, env);
          return await adminPage(env, url.searchParams.get("done"));
        }
        if (path === "/admin/access" && method === "POST") {
          if (!isAdmin(user, env)) return json({ error: "Forbidden" }, 403);
          return await changeAccess(request, env, user);
        }
        if (path.startsWith("/api/")) {
          if (!user) return json({ error: "Sign in to use Erev." }, 401);
          if (user.status !== "approved") return json({ error: "This account needs approval." }, 403);
          if (path === "/api/me" && method === "GET") {
            if (url.searchParams.get("roomClient") !== "2") return json({ error: "Refresh Erev to use the current room client." }, 403);
            return json({ name: user.name, admin: isAdmin(user, env) });
          }
          if (path === "/api/rooms" && method === "POST") {
            if (!(request.headers.get("Content-Type") || "").startsWith("application/json")) return json({ error: "JSON required" }, 415);
            return await roomAccess(request, env, user);
          }
          return json({ error: "Not found" }, 404);
        }
        if (method === "POST") return json({ error: "Not found" }, 404);
        if (path === "/" || path === "/index.html") {
          if (!user) return signInPage(env, url.searchParams.has("sign-in-error"));
          if (user.status !== "approved") return accountStatus(user);
        }
        if (!asset) return json({ error: "Not found" }, 404);
        if (!user || user.status !== "approved") return json({ error: "Forbidden" }, 403);
        const h = headers(asset[0]);
        if (path === "/" || path === "/index.html") {
          h.set("X-Frame-Options", "DENY");
          h.set("Content-Security-Policy", "default-src 'self'; script-src 'self' https://cdnjs.cloudflare.com/ajax/libs/peerjs/1.5.5/peerjs.min.js https://www.youtube.com/iframe_api https://www.youtube.com/s/player/ https://s.ytimg.com/yts/jsbin/; style-src 'self' 'unsafe-inline'; connect-src 'self' https://0.peerjs.com wss://0.peerjs.com https://www.youtube.com https://www.youtube-nocookie.com; img-src 'self' https: data: blob:; media-src 'self' https: blob:; frame-src https:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
        }
        return new Response(method === "HEAD" ? null : asset[1], { headers: h });
      } catch (error) {
        console.error("Erev request failed", { name: error?.name || "Error" });
        return json({ error: "Erev is temporarily unavailable. Try again." }, 503);
      }
    },
  };
}
