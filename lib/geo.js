// Looks up country/city info for an IP address using the free ip-api.com service
// (no API key needed, fine for low/medium volume). Swap for a paid provider
// (ipinfo.io, MaxMind, etc.) if you need higher accuracy or volume.

function isPrivateIp(ip) {
  if (!ip) return true;
  return (
    ip === '::1' ||
    ip === '127.0.0.1' ||
    ip.startsWith('10.') ||
    ip.startsWith('192.168.') ||
    ip.startsWith('172.16.') ||
    ip.startsWith('::ffff:127.') ||
    ip.startsWith('::ffff:10.') ||
    ip.startsWith('::ffff:192.168.')
  );
}

async function getGeoInfo(ip) {
  if (isPrivateIp(ip)) {
    return { ip: ip || '', country: 'Unknown (local)', countryCode: '', city: '' };
  }

  try {
    const res = await fetch(
      `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,countryCode,city,query`
    );
    const data = await res.json();
    if (data.status === 'success') {
      return {
        ip: data.query || ip,
        country: data.country || 'Unknown',
        countryCode: data.countryCode || '',
        city: data.city || ''
      };
    }
  } catch (e) {
    // fall through to unknown
  }

  return { ip: ip || '', country: 'Unknown', countryCode: '', city: '' };
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || '';
}

module.exports = { getGeoInfo, getClientIp };
