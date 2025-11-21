export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (!url.pathname.startsWith("/harmonize")) {
      return new Response("ASA Harmonizer Worker Online", { status: 200 });
    }

    // /harmonize/preview → /api/harmonize/preview
    // /harmonize/apply   → /api/harmonize/apply
    const endpoint = "/api" + url.pathname;

    return fetch(env.BACKEND_URL + endpoint, {
      method: req.method,
      headers: req.headers,
      body: req.body
    });
  }
}
