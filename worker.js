/**
 * Cloudflare Worker — CORS-Proxy für Nextcloud-WebDAV.
 *
 * Zweck: Die Zeiterfassungs-PWA läuft auf GitHub Pages und würde direkt
 * gegen die Nextcloud-WebDAV-Schnittstelle CORS-Fehler bekommen, weil die
 * Managed Nextcloud keine Access-Control-Allow-Origin-Header schickt.
 * Dieser Worker läuft server-seitig (kein Browser, kein CORS-Problem beim
 * Weiterleiten), reicht die Anfrage 1:1 an Nextcloud durch und ergänzt in
 * der Antwort nur die fehlenden CORS-Header.
 *
 * Wichtig: Der Worker speichert NICHTS. Er kennt auch keine Zugangsdaten —
 * der Authorization-Header kommt bei jedem Request vom Browser und wird
 * nur durchgereicht. Die Zeiterfassungsdaten selbst liegen ausschliesslich
 * auf eurer eigenen Nextcloud.
 */

const ALLOWED_ORIGIN = "https://jonashaldemann.github.io";
const NEXTCLOUD_BASE = "https://231121p3noy7vr3b2no.nextcloud.hosting.zone/remote.php/dav/files/";
const ALLOWED_METHODS = ["GET", "PUT", "MKCOL", "OPTIONS"];

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": ALLOWED_METHODS.join(", "),
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "3600"
  };
}

export default {
  async fetch(request) {
    // Preflight-Anfrage des Browsers
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (!ALLOWED_METHODS.includes(request.method)) {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
    }

    const url = new URL(request.url);
    const path = url.searchParams.get("path");
    if (!path) {
      return new Response("Missing ?path= parameter", { status: 400, headers: corsHeaders() });
    }

    // path kommt bereits als Klartext-Pfad an (z.B. "jonas@domain.ch/Buero/Admin/test_zeit/datei.csv"),
    // URLSearchParams hat die Prozent-Codierung schon aufgelöst.
    const targetUrl = NEXTCLOUD_BASE + path;

    const forwardHeaders = new Headers();
    const auth = request.headers.get("Authorization");
    if (auth) forwardHeaders.set("Authorization", auth);
    if (request.method === "PUT") forwardHeaders.set("Content-Type", "text/csv");

    const init = { method: request.method, headers: forwardHeaders };
    if (request.method === "PUT") {
      init.body = await request.arrayBuffer();
    }

    let upstream;
    try {
      upstream = await fetch(targetUrl, init);
    } catch (err) {
      return new Response("Upstream fetch failed: " + err.message, {
        status: 502,
        headers: corsHeaders()
      });
    }

    const body = await upstream.arrayBuffer();
    const respHeaders = new Headers(corsHeaders());
    const contentType = upstream.headers.get("Content-Type");
    if (contentType) respHeaders.set("Content-Type", contentType);

    return new Response(body, { status: upstream.status, headers: respHeaders });
  }
};
