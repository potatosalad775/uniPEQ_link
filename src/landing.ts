/**
 * `/l/<CODE>`: where the QR code points and where the intent link falls back (design §7.1). With
 * uniPEQ installed and this host verified, Android opens uniPEQ instead and this never shows.
 * Otherwise it shows the code, an "Open uniPEQ" intent link for this server, and where to get
 * uniPEQ.
 */
import { formatRoomCode, intentLink } from '../client/protocol';

const PLAY = 'https://play.google.com/store/apps/details?id=kr.potatosalad775.unipeq';
const RELEASES = 'https://github.com/potatosalad775/uniPEQ/releases/latest';

/** `room` is a validated code and `server` a URL origin, so neither needs escaping beyond `&`. */
export function landingPage(server: string, room: string): Response {
	const code = formatRoomCode(room);
	const open = intentLink(server, room).replaceAll('&', '&amp;');
	const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="robots" content="noindex">
<title>Link ${code} · uniPEQ</title>
<style>
	body { font: 16px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 30rem; padding: 2rem 1rem; text-align: center; }
	.code { font: 600 2.25rem ui-monospace, monospace; letter-spacing: 0.12em; margin: 0.5rem 0 1.5rem; user-select: all; }
	.open { display: inline-block; padding: 0.75rem 1.5rem; border-radius: 0.5rem; background: #2563eb; color: #fff; font-weight: 600; text-decoration: none; }
	.android { display: none; }
	.is-android .android { display: block; }
	p { margin: 1rem 0; }
	small { opacity: 0.7; }
</style>
</head>
<body>
<h1>Link with uniPEQ</h1>
<p>A modernGraphTool page wants to link with uniPEQ. The link code is</p>
<p class="code">${code}</p>
<div class="android"><p><a class="open" href="${open}">Open uniPEQ</a></p></div>
<p>Or open uniPEQ, choose <b>Link with modernGraphTool</b> in the EQ menu and type the code.</p>
<p><small>Don't have uniPEQ? Get it on <a href="${PLAY}">Google Play</a> or from <a href="${RELEASES}">GitHub</a>.</small></p>
<script>if (/Android/i.test(navigator.userAgent)) document.body.classList.add('is-android');</script>
</body>
</html>`;
	return new Response(html, {
		headers: {
			'Content-Type': 'text/html; charset=utf-8',
			// The page is the same for everyone, and a room code is short-lived.
			'Cache-Control': 'no-store',
			'Content-Security-Policy':
				"default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
			'Referrer-Policy': 'no-referrer'
		}
	});
}
