export default async function handler(req, res) {
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");

  const client_id = process.env.DISCORD_CLIENT_ID;
  const client_secret = process.env.DISCORD_CLIENT_SECRET;
  const bot_token = process.env.DISCORD_BOT_TOKEN;
  const guild_id = process.env.DISCORD_GUILD_ID;
  const redirect_uri = `https://${process.env.VERCEL_URL}/api/callback`;

  const params = new URLSearchParams({
    client_id,
    client_secret,
    grant_type: "authorization_code",
    code,
    redirect_uri,
  });

  try {
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
    });
    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      return res.status(400).send("Failed to get access token");
    }

    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userRes.json();

    await fetch(`https://discord.com/api/guilds/${guild_id}/members/${userData.id}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bot ${bot_token}`,
      },
      body: JSON.stringify({ access_token: tokenData.access_token }),
    });

    return res.redirect(`https://discord.com/channels/${guild_id}`);
  } catch (error) {
    console.error(error);
    return res.status(500).send("Server error");
  }
}
