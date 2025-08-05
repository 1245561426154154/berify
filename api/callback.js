export default async function handler(req, res) {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");

  // You can still use env vars for secrets, but hardcode redirect_uri for safety
  const client_id = process.env.DISCORD_CLIENT_ID;
  const client_secret = process.env.DISCORD_CLIENT_SECRET;
  const bot_token = process.env.DISCORD_BOT_TOKEN;
  const guild_id = process.env.DISCORD_GUILD_ID;
  const role_id = process.env.DISCORD_ROLE_ID;
  const webhook_url = process.env.DISCORD_WEBHOOK_URL;

  // IMPORTANT: Hardcode your redirect_uri to match Discord developer portal
  const redirect_uri = "https://berify-topaz.vercel.app/api/callback";

  // Get IP address behind proxies
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || "Unknown IP";
  // Get User Agent
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
      // Log the error for debugging
      console.error("Failed to get access token. Discord response:", tokenText);
      return res.status(400).send("Failed to get access token: " + tokenText);
    }

    // Fetch user info
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userRes.json();

    // Add role to existing guild member
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

    // Send detailed embed to webhook
    if (webhook_url) {
      const avatarUrl = userData.avatar
        ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png?size=1024`
        : null;

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
              { name: "Expires In (seconds)", value: tokenData.expires_in?.toString() || "unknown", inline: true }
            ],
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
